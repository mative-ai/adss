/**
 * The camera of the 3D scene (Phase 4): behind the vehicle and above it, looking down the road. It
 * follows the vehicle's position and the road's heading, not the vehicle's own: the road stays still on screen and the
 * vehicle is seen to yaw and to move across its lane. A short shake marks the ego's impact, and never runs for a
 * visitor who asked for reduced motion (the caller's check). Three's axes: see geometry.ts.
 */

/** Where the camera sits and what it looks at, m: behind and above the vehicle, at a point ahead on the road. */
export const CHASE = { back: 12.5, height: 5.2, ahead: 16, lookHeight: 0.5 } as const;

/**
 * The camera for a vehicle at (x, y) on a road heading `heading`, in three's axes: its position in out[0..2] and the
 * point it looks at in out[3..5].
 */
export function chaseCamera(x: number, y: number, heading: number, out: Float64Array): void {
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  out[0] = x - cos * CHASE.back;
  out[1] = CHASE.height;
  out[2] = -(y - sin * CHASE.back);
  out[3] = x + cos * CHASE.ahead;
  out[4] = CHASE.lookHeight;
  out[5] = -(y + sin * CHASE.ahead);
}

/** How long the camera shakes after an impact, s. */
export const SHAKE_SECONDS = 0.45;
const SHAKE_HZ = 13;
const SHAKE_METERS = 0.22;

/** The camera's offset `age` seconds after an impact, m to its right and up: a wobble that dies out. */
export function shakeOffset(age: number, out: { side: number; up: number }): void {
  if (!(age >= 0) || age >= SHAKE_SECONDS) {
    out.side = 0;
    out.up = 0;
    return;
  }
  const fade = (1 - age / SHAKE_SECONDS) ** 2;
  const phase = 2 * Math.PI * SHAKE_HZ * age;
  out.side = SHAKE_METERS * fade * Math.sin(phase);
  out.up = 0.5 * SHAKE_METERS * fade * Math.sin(1.7 * phase);
}
