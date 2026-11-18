/**
 * The vertical scales of the charts (Phase 4): each chart has one axis, with round ends that move in
 * whole steps as the run brings larger values, so that the lines do not jump at every sample.
 */

/** The ends of an axis from the least and the greatest value drawn (null when nothing is drawn yet). */
export type AxisRange = (min: number | null, max: number | null) => [number, number];

/** The smallest multiple of `step` at or above `value`. */
export const ceilTo = (value: number, step: number): number => Math.ceil(value / step - 1e-9) * step;

/** From zero up to the data in whole steps, and to `least` at least. */
export const fromZero =
  (step: number, least: number): AxisRange =>
  (_min, max) => [0, Math.max(least, ceilTo(max ?? 0, step))];

/** As far above zero as below it: to the data's largest size in whole steps, and to `least` at least. */
export const aroundZero =
  (step: number, least: number): AxisRange =>
  (min, max) => {
    const size = Math.max(least, ceilTo(Math.max(Math.abs(min ?? 0), Math.abs(max ?? 0)), step));
    return [-size, size];
  };

/** The decimals that write ticks `step` apart without rounding them into each other: 0 for 5, 1 for 0.5, 2 for 0.25. */
export function tickDigits(step: number): number {
  for (let digits = 0; digits < 3; digits++) {
    const scaled = Math.abs(step) * 10 ** digits;
    if (scaled > 0 && Math.abs(scaled - Math.round(scaled)) < 1e-9) return digits;
  }
  return 3;
}
