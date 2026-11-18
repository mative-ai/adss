/**
 * The geometry of the MPC's obstacle constraints: the vehicle covered by two discs, each obstacle a
 * box in road coordinates (s, e_y) predicted at constant velocity, and, per disc and stage, the half-plane that
 * keeps the disc out of the box inflated by the disc's radius and a margin. The MPC linearizes it at the nominal
 * plan (RTI): the half-plane's normal comes from the nominal geometry and the side the decision layer asks for.
 *
 * Road coordinates are used as if they were Cartesian (the curvature's scaling of s off the line is ignored, as
 * the corridor does): an obstacle is small next to the radius of a road's curves.
 */
import type { ObstacleTrack } from '../sensors/views.ts';
import { wheelbase, type VehicleParams } from '../vehicle/params.ts';

/**
 * How the plan treats the obstacles, settable per step by the decision layer:
 * - 'stop': a longitudinal limit before each obstacle in the path;
 * - 'left', 'right': pass each obstacle on that side (a lateral limit while the disc is alongside it);
 * - 'avoid': the half-plane normal from the nominal geometry (the closest point of the inflated box). It is not a
 *   maneuver of the decision layer, which uses the three above: the side it ends up on depends on the nominal plan
 *   and the RTI's linearization, so it serves for tests and comparisons. With the terminal braking row on, it
 *   stops before a static box in the lane (the tests pin that outcome).
 */
export type ObstacleSide = 'avoid' | 'stop' | 'left' | 'right';

/** Two discs that cover the vehicle's body: centers ahead of the center of gravity, m, and the common radius. */
export interface VehicleDiscs {
  readonly offsets: readonly [number, number];
  readonly radius: number;
}

/**
 * The two discs of the body: the body split in two halves along its length, each covered by the disc through
 * its corners (centers a quarter of the length from the body's middle, radius √((L/4)² + (W/2)²)).
 */
export function vehicleDiscs(params: VehicleParams): VehicleDiscs {
  const overhang = (params.length - wheelbase(params)) / 2;
  const front = params.lf + overhang;
  const rear = -(params.lr + overhang);
  const middle = (front + rear) / 2;
  const quarter = params.length / 4;
  return { offsets: [middle + quarter, middle - quarter], radius: Math.hypot(quarter, params.width / 2) };
}

/** An obstacle's center at time t from its track (constant velocity), m. */
export function predictTrack(track: ObstacleTrack, t: number, out: { s: number; ey: number }): void {
  out.s = track.s + track.vs * t;
  out.ey = track.ey + track.vey * t;
}

/** A half-plane n·(p − c) ≥ h(n) + R around an obstacle: unit normal (s, e_y) and the nominal clearance, m. */
export interface HalfPlane {
  ns: number;
  ney: number;
  /** n·(p̄ − c) − h(n) − R at the nominal disc center p̄: negative when the nominal plan violates it. */
  clearance: number;
}

/** The obstacle box seen by one disc: the center offset d = p − c, the box's half sizes, the inflation R. */
export interface DiscView {
  /** Disc center minus obstacle center, m. */
  readonly ds: number;
  readonly dey: number;
  /** Half length and half width of the obstacle, m. */
  readonly hs: number;
  readonly hey: number;
  /** Disc radius plus margin, m. */
  readonly inflation: number;
  /** Extra reach of the side-dependent windows (lateral overlap for 'stop', alongside for 'left' and 'right'), m. */
  readonly buffer: number;
  /**
   * How far one QP can move the stage, m: a disc outside a side's window by less than this could enter it within
   * the step's solution, and takes the tangent half-plane of the inflated box instead of none. 0 when absent.
   */
  readonly reach?: number;
  /**
   * The disc was already ahead of the obstacle's center when the plan started (at the planning state, with the
   * obstacle where it is then): 'avoid' may push it forward, 'stop' no longer holds it.
   */
  readonly ahead: boolean;
}

function set(out: HalfPlane, ns: number, ney: number, v: DiscView): HalfPlane {
  out.ns = ns;
  out.ney = ney;
  out.clearance = ns * v.ds + ney * v.dey - (Math.abs(ns) * v.hs + Math.abs(ney) * v.hey) - v.inflation;
  return out;
}

/**
 * The half-plane that `side` puts on a disc, into `out`; false when that side puts none on it at this stage
 * ('stop' on an obstacle out of the path or already passed at the start, 'left' and 'right' while the disc is not
 * alongside). Within `reach` outside a side's window, the disc takes the tangent half-plane of the inflated box at
 * its closest point: the nominal plan satisfies it (the disc is outside the box there), and the step's solution
 * cannot move the disc into the box from where the side's own row is missing.
 */
export function obstacleHalfPlane(side: ObstacleSide, v: DiscView, out: HalfPlane): boolean {
  const reach = v.reach ?? 0;
  switch (side) {
    case 'stop': {
      // Released only by the vehicle's position at the start, never by a nominal stage that has gone through the
      // box: that stage must be held back too.
      if (v.ahead) return false;
      const window = v.hey + v.inflation + v.buffer;
      const lateral = Math.abs(v.dey);
      if (lateral >= window + reach) return false;
      if (lateral >= window) tangent(v, out);
      else set(out, -1, 0, v);
      return true;
    }
    case 'left':
    case 'right': {
      const window = v.hs + v.inflation + v.buffer;
      const along = Math.abs(v.ds);
      if (along >= window + reach) return false;
      if (along >= window) tangent(v, out);
      else set(out, 0, side === 'left' ? 1 : -1, v);
      return true;
    }
    case 'avoid':
      avoid(v, out);
      return true;
  }
}

/** The normal from the box's closest point to a disc center outside the box, and its half-plane. */
function tangent(v: DiscView, out: HalfPlane): void {
  const es = v.ds - Math.min(v.hs, Math.max(-v.hs, v.ds));
  const eey = v.dey - Math.min(v.hey, Math.max(-v.hey, v.dey));
  const distance = Math.hypot(es, eey);
  if (distance > 0) set(out, es / distance, eey / distance, v);
  // On the box's edge (only without inflation and buffer): the normal of that edge.
  else if (Math.abs(v.dey) >= v.hey) set(out, 0, v.dey < 0 ? -1 : 1, v);
  else set(out, v.ds < 0 ? -1 : 1, 0, v);
}

/**
 * 'avoid': the normal from the box's closest point to the disc center, whose half-plane is tangent to the
 * inflated box. When the nominal disc center is inside the box, or has tunnelled through it while the vehicle
 * was still behind it, the exit with the least violation among back, left and right (forward only for a vehicle
 * already ahead) gives the normal.
 */
function avoid(v: DiscView, out: HalfPlane): void {
  const qs = Math.min(v.hs, Math.max(-v.hs, v.ds));
  const qey = Math.min(v.hey, Math.max(-v.hey, v.dey));
  const es = v.ds - qs;
  const eey = v.dey - qey;
  const distance = Math.hypot(es, eey);
  const tunnelled = !v.ahead && es > 0 && Math.abs(v.dey) < v.hey + v.inflation;
  if (distance > 1e-9 && !tunnelled) {
    set(out, es / distance, eey / distance, v);
    return;
  }
  set(out, -1, 0, v);
  let best = out.clearance;
  let bs = -1;
  let bey = 0;
  const exits: [number, number][] = v.ahead
    ? [
        [0, 1],
        [0, -1],
        [1, 0],
      ]
    : [
        [0, 1],
        [0, -1],
      ];
  for (const [ns, ney] of exits) {
    set(out, ns, ney, v);
    if (out.clearance > best) {
      best = out.clearance;
      bs = ns;
      bey = ney;
    }
  }
  set(out, bs, bey, v);
}

/**
 * Braking room from s0 to s1 along the road, ∫ a(s) ds with a(s) = min(η·μ(s)·g, a_max), by the trapezoid rule
 * on steps of at most `step` m: the v²/2 a vehicle can shed between them. Negative when s1 < s0.
 */
export function brakingRoom(decel: (s: number) => number, s0: number, s1: number, step: number): number {
  const length = s1 - s0;
  const n = Math.max(1, Math.ceil(Math.abs(length) / step - 1e-9));
  const h = length / n;
  let sum = 0.5 * (decel(s0) + decel(s1));
  for (let i = 1; i < n; i++) sum += decel(s0 + i * h);
  return sum * h;
}

/** Suffix of the id of a held copy (withHeldCopies): `${track.id}${HELD_SUFFIX}`. */
export const HELD_SUFFIX = '#held';

/** A lateral speed under this many σ of the sensor's velocity noise counts as standing (HOLD_MIN_LATERAL_SPEED). */
export const STILL_NOISE_SIGMAS = 2.5;

/**
 * The default floor of the lateral speed that counts as motion across the road, m/s: STILL_NOISE_SIGMAS σ of the v1
 * sensor's velocity noise (0.2 m/s). Below it a track takes no held copy and its band is its reported e_y
 * (mpc/branches.ts obstacleBand), so that a standing obstacle does not drift into the lane on noise alone. It is not
 * conservative for an obstacle crossing slower than that (at 0.4 m/s it moves about 1 m over the horizon unaccounted):
 * the decision driver takes STILL_NOISE_SIGMAS σ of the scenario's own sensor (BranchSettings.stillLateralSpeed).
 */
export const HOLD_MIN_LATERAL_SPEED = STILL_NOISE_SIGMAS * 0.2;

/** The id of the track a (possibly held) copy stands for. */
export function heldSource(id: string): string {
  return id.endsWith(HELD_SUFFIX) ? id.slice(0, -HELD_SUFFIX.length) : id;
}

/**
 * The tracks with, next to each one moving across the road (|v_ey| ≥ `still`), a copy held where it was reported
 * (v_ey = 0, the rest unchanged, id with HELD_SUFFIX): robustness to an obstacle that may stop. Constant velocity alone
 * predicts a crossing obstacle out of the lane; an animal or a pedestrian may stop in it at any time (the moose of
 * `moose` stops in the lane's middle). Over the horizon such an obstacle can be anywhere in the band its e_y sweeps from
 * the report to the constant-velocity prediction. The MPC writes one box per track and stage, so the band is covered
 * by its two ends: the moving track and the held copy. Between the two, each stage's band is covered while its width,
 * |v_ey|·t, stays within twice the obstacle's half width plus the disc's inflation (2·(w/2 + R + margin), 5.6 m for
 * the moose and the car's discs, 3.9 m for a pedestrian): a row's lateral window reaches that far from each end.
 *
 * The decision driver gives them to the evasions (B2, B3) only, whose rows pass both ends on their side. B0's rows
 * see the tracks as reported, B1 has none (mpc/decisionDriver.ts): held at the reported e_y, off the road for the moose's
 * first reports, the copy fell outside the 'stop' row's lateral window and took the inflated box's tangent half-plane,
 * whose normal points forward for a nominal stage past the box. B0's first plan after the first report then
 * accelerated (+2.2 m/s² on `moose`, seed 22, against −1.8 m/s² for the single maneuver of tranche 1): lane braking
 * lost two cycles, and hit the moose up to 1.8 m/s faster than tranche 1. Held in the vehicle's path instead, the copy
 * made B0 brake at once, but the evasions' rows on it ruined them (an evasion at 20 m hit at 17 m/s). The lane
 * candidates are judged on the whole band by the decision cost anyway (mpc/selector.ts).
 */
export function withHeldCopies(tracks: readonly ObstacleTrack[], still = HOLD_MIN_LATERAL_SPEED): ObstacleTrack[] {
  const out: ObstacleTrack[] = [];
  for (const track of tracks) {
    out.push(track);
    if (Math.abs(track.vey) >= still) out.push({ ...track, id: `${track.id}${HELD_SUFFIX}`, vey: 0 });
  }
  return out;
}
