/**
 * Pacejka's Magic Formula, normalized to a unit peak: sin(C·atan(Bx − E(Bx − atan Bx))). Surfaces use it to
 * find their peak slip, the ABS its target slip, the tire model its forces.
 */
export function magic(b: number, c: number, e: number, x: number): number {
  const bx = b * x;
  return Math.sin(c * Math.atan(bx - e * (bx - Math.atan(bx))));
}

/** d/dx of `magic`. */
export function magicSlope(b: number, c: number, e: number, x: number): number {
  const bx = b * x;
  const phi = bx - e * (bx - Math.atan(bx));
  const dPhi = b * (1 - e + e / (1 + bx * bx));
  return Math.cos(c * Math.atan(phi)) * (c / (1 + phi * phi)) * dPhi;
}

/** The value of Bx where the curve peaks (sine argument π/2). Needs C > 1 and E ≤ 1. */
export function peakArgument(c: number, e: number): number {
  const target = Math.tan(Math.PI / (2 * c));
  let lo = 0;
  let hi = 1e3;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (mid - e * (mid - Math.atan(mid)) < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** The value of Bx below the peak where the curve reaches `share` (between 0 and 1) of its peak. */
export function shareArgument(c: number, e: number, share: number): number {
  let lo = 0;
  let hi = peakArgument(c, e);
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (magic(1, c, e, mid) < share) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}
