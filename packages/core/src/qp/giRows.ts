/** Quadratic programs with A in compressed rows, the form the fast Goldfarb–Idnani works on. */
import type { QpProblem } from './problem.ts';

/**
 * The QP of QpProblem with A in compressed rows: entries rowStart[i]..rowStart[i+1] of rowIndex (columns,
 * increasing) and rowValue. A form a caller can fill directly, without a dense A.
 */
export interface RowQpProblem {
  readonly n: number;
  readonly m: number;
  /** n×n, full symmetric, row-major. */
  readonly P: Float64Array;
  readonly q: Float64Array;
  readonly rowStart: Int32Array;
  readonly rowIndex: Int32Array;
  readonly rowValue: Float64Array;
  readonly l: Float64Array;
  readonly u: Float64Array;
}

/** Compresses the rows of a dense QpProblem; exact zeros are left out. */
export function rowsFromDense(problem: QpProblem): RowQpProblem {
  const { n, m, A } = problem;
  const rowStart = new Int32Array(m + 1);
  let count = 0;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) if (A[i * n + j] !== 0) count++;
    rowStart[i + 1] = count;
  }
  const rowIndex = new Int32Array(count);
  const rowValue = new Float64Array(count);
  let e = 0;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      const value = A[i * n + j]!;
      if (value === 0) continue;
      rowIndex[e] = j;
      rowValue[e++] = value;
    }
  }
  return { n, m, P: problem.P, q: problem.q, rowStart, rowIndex, rowValue, l: problem.l, u: problem.u };
}
