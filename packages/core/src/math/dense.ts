/**
 * Dense linear algebra on row-major Float64Array matrices, for the small problems of the MPC (tens of
 * variables). Routines work in place or into caller-provided storage, so the solver loops do not allocate.
 */

/**
 * Cholesky factorization of the symmetric positive definite n×n matrix `a`, in place: its lower triangle
 * becomes L with a = L·Lᵀ; the strict upper triangle is left untouched. Returns false when a is not
 * positive definite.
 */
export function cholesky(a: Float64Array, n: number): boolean {
  for (let j = 0; j < n; j++) {
    const rowJ = j * n;
    let d = a[rowJ + j] ?? 0;
    for (let k = 0; k < j; k++) {
      const ljk = a[rowJ + k] ?? 0;
      d -= ljk * ljk;
    }
    if (!(d > 0)) return false;
    d = Math.sqrt(d);
    a[rowJ + j] = d;
    for (let i = j + 1; i < n; i++) {
      const rowI = i * n;
      let s = a[rowI + j] ?? 0;
      for (let k = 0; k < j; k++) s -= (a[rowI + k] ?? 0) * (a[rowJ + k] ?? 0);
      a[rowI + j] = s / d;
    }
  }
  return true;
}

/** Solves L·Lᵀ·x = b with L from `cholesky`; b is overwritten by x. */
export function choleskySolve(l: Float64Array, n: number, b: Float64Array): void {
  for (let i = 0; i < n; i++) {
    const row = i * n;
    let s = b[i] ?? 0;
    for (let k = 0; k < i; k++) s -= (l[row + k] ?? 0) * (b[k] ?? 0);
    b[i] = s / (l[row + i] ?? 1);
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i] ?? 0;
    for (let k = i + 1; k < n; k++) s -= (l[k * n + i] ?? 0) * (b[k] ?? 0);
    b[i] = s / (l[i * n + i] ?? 1);
  }
}

/**
 * LDLᵀ factorization without pivoting, in place, of a symmetric quasi-definite matrix (such as a regularized
 * KKT matrix [P + δI, Aᵀ; A, −δI]), which always admits one. The strict lower triangle becomes the unit
 * lower factor, the diagonal becomes D. Returns false on a zero pivot.
 */
export function ldl(a: Float64Array, n: number): boolean {
  for (let j = 0; j < n; j++) {
    const rowJ = j * n;
    let d = a[rowJ + j] ?? 0;
    for (let k = 0; k < j; k++) {
      const ljk = a[rowJ + k] ?? 0;
      d -= ljk * ljk * (a[k * n + k] ?? 0);
    }
    if (d === 0 || !Number.isFinite(d)) return false;
    a[rowJ + j] = d;
    for (let i = j + 1; i < n; i++) {
      const rowI = i * n;
      let s = a[rowI + j] ?? 0;
      for (let k = 0; k < j; k++) s -= (a[rowI + k] ?? 0) * (a[rowJ + k] ?? 0) * (a[k * n + k] ?? 0);
      a[rowI + j] = s / d;
    }
  }
  return true;
}

/** Solves L·D·Lᵀ·x = b with the factors from `ldl`; b is overwritten by x. */
export function ldlSolve(f: Float64Array, n: number, b: Float64Array): void {
  for (let i = 0; i < n; i++) {
    const row = i * n;
    let s = b[i] ?? 0;
    for (let k = 0; k < i; k++) s -= (f[row + k] ?? 0) * (b[k] ?? 0);
    b[i] = s;
  }
  for (let i = 0; i < n; i++) b[i] = (b[i] ?? 0) / (f[i * n + i] ?? 1);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i] ?? 0;
    for (let k = i + 1; k < n; k++) s -= (f[k * n + i] ?? 0) * (b[k] ?? 0);
    b[i] = s;
  }
}

/** out = M·x for the rows×cols matrix M. */
export function multiply(m: Float64Array, rows: number, cols: number, x: Float64Array, out: Float64Array): void {
  for (let i = 0; i < rows; i++) {
    const row = i * cols;
    let s = 0;
    for (let j = 0; j < cols; j++) s += (m[row + j] ?? 0) * (x[j] ?? 0);
    out[i] = s;
  }
}

/** out = Mᵀ·y for the rows×cols matrix M. */
export function multiplyTransposed(
  m: Float64Array,
  rows: number,
  cols: number,
  y: Float64Array,
  out: Float64Array,
): void {
  out.fill(0, 0, cols);
  for (let i = 0; i < rows; i++) {
    const yi = y[i] ?? 0;
    if (yi === 0) continue;
    const row = i * cols;
    for (let j = 0; j < cols; j++) out[j] = (out[j] ?? 0) + (m[row + j] ?? 0) * yi;
  }
}

/** Largest absolute value among the first n entries. */
export function normInf(v: Float64Array, n = v.length): number {
  let max = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(v[i] ?? 0);
    if (a > max) max = a;
  }
  return max;
}
