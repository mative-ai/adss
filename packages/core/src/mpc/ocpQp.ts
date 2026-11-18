/**
 * The QP of one RTI step before it takes a solver's form. Costs and rows are written over
 * the stage variables, in this order:
 *   δu_k for k < N (NU each), δx_{k+1} for k < N (NX each: the state after step k), then the slacks;
 * and the linearized dynamics tie them: δx_{k+1} = A_k·δx_k + B_k·δu_k, with δx_0 = 0 because the step starts
 * from a given state. The solvers take it condensed, the states eliminated with δX = Γ·δU (lowering.ts, dense,
 * for the exact reference; rowCondenser.ts, in compressed rows, for the fast solver): the MPC's costs and
 * constraints are written once, whatever form a solver wants.
 */

/** Row kinds, for the row keys. */
export const ROW_KIND = {
  BOUND: 0,
  RATE: 1,
  CORRIDOR: 2,
  FRICTION: 3,
  SLIP: 4,
  YAW: 5,
  SLACK: 6,
  /** Half-plane between a vehicle disc and an obstacle; index 2·track + disc. */
  OBSTACLE: 7,
  /** vx ≥ 0. */
  STANDSTILL: 8,
  /** Terminal braking feasibility, at the last stage. */
  TERMINAL: 9,
} as const;

/** Key step between a row and the same row one stage later. */
export const KEY_STAGE = 1024;

/** Identity of a row: kind, stage and index within the stage; the same row one stage later is key + KEY_STAGE. */
export function rowKey(kind: number, stage: number, index: number): number {
  return (kind * KEY_STAGE + stage) * KEY_STAGE + index;
}

export class OcpQp {
  readonly horizon: number;
  readonly nx: number;
  readonly nu: number;
  /** A_k, N×NX×NX row-major. */
  readonly a: Float64Array;
  /** B_k, N×NX×NU row-major. */
  readonly b: Float64Array;
  /** Stage of each slack: the latest stage whose rows use it. */
  readonly slackStage: number[] = [];
  // Cost ½·vᵀPv + qᵀv: P as upper-triangle triplets (i ≤ j), duplicates summed; q over the variables.
  readonly costRow: number[] = [];
  readonly costCol: number[] = [];
  readonly costValue: number[] = [];
  readonly linear: number[];
  // Rows l ≤ c·v ≤ u, compressed: entries rowStart[r]..rowStart[r+1] of rowIndex and rowValue.
  readonly rowStart: number[] = [0];
  readonly rowIndex: number[] = [];
  readonly rowValue: number[] = [];
  readonly lower: number[] = [];
  readonly upper: number[] = [];
  readonly rowKeys: number[] = [];

  constructor(horizon: number, nx: number, nu: number) {
    this.horizon = horizon;
    this.nx = nx;
    this.nu = nu;
    this.a = new Float64Array(horizon * nx * nx);
    this.b = new Float64Array(horizon * nx * nu);
    this.linear = new Array<number>(horizon * (nx + nu)).fill(0);
  }

  /** Index of δu_k[i]. */
  input(k: number, i: number): number {
    return k * this.nu + i;
  }

  /** Index of δx_{k+1}[s], the state after step k. */
  state(k: number, s: number): number {
    return this.horizon * this.nu + k * this.nx + s;
  }

  /** Index of slack j. */
  slack(j: number): number {
    return this.horizon * (this.nu + this.nx) + j;
  }

  get slacks(): number {
    return this.slackStage.length;
  }

  get variables(): number {
    return this.horizon * (this.nu + this.nx) + this.slacks;
  }

  get rows(): number {
    return this.lower.length;
  }

  /** Adds a slack variable used by the rows of `stage` and earlier; returns its index. */
  addSlack(stage: number): number {
    this.slackStage.push(stage);
    this.linear.push(0);
    return this.slack(this.slacks - 1);
  }

  /** Adds weight·(Σ coeff·v + offset)² to the cost, dropping the constant. */
  addSquare(index: readonly number[], coeff: readonly number[], offset: number, weight: number): void {
    for (let a = 0; a < index.length; a++) {
      const ia = index[a] ?? 0;
      const ca = coeff[a] ?? 0;
      this.linear[ia] = (this.linear[ia] ?? 0) + 2 * weight * offset * ca;
      for (let b = a; b < index.length; b++) this.addQuadratic(ia, index[b] ?? 0, 2 * weight * ca * (coeff[b] ?? 0));
    }
  }

  /** Adds value to P[i][j] and P[j][i] (once on the diagonal). */
  addQuadratic(i: number, j: number, value: number): void {
    this.costRow.push(Math.min(i, j));
    this.costCol.push(Math.max(i, j));
    this.costValue.push(value);
  }

  addLinear(i: number, value: number): void {
    this.linear[i] = (this.linear[i] ?? 0) + value;
  }

  /** Adds the row l ≤ Σ coeff·v ≤ u. */
  addRow(index: readonly number[], coeff: readonly number[], l: number, u: number, key: number): void {
    for (let e = 0; e < index.length; e++) {
      this.rowIndex.push(index[e] ?? 0);
      this.rowValue.push(coeff[e] ?? 0);
    }
    this.rowStart.push(this.rowIndex.length);
    this.lower.push(l);
    this.upper.push(u);
    this.rowKeys.push(key);
  }
}
