/**
 * The fast Goldfarb–Idnani (qp/goldfarbIdnaniFast.ts) is the same method as the reference
 * goldfarbIdnani.ts: it agrees with it to 1e-9 on random strictly convex QPs, on QPs shaped like the MPC's (soft
 * rows with separable slacks, which exercise the bounds it fixes and releases), on Hock–Schittkowski problems
 * and on the real step QPs of the M3 lane change; it reports infeasibility and its iteration cap as the
 * reference does, and it is deterministic. Its condensing (mpc/rowCondenser.ts) gives the shared Condenser's QP,
 * and on the MPC's QPs every slack starts fixed at its bound.
 */
import { describe, expect, it } from 'vitest';

import {
  CHASSIS,
  Condenser,
  CondensedStepSolver,
  GiStepSolver,
  GoldfarbIdnaniFastSolver,
  GoldfarbIdnaniSolver,
  isoLaneChange,
  MpcDriver,
  Prng,
  residuals,
  RoadPath,
  RowCondenser,
  runClosedLoop,
  ticksFor,
  uniformSurface,
  Vehicle,
  VEHICLES,
  type GoldfarbIdnaniFastSettings,
  type OcpQp,
  type QpProblem,
  type QpResult,
  type StepSolution,
} from '../src/index.ts';

const INF = Infinity;

function problem(P: number[][], q: number[], A: number[][], l: number[], u: number[]): QpProblem {
  return {
    n: q.length,
    m: l.length,
    P: Float64Array.from(P.flat()),
    q: Float64Array.from(q),
    A: Float64Array.from(A.flat()),
    l: Float64Array.from(l),
    u: Float64Array.from(u),
  };
}

const reference = new GoldfarbIdnaniSolver();
const VARIANTS: readonly [string, Partial<GoldfarbIdnaniFastSettings>][] = [
  ['plain', { eliminateBounds: false }],
  ['bounds eliminated', { eliminateBounds: true }],
];

/** Largest |a − b| relative to max(1, ‖b‖∞), and the relative objective gap. */
function gaps(a: QpResult, b: QpResult): { x: number; objective: number } {
  const scale = Math.max(1, ...Array.from(b.x, Math.abs));
  let x = 0;
  for (let j = 0; j < b.x.length; j++) x = Math.max(x, Math.abs(a.x[j]! - b.x[j]!));
  return { x: x / scale, objective: Math.abs(a.objective - b.objective) / Math.max(1, Math.abs(b.objective)) };
}

/** Copied from qp.test.ts: the published optima, constant terms of the objectives dropped. */
const HOCK_SCHITTKOWSKI = [
  {
    name: 'HS21',
    qp: problem(
      [
        [0.02, 0],
        [0, 2],
      ],
      [0, 0],
      [
        [10, -1],
        [1, 0],
        [0, 1],
      ],
      [10, 2, -50],
      [INF, 50, 50],
    ),
    x: [2, 0],
    objective: -99.96 + 100,
  },
  {
    name: 'HS35',
    qp: problem(
      [
        [4, 2, 2],
        [2, 4, 0],
        [2, 0, 2],
      ],
      [-8, -6, -4],
      [
        [1, 1, 2],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      [-INF, 0, 0, 0],
      [3, INF, INF, INF],
    ),
    x: [4 / 3, 7 / 9, 4 / 9],
    objective: 1 / 9 - 9,
  },
  {
    name: 'HS76',
    qp: problem(
      [
        [2, 0, -1, 0],
        [0, 1, 0, 0],
        [-1, 0, 2, 1],
        [0, 0, 1, 1],
      ],
      [-1, -3, 1, -1],
      [
        [1, 2, 1, 1],
        [3, 1, 2, -1],
        [0, 1, 4, 0],
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
      [-INF, -INF, 1.5, 0, 0, 0, 0],
      [5, 4, INF, INF, INF, INF, INF],
    ),
    x: [3 / 11, 23 / 11, 0, 6 / 11],
    objective: -103 / 22,
  },
];

/** Copied from qp.test.ts: a strictly convex QP with a known feasible point and mixed rows. */
function randomProblem(rng: Prng): QpProblem {
  const n = rng.integer(2, 40);
  const m = rng.integer(1, 60);
  const M = Array.from({ length: n * n }, () => rng.normal());
  const P = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = i === j ? 0.1 : 0;
      for (let k = 0; k < n; k++) s += (M[k * n + i] ?? 0) * (M[k * n + j] ?? 0);
      P[i * n + j] = s / n;
    }
  }
  const q = Float64Array.from({ length: n }, () => 3 * rng.normal());
  const A = Float64Array.from({ length: m * n }, () => (rng.next() < 0.6 ? rng.normal() : 0));
  const feasible = Float64Array.from({ length: n }, () => rng.normal());
  const l = new Float64Array(m);
  const u = new Float64Array(m);
  let equalities = 0;
  for (let i = 0; i < m; i++) {
    let ax = 0;
    for (let j = 0; j < n; j++) ax += (A[i * n + j] ?? 0) * (feasible[j] ?? 0);
    const kind = rng.next();
    if (kind < 0.1 && equalities < n - 1) {
      l[i] = ax;
      u[i] = ax;
      equalities++;
    } else if (kind < 0.4) {
      l[i] = ax - rng.uniform(0, 1);
      u[i] = INF;
    } else if (kind < 0.7) {
      l[i] = -INF;
      u[i] = ax + rng.uniform(0, 1);
    } else {
      l[i] = ax - rng.uniform(0, 1);
      u[i] = ax + rng.uniform(0, 1);
    }
  }
  return { n, m, P, q, A, l, u };
}

/**
 * A QP shaped like the MPC's: dense core variables, then separable slacks (diagonal P, mostly a large linear
 * cost) with simple bound rows (some scaled, some two-sided, some doubled) and soft rows core·x ∓ slack; a few
 * hard rows and equalities on the core, and sometimes an equality that uses a slack (which makes it
 * ineligible for fixing). Feasible by construction.
 */
function softProblem(rng: Prng): QpProblem {
  const core = rng.integer(2, 20);
  const slacks = rng.integer(1, 12);
  const n = core + slacks;
  const M = Array.from({ length: core * core }, () => rng.normal());
  const P = new Float64Array(n * n);
  for (let i = 0; i < core; i++) {
    for (let j = 0; j < core; j++) {
      let s = i === j ? 0.1 : 0;
      for (let k = 0; k < core; k++) s += M[k * core + i]! * M[k * core + j]!;
      P[i * n + j] = s / core;
    }
  }
  const q = new Float64Array(n);
  for (let i = 0; i < core; i++) q[i] = 3 * rng.normal();
  for (let j = core; j < n; j++) {
    P[j * n + j] = rng.uniform(0.5, 5);
    q[j] = rng.next() < 0.8 ? rng.uniform(1, 50) : -rng.uniform(1, 20);
  }
  const point = new Float64Array(n);
  for (let i = 0; i < core; i++) point[i] = rng.normal();
  const upper = new Float64Array(n).fill(INF);
  for (let j = core; j < n; j++) {
    if (rng.next() < 0.3) upper[j] = rng.uniform(0.5, 2);
    point[j] = rng.uniform(0, Math.min(1, upper[j]!));
  }
  const rows: { a: Float64Array; l: number; u: number }[] = [];
  const valueAt = (a: Float64Array) => a.reduce((s, v, j) => s + v * point[j]!, 0);
  // Simple bounds on the slacks.
  for (let j = core; j < n; j++) {
    const a = new Float64Array(n);
    const scale = rng.next() < 0.2 ? rng.uniform(0.5, 3) : 1;
    a[j] = scale;
    rows.push({ a, l: 0, u: Number.isFinite(upper[j]!) ? scale * upper[j]! : INF });
    if (rng.next() < 0.15) {
      const b = new Float64Array(n);
      b[j] = -1;
      rows.push({ a: b, l: -INF, u: -point[j]! + rng.uniform(0, 0.5) });
    }
  }
  // Soft rows: a·x − s ≤ u or a·x + s ≥ l.
  const soft = rng.integer(1, 3 * slacks);
  for (let r = 0; r < soft; r++) {
    const a = new Float64Array(n);
    for (let i = 0; i < core; i++) if (rng.next() < 0.6) a[i] = rng.normal();
    const j = core + rng.integer(0, slacks - 1);
    if (rng.next() < 0.5) {
      a[j] = -1;
      rows.push({ a, l: -INF, u: valueAt(a) + rng.uniform(-0.2, 0.5) });
    } else {
      a[j] = 1;
      rows.push({ a, l: valueAt(a) - rng.uniform(-0.2, 0.5), u: INF });
    }
  }
  // Hard rows and equalities on the core, sometimes an equality with a slack.
  const hard = rng.integer(0, core);
  for (let r = 0; r < hard; r++) {
    const a = new Float64Array(n);
    for (let i = 0; i < core; i++) if (rng.next() < 0.5) a[i] = rng.normal();
    const value = valueAt(a);
    const kind = rng.next();
    if (kind < 0.15) rows.push({ a, l: value, u: value });
    else if (kind < 0.6) rows.push({ a, l: value - rng.uniform(0, 1), u: value + rng.uniform(0, 1) });
    else rows.push({ a, l: -INF, u: value + rng.uniform(0, 1) });
  }
  if (rng.next() < 0.2) {
    const a = new Float64Array(n);
    a[0] = 1;
    a[core] = 1;
    const value = valueAt(a);
    rows.push({ a, l: value, u: value });
  }
  const m = rows.length;
  const A = new Float64Array(m * n);
  rows.forEach((row, i) => A.set(row.a, i * n));
  return {
    n,
    m,
    P,
    q,
    A,
    l: Float64Array.from(rows, (r) => r.l),
    u: Float64Array.from(rows, (r) => r.u),
  };
}

describe('fast Goldfarb–Idnani on Hock–Schittkowski problems', () => {
  for (const hs of HOCK_SCHITTKOWSKI) {
    for (const [label, settings] of VARIANTS) {
      it(`${hs.name}, ${label}`, () => {
        const result = new GoldfarbIdnaniFastSolver(settings).solve(hs.qp);
        expect(result.status).toBe('solved');
        result.x.forEach((xi, i) => expect(xi).toBeCloseTo(hs.x[i]!, 9));
        expect(result.objective).toBeCloseTo(hs.objective, 9);
        const gap = gaps(result, reference.solve(hs.qp));
        expect(gap.x).toBeLessThan(1e-9);
        expect(result.primalResidual).toBeLessThan(1e-9);
        expect(result.dualResidual).toBeLessThan(1e-9);
      });
    }
  }
});

describe('fast Goldfarb–Idnani against the reference', () => {
  for (const [label, generator, stream] of [
    ['random strictly convex', randomProblem, 20],
    ['MPC-shaped, with separable slacks', softProblem, 21],
  ] as const) {
    it(`agree to 1e-9 on 300 ${label} problems`, () => {
      const rng = Prng.create(20261102, stream);
      const solvers = VARIANTS.map(([, settings]) => new GoldfarbIdnaniFastSolver(settings));
      const mismatches: string[] = [];
      let fixed = 0;
      let released = 0;
      for (let k = 0; k < 300; k++) {
        const qp = generator(rng);
        const b = reference.solve(qp);
        solvers.forEach((solver, v) => {
          const a = solver.solve(qp);
          fixed += solver.stats.fixed;
          released += solver.stats.released;
          const gap = gaps(a, b);
          const r = residuals(qp, a.x, a.y);
          const ok =
            a.status === b.status &&
            (a.status !== 'solved' || (gap.x <= 1e-9 && gap.objective <= 1e-9 && Math.max(r.primal, r.dual) <= 1e-7));
          if (!ok && mismatches.length < 5) {
            mismatches.push(
              `#${k} ${VARIANTS[v]![0]} n=${qp.n} m=${qp.m}: ${a.status}/${b.status}, |Δx|=${gap.x.toExponential(2)}, ` +
                `|Δf|=${gap.objective.toExponential(2)}, residuals ${r.primal.toExponential(2)}/${r.dual.toExponential(2)}`,
            );
          }
        });
      }
      expect(mismatches).toEqual([]);
      if (generator === softProblem) {
        // The MPC-shaped problems do exercise the fixed bounds and their release.
        expect(fixed).toBeGreaterThan(300);
        expect(released).toBeGreaterThan(30);
      }
    }, 120_000);
  }

  it('report infeasible problems as the reference does', () => {
    const cases = [
      // An empty row that excludes zero.
      problem(
        [
          [1, 0],
          [0, 1],
        ],
        [1, 1],
        [[0, 0]],
        [1],
        [2],
      ),
      // x₁ ≥ 1 and x₁ ≤ 0.
      problem(
        [
          [1, 0],
          [0, 1],
        ],
        [0, 0],
        [
          [1, 0],
          [1, 0],
        ],
        [1, -INF],
        [INF, 0],
      ),
      // Two incompatible equalities.
      problem(
        [
          [2, 0],
          [0, 2],
        ],
        [0, 0],
        [
          [1, 1],
          [1, 1],
        ],
        [1, 2],
        [1, 2],
      ),
      // A separable slack s ∈ [0, 1] (fixed at 0 at the start) and x ≥ 0, with x + s ≤ −10.
      problem(
        [
          [1, 0],
          [0, 4],
        ],
        [0, 10],
        [
          [0, 1],
          [0, 1],
          [1, 0],
          [1, 1],
        ],
        [0, -INF, 0, -INF],
        [INF, 1, INF, -10],
      ),
    ];
    for (const qp of cases) {
      expect(reference.solve(qp).status).toBe('infeasible');
      for (const [, settings] of VARIANTS)
        expect(new GoldfarbIdnaniFastSolver(settings).solve(qp).status).toBe('infeasible');
    }
  });

  it('stop on the iteration cap and say so', () => {
    const qp = HOCK_SCHITTKOWSKI[2]!.qp;
    const capped = new GoldfarbIdnaniFastSolver({ maxIterations: 1 }).solve(qp);
    expect(capped.status).toBe('maxIterations');
    expect(capped.iterations).toBe(2);
    expect(new GoldfarbIdnaniSolver({ maxIterations: 1 }).solve(qp).iterations).toBe(2);
  });

  it('are deterministic, and a reused solver keeps nothing from the previous problem', () => {
    const rng = Prng.create(20261102, 22);
    const qps = Array.from({ length: 60 }, (_, k) => (k % 2 ? softProblem(rng) : randomProblem(rng)));
    const reused = new GoldfarbIdnaniFastSolver();
    const first = qps.map((qp) => reused.solve(qp));
    const again = qps.map((qp) => reused.solve(qp));
    const fresh = qps.map((qp) => new GoldfarbIdnaniFastSolver().solve(qp));
    for (const other of [again, fresh]) {
      other.forEach((r, k) => {
        expect(Array.from(r.x)).toEqual(Array.from(first[k]!.x));
        expect(Array.from(r.y)).toEqual(Array.from(first[k]!.y));
      });
    }
  });
});

/** The step QPs of the whole M3 run (60 km/h, dry), driven by the exact solver, and its plans. */
function m3Run(): { ocps: OcpQp[]; exact: StepSolution[] } {
  const car = VEHICLES.car;
  const speed = 60 / 3.6;
  const course = isoLaneChange(car, speed);
  const road = new RoadPath({ segments: [{ kind: 'straight', length: 400 }], width: { left: 6, right: 3 } });
  const vehicle = new Vehicle(car, uniformSurface('dry'));
  vehicle.reset(0, 0, 0, speed);
  const ocps: OcpQp[] = [];
  const exact: StepSolution[] = [];
  const solver = new CondensedStepSolver('gi', new GoldfarbIdnaniSolver());
  const recorder = {
    name: 'recorder',
    solve(ocp: OcpQp) {
      const solution = solver.solve(ocp);
      ocps.push(ocp);
      exact.push(solution);
      return solution;
    },
    reset: () => solver.reset(),
  };
  const driver = new MpcDriver(car, 1, road, course.corridor, course.reference, { solver: recorder });
  runClosedLoop(
    vehicle,
    {
      periodTicks: driver.periodTicks,
      delayTicks: driver.delayTicks,
      compute: (t, v, out) => driver.compute(t, v, out),
    },
    { ticks: ticksFor(20), until: (_t, v) => (v.plant.chassis[CHASSIS.X] ?? 0) > course.end },
  );
  return { ocps, exact };
}

describe('fast Goldfarb–Idnani on the step QPs of the M3 lane change', () => {
  const { ocps, exact } = m3Run();

  it('condenses into the same QP as the shared Condenser', () => {
    const condenser = new Condenser();
    const own = new RowCondenser();
    expect(ocps.length).toBeGreaterThan(100);
    for (const ocp of ocps.filter((_, i) => i % 5 === 0)) {
      const dense = condenser.lower(ocp);
      const rows = own.lower(ocp);
      expect([rows.n, rows.m]).toEqual([dense.n, dense.m]);
      const pScale = Math.max(...Array.from(dense.P, Math.abs));
      dense.P.forEach((p, k) => expect(Math.abs(rows.P[k]! - p)).toBeLessThan(1e-12 * pScale));
      const qScale = Math.max(1, ...Array.from(dense.q, Math.abs));
      dense.q.forEach((v, k) => expect(Math.abs(rows.q[k]! - v)).toBeLessThan(1e-12 * qScale));
      // P exactly symmetric.
      for (let a = 0; a < rows.n; a++)
        for (let b = 0; b < a; b++) expect(rows.P[a * rows.n + b]).toBe(rows.P[b * rows.n + a]);
      const A = new Float64Array(rows.m * rows.n);
      for (let i = 0; i < rows.m; i++) {
        for (let e = rows.rowStart[i]!; e < rows.rowStart[i + 1]!; e++)
          A[i * rows.n + rows.rowIndex[e]!] = rows.rowValue[e]!;
      }
      const aScale = Math.max(...Array.from(dense.A, Math.abs));
      dense.A.forEach((v, k) => expect(Math.abs(A[k]! - v)).toBeLessThan(1e-12 * aScale));
      expect(Array.from(rows.l)).toEqual(Array.from(dense.l));
      expect(Array.from(rows.u)).toEqual(Array.from(dense.u));
    }
  }, 30_000);

  it('agrees with the reference to 1e-9 on each QP, in every variant and step solver', () => {
    const condenser = new Condenser();
    const solvers = VARIANTS.map(([label, settings]) => ({ label, solver: new GoldfarbIdnaniFastSolver(settings) }));
    ocps.forEach((ocp, i) => {
      const qp = condenser.lower(ocp);
      const b = reference.solve(qp);
      for (const { label, solver } of solvers) {
        const a = solver.solve(qp);
        const gap = gaps(a, b);
        expect(a.status, `${label} #${i}`).toBe('solved');
        expect(gap.x, `${label} #${i}`).toBeLessThan(1e-9);
        expect(gap.objective, `${label} #${i}`).toBeLessThan(1e-9);
      }
    });
    const steps = [new GiStepSolver('bounds eliminated'), new GiStepSolver('plain', { settings: VARIANTS[0]![1] })];
    for (const step of steps) {
      ocps.forEach((ocp, i) => {
        const a = step.solve(ocp);
        const b = exact[i]!;
        const scale = Math.max(1, ...Array.from(b.du, Math.abs));
        let du = 0;
        b.du.forEach((v, j) => (du = Math.max(du, Math.abs(a.du[j]! - v))));
        expect(a.status, `${step.name} #${i}`).toBe('solved');
        expect(du / scale, `${step.name} #${i}`).toBeLessThan(1e-9);
        expect(Math.abs(a.objective - b.objective) / Math.max(1, Math.abs(b.objective))).toBeLessThan(1e-9);
      });
    }
    // Every QP of the lane change, two variants and two step solvers: over 12 s with the full suite in parallel.
  }, 60_000);

  it('starts with every slack fixed at its bound', () => {
    // If mpc.ts coupled the slacks (cross costs, equalities), the answer would not change but each slack would
    // cost an iteration again, about 8 times slower: this test says so.
    const condenser = new RowCondenser();
    const solver = new GoldfarbIdnaniFastSolver();
    for (const ocp of ocps) {
      solver.solveRows(condenser.lower(ocp));
      expect(solver.stats.fixed).toBe(ocp.slacks);
    }
  });

  it('gives the same plans to the bit on every pass', () => {
    const passes = [new GiStepSolver('a'), new GiStepSolver('b')].map((step) => ocps.map((ocp) => step.solve(ocp).du));
    passes[1]!.forEach((du, i) => expect(Array.from(du)).toEqual(Array.from(passes[0]![i]!)));
  });
});
