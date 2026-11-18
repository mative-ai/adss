/**
 * The condensed form of a step's QP, dense, as the exact reference takes it: variables [δU, slacks],
 * the states eliminated with δx_{k+1} = Γ_k·δU, where block (k, j) of Γ is A_k ⋯ A_{j+1}·B_j for j ≤ k; about 65
 * variables, P full. rowCondenser.ts writes the same QP in compressed rows for the fast solver. It drops the
 * OcpQp's constant, so a point has the OcpQp's objective without it.
 */
import type { QpProblem } from '../qp/problem.ts';
import type { OcpQp } from './ocpQp.ts';

export class Condenser {
  /** Γ, (N·NX)×(N·NU) row-major. */
  private gamma = new Float64Array(0);
  private block = new Float64Array(0);
  private tmp = new Float64Array(0);

  /** The condensed QP: variables δU (N·NU), then the slacks. */
  lower(ocp: OcpQp): QpProblem {
    const N = ocp.horizon;
    const { nx, nu } = ocp;
    const inputs = N * nu;
    const states = N * nx;
    const n = inputs + ocp.slacks;
    this.computeGamma(ocp);
    const g = this.gamma;
    // A stage variable is a unit column (input, slack) or a row of Γ over the first (k+1)·NU columns (state).
    const isState = (v: number) => v >= inputs && v < inputs + states;
    const column = (v: number) => (v < inputs ? v : v - states);
    const rowOffset = (v: number) => (v - inputs) * inputs;
    const support = (v: number) => (Math.floor((v - inputs) / nx) + 1) * nu;

    const P = new Float64Array(n * n);
    for (let t = 0; t < ocp.costValue.length; t++) {
      const i = ocp.costRow[t] ?? 0;
      const j = ocp.costCol[t] ?? 0;
      const p = ocp.costValue[t] ?? 0;
      if (p === 0) continue;
      if (!isState(i) && !isState(j)) {
        const ci = column(i);
        const cj = column(j);
        P[ci * n + cj] = P[ci * n + cj]! + p;
        if (ci !== cj) P[cj * n + ci] = P[cj * n + ci]! + p;
      } else if (isState(i) && isState(j)) {
        const oi = rowOffset(i);
        const oj = rowOffset(j);
        const li = support(i);
        const lj = support(j);
        for (let a = 0; a < li; a++) {
          const pa = p * g[oi + a]!;
          if (pa === 0) continue;
          for (let b = 0; b < lj; b++) {
            const value = pa * g[oj + b]!;
            P[a * n + b] = P[a * n + b]! + value;
            if (i !== j) P[b * n + a] = P[b * n + a]! + value;
          }
        }
      } else {
        const s = isState(i) ? i : j;
        const cu = column(isState(i) ? j : i);
        const o = rowOffset(s);
        const len = support(s);
        for (let a = 0; a < len; a++) {
          const value = p * g[o + a]!;
          P[cu * n + a] = P[cu * n + a]! + value;
          P[a * n + cu] = P[a * n + cu]! + value;
        }
      }
    }

    const q = new Float64Array(n);
    for (let v = 0; v < ocp.variables; v++) {
      const qv = ocp.linear[v] ?? 0;
      if (qv === 0) continue;
      if (!isState(v)) {
        q[column(v)] = q[column(v)]! + qv;
        continue;
      }
      const o = rowOffset(v);
      const len = support(v);
      for (let a = 0; a < len; a++) q[a] = q[a]! + qv * g[o + a]!;
    }

    const m = ocp.rows;
    const A = new Float64Array(m * n);
    for (let r = 0; r < m; r++) {
      const base = r * n;
      for (let e = ocp.rowStart[r] ?? 0; e < (ocp.rowStart[r + 1] ?? 0); e++) {
        const v = ocp.rowIndex[e] ?? 0;
        const c = ocp.rowValue[e] ?? 0;
        if (!isState(v)) {
          A[base + column(v)] = A[base + column(v)]! + c;
          continue;
        }
        const o = rowOffset(v);
        const len = support(v);
        for (let a = 0; a < len; a++) A[base + a] = A[base + a]! + c * g[o + a]!;
      }
    }
    return { n, m, P, q, A, l: Float64Array.from(ocp.lower), u: Float64Array.from(ocp.upper) };
  }

  /** Γ: block (k, j) = A_k ⋯ A_{j+1}·B_j for j ≤ k, the effect of δu_j on the state after step k. */
  private computeGamma(ocp: OcpQp): void {
    const N = ocp.horizon;
    const { nx, nu } = ocp;
    const cols = N * nu;
    if (this.gamma.length !== N * nx * cols) this.gamma = new Float64Array(N * nx * cols);
    if (this.block.length !== nx * nu) {
      this.block = new Float64Array(nx * nu);
      this.tmp = new Float64Array(nx * nu);
    }
    const g = this.gamma;
    const block = this.block;
    const tmp = this.tmp;
    g.fill(0);
    for (let j = 0; j < N; j++) {
      block.set(ocp.b.subarray(j * nx * nu, (j + 1) * nx * nu));
      for (let k = j; k < N; k++) {
        if (k > j) {
          const a = ocp.a.subarray(k * nx * nx, (k + 1) * nx * nx);
          for (let r = 0; r < nx; r++) {
            for (let c = 0; c < nu; c++) {
              let s = 0;
              for (let m = 0; m < nx; m++) s += a[r * nx + m]! * block[m * nu + c]!;
              tmp[r * nu + c] = s;
            }
          }
          block.set(tmp);
        }
        for (let r = 0; r < nx; r++) {
          for (let c = 0; c < nu; c++) g[(k * nx + r) * cols + j * nu + c] = block[r * nu + c]!;
        }
      }
    }
  }
}
