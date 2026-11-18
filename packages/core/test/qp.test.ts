/**
 * Milestone M2 (Phase 2), the oracle's side: the Goldfarb–Idnani reference reaches the published
 * optima of small problems of the Hock–Schittkowski set (part of Maros–Mészáros) and satisfies the optimality
 * conditions on random strictly convex QPs. The MPC's solver agrees with it to 1e-9 (qp-gi-fast.test.ts).
 */
import { describe, expect, it } from 'vitest';

import { GoldfarbIdnaniSolver, Prng, residuals, type QpProblem } from '../src/index.ts';

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

/** The published optima, constant terms of the objectives dropped. */
const HOCK_SCHITTKOWSKI = [
  {
    name: 'HS21',
    // min 0.01·x1² + x2² − 100,  10·x1 − x2 ≥ 10,  2 ≤ x1 ≤ 50,  −50 ≤ x2 ≤ 50
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
    // min 9 − 8x1 − 6x2 − 4x3 + 2x1² + 2x2² + x3² + 2x1x2 + 2x1x3,  x1 + x2 + 2x3 ≤ 3,  x ≥ 0
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
    // min x1² + ½x2² + x3² + ½x4² − x1x3 + x3x4 − x1 − 3x2 + x3 − x4, three linear constraints, x ≥ 0
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

describe('M2 Goldfarb–Idnani reference on Hock–Schittkowski problems', () => {
  for (const hs of HOCK_SCHITTKOWSKI) {
    it(`reaches the published optimum of ${hs.name}`, () => {
      const result = reference.solve(hs.qp);
      expect(result.status).toBe('solved');
      result.x.forEach((xi, i) => expect(xi).toBeCloseTo(hs.x[i] ?? 0, 6));
      expect(result.objective).toBeCloseTo(hs.objective, 6);
      expect(result.primalResidual).toBeLessThan(1e-7);
      expect(result.dualResidual).toBeLessThan(1e-7);
    });
  }
});

/** A strictly convex QP with a known feasible point, mixing two-sided, one-sided and equality rows. */
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

describe('M2 Goldfarb–Idnani reference on random strictly convex problems', () => {
  it('satisfies the optimality conditions on 200 problems', () => {
    const rng = Prng.create(20261102, 10);
    const mismatches: string[] = [];
    for (let k = 0; k < 200; k++) {
      const qp = randomProblem(rng);
      const b = reference.solve(qp);
      const rb = residuals(qp, b.x, b.y);
      // Dual feasibility: a multiplier is negative only on a finite lower bound, positive only on an upper one.
      let signs = true;
      for (let i = 0; i < qp.m; i++) {
        if ((qp.l[i] ?? 0) === (qp.u[i] ?? 0)) continue;
        if ((b.y[i] ?? 0) < -1e-9 && !Number.isFinite(qp.l[i] ?? -INF)) signs = false;
        if ((b.y[i] ?? 0) > 1e-9 && !Number.isFinite(qp.u[i] ?? INF)) signs = false;
      }
      // Complementarity: a row that is not at a bound carries no multiplier.
      let complementary = true;
      for (let i = 0; i < qp.m; i++) {
        let ax = 0;
        for (let j = 0; j < qp.n; j++) ax += (qp.A[i * qp.n + j] ?? 0) * (b.x[j] ?? 0);
        const room = Math.min(ax - (qp.l[i] ?? -INF), (qp.u[i] ?? INF) - ax);
        if (room > 1e-6 && Math.abs(b.y[i] ?? 0) > 1e-9) complementary = false;
      }
      const ok = b.status === 'solved' && Math.max(rb.primal, rb.dual) <= 1e-6 && signs && complementary;
      if (!ok && mismatches.length < 5) {
        mismatches.push(
          `#${k} n=${qp.n} m=${qp.m}: ${b.status}, residuals ${Math.max(rb.primal, rb.dual).toExponential(2)}, ` +
            `signs ${signs}, complementary ${complementary}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  }, 120_000);
});
