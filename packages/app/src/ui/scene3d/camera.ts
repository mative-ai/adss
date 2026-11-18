/**
 * The camera of the 3D scene (Phase 4): behind the vehicle and above it, looking down the road. It
 * follows the vehicle's position and the road's heading, not the vehicle's own: the road stays still on screen and the
 * vehicle is seen to yaw and to move across its lane. A short shake marks the ego's impact, and never runs for a
 * visitor who asked for reduced motion (the caller's check). Three's axes: see geometry.ts.
 *
 * A visitor may take the camera with the mouse and look at the vehicle from anywhere around it (Orbit, ViewCamera):
 * the place they chose still follows the vehicle and turns with the road.
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

/**
 * A place a visitor looks from, with the mouse: around the vehicle (degrees, 0 straight behind it, growing toward its
 * right side), above the ground (degrees) and at a distance (m). It turns with the road, as the chase camera does.
 */
export interface Orbit {
  readonly azimuth: number;
  readonly elevation: number;
  readonly distance: number;
}

/**
 * The orbit's limits and its pace: the height of the point looked at on the vehicle, m; how high and how far the camera
 * may go; the degrees a pixel of a drag turns it; the share of the distance a unit of the wheel takes or gives; and the
 * time the look takes to come from the road ahead to the vehicle when an orbit begins, ms.
 */
export const ORBIT = {
  height: 0.8,
  elevation: { min: 2, max: 85 },
  distance: { min: 3.5, max: 45 },
  turn: 0.3,
  zoom: 0.001,
  settle: 140,
} as const;

/** The orbit whose camera stands where the chase camera does: where a visitor's first drag starts from. */
export const CHASE_ORBIT: Orbit = {
  azimuth: 0,
  elevation: (Math.atan2(CHASE.height - ORBIT.height, CHASE.back) * 180) / Math.PI,
  distance: Math.hypot(CHASE.back, CHASE.height - ORBIT.height),
};

const within = (value: number, range: { readonly min: number; readonly max: number }): number =>
  Math.min(range.max, Math.max(range.min, value));

/**
 * The orbit after a drag of (dx, dy) pixels. The scene follows the hand: a drag to the right brings the camera around
 * to the vehicle's left, a drag down lifts it.
 */
export function dragOrbit(orbit: Orbit, dx: number, dy: number): Orbit {
  const turned = orbit.azimuth - dx * ORBIT.turn;
  return {
    azimuth: ((((turned + 180) % 360) + 360) % 360) - 180,
    elevation: within(orbit.elevation + dy * ORBIT.turn, ORBIT.elevation),
    distance: orbit.distance,
  };
}

/** The orbit after the wheel turned by `delta` (a wheel event's deltaY): away from the visitor moves the camera in. */
export function zoomOrbit(orbit: Orbit, delta: number): Orbit {
  return { ...orbit, distance: within(orbit.distance * Math.exp(delta * ORBIT.zoom), ORBIT.distance) };
}

/**
 * The camera of an orbit around a vehicle at (x, y) on a road heading `heading`, as chaseCamera writes it. It looks
 * `lead` m ahead of the vehicle along the road: none looks at the vehicle itself, and the chase camera's own distance,
 * from CHASE_ORBIT, is the chase camera exactly.
 */
export function orbitCamera(
  x: number,
  y: number,
  heading: number,
  orbit: Orbit,
  lead: number,
  out: Float64Array,
): void {
  const around = (orbit.azimuth * Math.PI) / 180 + heading + Math.PI;
  const above = (orbit.elevation * Math.PI) / 180;
  const flat = orbit.distance * Math.cos(above);
  out[0] = x + flat * Math.cos(around);
  out[1] = ORBIT.height + orbit.distance * Math.sin(above);
  out[2] = -(y + flat * Math.sin(around));
  out[3] = x + Math.cos(heading) * lead;
  out[4] = ORBIT.height + (CHASE.lookHeight - ORBIT.height) * (lead / CHASE.ahead);
  out[5] = -(y + Math.sin(heading) * lead);
}

/**
 * The camera of a scene: the chase camera, until a visitor takes it with the mouse. When an orbit begins the camera is
 * where it was, and its look comes from the road ahead to the vehicle in a moment, so that the picture does not jump.
 */
export class ViewCamera {
  private orbit: Orbit | null = null;
  /** How far ahead of the vehicle the camera looks, m: the chase camera's, falling to none while a visitor orbits. */
  private lead: number = CHASE.ahead;

  /** Whether a visitor holds the camera. */
  get held(): boolean {
    return this.orbit !== null;
  }

  /**
   * The visitor's place to look from, or the camera back to the road (null). With `eased` the look comes to the vehicle
   * in a moment; without (a visitor who asked for reduced motion) it is there at once.
   */
  set(orbit: Orbit | null, eased: boolean): void {
    if (!orbit) this.lead = CHASE.ahead;
    else if (!eased) this.lead = 0;
    this.orbit = orbit;
  }

  /** Writes the camera of this frame, `elapsed` ms after the one before; true while the look is still on its way. */
  camera(x: number, y: number, heading: number, elapsed: number, out: Float64Array): boolean {
    if (!this.orbit) {
      chaseCamera(x, y, heading, out);
      return false;
    }
    const moving = this.lead > 0.01;
    this.lead = moving ? this.lead * Math.exp(-Math.max(elapsed, 0) / ORBIT.settle) : 0;
    orbitCamera(x, y, heading, this.orbit, this.lead, out);
    return moving;
  }
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
