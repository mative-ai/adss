/**
 * What the controllers perceive of the world (Phase 3): the obstacles as the object sensor reports
 * them, at its 20 Hz with its latency and noise; the friction a controller expects along the road; the ego lane.
 * The scenario run updates the sources; the MPC and the baseline controller only read them, so neither sees the
 * true world.
 */
import type { ObstacleSpec } from '../world/obstacles.ts';

/** An obstacle as last reported by the object sensor, in road coordinates. */
export interface ObstacleTrack {
  readonly id: string;
  readonly kind: ObstacleSpec['kind'];
  /**
   * Tick of the obstacle state this track reports: the sensor's latency included, so a reader at tick t knows the
   * track is (t − tick)/TICK_HZ seconds old and predicts it forward by that much.
   */
  readonly tick: number;
  /** Center, m: s along the road's line, e_y to its left. */
  readonly s: number;
  readonly ey: number;
  /** Velocity along and across the road, m/s. */
  readonly vs: number;
  readonly vey: number;
  /** Size along and across the road, m. */
  readonly length: number;
  readonly width: number;
}

/** The obstacle tracks of the latest object-sensor update. */
export interface TrackSource {
  tracks(): readonly ObstacleTrack[];
}

/**
 * The friction coefficient a controller expects at arc length s: a preview along the road, the mean μ under the two
 * wheel tracks of a vehicle centered at e_y, the ego lane's center when e_y is absent. The MPC plans on the lane's;
 * the decision layer checks the grip where an evasion would pass (mpc/branches.ts, pathObstacles).
 */
export interface FrictionPreview {
  at(s: number, ey?: number): number;
}

/** The ego lane across the road (right-hand traffic: the opposite lane lies to its left), m. */
export interface LaneGeometry {
  /** e_y of the lane's center. */
  readonly center: number;
  readonly width: number;
}
