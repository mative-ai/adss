/**
 * Metrics of one vehicle's scenario run (Phase 3), in SI units, measured on the true world (not
 * on what the sensor reported). The scenario run feeds the tracker once per tick; solver times are measured by
 * the CLI, never in the core (AGENTS.md §5).
 *
 * - TTC: gap along the road from the body's front to the rear of an obstacle ahead whose e_y extent overlaps
 *   the body's at that tick, divided by the closing speed; the minimum over the run (null if never closing).
 * - Stopping distance: path length from the first strong braking command (≤ STRONG_BRAKE) to the first tick
 *   below STANDSTILL; null without strong braking or without standstill.
 * - Sideslip |β| = |atan2(vy, vx)|, only above SLIP_MIN_SPEED, where β means something.
 * - Impact speed: the closing speed along the road at the first contact, the ego's speed along the road minus
 *   the obstacle's (its spec velocity along s while it moves, else 0). A pedestrian crossing or a stopped car is
 *   hit at the ego's speed along the road; a car ahead moving the same way only at the difference. The sign tells
 *   who closed in: positive when the ego runs into the obstacle, negative when the ego is struck from behind by a
 *   faster obstacle (−15 m/s for a car at 25 m/s reaching an ego at 10 m/s). The ego's own speed at the contact,
 *   always ≥ 0, is kept as egoImpactSpeed. The collision event's speed is the same signed value.
 * - Duration: the time of the vehicle's last state, ticks / TICK_HZ with the same tick as VehicleRun.ticks (the
 *   collision or road-end tick, or the scenario's tick count when the run reaches its duration).
 */
import type { LaneGeometry } from '../sensors/views.ts';
import type { DriverCommand } from '../vehicle/actuators.ts';
import { wheelbase } from '../vehicle/params.ts';
import { CHASSIS } from '../vehicle/plant.ts';
import type { Vehicle } from '../vehicle/vehicle.ts';
import { obstacleMoving, type ObstacleSpec, type ObstacleState, type Obstacles } from '../world/obstacles.ts';
import { TICK_HZ } from './clock.ts';

/** A braking command at least this strong starts the stopping distance, m/s² (about 0.4 g). */
export const STRONG_BRAKE = -4;
/** Below this speed the vehicle counts as stopped, m/s. */
export const STANDSTILL = 0.1;
/** Sideslip is measured only above this speed, m/s. */
export const SLIP_MIN_SPEED = 2;

export interface RunMetrics {
  readonly collided: boolean;
  /**
   * Closing speed along the road at the first collision, m/s (the ego's speed along the road minus the obstacle's);
   * null without one. Positive when the ego runs into the obstacle, negative when it is struck from behind.
   */
  readonly impactSpeed: number | null;
  /** The ego's own speed (|v| of the center of gravity) at the first collision, m/s; null without one. */
  readonly egoImpactSpeed: number | null;
  readonly collisionObstacle: string | null;
  /** s; null when the vehicle never closed in on an obstacle in its path. */
  readonly minTtc: number | null;
  /** m; null without strong braking or without standstill. */
  readonly stoppingDistance: number | null;
  /** Largest |e_y − lane center|, m. */
  readonly maxLateralDeviation: number;
  /** Largest |a_y|, m/s². */
  readonly peakLateralAccel: number;
  /** Largest |β| above SLIP_MIN_SPEED, rad. */
  readonly maxSideslip: number;
  readonly finalSpeed: number;
  /** Path length of the center of gravity, m. */
  readonly distance: number;
  /** Time of the vehicle's last state, s: VehicleRun.ticks / TICK_HZ. */
  readonly duration: number;
}

/** The vehicle's speed along the road, m/s: its velocity projected on the road's tangent. */
function speedAlongRoad(vehicle: Vehicle, pose: RoadPose): number {
  const c = vehicle.plant.chassis;
  return (c[CHASSIS.VX] ?? 0) * Math.cos(pose.epsi) - (c[CHASSIS.VY] ?? 0) * Math.sin(pose.epsi);
}

/** An obstacle's speed along the road at `tick`: its spec velocity while it moves (obstacleMoving), else 0. */
function obstacleSpeedAlongRoad(spec: ObstacleSpec, state: ObstacleState, tick: number): number {
  return obstacleMoving(spec, state, tick) ? spec.velocity.s : 0;
}

/** Where the vehicle is in road coordinates at this tick. */
export interface RoadPose {
  readonly s: number;
  readonly ey: number;
  /** Heading relative to the road, rad. */
  readonly epsi: number;
}

export class MetricsTracker {
  private readonly lane: LaneGeometry;
  private readonly front: number;
  private readonly halfWidth: number;
  private readonly specs: readonly ObstacleSpec[];
  private minTtc = Infinity;
  private brakeStart = -1;
  private stopping: number | null = null;
  private maxDeviation = 0;
  private peakAy = 0;
  private maxBeta = 0;
  private distance = 0;
  private lastX = Number.NaN;
  private lastY = Number.NaN;
  private finalSpeed = 0;
  private ticks = 0;
  private impact: { closing: number; speed: number; obstacle: string } | null = null;

  constructor(vehicle: Vehicle, lane: LaneGeometry, specs: readonly ObstacleSpec[]) {
    const p = vehicle.params;
    this.lane = lane;
    this.front = p.lf + (p.length - wheelbase(p)) / 2;
    this.halfWidth = p.width / 2;
    this.specs = specs;
  }

  /** The state at `tick` (before its step), with the command in force from it and the true obstacles. */
  update(tick: number, vehicle: Vehicle, pose: RoadPose, command: Readonly<DriverCommand>, obstacles: Obstacles): void {
    const c = vehicle.plant.chassis;
    const x = c[CHASSIS.X] ?? 0;
    const y = c[CHASSIS.Y] ?? 0;
    const vx = c[CHASSIS.VX] ?? 0;
    const vy = c[CHASSIS.VY] ?? 0;
    const speed = vehicle.speed;
    if (Number.isFinite(this.lastX)) this.distance += Math.hypot(x - this.lastX, y - this.lastY);
    this.lastX = x;
    this.lastY = y;
    this.finalSpeed = speed;
    this.ticks = tick;

    this.maxDeviation = Math.max(this.maxDeviation, Math.abs(pose.ey - this.lane.center));
    this.peakAy = Math.max(this.peakAy, Math.abs(vehicle.plant.ay));
    if (speed > SLIP_MIN_SPEED) this.maxBeta = Math.max(this.maxBeta, Math.abs(Math.atan2(vy, vx)));

    if (this.brakeStart < 0 && command.accel <= STRONG_BRAKE) this.brakeStart = this.distance;
    if (this.brakeStart >= 0 && this.stopping === null && speed < STANDSTILL) {
      this.stopping = this.distance - this.brakeStart;
    }

    // The body's e_y extent is taken as its width around e_y (small heading errors).
    const along = speedAlongRoad(vehicle, pose);
    const nose = pose.s + this.front;
    this.specs.forEach((spec, i) => {
      const state = obstacles.states[i];
      if (!state) return;
      const rear = state.s - spec.length / 2;
      if (rear < pose.s) return;
      const overlap = Math.abs(state.ey - pose.ey) < spec.width / 2 + this.halfWidth;
      if (!overlap) return;
      const closing = along - obstacleSpeedAlongRoad(spec, state, tick);
      if (closing <= 0) return;
      this.minTtc = Math.min(this.minTtc, Math.max(0, rear - nose) / closing);
    });
  }

  /**
   * Records the first collision, with the obstacle at index `index` of the specs, at `tick` (after update()).
   * Returns the signed closing speed along the road, m/s: negative when the ego is struck from behind.
   */
  collide(tick: number, vehicle: Vehicle, pose: RoadPose, obstacles: Obstacles, index: number): number {
    const spec = this.specs[index];
    const state = obstacles.states[index];
    if (!spec || !state) throw new RangeError(`No obstacle at index ${index}`);
    const closing = speedAlongRoad(vehicle, pose) - obstacleSpeedAlongRoad(spec, state, tick);
    if (this.impact === null) this.impact = { obstacle: spec.id, closing, speed: vehicle.speed };
    return closing;
  }

  result(): RunMetrics {
    return {
      collided: this.impact !== null,
      impactSpeed: this.impact?.closing ?? null,
      egoImpactSpeed: this.impact?.speed ?? null,
      collisionObstacle: this.impact?.obstacle ?? null,
      minTtc: Number.isFinite(this.minTtc) ? this.minTtc : null,
      stoppingDistance: this.stopping,
      maxLateralDeviation: this.maxDeviation,
      peakLateralAccel: this.peakAy,
      maxSideslip: this.maxBeta,
      finalSpeed: this.finalSpeed,
      distance: this.distance,
      duration: this.ticks / TICK_HZ,
    };
  }
}
