/** Order statistics for the benchmark's reports. */

/** Nearest-rank percentile of `values` (not modified), q in [0, 1]. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank] ?? Number.NaN;
}

export interface Summary {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export function summarize(values: readonly number[]): Summary {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length === 0 ? Number.NaN : Math.max(...values),
  };
}

/** Median of a few values, for the per-QP time across passes. */
export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}
