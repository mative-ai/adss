/**
 * Tire forces: Pacejka's Magic Formula for the pure-slip curves, combined through the normalized slip vector.
 *
 * A pure curve is D·sin(C·atan(Bx − E(Bx − atan Bx))) with the peak D = μ·Fz. Both stiffnesses are fixed per
 * unit of load (longitudinal: SLIP_STIFFNESS; lateral: the axle's cornering stiffness), so on every surface
 * the peak slips scale with μ and keep the same ratio. Combined slip uses the slip vector normalized by the
 * peak slips, s = |(κ/κ*, α/α*)|: the total force follows the pure curve at s and points along that vector.
 * Pure slip gives back the pure curves, the force never leaves the friction circle, and a locked wheel
 * (κ = −1, far past its peak) loses almost all of its lateral grip on any surface.
 */
import { magic, magicSlope, peakArgument } from './magicFormula.ts';
import type { Surface } from './surfaces.ts';

/**
 * Lateral curve shape, the same on every surface: with E = −1 the car's front tire peaks near 11°
 * on dry asphalt instead of 15° with E = 0.
 */
export const LATERAL_C = 1.3;
export const LATERAL_E = -1;

const LATERAL_PEAK_ARGUMENT = peakArgument(LATERAL_C, LATERAL_E);

/**
 * Slip angle at the lateral peak for a cornering stiffness of `corneringPerLoad` (N/rad per N of load):
 * B = corneringPerLoad/(C·μ), so the initial slope is the same on every surface and the peak moves in with μ.
 */
export function lateralPeakSlip(corneringPerLoad: number, mu: number): number {
  return (LATERAL_PEAK_ARGUMENT * LATERAL_C * mu) / corneringPerLoad;
}

/**
 * Wheel-frame forces for longitudinal slip κ and slip angle α (positive when the contact patch slides to the
 * left), written to out[0] (Fx, positive forward) and out[1] (Fy, positive to the left).
 * Returns dFx/dκ of the pure longitudinal curve at |κ|, clamped at 0 past the peak, for the semi-implicit
 * wheel update.
 */
export function tireForces(
  kappa: number,
  alpha: number,
  fz: number,
  surface: Surface,
  corneringPerLoad: number,
  out: Float64Array,
): number {
  if (fz <= 0) {
    out[0] = 0;
    out[1] = 0;
    return 0;
  }
  const d = surface.mu * fz;
  const kappaPeak = surface.peakSlip;
  const alphaPeak = lateralPeakSlip(corneringPerLoad, surface.mu);
  const sx = kappa / kappaPeak;
  const sy = alpha / alphaPeak;
  const s = Math.sqrt(sx * sx + sy * sy);
  if (s < 1e-12) {
    out[0] = 0;
    out[1] = 0;
    return d * surface.b * surface.c;
  }
  const bLat = corneringPerLoad / (LATERAL_C * surface.mu);
  const fx = d * magic(surface.b, surface.c, surface.e, s * kappaPeak);
  const fy = d * magic(bLat, LATERAL_C, LATERAL_E, s * alphaPeak);
  out[0] = (fx * sx) / s;
  out[1] = (-fy * sy) / s;
  return Math.max(0, d * magicSlope(surface.b, surface.c, surface.e, Math.abs(kappa)));
}
