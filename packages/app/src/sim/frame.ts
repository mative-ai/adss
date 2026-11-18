/**
 * A frame of the worker (Phase 4) read into plain values the views draw from. The main thread copies
 * what it needs out of the transferred buffer and gives the buffer back at once (worker protocol), so a view never holds
 * a frame's memory. One FrameView lives for a run (its sizes come from the run's layout) and is overwritten by each
 * frame: no allocation at 60 Hz. SI units, as in the protocol; km/h, degrees and g appear only in `readoutOf`.
 */
import {
  FLAG,
  FRAME,
  OBSTACLE,
  OBSTACLE_SIZE,
  PLAN,
  PLAN_HEADER,
  PLANS,
  VEHICLE,
  type FrameLayout,
} from '@mpc-simulator/worker';

/** A vehicle's state in a frame: the center of gravity, the road coordinates, the steering and the accelerations. */
export interface VehicleView {
  x: number;
  y: number;
  psi: number;
  vx: number;
  vy: number;
  r: number;
  s: number;
  ey: number;
  /** Actual road-wheel angle, rad. */
  steer: number;
  ax: number;
  ay: number;
}

export interface ObstacleView {
  x: number;
  y: number;
  heading: number;
  s: number;
  ey: number;
  /** The ego's sensor tracks it. */
  detected: boolean;
}

/** A candidate maneuver's plan of the last control cycle, in world coordinates (x, y pairs). */
export interface PlanView {
  solved: boolean;
  /** `null` where the controller has no such check (the single-maneuver MPC). */
  feasible: boolean | null;
  chosen: boolean;
  points: Float64Array;
}

export interface FrameView {
  tick: number;
  /** The real-time factor achieved over the last second of play; 0 while paused. */
  rate: number;
  playing: boolean;
  done: boolean;
  egoEnded: boolean;
  ghostEnded: boolean;
  hasGhost: boolean;
  ego: VehicleView;
  ghost: VehicleView;
  obstacles: ObstacleView[];
  /** In B0–B3 order: keep, brake, left, right. */
  plans: PlanView[];
}

const vehicleView = (): VehicleView => ({
  x: 0,
  y: 0,
  psi: 0,
  vx: 0,
  vy: 0,
  r: 0,
  s: 0,
  ey: 0,
  steer: 0,
  ax: 0,
  ay: 0,
});

export function createFrameView(layout: FrameLayout): FrameView {
  return {
    tick: 0,
    rate: 0,
    playing: false,
    done: false,
    egoEnded: false,
    ghostEnded: false,
    hasGhost: false,
    ego: vehicleView(),
    ghost: vehicleView(),
    obstacles: Array.from({ length: layout.obstacleCount }, () => ({
      x: 0,
      y: 0,
      heading: 0,
      s: 0,
      ey: 0,
      detected: false,
    })),
    plans: Array.from({ length: PLANS }, () => ({
      solved: false,
      feasible: null,
      chosen: false,
      points: new Float64Array(2 * layout.planPoints),
    })),
  };
}

function readVehicle(data: Float64Array, at: number, v: VehicleView): void {
  v.x = data[at + VEHICLE.X] ?? 0;
  v.y = data[at + VEHICLE.Y] ?? 0;
  v.psi = data[at + VEHICLE.PSI] ?? 0;
  v.vx = data[at + VEHICLE.VX] ?? 0;
  v.vy = data[at + VEHICLE.VY] ?? 0;
  v.r = data[at + VEHICLE.R] ?? 0;
  v.s = data[at + VEHICLE.S] ?? 0;
  v.ey = data[at + VEHICLE.EY] ?? 0;
  v.steer = data[at + VEHICLE.STEER] ?? 0;
  v.ax = data[at + VEHICLE.AX] ?? 0;
  v.ay = data[at + VEHICLE.AY] ?? 0;
}

/** Whether a buffer is a frame of a run with this layout (a buffer of another run's size is not). */
export const isFrameOf = (data: Float64Array, layout: FrameLayout): boolean => data.length === layout.length;

/** Copies a frame's header, vehicles, obstacles and plans into `view`; the telemetry rows are not read here. */
export function readFrame(data: Float64Array, layout: FrameLayout, view: FrameView): void {
  const flags = data[FRAME.FLAGS] ?? 0;
  view.tick = data[FRAME.TICK] ?? 0;
  view.rate = data[FRAME.RATE] ?? 0;
  view.playing = (flags & FLAG.PLAYING) !== 0;
  view.done = (flags & FLAG.DONE) !== 0;
  view.egoEnded = (flags & FLAG.EGO_ENDED) !== 0;
  view.ghostEnded = (flags & FLAG.GHOST_ENDED) !== 0;
  view.hasGhost = (flags & FLAG.GHOST) !== 0;
  readVehicle(data, layout.ego, view.ego);
  if (view.hasGhost) readVehicle(data, layout.ghost, view.ghost);
  view.obstacles.forEach((o, i) => {
    const at = layout.obstacles + i * OBSTACLE_SIZE;
    o.x = data[at + OBSTACLE.X] ?? 0;
    o.y = data[at + OBSTACLE.Y] ?? 0;
    o.heading = data[at + OBSTACLE.HEADING] ?? 0;
    o.s = data[at + OBSTACLE.S] ?? 0;
    o.ey = data[at + OBSTACLE.EY] ?? 0;
    o.detected = data[at + OBSTACLE.DETECTED] === 1;
  });
  view.plans.forEach((plan, b) => {
    const at = layout.plans + b * layout.planSize;
    const feasible = data[at + PLAN.FEASIBLE] ?? Number.NaN;
    plan.solved = data[at + PLAN.SOLVED] === 1;
    plan.feasible = Number.isNaN(feasible) ? null : feasible === 1;
    plan.chosen = data[at + PLAN.CHOSEN] === 1;
    plan.points.set(data.subarray(at + PLAN_HEADER, at + layout.planSize));
  });
}

/** The values a panel shows, in the units people read: km/h, degrees, g, seconds, meters. */
export interface Readout {
  time: number;
  speedKmh: number;
  steerDeg: number;
  axG: number;
  ayG: number;
  /** Distance along the road, m. */
  s: number;
  /** The ghost's speed, km/h; null without a ghost. */
  ghostSpeedKmh: number | null;
}

/** Standard gravity, m/s²: accelerations are shown in g. */
export const G = 9.81;
/** Ticks per second of simulated time. */
export const TICK_HZ = 1000;

export function readoutOf(view: FrameView): Readout {
  const { ego, ghost } = view;
  return {
    time: view.tick / TICK_HZ,
    speedKmh: Math.hypot(ego.vx, ego.vy) * 3.6,
    steerDeg: (ego.steer * 180) / Math.PI,
    axG: ego.ax / G,
    ayG: ego.ay / G,
    s: ego.s,
    ghostSpeedKmh: view.hasGhost ? Math.hypot(ghost.vx, ghost.vy) * 3.6 : null,
  };
}
