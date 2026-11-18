/**
 * Milestone M3, first part: the prediction model's hand-written Jacobians against finite differences, at speed and
 * in the low-speed kinematic blend, and the stability of its RK4 map down to standstill.
 */
import { describe, expect, it } from 'vitest';

import { fiala, NU, NX, PredictionModel, Prng, STATE, VEHICLES } from '../src/index.ts';

const H = 1e-6;
const TOLERANCE = 1e-6;

function randomState(rng: Prng): Float64Array {
  return Float64Array.of(
    rng.uniform(0, 200),
    rng.uniform(-1.5, 1.5),
    rng.uniform(-0.2, 0.2),
    rng.uniform(4, 35),
    rng.uniform(-1.5, 1.5),
    rng.uniform(-0.6, 0.6),
    rng.uniform(-0.15, 0.15),
    rng.uniform(-8, 2),
  );
}

/** Largest entry error relative to max(1, |reference|). */
function worst(analytic: Float64Array, numeric: Float64Array): number {
  let error = 0;
  for (let i = 0; i < analytic.length; i++) {
    const ref = numeric[i] ?? 0;
    error = Math.max(error, Math.abs((analytic[i] ?? 0) - ref) / Math.max(1, Math.abs(ref)));
  }
  return error;
}

describe('Fiala tire', () => {
  it('is continuous and smooth where it saturates, and its slope matches finite differences', () => {
    const out = new Float64Array(2);
    const C = 1.1e5;
    const muFz = 8000;
    const limit = Math.atan((3 * muFz) / C);
    fiala(limit * (1 - 1e-9), C, muFz, out);
    expect(out[0]).toBeCloseTo(-muFz, 3);
    expect(Math.abs(out[1] ?? 0)).toBeLessThan(1);
    // Not at 0, where |tan α|·tan α has a kink in its second derivative and central differences lose O(h).
    for (const alpha of [-0.3, -0.1, -0.01, 0.001, 0.02, 0.15, 0.4]) {
      fiala(alpha, C, muFz, out);
      const slope = out[1] ?? 0;
      fiala(alpha + H, C, muFz, out);
      const plus = out[0] ?? 0;
      fiala(alpha - H, C, muFz, out);
      const minus = out[0] ?? 0;
      expect(Math.abs(slope - (plus - minus) / (2 * H)) / Math.max(1, Math.abs(slope))).toBeLessThan(TOLERANCE);
    }
  });
});

describe('prediction model Jacobians', () => {
  for (const id of ['car', 'van', 'truck'] as const) {
    it(`${id}: ∂f/∂x and ∂f/∂u match finite differences`, () => {
      const model = new PredictionModel(VEHICLES[id], 0.9);
      const rng = Prng.create(20261102, 20);
      const f = new Float64Array(NX);
      const fp = new Float64Array(NX);
      const fm = new Float64Array(NX);
      const jx = new Float64Array(NX * NX);
      const ju = new Float64Array(NX * NU);
      const nx = new Float64Array(NX * NX);
      const nu = new Float64Array(NX * NU);
      for (let trial = 0; trial < 50; trial++) {
        const x = randomState(rng);
        const u = Float64Array.of(rng.uniform(-0.3, 0.3), rng.uniform(-8, 2));
        const kappa = rng.uniform(-0.02, 0.02);
        // μ is a per-stage parameter, from ice to dry: the Jacobians hold on every surface.
        const mu = rng.uniform(0.1, 1);
        model.derivative(x, u, kappa, mu, f, jx, ju);
        for (let j = 0; j < NX; j++) {
          const xp = x.slice();
          const xm = x.slice();
          xp[j] = (xp[j] ?? 0) + H;
          xm[j] = (xm[j] ?? 0) - H;
          model.derivative(xp, u, kappa, mu, fp);
          model.derivative(xm, u, kappa, mu, fm);
          for (let i = 0; i < NX; i++) nx[i * NX + j] = ((fp[i] ?? 0) - (fm[i] ?? 0)) / (2 * H);
        }
        for (let j = 0; j < NU; j++) {
          const up = u.slice();
          const um = u.slice();
          up[j] = (up[j] ?? 0) + H;
          um[j] = (um[j] ?? 0) - H;
          model.derivative(x, up, kappa, mu, fp);
          model.derivative(x, um, kappa, mu, fm);
          for (let i = 0; i < NX; i++) nu[i * NU + j] = ((fp[i] ?? 0) - (fm[i] ?? 0)) / (2 * H);
        }
        expect(worst(jx, nx), `trial ${trial}, ∂f/∂x`).toBeLessThan(TOLERANCE);
        expect(worst(ju, nu), `trial ${trial}, ∂f/∂u`).toBeLessThan(TOLERANCE);
      }
    });
  }

  for (const duration of [0.05, 0.15]) {
    it(`the RK4 map over ${duration * 1000} ms has exact Jacobians`, () => {
      const model = new PredictionModel(VEHICLES.car, 1);
      const rng = Prng.create(20261102, 21);
      const next = new Float64Array(NX);
      const np = new Float64Array(NX);
      const nm = new Float64Array(NX);
      const a = new Float64Array(NX * NX);
      const b = new Float64Array(NX * NU);
      const na = new Float64Array(NX * NX);
      const nb = new Float64Array(NX * NU);
      for (let trial = 0; trial < 20; trial++) {
        const x = randomState(rng);
        const u = Float64Array.of(rng.uniform(-0.3, 0.3), rng.uniform(-8, 2));
        const kappa = rng.uniform(-0.02, 0.02);
        const mu = rng.uniform(0.1, 1);
        model.discretize(x, u, kappa, mu, duration, next, a, b);
        for (let j = 0; j < NX; j++) {
          const xp = x.slice();
          const xm = x.slice();
          xp[j] = (xp[j] ?? 0) + H;
          xm[j] = (xm[j] ?? 0) - H;
          model.discretize(xp, u, kappa, mu, duration, np);
          model.discretize(xm, u, kappa, mu, duration, nm);
          for (let i = 0; i < NX; i++) na[i * NX + j] = ((np[i] ?? 0) - (nm[i] ?? 0)) / (2 * H);
        }
        for (let j = 0; j < NU; j++) {
          const up = u.slice();
          const um = u.slice();
          up[j] = (up[j] ?? 0) + H;
          um[j] = (um[j] ?? 0) - H;
          model.discretize(x, up, kappa, mu, duration, np);
          model.discretize(x, um, kappa, mu, duration, nm);
          for (let i = 0; i < NX; i++) nb[i * NU + j] = ((np[i] ?? 0) - (nm[i] ?? 0)) / (2 * H);
        }
        expect(worst(a, na), `trial ${trial}, ∂Φ/∂x`).toBeLessThan(TOLERANCE);
        expect(worst(b, nb), `trial ${trial}, ∂Φ/∂u`).toBeLessThan(TOLERANCE);
      }
    });
  }

  it('takes μ per call: the default μ gives the same map to the bit, another μ a different one', () => {
    const model = new PredictionModel(VEHICLES.car, 0.8);
    const x = Float64Array.of(10, 0.2, 0.05, 20, 0.5, 0.3, 0.05, -2);
    const u = Float64Array.of(0.08, -3);
    const a = new Float64Array(NX);
    const b = new Float64Array(NX);
    const c = new Float64Array(NX);
    model.discretize(x, u, 0.01, model.mu, 0.15, a);
    model.discretize(x, u, 0.01, 0.8, 0.15, b);
    model.discretize(x, u, 0.01, 0.1, 0.15, c);
    expect(Array.from(a)).toEqual(Array.from(b));
    // On ice the same steering builds less lateral speed and yaw.
    expect(Math.abs((c[STATE.R] ?? 0) - (a[STATE.R] ?? 0))).toBeGreaterThan(1e-3);
    expect(model.rearSlipLimit(0.1)).toBeLessThan(model.rearSlipLimit());
  });
});

/** A state below 3 m/s, where the lateral and yaw dynamics blend into the kinematic model. */
function lowSpeedState(rng: Prng): Float64Array {
  return Float64Array.of(
    rng.uniform(0, 200),
    rng.uniform(-1.5, 1.5),
    rng.uniform(-0.2, 0.2),
    rng.uniform(0.05, 2.95),
    rng.uniform(-0.05, 0.05),
    rng.uniform(-0.15, 0.15),
    rng.uniform(-0.3, 0.3),
    rng.uniform(-8, 2),
  );
}

/** Central finite differences of `map` at (x, u), into nx (NX×NX) and nu (NX×NU). */
function differences(
  map: (x: Float64Array, u: Float64Array, out: Float64Array) => void,
  x: Float64Array,
  u: Float64Array,
  nx: Float64Array,
  nu: Float64Array,
): void {
  const fp = new Float64Array(NX);
  const fm = new Float64Array(NX);
  for (let j = 0; j < NX; j++) {
    const xp = x.slice();
    const xm = x.slice();
    xp[j] = (xp[j] ?? 0) + H;
    xm[j] = (xm[j] ?? 0) - H;
    map(xp, u, fp);
    map(xm, u, fm);
    for (let i = 0; i < NX; i++) nx[i * NX + j] = ((fp[i] ?? 0) - (fm[i] ?? 0)) / (2 * H);
  }
  for (let j = 0; j < NU; j++) {
    const up = u.slice();
    const um = u.slice();
    up[j] = (up[j] ?? 0) + H;
    um[j] = (um[j] ?? 0) - H;
    map(x, up, fp);
    map(x, um, fm);
    for (let i = 0; i < NX; i++) nu[i * NU + j] = ((fp[i] ?? 0) - (fm[i] ?? 0)) / (2 * H);
  }
}

describe('prediction model at low speed', () => {
  for (const id of ['car', 'van', 'truck'] as const) {
    it(`${id}: the kinematic blend's ∂f/∂x and ∂f/∂u match finite differences below 3 m/s`, () => {
      const model = new PredictionModel(VEHICLES[id], 0.9);
      const rng = Prng.create(20261103, 22);
      const f = new Float64Array(NX);
      const jx = new Float64Array(NX * NX);
      const ju = new Float64Array(NX * NU);
      const nx = new Float64Array(NX * NX);
      const nu = new Float64Array(NX * NU);
      for (let trial = 0; trial < 50; trial++) {
        const x = lowSpeedState(rng);
        const u = Float64Array.of(rng.uniform(-0.3, 0.3), rng.uniform(-8, 2));
        const kappa = rng.uniform(-0.02, 0.02);
        const mu = rng.uniform(0.1, 1);
        model.derivative(x, u, kappa, mu, f, jx, ju);
        differences((xs, us, out) => model.derivative(xs, us, kappa, mu, out), x, u, nx, nu);
        expect(worst(jx, nx), `trial ${trial}, ∂f/∂x`).toBeLessThan(TOLERANCE);
        expect(worst(ju, nu), `trial ${trial}, ∂f/∂u`).toBeLessThan(TOLERANCE);
      }
    });
  }

  for (const duration of [0.05, 0.15]) {
    it(`the RK4 map over ${duration * 1000} ms has exact Jacobians below 3 m/s`, () => {
      const model = new PredictionModel(VEHICLES.car, 1);
      const rng = Prng.create(20261103, 23);
      const next = new Float64Array(NX);
      const a = new Float64Array(NX * NX);
      const b = new Float64Array(NX * NU);
      const na = new Float64Array(NX * NX);
      const nb = new Float64Array(NX * NU);
      for (let trial = 0; trial < 20; trial++) {
        const x = lowSpeedState(rng);
        const u = Float64Array.of(rng.uniform(-0.3, 0.3), rng.uniform(-3, 2));
        const kappa = rng.uniform(-0.02, 0.02);
        const mu = rng.uniform(0.1, 1);
        model.discretize(x, u, kappa, mu, duration, next, a, b);
        differences((xs, us, out) => model.discretize(xs, us, kappa, mu, duration, out), x, u, na, nb);
        expect(worst(a, na), `trial ${trial}, ∂Φ/∂x`).toBeLessThan(TOLERANCE);
        expect(worst(b, nb), `trial ${trial}, ∂Φ/∂u`).toBeLessThan(TOLERANCE);
      }
    });
  }

  it('keeps the RK4 map stable down to standstill, where the dynamic model alone is not', () => {
    const next = new Float64Array(NX);
    const a = new Float64Array(NX * NX);
    const b = new Float64Array(NX * NU);
    // The gain of the map's Jacobian (on a straight line the tires stay in their linear range, where the dynamic
    // model's modes are fastest) and the lateral state the rollout reaches, from a straight and a turning state.
    const states = [Float64Array.of(0, 0, 0, 0, 0, 0, 0, -5), Float64Array.of(0, 0, 0, 0, 0.01, 0.02, 0.05, -5)];
    const inputs = [Float64Array.of(0, -5), Float64Array.of(0.05, -5)];
    const measure = (model: PredictionModel, vx: number, duration: number) => {
      let gain = 0;
      let lateral = 0;
      states.forEach((state, i) => {
        const x = state.slice();
        x[STATE.VX] = vx;
        model.discretize(x, inputs[i]!, 0, model.mu, duration, next, a, b);
        gain = Math.max(gain, ...Array.from(a, Math.abs));
        lateral = Math.max(lateral, Math.abs(next[STATE.VY] ?? 0), Math.abs(next[STATE.R] ?? 0));
      });
      return { gain, lateral };
    };
    let gain = 0;
    let lateral = 0;
    for (const id of ['car', 'van', 'truck'] as const) {
      const model = new PredictionModel(VEHICLES[id], 1);
      for (let vx = 0; vx <= 3.5; vx += 0.25) {
        for (const duration of [0.05, 0.15, 0.2]) {
          const m = measure(model, vx, duration);
          gain = Math.max(gain, m.gain);
          lateral = Math.max(lateral, m.lateral);
        }
      }
    }
    const dynamic = new PredictionModel(VEHICLES.car, 1);
    dynamic.lowSpeedBlend = false;
    const unstable = measure(dynamic, 1, 0.15);
    console.log(
      `low speed: largest |A| entry ${gain.toFixed(2)}, |vy|, |r| ≤ ${lateral.toFixed(3)} with the blend;` +
        ` without it at 1 m/s, ${unstable.gain.toExponential(2)} and ${unstable.lateral.toExponential(2)}`,
    );
    expect(gain).toBeLessThan(5);
    expect(lateral).toBeLessThan(0.5);
    expect(unstable.gain).toBeGreaterThan(1e3);
  });

  for (const duration of [0.05, 0.15]) {
    it(`standstill hold: never reverses, and the ${duration * 1000} ms map has exact Jacobians`, () => {
      const model = new PredictionModel(VEHICLES.car, 1);
      model.standstillHold = true;
      const rng = Prng.create(20261103, 25);
      const next = new Float64Array(NX);
      const a = new Float64Array(NX * NX);
      const b = new Float64Array(NX * NU);
      const na = new Float64Array(NX * NX);
      const nb = new Float64Array(NX * NU);
      let held = 0;
      let moving = 0;
      for (let trial = 0; trial < 60; trial++) {
        // Just above rest (or a hair below, as an observed state can be), braking hard or moving off.
        const x = Float64Array.of(
          rng.uniform(0, 200),
          rng.uniform(-1.5, 1.5),
          rng.uniform(-0.2, 0.2),
          rng.uniform(-0.02, 0.6),
          rng.uniform(-0.02, 0.02),
          rng.uniform(-0.05, 0.05),
          rng.uniform(-0.3, 0.3),
          rng.uniform(-8, 2),
        );
        const u = Float64Array.of(rng.uniform(-0.3, 0.3), rng.uniform(-8, 2));
        const kappa = rng.uniform(-0.02, 0.02);
        model.discretize(x, u, kappa, 1, duration, next, a, b);
        differences((xs, us, out) => model.discretize(xs, us, kappa, 1, duration, out), x, u, na, nb);
        expect(worst(a, na), `trial ${trial}, ∂Φ/∂x`).toBeLessThan(TOLERANCE);
        expect(worst(b, nb), `trial ${trial}, ∂Φ/∂u`).toBeLessThan(TOLERANCE);
        expect(next[STATE.VX], `trial ${trial}`).toBeGreaterThanOrEqual(0);
        if (next[STATE.VX] === 0) {
          // Held: no state or input moves vx (braking harder at rest changes nothing).
          held++;
          expect(Array.from(a.subarray(STATE.VX * NX, (STATE.VX + 1) * NX)).every((v) => v === 0)).toBe(true);
          expect(Array.from(b.subarray(STATE.VX * NU, (STATE.VX + 1) * NU)).every((v) => v === 0)).toBe(true);
        } else moving++;
      }
      // Both branches are exercised.
      expect(held).toBeGreaterThan(5);
      expect(moving).toBeGreaterThan(5);
    });
  }

  it('with the standstill hold, stays put at rest under braking, moves off under a positive command', () => {
    const model = new PredictionModel(VEHICLES.car, 1);
    model.standstillHold = true;
    const free = new PredictionModel(VEHICLES.car, 1);
    const rest = Float64Array.of(42, 0.3, 0, 0, 0, 0, 0, -6);
    const x = rest.slice();
    const next = new Float64Array(NX);
    for (let step = 0; step < 20; step++) {
      model.discretize(x, Float64Array.of(0, -6), 0, 1, 0.15, next);
      x.set(next);
    }
    expect(x[STATE.VX]).toBe(0);
    expect(x[STATE.S]).toBe(42);
    // Without the hold the same braking reverses.
    free.discretize(rest, Float64Array.of(0, -6), 0, 1, 0.15, next);
    expect(next[STATE.VX] ?? 0).toBeLessThan(-0.1);
    // A positive command lifts the acceleration through its lag and the vehicle moves off.
    for (let step = 0; step < 10; step++) {
      model.discretize(x, Float64Array.of(0, 2), 0, 1, 0.15, next);
      x.set(next);
    }
    expect(x[STATE.VX] ?? 0).toBeGreaterThan(0.5);
    expect(x[STATE.S] ?? 0).toBeGreaterThan(42);
  });

  it('with the standstill hold, is the same map to the bit where the vehicle does not stop', () => {
    const on = new PredictionModel(VEHICLES.car, 1);
    on.standstillHold = true;
    const off = new PredictionModel(VEHICLES.car, 1);
    const rng = Prng.create(20261103, 26);
    const maps = [0, 1].map(() => ({
      next: new Float64Array(NX),
      a: new Float64Array(NX * NX),
      b: new Float64Array(NX * NU),
    }));
    for (let trial = 0; trial < 50; trial++) {
      const x = randomState(rng);
      const u = Float64Array.of(rng.uniform(-0.3, 0.3), rng.uniform(-8, 2));
      [on, off].forEach((model, i) => model.discretize(x, u, 0.01, 1, 0.15, maps[i]!.next, maps[i]!.a, maps[i]!.b));
      expect(Array.from(maps[0]!.next)).toEqual(Array.from(maps[1]!.next));
      expect(Array.from(maps[0]!.a)).toEqual(Array.from(maps[1]!.a));
      expect(Array.from(maps[0]!.b)).toEqual(Array.from(maps[1]!.b));
    }
  });

  it('is the dynamic model to the bit at 3 m/s and above', () => {
    const on = new PredictionModel(VEHICLES.car, 1);
    const off = new PredictionModel(VEHICLES.car, 1);
    off.lowSpeedBlend = false;
    const rng = Prng.create(20261103, 24);
    const maps = [0, 1].map(() => ({
      next: new Float64Array(NX),
      a: new Float64Array(NX * NX),
      b: new Float64Array(NX * NU),
    }));
    for (let trial = 0; trial < 50; trial++) {
      const x = randomState(rng);
      // Fast enough that no RK4 stage of the 150 ms step drops under 3 m/s.
      x[STATE.VX] = 4.5 + (x[STATE.VX] ?? 0);
      const u = Float64Array.of(rng.uniform(-0.3, 0.3), rng.uniform(-8, 2));
      [on, off].forEach((model, i) => model.discretize(x, u, 0.01, 1, 0.15, maps[i]!.next, maps[i]!.a, maps[i]!.b));
      expect(Array.from(maps[0]!.next)).toEqual(Array.from(maps[1]!.next));
      expect(Array.from(maps[0]!.a)).toEqual(Array.from(maps[1]!.a));
      expect(Array.from(maps[0]!.b)).toEqual(Array.from(maps[1]!.b));
    }
  });
});
