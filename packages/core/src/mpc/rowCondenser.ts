/**
 * Condensing of the step's QP straight into compressed rows, for the fast Goldfarb–Idnani. The same
 * problem as Condenser in lowering.ts (variables δU, then the slacks; the states eliminated with δX = Γ·δU),
 * written for speed: buffers are reused between steps, P is accumulated on its upper triangle and mirrored, so it
 * is exactly symmetric, and each row of A is built in a dense accumulator over the columns it can touch and
 * emitted compressed.
 */
import type { RowQpProblem } from '../qp/giRows.ts';
import type { OcpQp } from './ocpQp.ts';

/** Adds value to the upper-triangle entry of (a, b) of the n×n matrix P. */
function addUpper(P: Float64Array, n: number, a: number, b: number, value: number): void {
  if (a <= b) P[a * n + b] = P[a * n + b]! + value;
  else P[b * n + a] = P[b * n + a]! + value;
}

function grow(a: Float64Array, size: number): Float64Array {
  return a.length >= size ? a : new Float64Array(size);
}
function growInt(a: Int32Array, size: number): Int32Array {
  return a.length >= size ? a : new Int32Array(size);
}

export class RowCondenser {
  /** Γ, (N·NX)×(N·NU) row-major: row of δx_{k+1}[s] is (k·NX + s). */
  private gamma = new Float64Array(0);
  private block = new Float64Array(0);
  private tmp = new Float64Array(0);
  private P = new Float64Array(0);
  private q = new Float64Array(0);
  private acc = new Float64Array(0);
  private rowStart = new Int32Array(1);
  private rowIndex = new Int32Array(0);
  private rowValue = new Float64Array(0);
  private l = new Float64Array(0);
  private u = new Float64Array(0);

  /** The condensed QP of `ocp`, in compressed rows, over buffers that the next call reuses. */
  lower(ocp: OcpQp): RowQpProblem {
    const N = ocp.horizon;
    const { nx, nu } = ocp;
    const inputs = N * nu;
    const states = N * nx;
    const n = inputs + ocp.slacks;
    this.computeGamma(ocp);
    const g = this.gamma;

    this.P = grow(this.P, n * n);
    const P = this.P;
    P.fill(0, 0, n * n);
    // Upper triangle first (a ≤ b), mirrored at the end.
    for (let t = 0; t < ocp.costValue.length; t++) {
      const i = ocp.costRow[t]!;
      const j = ocp.costCol[t]!;
      const p = ocp.costValue[t]!;
      if (p === 0) continue;
      const si = i >= inputs && i < inputs + states;
      const sj = j >= inputs && j < inputs + states;
      if (!si && !sj) {
        const ci = i < inputs ? i : i - states;
        const cj = j < inputs ? j : j - states;
        // A diagonal entry counts once, an off-diagonal one on both sides: on the upper triangle, once each.
        addUpper(P, n, ci, cj, p);
      } else if (si && sj) {
        const oi = (i - inputs) * inputs;
        const oj = (j - inputs) * inputs;
        const li = (Math.floor((i - inputs) / nx) + 1) * nu;
        const lj = (Math.floor((j - inputs) / nx) + 1) * nu;
        if (i === j) {
          for (let a = 0; a < li; a++) {
            const pa = p * g[oi + a]!;
            if (pa === 0) continue;
            const row = a * n;
            for (let b = a; b < li; b++) P[row + b] = P[row + b]! + pa * g[oi + b]!;
          }
        } else {
          // p·(g_i g_jᵀ + g_j g_iᵀ): on the upper triangle, each (a, b) term once and the diagonal twice.
          for (let a = 0; a < li; a++) {
            const pa = p * g[oi + a]!;
            if (pa === 0) continue;
            for (let b = 0; b < lj; b++) {
              const value = pa * g[oj + b]!;
              addUpper(P, n, a, b, a === b ? 2 * value : value);
            }
          }
        }
      } else {
        const s = si ? i : j;
        const other = si ? j : i;
        const cu = other < inputs ? other : other - states;
        const o = (s - inputs) * inputs;
        const len = (Math.floor((s - inputs) / nx) + 1) * nu;
        // p·(e_cu g_sᵀ + g_s e_cuᵀ): the diagonal entry a = cu takes both halves.
        for (let a = 0; a < len; a++) {
          const value = p * g[o + a]!;
          addUpper(P, n, cu, a, a === cu ? 2 * value : value);
        }
      }
    }
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) P[b * n + a] = P[a * n + b]!;
    }

    this.q = grow(this.q, n);
    const q = this.q;
    q.fill(0, 0, n);
    for (let v = 0; v < ocp.variables; v++) {
      const qv = ocp.linear[v]!;
      if (qv === 0) continue;
      if (v < inputs) q[v] = q[v]! + qv;
      else if (v >= inputs + states) q[v - states] = q[v - states]! + qv;
      else {
        const o = (v - inputs) * inputs;
        const len = (Math.floor((v - inputs) / nx) + 1) * nu;
        for (let a = 0; a < len; a++) q[a] = q[a]! + qv * g[o + a]!;
      }
    }

    // Rows: dense accumulator over the columns, emitted in increasing column order without exact zeros.
    const rows = ocp.rows;
    this.acc = grow(this.acc, n);
    this.rowStart = growInt(this.rowStart, rows + 1);
    this.l = grow(this.l, rows);
    this.u = grow(this.u, rows);
    const bound = rows * n;
    if (this.rowIndex.length < Math.min(bound, ocp.rowIndex.length * inputs + rows)) {
      const size = Math.min(bound, ocp.rowIndex.length * inputs + rows);
      this.rowIndex = new Int32Array(size);
      this.rowValue = new Float64Array(size);
    }
    const { acc, rowStart, rowIndex, rowValue, l, u } = this;
    acc.fill(0, 0, n);
    let count = 0;
    rowStart[0] = 0;
    for (let r = 0; r < rows; r++) {
      let top = 0;
      let firstSlack = n;
      let lastSlack = -1;
      for (let e = ocp.rowStart[r]!; e < ocp.rowStart[r + 1]!; e++) {
        const v = ocp.rowIndex[e]!;
        const c = ocp.rowValue[e]!;
        if (v < inputs) {
          acc[v] = acc[v]! + c;
          if (v + 1 > top) top = v + 1;
        } else if (v >= inputs + states) {
          const col = v - states;
          acc[col] = acc[col]! + c;
          if (col < firstSlack) firstSlack = col;
          if (col > lastSlack) lastSlack = col;
        } else {
          const o = (v - inputs) * inputs;
          const len = (Math.floor((v - inputs) / nx) + 1) * nu;
          for (let a = 0; a < len; a++) acc[a] = acc[a]! + c * g[o + a]!;
          if (len > top) top = len;
        }
      }
      for (let a = 0; a < top; a++) {
        const value = acc[a]!;
        if (value !== 0) {
          rowIndex[count] = a;
          rowValue[count++] = value;
        }
        acc[a] = 0;
      }
      for (let a = firstSlack; a <= lastSlack; a++) {
        const value = acc[a]!;
        if (value !== 0) {
          rowIndex[count] = a;
          rowValue[count++] = value;
        }
        acc[a] = 0;
      }
      l[r] = ocp.lower[r]!;
      u[r] = ocp.upper[r]!;
      rowStart[r + 1] = count;
    }
    return {
      n,
      m: rows,
      P: P.subarray(0, n * n),
      q: q.subarray(0, n),
      rowStart: rowStart.subarray(0, rows + 1),
      rowIndex: rowIndex.subarray(0, count),
      rowValue: rowValue.subarray(0, count),
      l: l.subarray(0, rows),
      u: u.subarray(0, rows),
    };
  }

  /** Γ: block (k, j) = A_k ⋯ A_{j+1}·B_j for j ≤ k, as in Condenser. */
  private computeGamma(ocp: OcpQp): void {
    const N = ocp.horizon;
    const { nx, nu } = ocp;
    const cols = N * nu;
    if (this.gamma.length !== N * nx * cols) this.gamma = new Float64Array(N * nx * cols);
    if (this.block.length !== nx * nu) {
      this.block = new Float64Array(nx * nu);
      this.tmp = new Float64Array(nx * nu);
    }
    const { gamma: g, block, tmp } = this;
    const A = ocp.a;
    const B = ocp.b;
    g.fill(0);
    for (let j = 0; j < N; j++) {
      for (let t = 0; t < nx * nu; t++) block[t] = B[j * nx * nu + t]!;
      for (let k = j; k < N; k++) {
        if (k > j) {
          const ak = k * nx * nx;
          for (let r = 0; r < nx; r++) {
            for (let c = 0; c < nu; c++) {
              let s = 0;
              for (let t = 0; t < nx; t++) s += A[ak + r * nx + t]! * block[t * nu + c]!;
              tmp[r * nu + c] = s;
            }
          }
          block.set(tmp);
        }
        for (let r = 0; r < nx; r++) {
          const base = (k * nx + r) * cols + j * nu;
          for (let c = 0; c < nu; c++) g[base + c] = block[r * nu + c]!;
        }
      }
    }
  }
}
