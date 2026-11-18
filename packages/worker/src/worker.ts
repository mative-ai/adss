/**
 * The simulation worker (Phase 4): the protocol's endpoint (protocol.ts) in a module worker. It holds
 * one live run, paces it with a Pacer while playing, and posts what the session reports: a frame about 60 times a
 * second (when the main thread has returned a buffer), each decision, each event, and the metrics after the run's last
 * frame. A turn of the loop starts no chunk of CHUNK ticks after BUDGET_MS, then yields, so `pause`, `returnBuffer`
 * and the rest are read in between: a turn lasts BUDGET_MS plus at most a chunk, and with it one step of the MPC.
 * Measured time only paces the run (CLAUDE.md §8).
 *
 * A frame skipped because the main thread holds every buffer is owed: while playing the next turn sends it, otherwise
 * the next buffer that comes back. So the page always ends up with the run's last state and every telemetry row, and
 * the metrics come once the last row is out. A live run that breaks on the way (the core throws) is dropped with an
 * `internal` error; `reset`, `setParams` and `init` start again.
 */
import { ScenarioError } from '@mpc-simulator/core';

import { runToCsv } from './csv.ts';
import { FrameCadence, Pacer } from './pacer.ts';
import { BufferPool } from './pool.ts';
import {
  PROTOCOL_VERSION,
  type BatchRun,
  type ErrorCode,
  type FromWorker,
  type SessionConfig,
  type ToWorker,
} from './protocol.ts';
import { checkRun, ConfigError, runSession, SimulationSession } from './session.ts';

/** Wall time per turn of the loop after which no chunk starts, ms. */
const BUDGET_MS = 12;
/** Wall time between frames, ms: about 60 Hz. */
const FRAME_MS = 1000 / 60;
/** Ticks simulated between two looks at the clock. */
const CHUNK = 10;
/** Wall time between turns while playing, ms. */
const TURN_MS = 4;

/** What a run is built from: the scenario as given, the seed, the configuration asked for. */
interface Source {
  readonly scenario: unknown;
  readonly seed: number;
  readonly config: Partial<SessionConfig>;
}

const now = () => performance.now();
const pacer = new Pacer();
const cadence = new FrameCadence(FRAME_MS, TURN_MS / 2);
let source: Source | undefined;
let session: SimulationSession | undefined;
let pool: BufferPool | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
/** The page lacks the run's latest state or some of its telemetry rows: a frame is owed. */
let owed = false;
/** The run is over, and its metrics wait for its last frame. */
let ending = false;
/** Batches started so far: a batch goes on while it is the last one. */
let batches = 0;

function post(message: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

/** A message that needs a run or a scenario before it. */
class StateError extends Error {}
/** A message from a page that speaks another protocol: another version, or a message or an action this one lacks. */
class VersionError extends Error {}

function codeOf(error: unknown): ErrorCode {
  if (error instanceof VersionError) return 'version';
  if (error instanceof ScenarioError) return 'scenario';
  if (error instanceof ConfigError || error instanceof RangeError) return 'config';
  if (error instanceof StateError) return 'state';
  return 'internal';
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function fail(error: unknown): void {
  post({ type: 'error', code: codeOf(error), message: messageOf(error) });
}

function stop(): void {
  pacer.pause();
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}

/** The live run broke on the way: it is dropped (its source stays, for reset and new parameters). */
function broken(error: unknown): void {
  stop();
  session = undefined;
  pool = undefined;
  owed = false;
  ending = false;
  post({ type: 'error', code: 'internal', message: messageOf(error) });
}

/** The frame of the run now, if a buffer is free (else it is owed); after the run's last one, its metrics. */
function sendFrame(): void {
  const s = session;
  if (!s || !pool) return;
  const buffer = pool.take();
  if (!buffer) {
    owed = true;
    return;
  }
  s.writeFrame(new Float64Array(buffer), pacer.isPlaying ? pacer.achievedRate : 0, pacer.isPlaying);
  owed = s.unsentRows > 0;
  cadence.sent(now());
  post({ type: 'frame', buffer }, [buffer]);
  if (ending && !owed) {
    ending = false;
    post({ type: 'metrics', metrics: s.metrics() });
  }
}

/** A new run of `next`: the first one, a reset, or new parameters. One that cannot run is refused before any change. */
function start(next: Source): void {
  const s = new SimulationSession(next.scenario, next.seed, next.config);
  stop();
  pacer.reset();
  source = next;
  session = s;
  pool = new BufferPool(s.layout.length * Float64Array.BYTES_PER_ELEMENT);
  owed = false;
  ending = false;
  post({ type: 'ready', version: PROTOCOL_VERSION, seed: s.seed, config: s.config, scene: s.scene() });
  sendFrame();
}

function origin(): Source {
  if (!source) throw new StateError('No scenario yet: send init first');
  return source;
}

function current(): SimulationSession {
  if (!session) throw new StateError('No run: send init, or after an error reset or new parameters');
  return session;
}

function flush(s: SimulationSession): void {
  for (const d of s.takeDecisions()) post({ type: 'decision', report: d.report, stepMs: d.stepMs });
  for (const event of s.takeEvents()) post({ type: 'event', event });
}

/** The run is over: its last frame, then its metrics. */
function finish(): void {
  stop();
  ending = true;
  sendFrame();
}

function pause(): void {
  stop();
  sendFrame();
}

function schedule(): void {
  if (timer === undefined) timer = setTimeout(turn, TURN_MS);
}

function turn(): void {
  timer = undefined;
  const s = session;
  if (!s || !pacer.isPlaying) return;
  const begin = now();
  const due = pacer.due(begin);
  let ticks = 0;
  try {
    while (ticks < due && !s.done && now() - begin < BUDGET_MS) ticks += s.advance(Math.min(CHUNK, due - ticks));
  } catch (error) {
    broken(error);
    return;
  }
  const notice = pacer.settle(ticks);
  flush(s);
  if (notice === 'slowMotion') post({ type: 'event', event: { kind: 'slowMotion', rate: pacer.achievedRate } });
  if (notice === 'realTime') post({ type: 'event', event: { kind: 'realTime' } });
  if (s.done) {
    finish();
    return;
  }
  if (cadence.due(now())) sendFrame();
  schedule();
}

function control(action: string): void {
  // A reset needs only the run's source: it also starts again a run that broke.
  if (action === 'reset') {
    post({ type: 'event', event: { kind: 'reset' } });
    start(origin());
    return;
  }
  const s = current();
  switch (action) {
    case 'play':
      if (s.done) return;
      pacer.play(now());
      schedule();
      return;
    case 'pause':
      pause();
      return;
    case 'step':
      if (s.done) return;
      stop();
      try {
        s.stepCycle();
      } catch (error) {
        broken(error);
        return;
      }
      flush(s);
      if (s.done) finish();
      else sendFrame();
      return;
    default:
      throw new VersionError(`Unknown control: ${action}`);
  }
}

/**
 * A batch: its runs to their end, one per turn so that messages are read in between, each answered by its metrics.
 * It pauses the live run and replaces the batch in progress; a run that cannot start refuses it whole, before any run.
 */
function startBatch(id: number, runs: readonly BatchRun[]): void {
  for (const run of runs) checkRun(run.scenario, run.seed, run.config);
  const generation = ++batches;
  if (runs.length > 0 && pacer.isPlaying) pause();
  const next = (index: number) => {
    const run = runs[index];
    if (generation !== batches || !run) return;
    try {
      post({
        type: 'metrics',
        metrics: runSession(run.scenario, run.seed, run.config).metrics({ id, index, total: runs.length }),
      });
    } catch (error) {
      // A run that breaks on the way (its configuration was checked) ends its batch.
      post({ type: 'error', code: 'internal', message: messageOf(error), batch: { id, index } });
      return;
    }
    setTimeout(() => next(index + 1), 0);
  };
  setTimeout(() => next(0), 0);
}

function handle(message: ToWorker): void {
  switch (message.type) {
    case 'init':
      if (message.version !== PROTOCOL_VERSION) {
        throw new VersionError(`The page speaks protocol ${message.version}, the worker ${PROTOCOL_VERSION}`);
      }
      start({ scenario: message.scenario, seed: message.seed, config: message.config ?? {} });
      return;
    case 'control':
      control(message.action);
      return;
    case 'setSpeed':
      pacer.setRate(message.rate);
      return;
    case 'setParams': {
      const from = origin();
      start({ ...from, config: { ...from.config, ...message.config } });
      return;
    }
    case 'runBatch':
      startBatch(message.id, message.runs);
      return;
    case 'exportCsv': {
      const s = current();
      post({ type: 'csv', filename: `${s.scenario.id}-seed${s.seed}.csv`, text: runToCsv(s) });
      return;
    }
    case 'returnBuffer':
      pool?.give(message.buffer);
      if (owed && !pacer.isPlaying) sendFrame();
      return;
    default:
      throw new VersionError(`Unknown message: ${String((message as { type?: unknown }).type)}`);
  }
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  try {
    handle(event.data);
  } catch (error) {
    fail(error);
  }
};
