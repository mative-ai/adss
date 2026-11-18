/**
 * The worker entry (worker.ts) through its messages, in Node with a stand-in `self`: init answers ready and a first
 * frame; play paces the run to its end, posting frames, decisions and events, then the metrics; the buffers go round,
 * and a frame the page could not take is sent when a buffer comes back, so the tail of a run is never lost; export,
 * parameters, steps, batches and the errors answer as the protocol says.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import ice from '../../../scenarios/ice.json';
import pedestrian from '../../../scenarios/pedestrian.json';
import { parseRunCsv } from './csv.ts';
import {
  FLAG,
  FRAME,
  PROTOCOL_VERSION,
  VEHICLE_SIZE,
  type FromWorker,
  type SessionConfig,
  type ToWorker,
} from './protocol.ts';
import { runSession } from './session.ts';

const posted: FromWorker[] = [];
const scope = globalThis as unknown as {
  self?: { postMessage: (message: FromWorker) => void; onmessage: ((event: { data: ToWorker }) => void) | null };
};
const original = scope.self;

beforeAll(async () => {
  scope.self = { postMessage: (message) => posted.push(message), onmessage: null };
  await import('./worker.ts');
});

afterAll(() => {
  scope.self = original;
});

const send = (data: ToWorker) => scope.self?.onmessage?.({ data });
const take = () => posted.splice(0);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (done: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await wait(10);
};
const codes = (messages: readonly FromWorker[]) => messages.map((m) => (m.type === 'error' ? m.code : m.type));

/** A frame's header as the page read it, before giving its buffer back (the worker writes into it again). */
interface Seen {
  readonly tick: number;
  readonly flags: number;
  readonly rate: number;
}

/** Takes the messages as the page does: each frame read, then its buffer given back; the rest into `other`. */
const pump = (frames: Seen[], other: FromWorker[]) => {
  for (const m of take()) {
    if (m.type !== 'frame') {
      other.push(m);
      continue;
    }
    const f = new Float64Array(m.buffer);
    frames.push({ tick: f[FRAME.TICK] ?? 0, flags: f[FRAME.FLAGS] ?? 0, rate: f[FRAME.RATE] ?? 0 });
    send({ type: 'returnBuffer', buffer: m.buffer });
  }
};

/** A configuration that runs fast, for the batches: no ghost, the shortest horizon, one maneuver. */
const QUICK: Partial<SessionConfig> = { ghost: false, horizon: 8, maneuvers: ['keep'] };

describe('the worker entry', () => {
  it('refuses another protocol version and messages before init', () => {
    send({ type: 'control', action: 'play' });
    send({ type: 'init', version: PROTOCOL_VERSION + 1, scenario: pedestrian, seed: 1 });
    expect(take().map((m) => (m.type === 'error' ? m.code : m.type))).toEqual(['state', 'version']);
  });

  it('plays a run to its end, frames, decisions and events on the way, the metrics last', async () => {
    send({ type: 'init', version: PROTOCOL_VERSION, scenario: pedestrian, seed: 1 });
    const opening = take();
    expect(opening.map((m) => m.type)).toEqual(['ready', 'frame']);
    send({ type: 'setSpeed', rate: 4 });
    send({ type: 'control', action: 'play' });
    const seen: FromWorker[] = [];
    let frames = 0;
    await until(() => {
      for (const m of take()) {
        seen.push(m);
        if (m.type === 'frame') {
          frames++;
          // The page draws the frame, then gives its buffer back.
          send({ type: 'returnBuffer', buffer: m.buffer });
        }
      }
      return seen.some((m) => m.type === 'metrics');
    });
    const metrics = seen.find((m) => m.type === 'metrics');
    expect(metrics?.type === 'metrics' && metrics.metrics.fingerprint).toBe(
      runSession(pedestrian, 1).metrics().fingerprint,
    );
    expect(frames).toBeGreaterThan(10);
    expect(seen.filter((m) => m.type === 'decision')).toHaveLength(160);
    expect(seen.some((m) => m.type === 'event' && m.event.kind === 'end')).toBe(true);
    const last = seen.filter((m) => m.type === 'frame').at(-1);
    expect(last?.type === 'frame' && new Float64Array(last.buffer)[FRAME.TICK]).toBe(8000);
  }, 30_000);

  it('exports the run, steps a cycle, starts again with new parameters', () => {
    send({ type: 'exportCsv' });
    const csv = take().find((m) => m.type === 'csv');
    expect(csv?.type === 'csv' && csv.filename).toBe('pedestrian-seed1.csv');
    expect(csv?.type === 'csv' && parseRunCsv(csv.text).seed).toBe(1);
    send({ type: 'control', action: 'reset' });
    expect(take().map((m) => m.type)).toEqual(['event', 'ready', 'frame']);
    send({ type: 'control', action: 'step' });
    const step = take();
    expect(step.filter((m) => m.type === 'decision')).toHaveLength(1);
    const frame = step.find((m) => m.type === 'frame');
    expect(frame?.type === 'frame' && new Float64Array(frame.buffer)[FRAME.TICK]).toBe(50);
    send({ type: 'setParams', config: { horizon: 15 } });
    const ready = take().find((m) => m.type === 'ready');
    expect(ready?.type === 'ready' && ready.config.horizon).toBe(15);
    send({ type: 'setParams', config: { horizon: 3 } });
    expect(codes(take())).toEqual(['config']);
  });

  it('keeps a configuration it refuses out of the run: reset and new parameters go on from the last good one', () => {
    send({ type: 'control', action: 'reset' });
    const reset = take();
    expect(reset.map((m) => m.type)).toEqual(['event', 'ready', 'frame']);
    const ready = reset.find((m) => m.type === 'ready');
    expect(ready?.type === 'ready' && ready.config.horizon).toBe(15);
    send({ type: 'setParams', config: { delayTicks: 20 } });
    const again = take().find((m) => m.type === 'ready');
    expect(again?.type === 'ready' && [again.config.horizon, again.config.delayTicks]).toEqual([15, 20]);
    send({ type: 'init', version: PROTOCOL_VERSION, scenario: { id: 'x' }, seed: 1 });
    expect(codes(take())).toEqual(['scenario']);
    send({ type: 'control', action: 'step' });
    const step = take().find((m) => m.type === 'frame');
    expect(step?.type === 'frame' && new Float64Array(step.buffer)[FRAME.TICK]).toBe(50);
    // The source refused never replaced the last good one.
    send({ type: 'control', action: 'reset' });
    const last = take().find((m) => m.type === 'ready');
    expect(last?.type === 'ready' && [last.scene.scenario, last.config.horizon, last.config.delayTicks]).toEqual([
      'pedestrian',
      15,
      20,
    ]);
  });

  it('leaves a playing run playing when it refuses an init or new parameters', async () => {
    send({ type: 'init', version: PROTOCOL_VERSION, scenario: pedestrian, seed: 1 });
    const frames: Seen[] = [];
    const other: FromWorker[] = [];
    pump(frames, other);
    send({ type: 'control', action: 'play' });
    await until(() => {
      pump(frames, other);
      return frames.some((f) => f.flags & FLAG.PLAYING);
    });
    send({ type: 'setParams', config: { horizon: 3 } });
    send({ type: 'init', version: PROTOCOL_VERSION, scenario: { id: 'x' }, seed: 1 });
    const before = frames.length;
    await until(() => {
      pump(frames, other);
      return frames.length > before + 2;
    });
    send({ type: 'control', action: 'pause' });
    pump(frames, other);
    expect(codes(other.filter((m) => m.type === 'error' || m.type === 'ready'))).toEqual([
      'ready',
      'config',
      'scenario',
    ]);
    expect(frames.slice(before, before + 2).every((f) => f.flags & FLAG.PLAYING)).toBe(true);
  });

  it('plays at the rate it is asked for, and says the rate in its frames', async () => {
    send({ type: 'init', version: PROTOCOL_VERSION, scenario: pedestrian, seed: 1 });
    const frames: Seen[] = [];
    pump(frames, []);
    send({ type: 'setSpeed', rate: 0.25 });
    const begin = performance.now();
    send({ type: 'control', action: 'play' });
    await until(() => {
      pump(frames, []);
      return frames.some((f) => f.tick >= 50);
    });
    send({ type: 'control', action: 'pause' });
    const elapsed = performance.now() - begin;
    pump(frames, []);
    send({ type: 'setSpeed', rate: 1 });
    // The pacer never owes more than the wall time at the rate: at 1 the run would be four times as far.
    expect(frames.at(-1)?.tick).toBeLessThanOrEqual(0.25 * elapsed + 1);
    expect(frames[0]?.rate).toBe(0);
    expect(frames.filter((f) => f.flags & FLAG.PLAYING).every((f) => f.rate > 0)).toBe(true);
  });

  it('drops a live run that breaks on the way, and starts again on new parameters', async () => {
    // ice at 1e300 km/h: the core refuses a non-finite command at tick 100, in the third control cycle.
    send({ type: 'init', version: PROTOCOL_VERSION, scenario: ice, seed: 1, config: { speedKmh: 1e300 } });
    take();
    for (let i = 0; i < 3; i++) send({ type: 'control', action: 'step' });
    expect(codes(take()).at(-1)).toBe('internal');
    send({ type: 'control', action: 'step' });
    send({ type: 'exportCsv' });
    expect(codes(take())).toEqual(['state', 'state']);
    // The same while playing: the error, then nothing, no metrics and no loop left running.
    send({ type: 'control', action: 'reset' });
    take();
    send({ type: 'control', action: 'play' });
    await until(() => posted.some((m) => m.type === 'error'));
    await wait(100);
    const playing = take();
    expect(codes(playing).filter((c) => c !== 'frame' && c !== 'decision' && c !== 'event')).toEqual(['internal']);
    expect(take()).toEqual([]);
    send({ type: 'setParams', config: { speedKmh: 70 } });
    expect(codes(take())).toEqual(['ready', 'frame']);
    // A batch run that breaks so ends its batch, and the error names it.
    send({ type: 'runBatch', id: 30, runs: [{ scenario: ice, seed: 1, config: { speedKmh: 1e300 } }] });
    await until(() => posted.some((m) => m.type === 'error'));
    const error = take().find((m) => m.type === 'error');
    expect(error?.type === 'error' && [error.code, error.batch]).toEqual(['internal', { id: 30, index: 0 }]);
  });

  it('sends the tail of a run whose buffers the page held: the last frames as they come back, then the metrics', async () => {
    send({ type: 'init', version: PROTOCOL_VERSION, scenario: pedestrian, seed: 1 });
    const opening = take();
    const ready = opening.find((m) => m.type === 'ready');
    if (ready?.type !== 'ready') throw new Error('No ready');
    const L = ready.scene.frame;
    const rows = { ego: [] as number[], ghost: [] as number[] };
    const held: ArrayBuffer[] = [];
    const seen: FromWorker[] = [];
    let last = { tick: 0, flags: 0 };
    const read = (messages: readonly FromWorker[]) => {
      for (const m of messages) {
        seen.push(m);
        if (m.type !== 'frame') continue;
        const f = new Float64Array(m.buffer);
        rows.ego.push(...f.subarray(L.egoTelemetry, L.egoTelemetry + (f[FRAME.EGO_ROWS] ?? 0) * VEHICLE_SIZE));
        rows.ghost.push(...f.subarray(L.ghostTelemetry, L.ghostTelemetry + (f[FRAME.GHOST_ROWS] ?? 0) * VEHICLE_SIZE));
        last = { tick: f[FRAME.TICK] ?? 0, flags: f[FRAME.FLAGS] ?? 0 };
        held.push(m.buffer);
      }
    };
    read(opening);
    send({ type: 'setSpeed', rate: 4 });
    send({ type: 'control', action: 'play' });
    // The page holds every buffer to the run's end: the frames after the fourth are skipped.
    await until(() => {
      read(take());
      return seen.some((m) => m.type === 'event' && m.event.kind === 'end');
    });
    expect(seen.filter((m) => m.type === 'frame').length).toBeLessThanOrEqual(4);
    expect(seen.some((m) => m.type === 'metrics')).toBe(false);
    // Then it gives them back one by one, as it draws them.
    for (let i = 0; i < 1000 && !seen.some((m) => m.type === 'metrics'); i++) {
      const buffer = held.shift();
      if (!buffer) break;
      send({ type: 'returnBuffer', buffer });
      read(take());
    }
    const batch = runSession(pedestrian, 1).run.result();
    expect(Float64Array.from(rows.ego)).toEqual(batch.ego.records);
    expect(Float64Array.from(rows.ghost)).toEqual(batch.ghost?.records);
    expect(last.tick).toBe(8000);
    expect(last.flags & FLAG.DONE).toBe(FLAG.DONE);
    expect(seen.filter((m) => m.type === 'metrics')).toHaveLength(1);
    expect(seen.at(-1)?.type).toBe('metrics');
  }, 30_000);

  it('owes the page the paused state while it holds the buffers, and sends it when one comes back', async () => {
    send({ type: 'init', version: PROTOCOL_VERSION, scenario: pedestrian, seed: 1 });
    const held = take().flatMap((m) => (m.type === 'frame' ? [m.buffer] : []));
    send({ type: 'control', action: 'play' });
    await until(() => {
      for (const m of take()) if (m.type === 'frame') held.push(m.buffer);
      return held.length >= 4;
    });
    await wait(50);
    send({ type: 'control', action: 'pause' });
    expect(take().filter((m) => m.type === 'frame')).toEqual([]);
    send({ type: 'returnBuffer', buffer: held.pop()! });
    const frame = take().find((m) => m.type === 'frame');
    const f = frame?.type === 'frame' ? new Float64Array(frame.buffer) : new Float64Array(FRAME.FLAGS + 1);
    expect(f[FRAME.TICK]).toBeGreaterThan(0);
    expect((f[FRAME.FLAGS] ?? 0) & FLAG.PLAYING).toBe(0);
    // The rows that waited follow, a frame for each buffer back; then nothing is owed.
    let back = frame?.type === 'frame' ? frame.buffer : undefined;
    for (let i = 0; back && i < 100; i++) {
      send({ type: 'returnBuffer', buffer: back });
      const next = take().find((m) => m.type === 'frame');
      back = next?.type === 'frame' ? next.buffer : undefined;
    }
    expect(back).toBeUndefined();
    send({ type: 'returnBuffer', buffer: held.pop()! });
    expect(take()).toEqual([]);
  });

  it('runs the newest batch, run by run, with the live run paused', async () => {
    send({ type: 'init', version: PROTOCOL_VERSION, scenario: pedestrian, seed: 1 });
    take();
    send({ type: 'control', action: 'play' });
    const runs = [1, 2].map((seed) => ({ scenario: pedestrian, seed, config: QUICK }));
    send({ type: 'runBatch', id: 8, runs: [...runs, ...runs] });
    send({ type: 'runBatch', id: 9, runs });
    const pause = take().find((m) => m.type === 'frame');
    expect(pause?.type === 'frame' && (new Float64Array(pause.buffer)[FRAME.FLAGS] ?? 0) & FLAG.PLAYING).toBe(0);
    const seen: FromWorker[] = [];
    await until(() => {
      seen.push(...take());
      return seen.filter((m) => m.type === 'metrics').length >= 2;
    });
    await wait(300);
    seen.push(...take());
    const metrics = seen.flatMap((m) => (m.type === 'metrics' ? [m.metrics] : []));
    expect(metrics.map((m) => m.batch)).toEqual([
      { id: 9, index: 0, total: 2 },
      { id: 9, index: 1, total: 2 },
    ]);
    expect(metrics.map((m) => m.fingerprint)).toEqual(
      runs.map((r) => runSession(r.scenario, r.seed, r.config).metrics().fingerprint),
    );
    expect(seen.some((m) => m.type === 'frame')).toBe(false);
  });

  it('stops a batch with an empty one, and refuses whole a batch with a run that cannot start', async () => {
    send({ type: 'runBatch', id: 10, runs: [1, 2, 3].map((seed) => ({ scenario: pedestrian, seed, config: QUICK })) });
    await until(() => posted.some((m) => m.type === 'metrics'));
    send({ type: 'runBatch', id: 11, runs: [] });
    take();
    await wait(500);
    expect(take()).toEqual([]);
    send({
      type: 'runBatch',
      id: 12,
      runs: [
        { scenario: pedestrian, seed: 1, config: QUICK },
        { scenario: pedestrian, seed: 1, config: { horizon: 3 } },
      ],
    });
    await wait(100);
    expect(codes(take())).toEqual(['config']);
  });

  it('refuses a batch while one runs, and the one in progress goes on', async () => {
    send({ type: 'runBatch', id: 20, runs: [1, 2, 3].map((seed) => ({ scenario: pedestrian, seed, config: QUICK })) });
    const seen: FromWorker[] = [];
    await until(() => {
      seen.push(...take());
      return seen.some((m) => m.type === 'metrics');
    });
    send({
      type: 'runBatch',
      id: 21,
      runs: [
        { scenario: pedestrian, seed: 1, config: QUICK },
        { scenario: pedestrian, seed: 1, config: { horizon: 3 } },
      ],
    });
    await until(() => {
      seen.push(...take());
      return seen.filter((m) => m.type === 'metrics').length >= 3;
    });
    expect(codes(seen)).toEqual(['metrics', 'config', 'metrics', 'metrics']);
    expect(seen.flatMap((m) => (m.type === 'metrics' ? [m.metrics.batch?.id] : []))).toEqual([20, 20, 20]);
  });

  it('refuses a message or a control it does not know, as another protocol', () => {
    send({ type: 'control', action: 'rewind' } as unknown as ToWorker);
    send({ type: 'seek', tick: 3 } as unknown as ToWorker);
    expect(codes(take())).toEqual(['version', 'version']);
  });
});
