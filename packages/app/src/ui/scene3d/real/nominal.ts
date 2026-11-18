/**
 * The sizes the models of the realistic scene are built to (Phase 8), m. The builder (tools/models)
 * makes each model to these, and the scene scales a model from them to the vehicle or the obstacle a run has.
 */

/** The core's `car`: `axle` is how far each axle is from the middle of the body. */
export const CAR = { length: 4.4, width: 1.8, track: 1.55, axle: 1.364, wheelRadius: 0.33 } as const;
/** The core's rigid `truck`. */
export const TRUCK = { length: 8.5, width: 2.5, track: 2.05, axle: 2.805, wheelRadius: 0.5 } as const;
export const PEDESTRIAN = { height: 1.77 } as const;
/** From the tail to the nose, and across the body. */
export const MOOSE = { length: 2.3, width: 0.8 } as const;
