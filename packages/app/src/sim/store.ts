/**
 * The app's side of the worker protocol (Phase 4): sends the commands, receives the messages,
 * and keeps what the screens show. It never computes physics or control. Two rates of change are kept apart:
 *
 * - `frame` is one mutable FrameView, overwritten at about 60 Hz and read by the canvas in its own animation loop: a
 *   frame is copied out of its buffer, and the buffer goes back to the worker at once (`returnBuffer`, transferred);
 * - the snapshot (`subscribe` and `getSnapshot`, for React's `useSyncExternalStore`) is replaced only when something
 *   the panels show changes, and its readout and decision at most every PANEL_MS while the run plays.
 *
 * It knows the worker only through WorkerPort, so Node tests drive it with a stand-in.
 */
import {
  PROTOCOL_VERSION,
  type ErrorCode,
  type FrameLayout,
  type FromWorker,
  type SceneInfo,
  type SessionConfig,
  type SessionEvent,
  type SessionMetrics,
  type ToWorker,
} from '@mpc-simulator/worker';

import { createFrameView, isFrameOf, readFrame, readoutOf, type FrameView, type Readout } from './frame.ts';
import { Telemetry } from './telemetry.ts';

/** What the store needs of a Worker. */
export interface WorkerPort {
  postMessage(message: ToWorker, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export type DecisionReport = Extract<FromWorker, { type: 'decision' }>['report'];

export interface LoggedEvent {
  /** A running number, for a list's keys. */
  readonly id: number;
  readonly event: SessionEvent;
}

export interface Snapshot {
  /** `loading` until the worker answers its first `init`; `error` when the run is dropped or the worker crashed. */
  readonly status: 'loading' | 'ready' | 'error';
  readonly error: { readonly code: ErrorCode | 'crash'; readonly message: string } | null;
  /** A message the worker refused: the run is as it was. */
  readonly notice: { readonly code: ErrorCode; readonly message: string } | null;
  readonly scene: SceneInfo | null;
  readonly config: SessionConfig | null;
  readonly scenarioId: string | null;
  readonly seed: number;
  readonly playing: boolean;
  readonly done: boolean;
  /** The playback rate asked for: 1 is real time. */
  readonly speed: number;
  /** The rate the simulation achieves while it cannot keep up (automatic slow motion); null otherwise. */
  readonly slowMotion: number | null;
  readonly readout: Readout | null;
  readonly decision: { readonly report: DecisionReport; readonly stepMs: number } | null;
  readonly events: readonly LoggedEvent[];
  readonly metrics: SessionMetrics | null;
}

/** The slowest the panels update while the run plays, ms. */
export const PANEL_MS = 100;
/** Events kept for the log. */
export const EVENT_LOG_MAX = 200;

const INITIAL: Snapshot = {
  status: 'loading',
  error: null,
  notice: null,
  scene: null,
  config: null,
  scenarioId: null,
  seed: 1,
  playing: false,
  done: false,
  speed: 1,
  slowMotion: null,
  readout: null,
  decision: null,
  events: [],
  metrics: null,
};

export class SimulationStore {
  /** The frame now, read by the canvas; null before the first `ready`. */
  frame: FrameView | null = null;
  /** Counts the frames read (and the runs begun): the canvas redraws when it changes. */
  frameSeq = 0;
  /** The run's history, for the charts: mutable like `frame`, read by the charts in their own loop. */
  readonly telemetry = new Telemetry();

  private snapshot: Snapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly port: WorkerPort;
  private readonly now: () => number;
  private layout: FrameLayout | null = null;
  private pending: Snapshot['decision'] = null;
  private lastPanel = Number.NEGATIVE_INFINITY;
  private eventId = 0;

  constructor(port: WorkerPort, now: () => number = () => performance.now()) {
    this.port = port;
    this.now = now;
    port.onmessage = (event) => this.receive(event.data);
    port.onerror = (event) => this.update({ status: 'error', error: { code: 'crash', message: event.message } });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  // Commands. Each one is a message: the answer comes back as frames and events, never as a return value.

  /** Starts a scenario: `json` is the scenario file as it is, validated in the worker. */
  start(id: string, json: unknown, seed = this.snapshot.seed, config: Partial<SessionConfig> = {}): void {
    this.update({ scenarioId: id, seed, notice: null });
    this.post({ type: 'init', version: PROTOCOL_VERSION, scenario: json, seed, config });
  }

  play(): void {
    this.post({ type: 'control', action: 'play' });
  }

  pause(): void {
    this.post({ type: 'control', action: 'pause' });
  }

  /** One control cycle (50 ms of simulated time). */
  step(): void {
    this.post({ type: 'control', action: 'step' });
  }

  /** The run again from its start; the way out of an error that dropped it (the `ready` that answers clears it). */
  reset(): void {
    this.update({ notice: null });
    this.post({ type: 'control', action: 'reset' });
  }

  setSpeed(rate: number): void {
    this.update({ speed: rate });
    this.post({ type: 'setSpeed', rate });
  }

  /** New parameters: the run starts again. */
  setParams(config: Partial<SessionConfig>): void {
    this.update({ notice: null });
    this.post({ type: 'setParams', config });
  }

  dispose(): void {
    this.port.onmessage = null;
    this.port.onerror = null;
    this.port.terminate();
    this.listeners.clear();
  }

  private post(message: ToWorker, transfer: Transferable[] = []): void {
    this.port.postMessage(message, transfer);
  }

  private update(patch: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private receive(message: FromWorker): void {
    switch (message.type) {
      case 'ready':
        this.layout = message.scene.frame;
        this.frame = createFrameView(message.scene.frame);
        this.frameSeq++;
        this.telemetry.clear();
        this.pending = null;
        this.lastPanel = Number.NEGATIVE_INFINITY;
        this.update({
          status: 'ready',
          error: null,
          notice: null,
          scene: message.scene,
          config: message.config,
          seed: message.seed,
          playing: false,
          done: false,
          slowMotion: null,
          readout: null,
          decision: null,
          events: [],
          metrics: null,
        });
        return;
      case 'frame':
        this.receiveFrame(message.buffer);
        return;
      case 'decision': {
        const { report, stepMs } = message;
        this.pending = { report, stepMs };
        const inForce = report.candidates.find((candidate) => candidate.id === report.chosen);
        this.telemetry.addDecision(report.tick, inForce?.minTtc ?? null, stepMs);
        return;
      }
      case 'event':
        this.receiveEvent(message.event);
        return;
      case 'metrics':
        this.update({ metrics: message.metrics });
        return;
      case 'csv':
        return;
      case 'error':
        if (message.code === 'internal') {
          this.update({ status: 'error', error: { code: message.code, message: message.message }, playing: false });
        } else {
          this.update({ notice: { code: message.code, message: message.message } });
        }
        return;
    }
  }

  private receiveFrame(buffer: ArrayBuffer): void {
    const view = this.frame;
    const layout = this.layout;
    const data = new Float64Array(buffer);
    if (view && layout && isFrameOf(data, layout)) {
      readFrame(data, layout, view);
      this.telemetry.readFrame(data, layout);
      this.frameSeq++;
      const t = this.now();
      const flags = view.playing !== this.snapshot.playing || view.done !== this.snapshot.done;
      // While the run plays the panels follow at PANEL_MS; a paused or finished run shows every frame it gets.
      if (flags || !view.playing || t - this.lastPanel >= PANEL_MS) {
        this.lastPanel = t;
        this.update({
          playing: view.playing,
          done: view.done,
          readout: readoutOf(view),
          decision: this.pending ?? this.snapshot.decision,
        });
      }
    }
    // The buffer goes back whatever it held: the worker pool drops one of another run's size.
    this.post({ type: 'returnBuffer', buffer }, [buffer]);
  }

  private receiveEvent(event: SessionEvent): void {
    if (event.kind === 'slowMotion') this.update({ slowMotion: event.rate });
    else if (event.kind === 'realTime') this.update({ slowMotion: null });
    else if (event.kind !== 'reset') {
      const events = [...this.snapshot.events, { id: this.eventId++, event }].slice(-EVENT_LOG_MAX);
      this.update({ events });
    }
  }
}
