/**
 * The worker protocol (Phase 4; CLAUDE.md §8): the typed messages between the app's main thread and the
 * simulation worker, and the layout of a frame. PROTOCOL_VERSION names them: a change of any message, field or frame
 * layout bumps it on both sides in the same change, and `init` from another version is refused.
 *
 * To the worker: `init` (a scenario, a seed, a configuration), `control` (play, pause, step one control cycle, reset),
 * `setSpeed` (the playback rate), `setParams` (a new configuration: the run starts again), `runBatch` (runs to the end
 * without frames), `exportCsv`, `returnBuffer` (a frame's buffer back to the pool). From the worker: `ready`, `frame`
 * (a transferred Float64Array, FRAME layout), `decision` (each control cycle of the decision layer), `event`,
 * `metrics` (at the end of a run, after its last frame), `csv`, `error`. A message the worker refuses (an error)
 * changes nothing: the run, its configuration and the batch in progress stay as they were. A run that breaks on the
 * way (the core throws) is dropped with an `internal` error: the live one until `reset`, `setParams` or `init`, a
 * batch's with its batch, whose id the error carries.
 *
 * Only the configuration, the scenario and the seed change a result; the playback rate, pauses and steps change the
 * pacing alone, so a run played live and the same run in a batch give the same fingerprint (M6).
 */
import type { BranchId, DecisionReport, MpcSettings, RunEvent, RunMetrics } from '@mpc-simulator/core';

export const PROTOCOL_VERSION = 1;

/** What changes a run's result, besides the scenario and the seed: recorded with the run (CLAUDE.md §8). */
export interface SessionConfig {
  /** The ego: the MPC with the decision layer, or the single-maneuver MPC of M4 braking in its lane. */
  readonly controller: 'decision' | 'stop';
  /** Stages of the MPC's horizon: the first 6 of 50 ms, the others of 150 ms (200 ms for the truck). */
  readonly horizon: number;
  /** The decision layer's candidate maneuvers, `keep` always among them. */
  readonly maneuvers: readonly BranchId[];
  /** The MPC's Bryson scales over its defaults. */
  readonly scales: Partial<MpcSettings['scales']>;
  /** Computation delay the MPC compensates, ticks: a configuration, never a measured time. */
  readonly delayTicks: number;
  /** The object sensor's noise σ instead of the scenario's: position on s and e_y, m; velocity, m/s. */
  readonly noise?: { readonly position: number; readonly velocity: number };
  /** The scenario's initial and reference speed, km/h, instead of its own. */
  readonly speedKmh?: number;
  /** Trigger distances, m, by obstacle id, instead of the scenario's. */
  readonly triggerDistance?: Readonly<Record<string, number>>;
  /** The baseline controller as a ghost, in lockstep in its own copy of the world. */
  readonly ghost: boolean;
}

export const DEFAULT_CONFIG: SessionConfig = {
  controller: 'decision',
  horizon: 20,
  maneuvers: ['keep', 'brake', 'left', 'right'],
  scales: {},
  delayTicks: 50,
  ghost: true,
};

/**
 * The mobile preset: the full horizon, the decision layer without `right`, one candidate fewer to solve each
 * cycle. In the v1 scenarios `right` is never the maneuver chosen, so a run with the preset is the run with all four.
 */
export const MOBILE_CONFIG: Partial<SessionConfig> = { maneuvers: ['keep', 'brake', 'left'] };

/** The shortest and the longest horizon a configuration may ask for, stages. */
export const HORIZON_RANGE = { min: 8, max: 20 } as const;

/** A run of a batch: the scenario as JSON (validated in the worker), its seed and configuration. */
export interface BatchRun {
  readonly scenario: unknown;
  readonly seed: number;
  readonly config?: Partial<SessionConfig>;
}

export type ToWorker =
  | {
      readonly type: 'init';
      readonly version: number;
      readonly scenario: unknown;
      readonly seed: number;
      readonly config?: Partial<SessionConfig>;
    }
  | { readonly type: 'control'; readonly action: 'play' | 'pause' | 'step' | 'reset' }
  | { readonly type: 'setSpeed'; readonly rate: number }
  | { readonly type: 'setParams'; readonly config: Partial<SessionConfig> }
  /**
   * Runs to their end without frames, one per turn, each answered by its metrics with the batch's `id` (the page's).
   * A batch pauses the live run and replaces the one in progress; an empty one just stops it. One with a run that
   * cannot start is refused whole, before any run.
   */
  | { readonly type: 'runBatch'; readonly id: number; readonly runs: readonly BatchRun[] }
  | { readonly type: 'exportCsv' }
  | { readonly type: 'returnBuffer'; readonly buffer: ArrayBuffer };

/** The scene a view draws, sent once with `ready`. */
export interface SceneInfo {
  readonly scenario: string;
  readonly ticks: number;
  /**
   * The vehicle's size, m, and where its body is: `bodyOffset` m ahead of VEHICLE.X, VEHICLE.Y (the center of
   * gravity) along the heading, where the core tests contacts.
   */
  readonly vehicle: {
    readonly id: string;
    readonly length: number;
    readonly width: number;
    readonly track: number;
    readonly bodyOffset: number;
  };
  /** The road's line every ROAD_SAMPLE_STEP m: ROAD_SAMPLE values per point (s, x, y, heading, curvature). */
  readonly road: Float64Array;
  /** The road's edges from its line, m (left positive). */
  readonly width: { readonly left: number; readonly right: number };
  readonly lane: { readonly center: number; readonly width: number };
  /** The base surface and the zones over it, with their friction coefficient. */
  readonly surface: {
    readonly base: { readonly id: string; readonly mu: number };
    readonly zones: readonly {
      readonly from: number;
      readonly to: number;
      readonly side: 'both' | 'left' | 'right';
      readonly id: string;
      readonly mu: number;
    }[];
  };
  readonly obstacles: readonly {
    readonly id: string;
    readonly kind: string;
    readonly length: number;
    readonly width: number;
  }[];
  /** The frame's sizes for this run: FRAME layout. */
  readonly frame: FrameLayout;
}

export const ROAD_SAMPLE_STEP = 1;
export const ROAD_SAMPLE = 5;

/**
 * A vehicle's block in a frame, and a telemetry row: the core's RUN_RECORD layout, named here so that the main thread
 * reads frames without the core (session.test.ts checks that the two agree). SI units: m, rad, m/s, rad/s, m/s². X and
 * Y are the center of gravity (SceneInfo.vehicle.bodyOffset places the body). A telemetry row is one tick throughout.
 * In a frame's block the plant (X to R, STEER, AX, AY) is at FRAME.TICK, while TICK, S, EY and the commands are those
 * of the last tick observed: one earlier while the vehicle runs, since the plant steps after it is observed.
 */
export const VEHICLE = {
  TICK: 0,
  X: 1,
  Y: 2,
  PSI: 3,
  VX: 4,
  VY: 5,
  R: 6,
  S: 7,
  EY: 8,
  /** Actual road-wheel angle, rad. */
  STEER: 9,
  /** Command in force: steering, rad, and acceleration, m/s². */
  STEER_CMD: 10,
  ACCEL_CMD: 11,
  AX: 12,
  AY: 13,
} as const;
export const VEHICLE_SIZE = 14;
/**
 * An obstacle's block: x, y, heading, s, e_y, detected (1 when the ego's sensor tracks it). It is the ego's copy of the
 * obstacle: the ghost meets its own, triggered by its own progress, which frames do not carry.
 */
export const OBSTACLE = { X: 0, Y: 1, HEADING: 2, S: 3, EY: 4, DETECTED: 5 } as const;
export const OBSTACLE_SIZE = 6;
/**
 * A candidate plan's header: solved this cycle, feasible, chosen (1 or 0; feasible is NaN for the single-maneuver MPC
 * of the stop controller, which has no such check); then its points, x and y each.
 */
export const PLAN = { SOLVED: 0, FEASIBLE: 1, CHOSEN: 2 } as const;
export const PLAN_HEADER = 3;
/** The candidates a frame carries, in B0–B3 order. */
export const PLANS = 4;
/** The most telemetry rows (100 Hz records) per vehicle in one frame; the rest follow in the next frames. */
export const TELEMETRY_MAX = 32;

/** The fixed header of a frame. */
export const FRAME = {
  VERSION: 0,
  /** The tick the frame shows: the next to simulate while the run goes, its last state's once it is over. */
  TICK: 1,
  /** The real-time factor achieved over the last second of play (simulated over wall-clock time); 0 while paused. */
  RATE: 2,
  /** Bit flags, FLAG. */
  FLAGS: 3,
  /** Telemetry rows of the ego and of the ghost in this frame. */
  EGO_ROWS: 4,
  GHOST_ROWS: 5,
} as const;
export const FRAME_HEADER = 6;
export const FLAG = { DONE: 1, EGO_ENDED: 2, GHOST_ENDED: 4, GHOST: 8, PLAYING: 16 } as const;

/** Where each block of a frame starts, for a run's obstacle count and horizon. */
export interface FrameLayout {
  readonly ego: number;
  readonly ghost: number;
  readonly obstacles: number;
  readonly obstacleCount: number;
  readonly plans: number;
  /** Points per plan: the horizon's stages plus its start. */
  readonly planPoints: number;
  readonly planSize: number;
  readonly egoTelemetry: number;
  readonly ghostTelemetry: number;
  readonly length: number;
}

export function frameLayout(obstacleCount: number, horizon: number): FrameLayout {
  const ego = FRAME_HEADER;
  const ghost = ego + VEHICLE_SIZE;
  const obstacles = ghost + VEHICLE_SIZE;
  const plans = obstacles + obstacleCount * OBSTACLE_SIZE;
  const planPoints = horizon + 1;
  const planSize = PLAN_HEADER + 2 * planPoints;
  const egoTelemetry = plans + PLANS * planSize;
  const ghostTelemetry = egoTelemetry + TELEMETRY_MAX * VEHICLE_SIZE;
  const length = ghostTelemetry + TELEMETRY_MAX * VEHICLE_SIZE;
  return { ego, ghost, obstacles, obstacleCount, plans, planPoints, planSize, egoTelemetry, ghostTelemetry, length };
}

/**
 * What a session reports beside the frames: the run's events, in tick order (the ego's first at the same tick) however
 * the run is paced, and the pacing's notices. `end` comes last, at the tick of the run's last state.
 */
export type SessionEvent =
  | (RunEvent & { readonly vehicle: 'ego' | 'ghost' })
  | { readonly kind: 'end'; readonly tick: number }
  | { readonly kind: 'reset' }
  /** The simulation cannot keep up with the playback rate: it runs at `rate` instead (automatic slow motion). */
  | { readonly kind: 'slowMotion'; readonly rate: number }
  | { readonly kind: 'realTime' };

export interface VehicleSummary {
  /** How the vehicle's run ended; `running` in metrics read before its end. */
  readonly end: 'duration' | 'collision' | 'roadEnd' | 'running';
  readonly ticks: number;
  readonly metrics: RunMetrics;
  /** vehicleFingerprint of the core: what a CSV read back is checked against (M8). */
  readonly fingerprint: string;
}

export interface SessionMetrics {
  readonly scenario: string;
  readonly seed: number;
  readonly config: SessionConfig;
  /** The run's fingerprint, ego and ghost together: the same for the live run and its replay (M6). */
  readonly fingerprint: string;
  readonly ego: VehicleSummary;
  readonly ghost: VehicleSummary | null;
  /** The run's batch (the id `runBatch` gave) and its place in it; absent for the live run. */
  readonly batch?: { readonly id: number; readonly index: number; readonly total: number };
}

export type ErrorCode = 'version' | 'scenario' | 'config' | 'state' | 'internal';

export type FromWorker =
  | {
      readonly type: 'ready';
      readonly version: number;
      readonly seed: number;
      readonly config: SessionConfig;
      readonly scene: SceneInfo;
    }
  | { readonly type: 'frame'; readonly buffer: ArrayBuffer }
  /** A control cycle of the decision layer, with the time its step took, ms (measured; it changes nothing). */
  | { readonly type: 'decision'; readonly report: DecisionReport; readonly stepMs: number }
  | { readonly type: 'event'; readonly event: SessionEvent }
  | { readonly type: 'metrics'; readonly metrics: SessionMetrics }
  | { readonly type: 'csv'; readonly filename: string; readonly text: string }
  /** A message refused, or a run broken on the way; `batch` names the batch run that broke. */
  | {
      readonly type: 'error';
      readonly code: ErrorCode;
      readonly message: string;
      readonly batch?: { readonly id: number; readonly index: number };
    };
