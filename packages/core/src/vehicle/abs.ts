/**
 * Anti-lock braking, one slip controller per wheel. It is idealized: it knows the friction curve
 * of the surface under each wheel, not a model of a commercial system.
 * - It never lets a brake ask for more torque than the tire can react at its peak (μ·Fz·R), so a wheel does
 *   not lock deeply even when the request is ten times the grip, as on ice.
 * - A factor in [0, 1] per wheel then holds the slip where the tire gives ABS_TARGET of its peak force, on the
 *   stable side of the curve: it integrates the slip error, normalized by the peak slip.
 * Below 1.5 m/s it switches off and lets the wheels lock, as real systems do.
 */
import { peakArgument, shareArgument } from './magicFormula.ts';
import type { Surface } from './surfaces.ts';

/** Share of a tire's peak force the ABS aims for. The M1 braking test uses it as the efficiency η. */
export const ABS_TARGET = 0.97;
const MIN_SPEED = 1.5;
/** Factor change per second, per unit of slip error normalized by the peak slip. */
const GAIN = 40;

const targetSlips = new WeakMap<Surface, number>();

/** Slip where the surface's curve reaches ABS_TARGET of its peak, below the peak. */
export function absTargetSlip(surface: Surface): number {
  let slip = targetSlips.get(surface);
  if (slip === undefined) {
    slip = (surface.peakSlip * shareArgument(surface.c, surface.e, ABS_TARGET)) / peakArgument(surface.c, surface.e);
    targetSlips.set(surface, slip);
  }
  return slip;
}

export class Abs {
  enabled: boolean;
  /** Brake pressure factor per wheel (FL, FR, RL, RR). */
  readonly factor = new Float64Array(4).fill(1);
  /** Whether the ABS acted on the last update (enabled and fast enough). */
  active = false;

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  reset(): void {
    this.factor.fill(1);
    this.active = false;
  }

  update(kappa: Float64Array, surfaces: readonly Surface[], speed: number, dt: number): void {
    this.active = this.enabled && speed >= MIN_SPEED;
    if (!this.active) {
      this.factor.fill(1);
      return;
    }
    for (let i = 0; i < 4; i++) {
      const surface = surfaces[i] as Surface;
      const error = (absTargetSlip(surface) + (kappa[i] ?? 0)) / surface.peakSlip;
      const f = (this.factor[i] ?? 1) + dt * GAIN * error;
      this.factor[i] = f < 0 ? 0 : f > 1 ? 1 : f;
    }
  }

  /** Brake torque let through to `wheel`, for a requested torque, the wheel's load and its surface. */
  torque(wheel: number, request: number, fz: number, surface: Surface, radius: number): number {
    if (!this.active) return request;
    const peak = surface.mu * fz * radius;
    return (this.factor[wheel] ?? 1) * (request < peak ? request : peak);
  }
}
