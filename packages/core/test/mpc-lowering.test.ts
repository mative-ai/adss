/**
 * The condensed QP (mpc/lowering.ts) is the step's QP with the states eliminated. On real step QPs of
 * the M3 lane change, at random points (δU, slacks), its objective and its rows equal the OcpQp's evaluated with
 * δX from the linearized dynamics, and its bounds are the OcpQp's: the same quadratic and the same constraints,
 * as functions of δU and the slacks.
 */
import { describe, expect, it } from 'vitest';

import {
  Condenser,
  CondensedStepSolver,
  GoldfarbIdnaniSolver,
  isoLaneChange,
  MpcDriver,
  objective,
  Prng,
  RoadPath,
  runClosedLoop,
  ticksFor,
  uniformSurface,
  Vehicle,
  VEHICLES,
  type OcpQp,
} from '../src/index.ts';

/** Step QPs of the first four seconds of the M3 run, driven by the exact solver. */
function stepQps(): OcpQp[] {
  const car = VEHICLES.car;
  const speed = 60 / 3.6;
  const course = isoLaneChange(car, speed);
  const road = new RoadPath({ segments: [{ kind: 'straight', length: 400 }], width: { left: 6, right: 3 } });
  const vehicle = new Vehicle(car, uniformSurface('dry'));
  vehicle.reset(0, 0, 0, speed);
  const solver = new CondensedStepSolver('gi', new GoldfarbIdnaniSolver());
  const driver = new MpcDriver(car, 1, road, course.corridor, course.reference, { solver });
  const ocps: OcpQp[] = [];
  runClosedLoop(
    vehicle,
    {
      periodTicks: driver.periodTicks,
      delayTicks: driver.delayTicks,
      compute(tick, v, out) {
        driver.compute(tick, v, out);
        if (driver.mpc.lastOcp) ocps.push(driver.mpc.lastOcp);
      },
    },
    { ticks: ticksFor(4) },
  );
  return ocps;
}

/** The stage variables of the condensed point x = (δU, slacks), with δX from the linearized dynamics. */
function expand(ocp: OcpQp, x: Float64Array): Float64Array {
  const N = ocp.horizon;
  const { nx, nu } = ocp;
  const v = new Float64Array(ocp.variables);
  const dx = new Float64Array(nx);
  const next = new Float64Array(nx);
  for (let k = 0; k < N; k++) {
    for (let s = 0; s < nx; s++) {
      let value = 0;
      for (let t = 0; t < nx; t++) value += ocp.a[(k * nx + s) * nx + t]! * dx[t]!;
      for (let c = 0; c < nu; c++) value += ocp.b[(k * nx + s) * nu + c]! * x[k * nu + c]!;
      next[s] = value;
    }
    dx.set(next);
    for (let c = 0; c < nu; c++) v[ocp.input(k, c)] = x[k * nu + c]!;
    for (let s = 0; s < nx; s++) v[ocp.state(k, s)] = dx[s]!;
  }
  for (let j = 0; j < ocp.slacks; j++) v[ocp.slack(j)] = x[N * nu + j]!;
  return v;
}

/** ½·vᵀPv + qᵀv of the OcpQp, with P from its upper-triangle triplets, without the dropped constant. */
function ocpObjective(ocp: OcpQp, v: Float64Array): number {
  let value = 0;
  for (let t = 0; t < ocp.costValue.length; t++) {
    const i = ocp.costRow[t]!;
    const j = ocp.costCol[t]!;
    const p = ocp.costValue[t]!;
    value += i === j ? 0.5 * p * v[i]! * v[i]! : p * v[i]! * v[j]!;
  }
  for (let i = 0; i < ocp.variables; i++) value += ocp.linear[i]! * v[i]!;
  return value;
}

describe('the condensed form of the step QP', () => {
  const ocps = stepQps();
  const condenser = new Condenser();

  it('is the step QP with the states eliminated through the dynamics', () => {
    expect(ocps.length).toBe(80);
    const rng = Prng.create(20261103, 0);
    for (const ocp of ocps.filter((_, i) => i % 8 === 3)) {
      const qp = condenser.lower(ocp);
      expect([qp.n, qp.m]).toEqual([ocp.horizon * ocp.nu + ocp.slacks, ocp.rows]);
      expect(Array.from(qp.l)).toEqual(ocp.lower);
      expect(Array.from(qp.u)).toEqual(ocp.upper);
      for (let trial = 0; trial < 4; trial++) {
        const x = Float64Array.from({ length: qp.n }, () => rng.uniform(-0.5, 0.5));
        const v = expand(ocp, x);
        const expected = ocpObjective(ocp, v);
        expect(Math.abs(objective(qp, x) - expected)).toBeLessThan(1e-9 * Math.max(1, Math.abs(expected)));
        for (let r = 0; r < ocp.rows; r++) {
          let full = 0;
          let scale = 1;
          for (let e = ocp.rowStart[r]!; e < ocp.rowStart[r + 1]!; e++) {
            const term = ocp.rowValue[e]! * v[ocp.rowIndex[e]!]!;
            full += term;
            scale = Math.max(scale, Math.abs(term));
          }
          let condensed = 0;
          for (let j = 0; j < qp.n; j++) condensed += qp.A[r * qp.n + j]! * x[j]!;
          expect(Math.abs(condensed - full), `row ${r}`).toBeLessThan(1e-10 * scale);
        }
      }
    }
  });
});
