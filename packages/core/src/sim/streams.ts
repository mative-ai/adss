/**
 * The seeded PRNG streams of a run, one per purpose: `Prng.create(seed, STREAM.X)`. A new purpose
 * takes a new number, so adding a sensor never shifts the noise of another.
 */
export const STREAM = {
  /** Noise of the object sensor (position and velocity of the tracks). */
  OBJECTS: 1,
} as const;
