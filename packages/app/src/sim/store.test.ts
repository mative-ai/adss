/**
 * The app's side of the protocol (store.ts) against a stand-in worker: `init` carries the protocol version, each frame
 * is copied out and its buffer goes back transferred, the panels follow a playing run at PANEL_MS and a paused one at
 * once, an error drops the run only when it says `internal`, and slow motion and the event log follow the events.
 */
import { describe, expect, it } from 'vitest';

import {
  FLAG,
  FRAME,
  frameLayout,
  PROTOCOL_VERSION,
  VEHICLE,
  type FromWorker,
  type SceneInfo,
  type SessionConfig,
  type ToWorker,
} from '@mpc-simulator/worker';

import { EVENT_LOG_MAX, PANEL_MS, SimulationStore, type WorkerPort } from './store.ts';

const layout = frameLayout(1, 8);

class FakeWorker implements WorkerPort {
  onmessage: WorkerPort['onmessage'] = null;
  onerror: WorkerPort['onerror'] = null;
  terminated = false;
  readonly sent: { message: ToWorker; transfer: Transferable[] }[] = [];

  postMessage(message: ToWorker, transfer: Transferable[] = []): void {
    this.sent.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  /** A message from the worker, as the page gets it. */
  emit(message: FromWorker): void {
    this.onmessage?.({ data: message } as MessageEvent<FromWorker>);
  }
}

const scene = (): SceneInfo => ({
  scenario: 'pedestrian',
  ticks: 8000,
  vehicle: { id: 'car', length: 4.4, width: 1.8, track: 1.55, bodyOffset: -0.265 },
  road: new Float64Array(5),
  width: { left: 3.5, right: 3.5 },
  lane: { center: -1.75, width: 3.5 },
  surface: { base: { id: 'dry', mu: 1 }, zones: [] },
  obstacles: [{ id: 'pedestrian', kind: 'pedestrian', length: 0.5, width: 0.5 }],
  frame: layout,
});

const config: SessionConfig = {
  controller: 'decision',
  horizon: 8,
  maneuvers: ['keep', 'brake', 'left', 'right'],
  scales: {},
  delayTicks: 50,
  ghost: true,
};

const ready = (): FromWorker => ({ type: 'ready', version: PROTOCOL_VERSION, seed: 1, config, scene: scene() });

function frame(tick: number, flags: number, vx = 10): FromWorker {
  const data = new Float64Array(layout.length);
  data[FRAME.TICK] = tick;
  data[FRAME.FLAGS] = flags;
  data[layout.ego + VEHICLE.VX] = vx;
  return { type: 'frame', buffer: data.buffer };
}

function setup() {
  let clock = 0;
  const worker = new FakeWorker();
  const store = new SimulationStore(worker, () => clock);
  let renders = 0;
  store.subscribe(() => renders++);
  return { worker, store, advance: (ms: number) => (clock += ms), renders: () => renders };
}

describe('the commands', () => {
  it('start with the protocol version, and every other command is one message', () => {
    const { worker, store } = setup();
    store.start('pedestrian', { id: 'pedestrian' }, 3, { horizon: 15 });
    store.play();
    store.pause();
    store.step();
    store.reset();
    store.setSpeed(0.5);
    store.setParams({ ghost: false });
    expect(worker.sent.map((s) => s.message)).toEqual([
      { type: 'init', version: PROTOCOL_VERSION, scenario: { id: 'pedestrian' }, seed: 3, config: { horizon: 15 } },
      { type: 'control', action: 'play' },
      { type: 'control', action: 'pause' },
      { type: 'control', action: 'step' },
      { type: 'control', action: 'reset' },
      { type: 'setSpeed', rate: 0.5 },
      { type: 'setParams', config: { ghost: false } },
    ]);
    expect(store.getSnapshot()).toMatchObject({ scenarioId: 'pedestrian', seed: 3, speed: 0.5 });
  });
});

describe('a run', () => {
  it('is loading until the worker answers, then ready with its scene and a frame to draw from', () => {
    const { worker, store } = setup();
    expect(store.getSnapshot().status).toBe('loading');
    expect(store.frame).toBeNull();
    worker.emit(ready());
    expect(store.getSnapshot()).toMatchObject({
      status: 'ready',
      scene: { scenario: 'pedestrian' },
      config,
      done: false,
    });
    expect(store.frame?.obstacles).toHaveLength(1);
  });

  it('copies a frame out and gives its buffer back, transferred, whatever size it is', () => {
    const { worker, store } = setup();
    worker.emit(ready());
    const message = frame(50, FLAG.GHOST, 12);
    if (message.type !== 'frame') throw new Error('frame');
    worker.emit(message);
    expect(store.frame).toMatchObject({ tick: 50, ego: { vx: 12 } });
    const [back] = worker.sent.slice(-1);
    expect(back?.message).toEqual({ type: 'returnBuffer', buffer: message.buffer });
    expect(back?.transfer).toEqual([message.buffer]);
    // A buffer of another run's size is not read, and goes back all the same.
    const other = new Float64Array(7).buffer;
    worker.emit({ type: 'frame', buffer: other });
    expect(store.frame?.tick).toBe(50);
    expect(worker.sent.at(-1)?.transfer).toEqual([other]);
  });

  it('updates the panels of a playing run every PANEL_MS, and a paused or finished one at once', () => {
    const { worker, store, advance, renders } = setup();
    worker.emit(ready());
    worker.emit(frame(0, 0));
    const paused = renders();
    worker.emit(frame(10, 0));
    expect(renders()).toBe(paused + 1);
    // Play starts: the flag changes, the panels follow; then frames at 16 ms come in faster than the panels go.
    worker.emit(frame(20, FLAG.PLAYING));
    const playing = renders();
    // Seven frames in 112 ms: the canvas reads each one, the panels update once, at the seventh.
    for (let i = 0; i < 7; i++) {
      advance(16);
      worker.emit(frame(30 + i, FLAG.PLAYING));
      expect(store.frame?.tick).toBe(30 + i);
      expect(renders() - playing).toBe(i < 6 ? 0 : 1);
    }
    expect(7 * 16).toBeGreaterThanOrEqual(PANEL_MS);
    worker.emit(frame(8000, FLAG.DONE));
    expect(store.getSnapshot()).toMatchObject({ playing: false, done: true });
    expect(store.getSnapshot().readout?.time).toBe(8);
  });

  it('shows the last decision with the panels, and the final metrics when they come', () => {
    const { worker, store } = setup();
    worker.emit(ready());
    const report = { tick: 50, chosen: 'keep', candidates: [] } as unknown as Extract<
      FromWorker,
      { type: 'decision' }
    >['report'];
    worker.emit({ type: 'decision', report, stepMs: 4.2 });
    worker.emit(frame(50, 0));
    expect(store.getSnapshot().decision).toEqual({ report, stepMs: 4.2 });
    const metrics = { fingerprint: 'abc' } as unknown as Extract<FromWorker, { type: 'metrics' }>['metrics'];
    worker.emit({ type: 'metrics', metrics });
    expect(store.getSnapshot().metrics).toBe(metrics);
  });

  it('keeps the history of the run for the charts, and empties it when a new run is ready', () => {
    const { worker, store } = setup();
    worker.emit(ready());
    const data = new Float64Array(layout.length);
    data[FRAME.EGO_ROWS] = 1;
    data[layout.egoTelemetry + VEHICLE.TICK] = 10;
    data[layout.egoTelemetry + VEHICLE.VX] = 10;
    worker.emit({ type: 'frame', buffer: data.buffer });
    expect(store.telemetry.time).toEqual([0.01]);
    expect(store.telemetry.ego.speed).toEqual([36]);
    // The TTC kept is the one of the maneuver in force, not of another candidate.
    const report = {
      tick: 50,
      chosen: 'brake',
      candidates: [
        { id: 'keep', minTtc: 0.4 },
        { id: 'brake', minTtc: 1.5 },
      ],
    } as unknown as Extract<FromWorker, { type: 'decision' }>['report'];
    worker.emit({ type: 'decision', report, stepMs: 4.2 });
    expect(store.telemetry.decisionTime).toEqual([0.05]);
    expect(store.telemetry.ttc).toEqual([1.5]);
    expect(store.telemetry.stepMs).toEqual([4.2]);
    worker.emit(ready());
    expect(store.telemetry.time).toEqual([]);
    expect(store.telemetry.ttc).toEqual([]);
  });

  it('forgets the run before it when a new one is ready', () => {
    const { worker, store } = setup();
    worker.emit(ready());
    worker.emit({ type: 'event', event: { kind: 'end', tick: 8000 } });
    worker.emit(frame(8000, FLAG.DONE));
    worker.emit({ type: 'event', event: { kind: 'reset' } });
    worker.emit(ready());
    expect(store.getSnapshot()).toMatchObject({ events: [], metrics: null, readout: null, done: false });
  });
});

describe('the events', () => {
  it('log the run and keep the last ones, with slow motion and the reset kept out of the log', () => {
    const { worker, store } = setup();
    worker.emit(ready());
    worker.emit({ type: 'event', event: { kind: 'trigger', tick: 2945, obstacle: 'pedestrian', vehicle: 'ego' } });
    worker.emit({ type: 'event', event: { kind: 'slowMotion', rate: 0.4 } });
    expect(store.getSnapshot().slowMotion).toBe(0.4);
    worker.emit({ type: 'event', event: { kind: 'realTime' } });
    worker.emit({ type: 'event', event: { kind: 'reset' } });
    expect(store.getSnapshot().slowMotion).toBeNull();
    expect(store.getSnapshot().events.map((e) => e.event.kind)).toEqual(['trigger']);
    for (let i = 0; i < EVENT_LOG_MAX + 5; i++) worker.emit({ type: 'event', event: { kind: 'end', tick: i } });
    const events = store.getSnapshot().events;
    expect(events).toHaveLength(EVENT_LOG_MAX);
    expect(new Set(events.map((e) => e.id)).size).toBe(EVENT_LOG_MAX);
  });
});

describe('the errors', () => {
  it('drop the run only when the worker says internal; a refusal leaves it as it was', () => {
    const { worker, store } = setup();
    worker.emit(ready());
    worker.emit({ type: 'error', code: 'config', message: 'The horizon must be from 8 to 20' });
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', notice: { code: 'config' }, error: null });
    store.reset();
    expect(store.getSnapshot().notice).toBeNull();
    worker.emit({ type: 'error', code: 'internal', message: 'Non-finite driver command' });
    expect(store.getSnapshot()).toMatchObject({ status: 'error', error: { code: 'internal' }, playing: false });
    // Reset starts again, and the worker's `ready` clears the error.
    store.reset();
    worker.emit(ready());
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', error: null });
  });

  it('take a worker that crashes to the error state, and a disposed store lets go of the worker', () => {
    const { worker, store } = setup();
    worker.onerror?.({ message: 'Script error' } as ErrorEvent);
    expect(store.getSnapshot()).toMatchObject({ status: 'error', error: { code: 'crash', message: 'Script error' } });
    store.dispose();
    expect(worker.terminated).toBe(true);
    expect(worker.onmessage).toBeNull();
  });
});
