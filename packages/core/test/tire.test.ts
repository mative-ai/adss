import { describe, expect, it } from 'vitest';

import {
  lateralPeakSlip,
  magic,
  magicSlope,
  peakArgument,
  shareArgument,
  SLIP_STIFFNESS,
  SURFACES,
  tireForces,
  type SurfaceId,
} from '../src/index.ts';

const FZ = 4000;
/** Cornering stiffness per unit load of the car's front axle, N/rad per N. */
const CORNERING_PER_LOAD = 12.9;
const SURFACE_IDS: SurfaceId[] = ['dry', 'wet', 'snow', 'ice'];
const out = new Float64Array(2);
const forces = (kappa: number, alpha: number, surface: SurfaceId) => {
  tireForces(kappa, alpha, FZ, SURFACES[surface], CORNERING_PER_LOAD, out);
  return { fx: out[0] ?? 0, fy: out[1] ?? 0 };
};

describe('Magic Formula', () => {
  for (const id of SURFACE_IDS) {
    const { c, e } = SURFACES[id];
    it(`${id}: the curve peaks at peakArgument and reaches a share where shareArgument says`, () => {
      const x = peakArgument(c, e);
      expect(magic(1, c, e, x)).toBeCloseTo(1, 12);
      expect(magic(1, c, e, x * 0.98)).toBeLessThan(1);
      expect(magic(1, c, e, x * 1.02)).toBeLessThan(1);
      expect(magic(1, c, e, shareArgument(c, e, 0.97))).toBeCloseTo(0.97, 12);
    });

    it(`${id}: magicSlope matches finite differences`, () => {
      for (const x of [0, 0.3, 1, 2.5, 6]) {
        const h = 1e-6;
        const numeric = (magic(1, c, e, x + h) - magic(1, c, e, x - h)) / (2 * h);
        expect(magicSlope(1, c, e, x)).toBeCloseTo(numeric, 6);
      }
    });
  }
});

describe('tire forces', () => {
  for (const id of SURFACE_IDS) {
    const surface = SURFACES[id];
    const peak = surface.mu * FZ;

    it(`${id}: pure longitudinal and lateral curves peak at μ·Fz`, () => {
      expect(forces(surface.peakSlip, 0, id).fx).toBeCloseTo(peak, 6);
      expect(forces(-surface.peakSlip, 0, id).fx).toBeCloseTo(-peak, 6);
      const alphaPeak = lateralPeakSlip(CORNERING_PER_LOAD, surface.mu);
      expect(forces(0, alphaPeak, id).fy).toBeCloseTo(-peak, 6);
    });

    it(`${id}: the combined force never leaves the friction circle`, () => {
      for (let k = -1; k <= 1; k += 0.05) {
        for (let a = -0.6; a <= 0.6; a += 0.03) {
          const f = forces(k, a, id);
          expect(Math.hypot(f.fx, f.fy)).toBeLessThanOrEqual(peak * (1 + 1e-12));
        }
      }
    });

    it(`${id}: both initial stiffnesses are the same on every surface`, () => {
      const d = 1e-7;
      expect(-forces(0, d, id).fy / d).toBeCloseTo(CORNERING_PER_LOAD * FZ, -2);
      expect(forces(d, 0, id).fx / d).toBeCloseTo(SLIP_STIFFNESS * FZ, -2);
    });

    it(`${id}: a locked wheel keeps almost no lateral grip, a rolling one keeps it`, () => {
      const alpha = (5 * Math.PI) / 180;
      const rolling = forces(0, alpha, id);
      const locked = forces(-1, alpha, id);
      expect(Math.abs(locked.fy)).toBeLessThan(0.1 * peak);
      expect(Math.abs(rolling.fy)).toBeGreaterThan(0.8 * peak);
      // Sliding friction: about 0.9 of the peak, 0.78 on wet asphalt, whose curve falls off most.
      expect(locked.fx).toBeLessThan(-0.7 * peak);
    });
  }

  it('peak slips shrink with μ, as the brush model predicts', () => {
    const slips = SURFACE_IDS.map((id) => SURFACES[id].peakSlip);
    for (let i = 1; i < slips.length; i++) expect(slips[i]).toBeLessThan(slips[i - 1] ?? 0);
  });

  it('forces oppose the slip: braking slip pulls back, a leftward slide pushes right', () => {
    expect(forces(-0.05, 0, 'dry').fx).toBeLessThan(0);
    expect(forces(0.05, 0, 'dry').fx).toBeGreaterThan(0);
    expect(forces(0, 0.05, 'dry').fy).toBeLessThan(0);
  });

  it('no load, no force', () => {
    tireForces(-0.1, 0.1, 0, SURFACES.dry, CORNERING_PER_LOAD, out);
    expect([out[0], out[1]]).toEqual([0, 0]);
  });
});
