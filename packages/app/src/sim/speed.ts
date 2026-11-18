/**
 * The top speed a visitor gives the vehicle (Phase 4): the speed it starts at and holds until it has to
 * brake, in place of the scenario's own. It is a parameter of the run (`speedKmh` of the session's configuration), so a
 * change starts the run again and is recorded with its result; it is not a pace of the playback, which stays real time.
 */

/** The speeds offered, km/h: every scenario's own is one of them (speed.test.ts). */
export const SPEED_RANGE = { min: 30, max: 130, step: 10 } as const;

/** The speed one step above (`direction` 1) or below (−1) `speed`, kept within the range. */
export function stepSpeed(speed: number, direction: 1 | -1): number {
  const { min, max, step } = SPEED_RANGE;
  return Math.min(max, Math.max(min, speed + direction * step));
}
