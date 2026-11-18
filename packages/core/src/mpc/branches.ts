/**
 * The candidate maneuvers of the decision layer (Phase 3). Every control
 * cycle the decision driver solves at most four of them, each an MpcController of its own, from the same planning
 * state, tracks and friction preview:
 * - B0 `keep`: the lane at the reference speed in the road's corridor; the obstacles are 'stop' rows on the tracks as
 *   reported, so it brakes only as much as they ask: the single maneuver of tranche 1. Always solved.
 * - B1 `brake`: the hardest braking in the lane: the lane's center, a speed reference falling to 0 at the vehicle's
 *   full braking command (−accelMin, BrakeReference), tracked closely (its speed scale is brakeSpeedScale, a quarter
 *   of the MPC's), and no obstacle rows: the MPC's friction rows cap each stage at its μ·g and its rate row at
 *   accelRateMax, so the plan brakes as hard as the friction and the actuators allow, from the first cycle (a profile at
 *   the preview's μ·g held the `mu-split` stop at 5.4 m/s², the mean of the two wheel tracks, and hit the car). Its
 *   rollout is the decision layer's test of "braking in the lane suffices": with obstacle rows, its first plans after a
 *   report were single RTI steps from a cruise and predicted a contact where the closed loop stopped (on `moose` at
 *   26 m, which then evaded). Solved while an obstacle is in the path, or while it is the current maneuver.
 * - B2 `left`, B3 `right`: a lateral reference that passes the target obstacle (the nearest in the path) on that
 *   side with clearance and returns to the lane (EvadeReference); the target's side is 'left' or 'right', every
 *   other obstacle 'stop'. Solved only when a drivable gap exists on that side, with the grip for it (pathObstacles),
 *   or while current.
 * So a cruise solves one QP per cycle and an event at most four.
 *
 * Geometry is in road coordinates, as for the MPC's obstacle rows (mpc/obstacles.ts): the vehicle's two discs, each
 * obstacle's box inflated by the disc radius and the obstacle margin. An obstacle that moves across the road may stop
 * at any time (the moose of `moose` stops in the lane): its lateral band runs from its reported e_y to its
 * constant-velocity e_y at the time considered (obstacleBand), here and in the decision cost (mpc/selector.ts).
 */
import type { FrictionPreview, LaneGeometry, ObstacleTrack } from '../sensors/views.ts';
import { GRAVITY, type VehicleParams } from '../vehicle/params.ts';
import type { Corridor, MpcSettings, Reference } from './mpc.ts';
import { HOLD_MIN_LATERAL_SPEED, STILL_NOISE_SIGMAS, type VehicleDiscs } from './obstacles.ts';

/** The candidate maneuvers, in their B0–B3 order (also the order that breaks a tie). */
export const BRANCH_IDS = ['keep', 'brake', 'left', 'right'] as const;
export type BranchId = (typeof BRANCH_IDS)[number];

export interface BranchSettings {
  /**
   * Share of μ·g a stop is counted on where it is not planned: the decision cost's stop beyond the horizon, the point
   * of no return, the path's range. The MPC's terminal braking row counts on the same share
   * (MpcConstraintSettings.brakeEfficiency: ABS slip around the peak, load transfer, the brake lag).
   */
  readonly stopShare: number;
  /** Lateral clearance an evasion adds beyond the inflated box (disc radius plus obstacle margin), m. */
  readonly evadeClearance: number;
  /** Time over which an evasion's reference moves to its offset, at the planning speed, s. */
  readonly evadeRampTime: number;
  /** Time over which it returns to the lane once the obstacle is passed, s. */
  readonly evadeReturnTime: number;
  /** Shortest ramp and return, m (at low speed). */
  readonly evadeMinLength: number;
  /**
   * An obstacle is in the path when it is ahead within this much beyond the horizon's travel and the stopping
   * distance, m (pathObstacles).
   */
  readonly pathMargin: number;
  /**
   * An obstacle in the path in the previous cycle leaves it only once its band clears the lane and the vehicle's discs
   * by this much, m: a pedestrian at the lane's edge drifted in and out of the path on the sensor's noise, ending the
   * event and starting a new one (on `pedestrian` over 100 seeds: B1, back to B0, then B1 or an evasion again).
   */
  readonly pathExitMargin: number;
  /** B1's speed scale (MpcSettings.scales.speed), m/s: a quarter of the MPC's, so that the plan follows its stop. */
  readonly brakeSpeedScale: number;
  /** B2's and B3's Bryson scales over the MPC's (MpcSettings.scales), for their lateral tracking. */
  readonly evadeScales: Partial<MpcSettings['scales']>;
  /**
   * A gap is drivable only where the grip along the passage (the preview's μ at the e_y the evasion takes) is at least
   * this share of the lane's, which the evasion's plan counts on (the MPC's rows take the lane's μ). On `mu-split` the
   * left lane is ice (μ 0.1) beside a lane of 0.55: evasions planned on 0.55 slid 9 to 12 m across it or hit the
   * stopped car at up to 13.9 m/s, where braking in the lane hit at most at 4.8 m/s (seeds 1 to 10). The passage is
   * sampled alongside the target only, not along the ramp to it and the return.
   */
  readonly gapGripShare: number;
  /**
   * Lateral speed below which a track counts as standing, m/s (obstacleBand, the held copies): STILL_NOISE_SIGMAS σ of
   * the sensor's velocity noise, HOLD_MIN_LATERAL_SPEED for the v1 sensor.
   */
  readonly stillLateralSpeed: number;
}

export const BRANCH_DEFAULTS: BranchSettings = {
  stopShare: 0.8,
  evadeClearance: 0.3,
  evadeRampTime: 1.5,
  evadeReturnTime: 2,
  evadeMinLength: 5,
  pathMargin: 10,
  pathExitMargin: 1,
  brakeSpeedScale: 0.25,
  evadeScales: {},
  gapGripShare: 0.5,
  stillLateralSpeed: HOLD_MIN_LATERAL_SPEED,
};

/** BranchSettings.stillLateralSpeed for a sensor whose lateral velocity noise is σ (m/s): STILL_NOISE_SIGMAS·σ. */
export function stillLateralSpeed(velocityNoise: number): number {
  return STILL_NOISE_SIGMAS * velocityNoise;
}

/** What the branches need of the vehicle and the road. */
export interface BranchGeometry {
  readonly params: VehicleParams;
  readonly corridor: Corridor;
  readonly lane: LaneGeometry;
  readonly discs: VehicleDiscs;
  /** Disc radius plus the MPC's obstacle margin, m. */
  readonly inflation: number;
  /** The MPC's obstacle margin (MpcConstraintSettings.obstacleMargin), m. */
  readonly obstacleMargin: number;
  /** The MPC's margin from the corridor edges, m. */
  readonly corridorMargin: number;
  readonly friction: FrictionPreview;
}

/** The deceleration a stop is counted on at arc length s, min(share·μ(s)·g, −accelMin), m/s² (share: stopShare). */
export function brakeDecel(geometry: BranchGeometry, share: number, s: number): number {
  const mu = Math.max(geometry.friction.at(s), 0.01);
  return Math.min(share * mu * GRAVITY, -geometry.params.accelMin);
}

/**
 * The lateral band an obstacle may occupy at time `time` after its report, into `out` (centers, without its half
 * width): from its reported e_y (it stopped then) to its constant-velocity e_y (it kept going). A lateral speed under
 * `still` (BranchSettings.stillLateralSpeed) is taken as noise on a standing obstacle: the band is then its reported
 * e_y, else a pedestrian waiting on the curb drifted into the lane on noise alone.
 */
export function obstacleBand(
  track: ObstacleTrack,
  time: number,
  out: { lo: number; hi: number },
  still = HOLD_MIN_LATERAL_SPEED,
): void {
  const vey = Math.abs(track.vey) < still ? 0 : track.vey;
  const later = track.ey + vey * time;
  out.lo = Math.min(track.ey, later);
  out.hi = Math.max(track.ey, later);
}

/** An obstacle in the path, with what the evasions need of it. */
export interface PathObstacle {
  readonly track: ObstacleTrack;
  /** Index in the tracks the cycle read. */
  readonly index: number;
  /** Age of the track at the plan's start, s. */
  readonly age: number;
  /** Its center along the road when the vehicle's front disc reaches its inflated box, m. */
  readonly s: number;
  /** Time until then, and until the rear disc leaves the inflated box, from the plan's start, s. */
  readonly arrival: number;
  readonly pass: number;
  /** Its lateral band (box edges included) from the report to `pass`, m. */
  readonly lo: number;
  readonly hi: number;
  /** Gap from the front disc to the inflated box along the road at the plan's start, m (negative alongside). */
  readonly gap: number;
}

/** The target of the evasions and the e_y each side would pass it at, or null without a drivable gap. */
export interface PathAnalysis {
  /** Obstacles in the path, nearest first. */
  readonly obstacles: readonly PathObstacle[];
  /** The nearest one: what B2 and B3 pass. */
  readonly target: PathObstacle | null;
  readonly left: number | null;
  readonly right: number | null;
}

const band = { lo: 0, hi: 0 };
const bounds = { left: 0, right: 0 };

/**
 * The obstacles in the path from the planning state x0 = (s, e_y, …, vx) with horizon `horizon` s, and the gaps
 * beside the nearest. An obstacle is in the path when:
 * - it is not yet passed (the rear disc has not left its inflated box) and its inflated box starts within
 *   v·horizon + v²/(2·a_stop) + pathMargin of the front disc (a_stop at stopShare), v the larger of vx and
 *   x0.vRange (the reference speed: a vehicle that braked for an obstacle and stopped short of it still has it in its
 *   path, else the event ended, B0 drove on and the obstacle came back into the path);
 * - its band from the report until the vehicle passes it at the current speed (capped at the horizon), widened by
 *   its half width, overlaps the ego lane or the band of the vehicle's discs at its e_y now; for one in `sticky` (in
 *   the path in the previous cycle) widened by pathExitMargin too.
 * The gap on a side is the room between that band and the corridor edge, the tightest over the span where the vehicle
 * is alongside the target (its inflated box: both ends and the middle), narrowed by every other track alongside the
 * target on that side (its band at the target's pass): drivable when the body (half its width) fits between them
 * with the obstacle margin and the evasion's clearance, the corridor's margin kept, and when the grip there is at
 * least gapGripShare of the lane's, at both ends and the middle of the span, on the passage's two edges and its
 * middle. The side's offset is then the farthest e_y the body may take there: the corridor edge less its margin and
 * half the body, or the other track's band less the same room. The rows of the MPC are written on the discs, which
 * reach wider than the body (1.42 m against 0.9 m for the car), and may take some slack where the gap only fits the
 * body.
 */
export function pathObstacles(
  x0: { readonly s: number; readonly ey: number; readonly vx: number; readonly vRange?: number },
  tracks: readonly ObstacleTrack[],
  ages: readonly number[],
  horizon: number,
  geometry: BranchGeometry,
  settings: BranchSettings,
  sticky?: ReadonlySet<string>,
): PathAnalysis {
  const { discs, inflation, lane } = geometry;
  const front = x0.s + discs.offsets[0];
  const rear = x0.s + discs.offsets[1];
  const v = Math.max(x0.vx, 0);
  const vr = Math.max(v, x0.vRange ?? 0);
  const range = vr * horizon + (vr * vr) / (2 * brakeDecel(geometry, settings.stopShare, x0.s)) + settings.pathMargin;
  const laneLo = lane.center - lane.width / 2;
  const laneHi = lane.center + lane.width / 2;
  const found: PathObstacle[] = [];
  tracks.forEach((track, index) => {
    const age = ages[index] ?? 0;
    const hs = track.length / 2;
    const hey = track.width / 2;
    const sNow = track.s + track.vs * age;
    if (sNow + hs + inflation <= rear) return;
    const gap = sNow - hs - inflation - front;
    if (gap > range) return;
    const closing = v - track.vs;
    const arrival = closing > 0.5 ? Math.min(Math.max(gap, 0) / closing, horizon) : horizon;
    const pass = closing > 0.5 ? Math.min((sNow + hs + inflation - rear) / closing, horizon) : horizon;
    obstacleBand(track, age + pass, band, settings.stillLateralSpeed);
    const lo = band.lo - hey;
    const hi = band.hi + hey;
    const exit = sticky?.has(track.id) === true ? settings.pathExitMargin : 0;
    const ego = discs.radius + exit;
    const overlapsLane = hi + exit > laneLo && lo - exit < laneHi;
    const overlapsEgo = hi > x0.ey - ego && lo < x0.ey + ego;
    if (!overlapsLane && !overlapsEgo) return;
    found.push({ track, index, age, s: track.s + track.vs * (age + arrival), arrival, pass, lo, hi, gap });
  });
  found.sort((a, b) => a.gap - b.gap || a.index - b.index);
  const target = found[0] ?? null;
  if (target === null) return { obstacles: found, target, left: null, right: null };
  const half = geometry.params.width / 2;
  const body = half + geometry.obstacleMargin + settings.evadeClearance;
  // The corridor over the span where the vehicle is alongside the target (its inflated box: both ends and the middle).
  const reach = target.track.length / 2 + inflation;
  let leftMax = Infinity;
  let rightMin = -Infinity;
  for (const s of [target.s - reach, target.s, target.s + reach]) {
    geometry.corridor.bounds(s, bounds);
    leftMax = Math.min(leftMax, bounds.left - geometry.corridorMargin - half);
    rightMin = Math.max(rightMin, bounds.right + geometry.corridorMargin + half);
  }
  // Every other track alongside the target narrows the side it is on: its band when the vehicle passes the target.
  const middle = (target.lo + target.hi) / 2;
  tracks.forEach((other, index) => {
    if (index === target.index) return;
    const age = ages[index] ?? 0;
    const along = other.s + other.vs * (age + target.arrival);
    if (Math.abs(along - target.s) >= other.length / 2 + inflation + reach + geometry.params.length) return;
    obstacleBand(other, age + target.pass, band, settings.stillLateralSpeed);
    const lo = band.lo - other.width / 2;
    const hi = band.hi + other.width / 2;
    if ((lo + hi) / 2 >= middle) leftMax = Math.min(leftMax, lo - body);
    else rightMin = Math.max(rightMin, hi + body);
  });
  // The grip along a passage from e_y lo to hi, against the lane's that the evasion's plan counts on.
  const grips = (lo: number, hi: number): boolean => {
    for (const s of [target.s - reach, target.s, target.s + reach]) {
      const floor = settings.gapGripShare * geometry.friction.at(s);
      for (const ey of [lo, (lo + hi) / 2, hi]) if (geometry.friction.at(s, ey) < floor) return false;
    }
    return true;
  };
  return {
    obstacles: found,
    target,
    left: target.hi + body <= leftMax && grips(target.hi + body, leftMax) ? leftMax : null,
    right: target.lo - body >= rightMin && grips(rightMin, target.lo - body) ? rightMin : null,
  };
}

/** B1's reference: the base reference's e_y, and a speed falling from v0 at s0 to 0 at `decel`. */
export class BrakeReference implements Reference {
  private s0 = 0;
  private v0 = 0;
  private decel = 1;
  private readonly base: Reference;

  constructor(base: Reference) {
    this.base = base;
  }

  /** Anchors the profile at the planning state, every cycle. */
  anchor(s0: number, v0: number, decel: number): void {
    this.s0 = s0;
    this.v0 = Math.max(v0, 0);
    this.decel = decel;
  }

  at(s: number, out: { ey: number; speed: number }): void {
    this.base.at(s, out);
    const v2 = this.v0 * this.v0 - 2 * this.decel * Math.max(s - this.s0, 0);
    out.speed = Math.min(out.speed, v2 > 0 ? Math.sqrt(v2) : 0);
  }
}

/** Smooth step from 0 at u ≤ 0 to 1 at u ≥ 1 (C¹). */
function smoothstep(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u * u * (3 - 2 * u);
}

/**
 * B2's and B3's reference: the base reference's speed capped at the planning speed (an evasion does not accelerate;
 * the cap follows the vehicle down when it brakes), and an e_y that moves from the base's to `offset` over a
 * ramp ending where the front disc reaches the target's inflated box, holds it until the rear disc has left the
 * box, then returns to the base's over the return length. The ramp starts evadeRampTime ahead at the planning speed,
 * or already behind the vehicle when the target is nearer (the reference is then partly moved at once).
 */
export class EvadeReference implements Reference {
  private offset = 0;
  private speed = Infinity;
  private rampStart = 0;
  private full = 0;
  private holdEnd = 0;
  private back = 0;
  private readonly base: Reference;

  constructor(base: Reference) {
    this.base = base;
  }

  /** Anchors the evasion around the target, every cycle while it is tracked. */
  anchor(target: PathObstacle, offset: number, v0: number, geometry: BranchGeometry, settings: BranchSettings): void {
    const { offsets } = geometry.discs;
    const hs = target.track.length / 2;
    const ramp = Math.max(v0 * settings.evadeRampTime, settings.evadeMinLength);
    const back = Math.max(v0 * settings.evadeReturnTime, settings.evadeMinLength);
    this.offset = offset;
    this.speed = Math.max(v0, 0);
    this.full = target.s - hs - geometry.inflation - offsets[0];
    this.rampStart = this.full - ramp;
    this.holdEnd = target.s + hs + geometry.inflation - offsets[1];
    this.back = this.holdEnd + back;
  }

  /** The e_y the evasion aims at, m. */
  get target(): number {
    return this.offset;
  }

  at(s: number, out: { ey: number; speed: number }): void {
    this.base.at(s, out);
    let w: number;
    if (s < this.full) w = smoothstep((s - this.rampStart) / (this.full - this.rampStart));
    else if (s <= this.holdEnd) w = 1;
    else w = 1 - smoothstep((s - this.holdEnd) / (this.back - this.holdEnd));
    out.ey += (this.offset - out.ey) * w;
    out.speed = Math.min(out.speed, this.speed);
  }
}
