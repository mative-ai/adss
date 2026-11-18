/**
 * Goldfarb–Idnani dual active-set method for strictly convex QPs (Goldfarb and Idnani, "A numerically stable
 * dual method for solving strictly convex quadratic programs", Mathematical Programming 27, 1983): the
 * reference of the tests and the first fallback in the choice of the MPC's solver. It starts from the
 * unconstrained minimum and adds the most violated constraint at each step, keeping J = L⁻ᵀ·Q and the triangular R
 * of the active constraints up to date with Givens rotations. Exact up to rounding; needs P positive definite.
 *
 * Constraints are taken as nᵀx + c ≥ 0 (inequalities) and nᵀx + c = 0 (equalities): each row of l ≤ Ax ≤ u
 * becomes one equality (l = u) or up to two inequalities.
 *
 * The code follows the structure of QuadProg++ by Luca Di Gaspero (MIT License, copyright (c) 2007-2016 Luca Di
 * Gaspero): the termination test on ψ, the Givens updates with xny = s/(1 + c), the restore of step 1 after a
 * numerically dependent constraint. Its notice ships with the bundle's license notices.
 */
import { cholesky, choleskySolve } from '../math/dense.ts';
import { objective, residuals, type QpProblem, type QpResult, type QpSolver } from './problem.ts';

const EPS = Number.EPSILON;

export interface GoldfarbIdnaniSettings {
  /** Cap on the active-set changes. */
  readonly maxIterations: number;
}

export class GoldfarbIdnaniSolver implements QpSolver {
  readonly settings: GoldfarbIdnaniSettings;

  constructor(settings: Partial<GoldfarbIdnaniSettings> = {}) {
    this.settings = { maxIterations: 1000, ...settings };
  }

  solve(problem: QpProblem): QpResult {
    const { n, m, P, q, A, l, u } = problem;

    // A row of zeros constrains nothing when 0 is within its bounds, and makes the problem infeasible otherwise.
    const zeroRow = new Uint8Array(m);
    for (let i = 0; i < m; i++) {
      let empty = true;
      for (let j = 0; j < n && empty; j++) empty = (A[i * n + j] ?? 0) === 0;
      if (!empty) continue;
      if ((l[i] ?? 0) > 0 || (u[i] ?? 0) < 0) return this.failure(problem, 'infeasible', 0);
      zeroRow[i] = 1;
    }

    // Constraint list: equalities first, then inequalities. side: 0 equality, −1 lower, +1 upper.
    const rowOf: number[] = [];
    const sideOf: number[] = [];
    for (let i = 0; i < m; i++) {
      if (l[i] === u[i] && !zeroRow[i]) {
        rowOf.push(i);
        sideOf.push(0);
      }
    }
    const me = rowOf.length;
    for (let i = 0; i < m; i++) {
      if (l[i] === u[i] || zeroRow[i]) continue;
      if (Number.isFinite(l[i] ?? -Infinity)) {
        rowOf.push(i);
        sideOf.push(-1);
      }
      if (Number.isFinite(u[i] ?? Infinity)) {
        rowOf.push(i);
        sideOf.push(1);
      }
    }
    const total = rowOf.length;
    const normals = new Float64Array(total * n);
    const offsets = new Float64Array(total);
    for (let c = 0; c < total; c++) {
      const row = rowOf[c] ?? 0;
      const side = sideOf[c] ?? 0;
      const sign = side > 0 ? -1 : 1;
      for (let j = 0; j < n; j++) normals[c * n + j] = sign * (A[row * n + j] ?? 0);
      offsets[c] = side > 0 ? (u[row] ?? 0) : -(l[row] ?? 0);
    }

    const L = P.slice();
    if (!cholesky(L, n)) return this.failure(problem, 'failed', 0);
    let c1 = 0;
    for (let i = 0; i < n; i++) c1 += P[i * n + i] ?? 0;

    // J = L⁻ᵀ (upper triangular): row i of J is column i of L⁻¹, found by forward substitution on e_i.
    const J = new Float64Array(n * n);
    const column = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      column.fill(0);
      column[i] = 1;
      for (let r = 0; r < n; r++) {
        let s = column[r] ?? 0;
        for (let k = 0; k < r; k++) s -= (L[r * n + k] ?? 0) * (column[k] ?? 0);
        column[r] = s / (L[r * n + r] ?? 1);
      }
      for (let r = 0; r < n; r++) J[i * n + r] = column[r] ?? 0;
    }
    let c2 = 0;
    for (let i = 0; i < n; i++) c2 += J[i * n + i] ?? 0;

    const x = new Float64Array(n);
    for (let j = 0; j < n; j++) x[j] = -(q[j] ?? 0);
    choleskySolve(L, n, x);

    const R = new Float64Array(n * n);
    const d = new Float64Array(n);
    const z = new Float64Array(n);
    const r = new Float64Array(n + 1);
    const slots = Math.min(total, n) + 1;
    const active = new Int32Array(slots + 1);
    const mult = new Float64Array(slots + 1);
    let iq = 0;
    let rNorm = 1;
    const np = new Float64Array(n);

    const computeD = () => {
      for (let j = 0; j < n; j++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += (J[i * n + j] ?? 0) * (np[i] ?? 0);
        d[j] = s;
      }
    };
    const updateZ = () => {
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let k = iq; k < n; k++) s += (J[i * n + k] ?? 0) * (d[k] ?? 0);
        z[i] = s;
      }
    };
    const updateR = () => {
      for (let i = iq - 1; i >= 0; i--) {
        let s = d[i] ?? 0;
        for (let k = i + 1; k < iq; k++) s -= (R[i * n + k] ?? 0) * (r[k] ?? 0);
        r[i] = s / (R[i * n + i] ?? 1);
      }
    };
    const dot = (a: Float64Array, b: Float64Array) => {
      let s = 0;
      for (let j = 0; j < n; j++) s += (a[j] ?? 0) * (b[j] ?? 0);
      return s;
    };
    const loadNormal = (c: number) => {
      for (let j = 0; j < n; j++) np[j] = normals[c * n + j] ?? 0;
    };
    const slack = (c: number) => {
      let s = offsets[c] ?? 0;
      for (let j = 0; j < n; j++) s += (normals[c * n + j] ?? 0) * (x[j] ?? 0);
      return s;
    };

    /** Adds the constraint whose d = Jᵀ·n is in `d`: zeroes d below position iq with Givens rotations. */
    const addConstraint = (): boolean => {
      for (let j = n - 1; j >= iq + 1; j--) {
        let cc = d[j - 1] ?? 0;
        let ss = d[j] ?? 0;
        const h = Math.hypot(cc, ss);
        if (h === 0) continue;
        d[j] = 0;
        ss /= h;
        cc /= h;
        if (cc < 0) {
          cc = -cc;
          ss = -ss;
          d[j - 1] = -h;
        } else {
          d[j - 1] = h;
        }
        const xny = ss / (1 + cc);
        for (let k = 0; k < n; k++) {
          const t1 = J[k * n + j - 1] ?? 0;
          const t2 = J[k * n + j] ?? 0;
          const updated = t1 * cc + t2 * ss;
          J[k * n + j - 1] = updated;
          J[k * n + j] = xny * (t1 + updated) - t2;
        }
      }
      iq++;
      for (let i = 0; i < iq; i++) R[i * n + iq - 1] = d[i] ?? 0;
      const pivot = Math.abs(d[iq - 1] ?? 0);
      if (pivot <= EPS * rNorm) return false;
      rNorm = Math.max(rNorm, pivot);
      return true;
    };

    /** Removes constraint `c` from the active set and restores R to triangular form. */
    const deleteConstraint = (c: number) => {
      let qq = -1;
      for (let i = me; i < iq; i++) {
        if (active[i] === c) {
          qq = i;
          break;
        }
      }
      if (qq < 0) return;
      for (let i = qq; i < iq - 1; i++) {
        active[i] = active[i + 1] ?? 0;
        mult[i] = mult[i + 1] ?? 0;
        for (let j = 0; j < n; j++) R[j * n + i] = R[j * n + i + 1] ?? 0;
      }
      active[iq - 1] = active[iq] ?? 0;
      mult[iq - 1] = mult[iq] ?? 0;
      active[iq] = 0;
      mult[iq] = 0;
      for (let j = 0; j < iq; j++) R[j * n + iq - 1] = 0;
      iq--;
      if (iq === 0) return;
      for (let j = qq; j < iq; j++) {
        let cc = R[j * n + j] ?? 0;
        let ss = R[(j + 1) * n + j] ?? 0;
        const h = Math.hypot(cc, ss);
        if (h === 0) continue;
        cc /= h;
        ss /= h;
        R[(j + 1) * n + j] = 0;
        if (cc < 0) {
          R[j * n + j] = -h;
          cc = -cc;
          ss = -ss;
        } else {
          R[j * n + j] = h;
        }
        const xny = ss / (1 + cc);
        for (let k = j + 1; k < iq; k++) {
          const t1 = R[j * n + k] ?? 0;
          const t2 = R[(j + 1) * n + k] ?? 0;
          const updated = t1 * cc + t2 * ss;
          R[j * n + k] = updated;
          R[(j + 1) * n + k] = xny * (t1 + updated) - t2;
        }
        for (let k = 0; k < n; k++) {
          const t1 = J[k * n + j] ?? 0;
          const t2 = J[k * n + j + 1] ?? 0;
          const updated = t1 * cc + t2 * ss;
          J[k * n + j] = updated;
          J[k * n + j + 1] = xny * (updated + t1) - t2;
        }
      }
    };

    // Equalities: a full step onto each, in order.
    for (let c = 0; c < me; c++) {
      loadNormal(c);
      computeD();
      updateZ();
      updateR();
      const zn = dot(z, np);
      const t2 = Math.abs(dot(z, z)) > EPS ? -slack(c) / zn : 0;
      for (let j = 0; j < n; j++) x[j] = (x[j] ?? 0) + t2 * (z[j] ?? 0);
      mult[iq] = t2;
      for (let k = 0; k < iq; k++) mult[k] = (mult[k] ?? 0) - t2 * (r[k] ?? 0);
      active[iq] = c;
      if (!addConstraint()) return this.failure(problem, 'infeasible', 0);
    }

    // Inequalities.
    const mi = total - me;
    const candidate = new Int32Array(total);
    const included = new Uint8Array(total);
    const s = new Float64Array(total);
    for (let c = me; c < total; c++) candidate[c] = c;
    const oldActive = new Int32Array(slots + 1);
    const oldMult = new Float64Array(slots + 1);
    const oldX = new Float64Array(n);

    let iterations = 0;
    for (;;) {
      // Step 1: constraint values; stop when none is violated.
      iterations++;
      if (iterations > this.settings.maxIterations)
        return this.finish(problem, x, rowOf, sideOf, active, mult, iq, 'maxIterations', iterations);
      for (let i = me; i < iq; i++) candidate[active[i] ?? 0] = -1;
      let psi = 0;
      for (let c = me; c < total; c++) {
        included[c] = 1;
        s[c] = slack(c);
        psi += Math.min(0, s[c] ?? 0);
      }
      if (Math.abs(psi) <= mi * EPS * c1 * c2 * 100) break;
      oldActive.set(active);
      oldMult.set(mult);
      oldX.set(x);

      let restart = false;
      for (;;) {
        // Step 2: the most violated candidate.
        let worst = 0;
        let ip = -1;
        for (let c = me; c < total; c++) {
          if ((s[c] ?? 0) < worst && candidate[c] !== -1 && included[c]) {
            worst = s[c] ?? 0;
            ip = c;
          }
        }
        if (ip < 0) return this.finish(problem, x, rowOf, sideOf, active, mult, iq, 'solved', iterations);
        loadNormal(ip);
        mult[iq] = 0;
        active[iq] = ip;

        for (;;) {
          // Step 2a: primal and dual directions.
          computeD();
          updateZ();
          updateR();
          // Step 2b: dual step to keep the multipliers non-negative, primal step to satisfy constraint ip.
          let t1 = Infinity;
          let drop = -1;
          for (let k = me; k < iq; k++) {
            const rk = r[k] ?? 0;
            if (rk > 0) {
              const ratio = (mult[k] ?? 0) / rk;
              if (ratio < t1) {
                t1 = ratio;
                drop = active[k] ?? -1;
              }
            }
          }
          const zn = dot(z, np);
          const t2 = Math.abs(dot(z, z)) > EPS ? -(s[ip] ?? 0) / zn : Infinity;
          const t = Math.min(t1, t2);
          if (t === Infinity) return this.finish(problem, x, rowOf, sideOf, active, mult, iq, 'infeasible', iterations);

          if (t2 === Infinity) {
            // Step in the dual space only.
            for (let k = 0; k < iq; k++) mult[k] = (mult[k] ?? 0) - t * (r[k] ?? 0);
            mult[iq] = (mult[iq] ?? 0) + t;
            candidate[drop] = drop;
            deleteConstraint(drop);
            continue;
          }

          for (let j = 0; j < n; j++) x[j] = (x[j] ?? 0) + t * (z[j] ?? 0);
          for (let k = 0; k < iq; k++) mult[k] = (mult[k] ?? 0) - t * (r[k] ?? 0);
          mult[iq] = (mult[iq] ?? 0) + t;

          if (t === t2) {
            // Full step: constraint ip joins the active set.
            if (!addConstraint()) {
              // Numerically dependent: exclude it and restore the state of step 1.
              included[ip] = 0;
              deleteConstraint(ip);
              for (let c = me; c < total; c++) candidate[c] = c;
              for (let i = me; i < iq; i++) {
                active[i] = oldActive[i] ?? 0;
                mult[i] = oldMult[i] ?? 0;
                candidate[active[i] ?? 0] = -1;
              }
              x.set(oldX);
              break;
            }
            candidate[ip] = -1;
            restart = true;
            break;
          }

          // Partial step: drop the constraint that limited it, and try again with ip.
          candidate[drop] = drop;
          deleteConstraint(drop);
          s[ip] = slack(ip);
        }
        if (restart) break;
      }
    }
    return this.finish(problem, x, rowOf, sideOf, active, mult, iq, 'solved', iterations);
  }

  private finish(
    problem: QpProblem,
    x: Float64Array,
    rowOf: readonly number[],
    sideOf: readonly number[],
    active: Int32Array,
    mult: Float64Array,
    iq: number,
    status: QpResult['status'],
    iterations: number,
  ): QpResult {
    // Stationarity of this method: Px + q = Σ u·n; OSQP's sign is y = −u on lower bounds and equalities, +u on upper.
    const y = new Float64Array(problem.m);
    for (let k = 0; k < iq; k++) {
      const c = active[k] ?? 0;
      const row = rowOf[c] ?? 0;
      const side = sideOf[c] ?? 0;
      y[row] = (y[row] ?? 0) + (side > 0 ? 1 : -1) * (mult[k] ?? 0);
    }
    const out = x.slice();
    const r = residuals(problem, out, y);
    return {
      status,
      x: out,
      y,
      iterations,
      objective: objective(problem, out),
      primalResidual: r.primal,
      dualResidual: r.dual,
    };
  }

  private failure(problem: QpProblem, status: QpResult['status'], iterations: number): QpResult {
    return {
      status,
      x: new Float64Array(problem.n).fill(Number.NaN),
      y: new Float64Array(problem.m).fill(Number.NaN),
      iterations,
      objective: Number.NaN,
      primalResidual: Infinity,
      dualResidual: Infinity,
    };
  }
}
