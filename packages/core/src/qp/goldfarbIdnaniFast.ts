/**
 * Goldfarb–Idnani, fast: the same dual active-set method as goldfarbIdnani.ts, the
 * reference, with the same steps and the same answers up to rounding, organized for the step QPs of the MPC.
 * - Rows are kept compressed: a constraint's value and d = Jᵀ·n cost one product per nonzero, not per variable,
 *   and step 1 evaluates each row once for both of its sides. Without the options below the method takes the
 *   reference's path, and its iterates differ from the reference's by rounding only.
 * - J = L⁻ᵀ·Q is stored by columns, so its updates run on contiguous memory, and the inactive part J₂ is
 *   reflected (Householder) when a constraint is tried, which gives the primal direction as one column and makes
 *   the add free of rotations (reflect).
 * - `eliminateBounds`: a separable variable (no coupling in P, in no equality) whose unconstrained minimum
 *   violates one of its simple bounds starts fixed at that bound, out of J and R: the slacks of the soft rows,
 *   which sit at zero in most steps. The bound stays active with a multiplier kept by stationarity in that
 *   coordinate; when the multiplier reaches zero (the method's usual drop), the variable joins the free ones and
 *   one row of Givens rotations brings R back to triangular form. Starting with these bounds active keeps the
 *   start dual feasible, so the method and its optimum are unchanged; it saves one iteration per bound and makes
 *   J smaller while the slacks are fixed.
 * It starts cold: a warm active set from the previous step did not pay on the MPC's QPs. It stops on
 * its iteration cap only (CLAUDE.md §8). The solver keeps its workspace between solves: one instance serves one
 * caller at a time.
 *
 * Like the reference, it follows the structure of QuadProg++ by Luca Di Gaspero (MIT License, copyright (c)
 * 2007-2016 Luca Di Gaspero): the termination test on ψ, the Givens updates with xny = s/(1 + c), the restore of
 * step 1 after a numerically dependent constraint. Its notice ships with the bundle's license notices.
 */
import { cholesky, choleskySolve } from '../math/dense.ts';
import { rowsFromDense, type RowQpProblem } from './giRows.ts';
import type { QpProblem, QpResult, QpSolver, QpStatus } from './problem.ts';

const EPS = Number.EPSILON;

export interface GoldfarbIdnaniFastSettings {
  /** Cap on the active-set changes, as in the reference. */
  readonly maxIterations: number;
  /** Starts separable variables at their violated simple bound, outside J and R until the bound drops. */
  readonly eliminateBounds: boolean;
}

export const GI_FAST_DEFAULTS: GoldfarbIdnaniFastSettings = {
  maxIterations: 1000,
  eliminateBounds: true,
};

/** What one solve did, for the benchmark and the tests. */
export interface GoldfarbIdnaniFastStats {
  /** Variables fixed at a bound at the start, and those released later. */
  fixed: number;
  released: number;
  /** Constraints dropped from the active set, and the size of the active set at the end (bounds included). */
  dropped: number;
  active: number;
}

/** Grows a typed array to at least `size` entries, keeping nothing: workspaces are filled before use. */
function f64(a: Float64Array, size: number): Float64Array {
  return a.length >= size ? a : new Float64Array(size);
}
function i32(a: Int32Array, size: number): Int32Array {
  return a.length >= size ? a : new Int32Array(size);
}
function u8(a: Uint8Array, size: number): Uint8Array {
  return a.length >= size ? a : new Uint8Array(size);
}

export class GoldfarbIdnaniFastSolver implements QpSolver {
  readonly settings: GoldfarbIdnaniFastSettings;
  /** Counters of the last solve. */
  readonly stats: GoldfarbIdnaniFastStats = { fixed: 0, released: 0, dropped: 0, active: 0 };

  // Problem of the current solve.
  private n = 0;
  private P = new Float64Array(0);
  private rs = new Int32Array(1);
  private ri = new Int32Array(0);
  private rv = new Float64Array(0);
  // Constraints nᵀx + offset ≥ 0 (= 0 for the first `me`): row, sign of the row in the normal, offset.
  private cRow = new Int32Array(0);
  private cSign = new Float64Array(0);
  private cOff = new Float64Array(0);
  private me = 0;
  private total = 0;
  // Free variables: position in J of each variable (−1 when fixed) and the variable at each position.
  private pos = new Int32Array(0);
  private varAt = new Int32Array(0);
  private nF = 0;
  // Fixed variables: the constraint holding each (−1 when free), its normal's entry, multiplier and dual step.
  private fixC = new Int32Array(0);
  private fixN = new Float64Array(0);
  private uB = new Float64Array(0);
  private rB = new Float64Array(0);
  private fixedList = new Int32Array(0);
  private nB = 0;
  // Method state. J by columns (column c at c·n), R row-major with stride n.
  private Jt = new Float64Array(0);
  private R = new Float64Array(0);
  private d = new Float64Array(0);
  private z = new Float64Array(0);
  private r = new Float64Array(0);
  private x = new Float64Array(0);
  private active = new Int32Array(0);
  private mult = new Float64Array(0);
  private iq = 0;
  private rNorm = 1;
  // The normal being added, over the free positions.
  private npPos = new Int32Array(0);
  private npVal = new Float64Array(0);
  private npLen = 0;
  // Per constraint.
  private s = new Float64Array(0);
  /** Row values A·x, per row. */
  private ax = new Float64Array(0);
  private candidate = new Int32Array(0);
  private included = new Uint8Array(0);
  // Saved at step 1.
  private oldActive = new Int32Array(0);
  private oldMult = new Float64Array(0);
  private oldX = new Float64Array(0);
  private oldUB = new Float64Array(0);
  // Scratch.
  private Lf = new Float64Array(0);
  private column = new Float64Array(0);
  private w = new Float64Array(0);
  private eligible = new Uint8Array(0);

  constructor(settings: Partial<GoldfarbIdnaniFastSettings> = {}) {
    this.settings = { ...GI_FAST_DEFAULTS, ...settings };
  }

  solve(problem: QpProblem): QpResult {
    return this.solveRows(rowsFromDense(problem));
  }

  solveRows(problem: RowQpProblem): QpResult {
    const { n, m, P, q, rowStart: rs, rowIndex: ri, rowValue: rv, l, u } = problem;
    this.stats.fixed = 0;
    this.stats.released = 0;
    this.stats.dropped = 0;
    this.stats.active = 0;
    this.n = n;
    this.P = P;
    this.rs = rs;
    this.ri = ri;
    this.rv = rv;

    // An empty row constrains nothing when 0 is within its bounds, and makes the problem infeasible otherwise.
    for (let i = 0; i < m; i++) {
      if (rs[i] !== rs[i + 1]) continue;
      if (l[i]! > 0 || u[i]! < 0) return this.failure(n, m, 'infeasible', 0);
    }

    // Constraint list, as in the reference: equalities first, then the finite sides of the other rows.
    const cap = 2 * m;
    this.cRow = i32(this.cRow, cap);
    this.cSign = f64(this.cSign, cap);
    this.cOff = f64(this.cOff, cap);
    const { cRow, cSign, cOff } = this;
    let total = 0;
    for (let i = 0; i < m; i++) {
      if (l[i] === u[i] && rs[i] !== rs[i + 1]) {
        cRow[total] = i;
        cSign[total] = 1;
        cOff[total++] = -l[i]!;
      }
    }
    const me = total;
    for (let i = 0; i < m; i++) {
      if (l[i] === u[i] || rs[i] === rs[i + 1]) continue;
      if (Number.isFinite(l[i]!)) {
        cRow[total] = i;
        cSign[total] = 1;
        cOff[total++] = -l[i]!;
      }
      if (Number.isFinite(u[i]!)) {
        cRow[total] = i;
        cSign[total] = -1;
        cOff[total++] = u[i]!;
      }
    }
    this.me = me;
    this.total = total;

    this.allocate(n, total);
    this.ax = f64(this.ax, m);
    const { pos, varAt, fixC, fixN, uB, x } = this;

    // Separable variables at a violated simple bound start fixed there.
    fixC.fill(-1, 0, n);
    this.nB = 0;
    if (this.settings.eliminateBounds) this.fixBounds(problem);
    let nF = 0;
    for (let j = 0; j < n; j++) {
      if (fixC[j]! >= 0) {
        pos[j] = -1;
        continue;
      }
      pos[j] = nF;
      varAt[nF++] = j;
    }
    this.nF = nF;
    this.stats.fixed = this.nB;

    // Cholesky of P over the free variables, J = L⁻ᵀ by columns, and the unconstrained minimum.
    const Lf = this.Lf;
    for (let a = 0; a < nF; a++) {
      const va = varAt[a]!;
      for (let b = 0; b < nF; b++) Lf[a * nF + b] = P[va * n + varAt[b]!]!;
    }
    if (nF > 0 && !cholesky(Lf, nF)) return this.failure(n, m, 'failed', 0);
    let c1 = 0;
    for (let i = 0; i < n; i++) c1 += P[i * n + i]!;
    this.inverseFactor();
    let c2 = 0;
    for (let i = 0; i < nF; i++) c2 += this.Jt[i * n + i]!;

    const xf = this.w;
    for (let a = 0; a < nF; a++) xf[a] = -q[varAt[a]!]!;
    if (nF > 0) choleskySolve(Lf, nF, xf);
    for (let a = 0; a < nF; a++) x[varAt[a]!] = xf[a]!;
    for (let b = 0; b < this.nB; b++) {
      const j = this.fixedList[b]!;
      const c = fixC[j]!;
      // The bound's point, and its multiplier by stationarity in that coordinate.
      x[j] = -cOff[c]! / fixN[j]!;
      uB[j] = (P[j * n + j]! * x[j]! + q[j]!) / fixN[j]!;
    }

    this.R.fill(0, 0, n * n);
    this.active.fill(0);
    this.mult.fill(0);
    this.iq = 0;
    this.rNorm = 1;
    const { z, r, active, mult } = this;

    // Equalities: a full step onto each, in order. Fixed variables are in none of them.
    for (let c = 0; c < me; c++) {
      this.loadNormal(c);
      this.computeD();
      this.reflect();
      this.updateR();
      const zn = this.dotNormal(z);
      const t2 = Math.abs(this.dotZ()) > EPS ? -this.slack(c) / zn : 0;
      this.stepX(t2);
      const iq = this.iq;
      mult[iq] = t2;
      for (let k = 0; k < iq; k++) mult[k] = mult[k]! - t2 * r[k]!;
      active[iq] = c;
      if (!this.addConstraint()) return this.failure(n, m, 'infeasible', 0);
    }

    // Inequalities.
    const mi = total - me;
    const { candidate, included, s, oldActive, oldMult, oldX, oldUB, rB } = this;
    for (let c = me; c < total; c++) {
      candidate[c] = c;
      included[c] = 1;
    }
    for (let b = 0; b < this.nB; b++) candidate[fixC[this.fixedList[b]!]!] = -1;

    let iterations = 0;
    for (;;) {
      // Step 1: constraint values; stop when none is violated.
      iterations++;
      if (iterations > this.settings.maxIterations) return this.finish(problem, 'maxIterations', iterations);
      for (let i = me; i < this.iq; i++) candidate[active[i]!] = -1;
      const psi = this.evaluate(m);
      if (Math.abs(psi) <= mi * EPS * c1 * c2 * 100) break;
      oldActive.set(active);
      oldMult.set(mult);
      oldX.set(x);
      oldUB.set(uB);

      let restart = false;
      for (;;) {
        // Step 2: the most violated candidate.
        const ip = this.mostViolated();
        if (ip < 0) return this.finish(problem, 'solved', iterations);
        this.loadNormal(ip);
        mult[this.iq] = 0;
        active[this.iq] = ip;

        for (;;) {
          // Step 2a: primal and dual directions.
          this.computeD();
          this.reflect();
          this.updateR();
          const iq = this.iq;
          // Step 2b: dual step to keep the multipliers non-negative, primal step to satisfy constraint ip.
          let t1 = Infinity;
          let drop = -1;
          let dropVar = -1;
          for (let k = me; k < iq; k++) {
            const rk = r[k]!;
            if (rk > 0) {
              const ratio = mult[k]! / rk;
              if (ratio < t1) {
                t1 = ratio;
                drop = active[k]!;
              }
            }
          }
          if (this.nB > 0) {
            this.boundSteps(ip);
            for (let b = 0; b < this.nB; b++) {
              const j = this.fixedList[b]!;
              const rj = rB[j]!;
              if (rj > 0) {
                const ratio = uB[j]! / rj;
                if (ratio < t1) {
                  t1 = ratio;
                  drop = fixC[j]!;
                  dropVar = j;
                }
              }
            }
          }
          const zn = this.dotNormal(z);
          const t2 = Math.abs(this.dotZ()) > EPS ? -s[ip]! / zn : Infinity;
          const t = Math.min(t1, t2);
          if (t === Infinity) return this.finish(problem, 'infeasible', iterations);

          if (t2 === Infinity) {
            // Step in the dual space only.
            this.stepDual(t);
            candidate[drop] = drop;
            if (dropVar >= 0) this.release(dropVar, ip);
            else this.deleteConstraint(drop);
            continue;
          }

          this.stepX(t);
          this.stepDual(t);

          if (t === t2) {
            // Full step: constraint ip joins the active set.
            if (!this.addConstraint()) {
              // Numerically dependent: exclude it and restore the state of step 1, as the reference does.
              included[ip] = 0;
              this.deleteConstraint(ip);
              for (let c = me; c < total; c++) candidate[c] = c;
              for (let b = 0; b < this.nB; b++) candidate[fixC[this.fixedList[b]!]!] = -1;
              for (let i = me; i < this.iq; i++) {
                active[i] = oldActive[i]!;
                mult[i] = oldMult[i]!;
                candidate[active[i]!] = -1;
              }
              x.set(oldX);
              for (let b = 0; b < this.nB; b++) {
                const j = this.fixedList[b]!;
                uB[j] = oldUB[j]!;
              }
              break;
            }
            candidate[ip] = -1;
            restart = true;
            break;
          }

          // Partial step: drop the constraint that limited it, and try again with ip.
          candidate[drop] = drop;
          if (dropVar >= 0) this.release(dropVar, ip);
          else this.deleteConstraint(drop);
          s[ip] = this.slack(ip);
        }
        if (restart) break;
      }
    }
    return this.finish(problem, 'solved', iterations);
  }

  /** Sizes the workspaces for n variables and `total` constraints. */
  private allocate(n: number, total: number): void {
    const nn = n * n;
    this.pos = i32(this.pos, n);
    this.varAt = i32(this.varAt, n);
    this.fixC = i32(this.fixC, n);
    this.fixN = f64(this.fixN, n);
    this.uB = f64(this.uB, n);
    this.rB = f64(this.rB, n);
    this.fixedList = i32(this.fixedList, n);
    this.Jt = f64(this.Jt, nn);
    this.R = f64(this.R, nn);
    this.d = f64(this.d, n);
    this.z = f64(this.z, n);
    this.r = f64(this.r, n + 1);
    this.x = f64(this.x, n);
    this.active = i32(this.active, n + 2);
    this.mult = f64(this.mult, n + 2);
    this.oldActive = i32(this.oldActive, n + 2);
    this.oldMult = f64(this.oldMult, n + 2);
    // The saved copies take whole arrays: keep them the same length as what they copy.
    if (this.oldActive.length !== this.active.length) this.oldActive = new Int32Array(this.active.length);
    if (this.oldMult.length !== this.mult.length) this.oldMult = new Float64Array(this.mult.length);
    if (this.oldX.length !== this.x.length) this.oldX = new Float64Array(this.x.length);
    if (this.oldUB.length !== this.uB.length) this.oldUB = new Float64Array(this.uB.length);
    this.npPos = i32(this.npPos, n);
    this.npVal = f64(this.npVal, n);
    this.s = f64(this.s, total);
    this.candidate = i32(this.candidate, total);
    this.included = u8(this.included, total);
    this.Lf = f64(this.Lf, nn);
    this.column = f64(this.column, n);
    this.w = f64(this.w, n);
    this.eligible = u8(this.eligible, n);
    this.x.fill(0);
  }

  /**
   * Marks the separable variables (P has only its diagonal on their row and column, and no equality uses them)
   * whose unconstrained minimum −q/p violates a single-entry row: each is fixed at the tightest such bound.
   */
  private fixBounds(problem: RowQpProblem): void {
    const { n, m, P, q, rowStart: rs, rowIndex: ri, rowValue: rv, l, u } = problem;
    const { fixC, fixN, cRow, cSign, cOff, me, total } = this;
    const eligible = this.eligible;
    for (let j = 0; j < n; j++) {
      let separable = P[j * n + j]! > 0;
      for (let k = 0; k < n && separable; k++) if (k !== j && P[j * n + k] !== 0) separable = false;
      eligible[j] = separable ? 1 : 0;
    }
    for (let i = 0; i < m; i++) {
      if (l[i] !== u[i]) continue;
      for (let e = rs[i]!; e < rs[i + 1]!; e++) eligible[ri[e]!] = 0;
    }
    const best = this.column;
    for (let c = me; c < total; c++) {
      const row = cRow[c]!;
      if (rs[row]! + 1 !== rs[row + 1]) continue;
      const j = ri[rs[row]!]!;
      if (!eligible[j]) continue;
      const nj = cSign[c]! * rv[rs[row]!]!;
      const free = -q[j]! / P[j * n + j]!;
      if (nj * free + cOff[c]! >= 0) continue;
      // Violated at the minimum: the bound value; for the same side, the tightest bound wins.
      const value = -cOff[c]! / nj;
      const previous = fixC[j]!;
      if (previous >= 0) {
        const tighter = nj > 0 ? value > best[j]! : value < best[j]!;
        if (fixN[j]! * nj < 0 || !tighter) continue;
      } else {
        this.fixedList[this.nB++] = j;
      }
      fixC[j] = c;
      fixN[j] = nj;
      best[j] = value;
    }
    // Keep the list in variable order, so that the release order does not depend on the rows' order.
    const list = this.fixedList.subarray(0, this.nB);
    list.sort();
  }

  /** J = L⁻ᵀ by columns, from the Cholesky factor in Lf: row i of J is column i of L⁻¹. */
  private inverseFactor(): void {
    const { Jt, Lf, column, n, nF } = this;
    Jt.fill(0, 0, n * n);
    for (let i = 0; i < nF; i++) {
      // Forward substitution on e_i, whose solution is zero above i.
      for (let r = i; r < nF; r++) {
        let s = r === i ? 1 : 0;
        for (let k = i; k < r; k++) s -= Lf[r * nF + k]! * column[k]!;
        column[r] = s / Lf[r * nF + r]!;
      }
      for (let r = i; r < nF; r++) Jt[r * n + i] = column[r]!;
    }
  }

  /** Step 1: each row's value once, then both of its sides; returns the sum of the violations. */
  private evaluate(m: number): number {
    const { rs, ri, rv, x, ax, s, cOff, cSign, cRow, included, me, total } = this;
    for (let i = 0; i < m; i++) {
      let value = 0;
      for (let e = rs[i]!; e < rs[i + 1]!; e++) value += rv[e]! * x[ri[e]!]!;
      ax[i] = value;
    }
    let psi = 0;
    for (let c = me; c < total; c++) {
      included[c] = 1;
      const value = cOff[c]! + cSign[c]! * ax[cRow[c]!]!;
      s[c] = value;
      psi += Math.min(0, value);
    }
    return psi;
  }

  /** Step 2: the most violated candidate; −1 when none. */
  private mostViolated(): number {
    const { s, candidate, included, me, total } = this;
    let worst = 0;
    let ip = -1;
    for (let c = me; c < total; c++) {
      const value = s[c]!;
      if (value < worst && candidate[c] !== -1 && included[c]) {
        worst = value;
        ip = c;
      }
    }
    return ip;
  }

  /** Loads the normal of constraint c over the free positions. */
  private loadNormal(c: number): void {
    const row = this.cRow[c]!;
    const sign = this.cSign[c]!;
    const { rs, ri, rv, pos, npPos, npVal } = this;
    let len = 0;
    for (let e = rs[row]!; e < rs[row + 1]!; e++) {
      const p = pos[ri[e]!]!;
      if (p < 0) continue;
      npPos[len] = p;
      npVal[len++] = sign * rv[e]!;
    }
    this.npLen = len;
  }

  /** Value of constraint c at x: nᵀx + offset, from the row's value as in step 1. */
  private slack(c: number): number {
    const row = this.cRow[c]!;
    const { rs, ri, rv, x } = this;
    let value = 0;
    for (let e = rs[row]!; e < rs[row + 1]!; e++) value += rv[e]! * x[ri[e]!]!;
    return this.cOff[c]! + this.cSign[c]! * value;
  }

  /** d = Jᵀ·n over the free positions. */
  private computeD(): void {
    const { Jt, d, npPos, npVal, npLen, n, nF } = this;
    for (let j = 0; j < nF; j++) {
      const base = j * n;
      let s = 0;
      for (let e = 0; e < npLen; e++) s += Jt[base + npPos[e]!]! * npVal[e]!;
      d[j] = s;
    }
  }

  /**
   * The primal direction z = J₂·d₂. J₂ may be replaced by J₂·H for any orthogonal H without changing what it
   * spans, so a Householder reflection H that maps d₂ to (α, 0, …, 0) is applied right away: then z = α·J[:, iq],
   * and adding the constraint needs no rotations. It replaces the reference's product J₂·d₂ and the Givens
   * chain of its add with one reflection of J₂, about half the work.
   */
  private reflect(): void {
    const { Jt, d, z, w, n, nF, iq } = this;
    z.fill(0, 0, nF);
    if (iq >= nF) return;
    let tail = 0;
    for (let k = iq + 1; k < nF; k++) tail += d[k]! * d[k]!;
    const d0 = d[iq]!;
    if (tail > 0) {
      const norm = Math.sqrt(d0 * d0 + tail);
      const alpha = d0 >= 0 ? -norm : norm;
      // v = d₂ − α·e₀, without cancellation in its first entry; H = I − β·v·vᵀ.
      const v0 = d0 - alpha;
      const beta = 1 / (norm * (norm + Math.abs(d0)));
      d[iq] = v0;
      w.fill(0, 0, nF);
      for (let k = iq; k < nF; k++) {
        const vk = d[k]!;
        if (vk === 0) continue;
        const base = k * n;
        for (let i = 0; i < nF; i++) w[i] = w[i]! + Jt[base + i]! * vk;
      }
      for (let k = iq; k < nF; k++) {
        const f = beta * d[k]!;
        if (f === 0) continue;
        const base = k * n;
        for (let i = 0; i < nF; i++) Jt[base + i] = Jt[base + i]! - f * w[i]!;
        d[k] = 0;
      }
      d[iq] = alpha;
    }
    const a = d[iq]!;
    const base = iq * n;
    for (let i = 0; i < nF; i++) z[i] = a * Jt[base + i]!;
  }

  /** r = R⁻¹·d₁, the dual direction. */
  private updateR(): void {
    const { R, d, r, n, iq } = this;
    for (let i = iq - 1; i >= 0; i--) {
      let s = d[i]!;
      for (let k = i + 1; k < iq; k++) s -= R[i * n + k]! * r[k]!;
      r[i] = s / R[i * n + i]!;
    }
  }

  private dotNormal(v: Float64Array): number {
    const { npPos, npVal, npLen } = this;
    let s = 0;
    for (let e = 0; e < npLen; e++) s += v[npPos[e]!]! * npVal[e]!;
    return s;
  }

  private dotZ(): number {
    const { z, nF } = this;
    let s = 0;
    for (let i = 0; i < nF; i++) s += z[i]! * z[i]!;
    return s;
  }

  private stepX(t: number): void {
    const { x, z, varAt, nF } = this;
    for (let i = 0; i < nF; i++) {
      const j = varAt[i]!;
      x[j] = x[j]! + t * z[i]!;
    }
  }

  /** Multipliers after a step t: the active ones move along −r, the one being added gains t. */
  private stepDual(t: number): void {
    const { mult, r, iq, uB, rB, fixedList, nB } = this;
    for (let k = 0; k < iq; k++) mult[k] = mult[k]! - t * r[k]!;
    mult[iq] = mult[iq]! + t;
    for (let b = 0; b < nB; b++) {
      const j = fixedList[b]!;
      uB[j] = uB[j]! - t * rB[j]!;
    }
  }

  /**
   * Dual steps of the fixed bounds, from stationarity in their coordinates: for bound j with normal entry ν,
   * ν·r_j = n_ip[j] − Σ_k r_k·n_k[j] over the active constraints.
   */
  private boundSteps(ip: number): void {
    const { rB, fixN, fixedList, nB, active, r, iq, me } = this;
    for (let b = 0; b < nB; b++) rB[fixedList[b]!] = 0;
    this.accumulateBound(ip, 1);
    for (let k = me; k < iq; k++) this.accumulateBound(active[k]!, -r[k]!);
    for (let b = 0; b < nB; b++) {
      const j = fixedList[b]!;
      rB[j] = rB[j]! / fixN[j]!;
    }
  }

  /** rB[j] += weight·n_c[j] over the fixed variables of constraint c's row. */
  private accumulateBound(c: number, weight: number): void {
    const { rB, fixC, rs, ri, rv } = this;
    const row = this.cRow[c]!;
    const sign = this.cSign[c]! * weight;
    for (let e = rs[row]!; e < rs[row + 1]!; e++) {
      const j = ri[e]!;
      if (fixC[j]! >= 0) rB[j] = rB[j]! + sign * rv[e]!;
    }
  }

  /** Adds the constraint whose d = Jᵀ·n is in `d`, already zero below position iq (reflect). */
  private addConstraint(): boolean {
    const { d, R, n } = this;
    const iq = this.iq;
    this.iq = iq + 1;
    for (let i = 0; i <= iq; i++) R[i * n + iq] = d[i]!;
    const pivot = Math.abs(d[iq]!);
    if (pivot <= EPS * this.rNorm) return false;
    this.rNorm = Math.max(this.rNorm, pivot);
    return true;
  }

  /** Removes constraint `c` from the active set and restores R to triangular form. */
  private deleteConstraint(c: number): void {
    const { active, mult, R, Jt, n, nF, me } = this;
    let iq = this.iq;
    let qq = -1;
    for (let i = me; i < iq; i++) {
      if (active[i] === c) {
        qq = i;
        break;
      }
    }
    if (qq < 0) return;
    this.stats.dropped++;
    for (let i = qq; i < iq - 1; i++) {
      active[i] = active[i + 1]!;
      mult[i] = mult[i + 1]!;
      for (let j = 0; j < n; j++) R[j * n + i] = R[j * n + i + 1]!;
    }
    active[iq - 1] = active[iq]!;
    mult[iq - 1] = mult[iq]!;
    active[iq] = 0;
    mult[iq] = 0;
    for (let j = 0; j < iq; j++) R[j * n + iq - 1] = 0;
    iq--;
    this.iq = iq;
    if (iq === 0) return;
    for (let j = qq; j < iq; j++) {
      let cc = R[j * n + j]!;
      let ss = R[(j + 1) * n + j]!;
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
        const t1 = R[j * n + k]!;
        const t2 = R[(j + 1) * n + k]!;
        const updated = t1 * cc + t2 * ss;
        R[j * n + k] = updated;
        R[(j + 1) * n + k] = xny * (t1 + updated) - t2;
      }
      const a = j * n;
      const b = (j + 1) * n;
      for (let k = 0; k < nF; k++) {
        const t1 = Jt[a + k]!;
        const t2 = Jt[b + k]!;
        const updated = t1 * cc + t2 * ss;
        Jt[a + k] = updated;
        Jt[b + k] = xny * (updated + t1) - t2;
      }
    }
  }

  /**
   * Frees fixed variable j, whose bound multiplier reached zero: it takes the next position in J, with the
   * column e/√p (P is diagonal on it), and the new row of Jᵀ·N, (1/√p)·n_k[j] over the active constraints, is
   * rotated into R so that R stays triangular. The point and the multipliers do not change; the normal of `ip`,
   * the constraint being added, is reloaded with its entry on j.
   */
  private release(j: number, ip: number): void {
    const { n, Jt, R, active, iq, rs, ri, rv, cRow, cSign, fixC, fixedList, pos, varAt, w } = this;
    const p = this.nF;
    // Jt rows at position p are zero in every column: no loop has reached them yet.
    const root = Math.sqrt(this.P[j * n + j]!);
    const base = p * n;
    Jt[base + p] = 1 / root;
    pos[j] = p;
    varAt[p] = j;
    this.nF = p + 1;
    fixC[j] = -1;
    let b = 0;
    while (fixedList[b] !== j) b++;
    fixedList.copyWithin(b, b + 1, this.nB);
    this.nB--;
    this.stats.released++;

    for (let k = 0; k < iq; k++) {
      const row = cRow[active[k]!]!;
      let value = 0;
      for (let e = rs[row]!; e < rs[row + 1]!; e++) {
        if (ri[e] === j) {
          value = cSign[active[k]!]! * rv[e]!;
          break;
        }
      }
      w[k] = value / root;
    }
    for (let k = 0; k < iq; k++) {
      const wk = w[k]!;
      if (wk === 0) continue;
      const rkk = R[k * n + k]!;
      const h = Math.hypot(rkk, wk);
      const cc = rkk / h;
      const ss = wk / h;
      R[k * n + k] = h;
      w[k] = 0;
      for (let col = k + 1; col < iq; col++) {
        const a = R[k * n + col]!;
        const v = w[col]!;
        R[k * n + col] = cc * a + ss * v;
        w[col] = -ss * a + cc * v;
      }
      const a = k * n;
      for (let i = 0; i <= p; i++) {
        const t1 = Jt[a + i]!;
        const t2 = Jt[base + i]!;
        Jt[a + i] = cc * t1 + ss * t2;
        Jt[base + i] = -ss * t1 + cc * t2;
      }
    }
    this.loadNormal(ip);
  }

  private finish(problem: RowQpProblem, status: QpStatus, iterations: number): QpResult {
    // Stationarity of this method: Px + q = Σ u·n; OSQP's sign is y = −u on lower bounds and equalities, +u on upper.
    const { n, m, P, q, rowStart: rs, rowIndex: ri, rowValue: rv, l, u } = problem;
    const { active, mult, iq, cRow, cSign, fixC, uB, fixedList, nB } = this;
    const y = new Float64Array(m);
    for (let k = 0; k < iq; k++) {
      const c = active[k]!;
      const row = cRow[c]!;
      y[row] = y[row]! + (cSign[c]! < 0 ? 1 : -1) * mult[k]!;
    }
    for (let b = 0; b < nB; b++) {
      const j = fixedList[b]!;
      const c = fixC[j]!;
      const row = cRow[c]!;
      y[row] = y[row]! + (cSign[c]! < 0 ? 1 : -1) * uB[j]!;
    }
    this.stats.active = iq + nB;
    const x = this.x.slice(0, n);
    // Residuals and objective, over the nonzeros.
    let primal = 0;
    const g = new Float64Array(n);
    for (let i = 0; i < m; i++) {
      let ax = 0;
      const yi = y[i]!;
      for (let e = rs[i]!; e < rs[i + 1]!; e++) {
        ax += rv[e]! * x[ri[e]!]!;
        if (yi !== 0) g[ri[e]!] = g[ri[e]!]! + rv[e]! * yi;
      }
      const violation = Math.max(l[i]! - ax, ax - u[i]!, 0);
      if (violation > primal) primal = violation;
    }
    let value = 0;
    let dual = 0;
    for (let i = 0; i < n; i++) {
      let row = 0;
      for (let k = 0; k < n; k++) row += P[i * n + k]! * x[k]!;
      value += x[i]! * (0.5 * row + q[i]!);
      const gi = Math.abs(g[i]! + row + q[i]!);
      if (gi > dual) dual = gi;
    }
    return { status, x, y, iterations, objective: value, primalResidual: primal, dualResidual: dual };
  }

  private failure(n: number, m: number, status: QpStatus, iterations: number): QpResult {
    return {
      status,
      x: new Float64Array(n).fill(Number.NaN),
      y: new Float64Array(m).fill(Number.NaN),
      iterations,
      objective: Number.NaN,
      primalResidual: Infinity,
      dualResidual: Infinity,
    };
  }
}
