/**
 * Simulated time is an integer tick at 1 kHz (AGENTS.md §5): seconds are derived from the tick, never
 * accumulated in floating point.
 */
export const TICK_HZ = 1000;
export const TICK_SECONDS = 1 / TICK_HZ;

export function ticksFor(seconds: number): number {
  return Math.round(seconds * TICK_HZ);
}

export function secondsAt(tick: number): number {
  return tick / TICK_HZ;
}
