/**
 * Quadratic programs in the form both solvers take, the one OSQP uses:
 *   minimize ½·xᵀPx + qᵀx  subject to  l ≤ Ax ≤ u,
 * with P symmetric positive semidefinite (positive definite for Goldfarb–Idnani), dense and row-major;
 * l may hold −Infinity and u +Infinity; l = u makes an equality.
 */
export interface QpProblem {
  readonly n: number;
  readonly m: number;
  /** n×n, full symmetric. */
  readonly P: Float64Array;
  readonly q: Float64Array;
  /** m×n. */
  readonly A: Float64Array;
  readonly l: Float64Array;
  readonly u: Float64Array;
}

export type QpStatus = 'solved' | 'maxIterations' | 'infeasible' | 'failed';

export interface QpResult {
  readonly status: QpStatus;
  /** Primal solution, n values. */
  readonly x: Float64Array;
  /**
   * Constraint multipliers, m values, signed as in OSQP: Px + q + Aᵀy = 0 at the optimum, with y < 0 on an
   * active lower bound and y > 0 on an active upper bound.
   */
  readonly y: Float64Array;
  readonly iterations: number;
  readonly objective: number;
  /** Largest violation of l ≤ Ax ≤ u. */
  readonly primalResidual: number;
  /** ‖Px + q + Aᵀy‖∞. */
  readonly dualResidual: number;
}

export interface WarmStart {
  readonly x?: Float64Array;
  readonly y?: Float64Array;
}

export interface QpSolver {
  solve(problem: QpProblem, warm?: WarmStart): QpResult;
}

/** ½·xᵀPx + qᵀx. */
export function objective(problem: QpProblem, x: Float64Array): number {
  const { n, P, q } = problem;
  let value = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i] ?? 0;
    let row = 0;
    for (let j = 0; j < n; j++) row += (P[i * n + j] ?? 0) * (x[j] ?? 0);
    value += xi * (0.5 * row + (q[i] ?? 0));
  }
  return value;
}

/** Primal and dual residuals of (x, y) in the original problem, as reported in QpResult. */
export function residuals(problem: QpProblem, x: Float64Array, y: Float64Array): { primal: number; dual: number } {
  const { n, m, P, q, A, l, u } = problem;
  let primal = 0;
  for (let i = 0; i < m; i++) {
    let ax = 0;
    for (let j = 0; j < n; j++) ax += (A[i * n + j] ?? 0) * (x[j] ?? 0);
    const violation = Math.max((l[i] ?? 0) - ax, ax - (u[i] ?? 0), 0);
    if (violation > primal) primal = violation;
  }
  let dual = 0;
  for (let j = 0; j < n; j++) {
    let g = q[j] ?? 0;
    for (let k = 0; k < n; k++) g += (P[j * n + k] ?? 0) * (x[k] ?? 0);
    for (let i = 0; i < m; i++) g += (A[i * n + j] ?? 0) * (y[i] ?? 0);
    if (Math.abs(g) > dual) dual = Math.abs(g);
  }
  return { primal, dual };
}
