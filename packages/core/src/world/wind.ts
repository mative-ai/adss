/**
 * A crosswind gust as an external load on the vehicle: a trapezoidal profile (rise, hold, fall) of lateral
 * force, applied at a center of pressure ahead of the center of gravity, so it also yaws the vehicle.
 */
import { secondsAt } from '../sim/clock.ts';
import type { ExternalLoads } from '../vehicle/plant.ts';

export interface Gust {
  /** Start, rise, hold and fall times, s. */
  readonly start: number;
  readonly rise: number;
  readonly hold: number;
  readonly fall: number;
  /** Peak lateral force, N, positive toward the vehicle's left. */
  readonly force: number;
  /** Distance of the center of pressure ahead of the center of gravity, m. */
  readonly arm: number;
}

export function gustLevel(gust: Gust, tick: number): number {
  const t = secondsAt(tick) - gust.start;
  if (t <= 0) return 0;
  if (t < gust.rise) return t / gust.rise;
  if (t < gust.rise + gust.hold) return 1;
  const falling = t - gust.rise - gust.hold;
  return falling < gust.fall ? 1 - falling / gust.fall : 0;
}

export function gustLoads(gust: Gust, tick: number, out: ExternalLoads): ExternalLoads {
  const fy = gust.force * gustLevel(gust, tick);
  out.fy = fy;
  out.mz = fy * gust.arm;
  return out;
}
