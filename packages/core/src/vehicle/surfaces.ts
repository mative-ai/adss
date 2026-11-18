/**
 * Road surfaces: peak friction μ and the shape (C, E) of the longitudinal Magic Formula curve, from the widely
 * used reference set for dry asphalt, wet asphalt, snow and ice. The stiffness B is not taken from
 * that set: it follows from one slip stiffness per unit of load, the same on every surface, so the peak slip
 * shrinks with μ as the brush model predicts and stays in proportion with the lateral one.
 */
import { peakArgument } from './magicFormula.ts';

export type SurfaceId = 'dry' | 'wet' | 'snow' | 'ice';

/** Longitudinal slip stiffness per unit of vertical load: B·C·μ of the dry reference curve (10 × 1.9 × 1). */
export const SLIP_STIFFNESS = 19;

export interface Surface {
  readonly id: SurfaceId;
  readonly mu: number;
  readonly b: number;
  readonly c: number;
  readonly e: number;
  /** Longitudinal slip κ at the peak of the curve. */
  readonly peakSlip: number;
}

function surface(id: SurfaceId, mu: number, c: number, e: number): Surface {
  const b = SLIP_STIFFNESS / (c * mu);
  return { id, mu, b, c, e, peakSlip: peakArgument(c, e) / b };
}

export const SURFACES: Readonly<Record<SurfaceId, Surface>> = {
  dry: surface('dry', 1.0, 1.9, 0.97),
  wet: surface('wet', 0.7, 2.3, 1),
  snow: surface('snow', 0.3, 2, 1),
  ice: surface('ice', 0.1, 2, 1),
};
