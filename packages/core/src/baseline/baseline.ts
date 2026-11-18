/**
 * The comparison controller (Phase 3): Stanley steering at the front axle, a PI on speed and an
 * automatic emergency brake (time to collision or required deceleration, counting the brake and computation delays).
 * It runs as the ghost next to the MPC, with the same
 * period and delay, and is deliberately classical: it tunes for dry asphalt and does not know the friction, so on
 * the low-grip curve it can spin where the MPC does not (M4). It reads the obstacle tracks of the object sensor,
 * never the true world.
 */
import { wrapAngle } from '../math/angle.ts';
import type { Reference } from '../mpc/mpc.ts';
import type { Projection, RoadPath, RoadPoint } from '../road/path.ts';
import type { TrackSource } from '../sensors/views.ts';
import type { Controller } from '../sim/closedLoop.ts';
import { TICK_HZ } from '../sim/clock.ts';
import type { DriverCommand } from '../vehicle/actuators.ts';
import type { VehicleParams } from '../vehicle/params.ts';
import { CHASSIS } from '../vehicle/plant.ts';
import type { Vehicle } from '../vehicle/vehicle.ts';

/** The AEB engages when the time to collision at the moment the brake takes effect drops below this, s. */
export const AEB_TTC_ENGAGE = 1.5;
/** A moving target releases the brake when that time rises above this, s (hysteresis). */
export const AEB_TTC_RELEASE = 2.5;
/**
 * The AEB also engages when the deceleration needed to stop the closing speed before contact, after the delays, exceeds
 * this share of the vehicle's braking capability: a heavy vehicle with slow brakes needs the earlier trigger.
 */
export const AEB_DECEL_ENGAGE = 0.7;
/** A moving target releases the brake only when the required deceleration is below this share (hysteresis). */
export const AEB_DECEL_RELEASE = 0.4;
/** Extra lateral clearance around the vehicle's footprint when deciding whether a track is in its path, m. */
export const AEB_LATERAL_MARGIN = 0.5;
/** A track slower than this along the road counts as stationary: it can hold the brake while in the path, m/s. */
const STATIONARY_SPEED = 0.5;
/**
 * A stationary track keeps the brake held only if it is the track that engaged the AEB or is nearer than this, m: a
 * far parked box must not keep the car at standstill after the pedestrian that stopped it has left the path.
 */
export const AEB_HOLD_GAP = 5;
/** Closing speeds below this give no collision course, m/s. */
const MIN_CLOSING_SPEED = 0.1;

export interface BaselineOptions {
  /** Control period, ticks: 50 at 1 kHz is 20 Hz. */
  readonly periodTicks?: number;
  /**
   * Computation delay, ticks at 1 kHz (50 is 0.05 s): the command takes effect this long after the state it was
   * computed from. Configuration, as for the MPC driver. The Stanley loop degrades as it grows (50 and 100 are the
   * values the tests use; large delays, near 1 s, are expected to leave the lane): re-measure before relying on a
   * figure for a given delay, none is claimed here.
   */
  readonly delayTicks?: number;
  /** Stanley cross-track gain, 1/s. */
  readonly stanleyGain?: number;
  /** Stanley softening speed, m/s. */
  readonly stanleySoftening?: number;
  /** Weight of the curvature feed-forward on the steering, 0 to 1. */
  readonly curvatureFeedForward?: number;
  readonly speedKp?: number;
  readonly speedKi?: number;
  /** Largest magnitude of the integral term, m/s². */
  readonly speedIntegralMax?: number;
  readonly aebEngageTtc?: number;
  readonly aebReleaseTtc?: number;
  /**
   * Judge the collision at the state it will have when the command takes effect, counting the computation delay
   * (delayTicks). With false the AEB ignores that delay and engages later (asserted in the tests: a later first
   * engagement tick at 50 km/h dry); the stop margin it costs is not claimed here. The brake actuator's own delay and
   * lag are always counted.
   *
   * The AEB assumes dry braking capability (params.accelMin) and does not know the friction, by design: on snow the
   * car cannot stop in time and drives through a box that dry braking would clear; on wet it still stops.
   */
  readonly aebCompensateDelay?: boolean;
  /** Share of the braking capability that triggers the AEB (0 to 1). */
  readonly aebDecelEngage?: number;
  /** Share of the braking capability below which a moving target releases the AEB. */
  readonly aebDecelRelease?: number;
}

export class BaselineDriver implements Controller {
  readonly periodTicks: number;
  readonly delayTicks: number;
  /** True while the AEB commands full braking: for the UI and the metrics. */
  aebActive = false;
  /** Tick of the first AEB engagement of the run, or -1. */
  aebFirstTick = -1;
  /** Time to collision judged at the last step, s (Infinity without a collision course). */
  ttc = Infinity;
  /** Gap to the threatening track at the last step, m (Infinity without one). */
  gap = Infinity;

  private readonly params: VehicleParams;
  private readonly road: RoadPath;
  private readonly reference: Reference;
  private readonly tracks: TrackSource;
  private readonly stanleyGain: number;
  private readonly stanleySoftening: number;
  private readonly feedForward: number;
  private readonly kp: number;
  private readonly ki: number;
  private readonly integralMax: number;
  private readonly engageTtc: number;
  private readonly releaseTtc: number;
  private readonly compensateDelay: boolean;
  private readonly brakeLatency: number;
  private readonly noseOffset: number;
  private readonly tailOffset: number;
  private readonly decelEngage: number;
  private readonly decelRelease: number;
  private readonly dt: number;
  private integral = 0;
  /** Id of the track that engaged the brake: it keeps the hold while stationary, at any gap. */
  private engagedBy = '';
  private readonly centre: Projection = { s: 0, ey: 0, heading: 0, curvature: 0, index: -1 };
  private readonly front: Projection = { s: 0, ey: 0, heading: 0, curvature: 0, index: -1 };
  private readonly point: RoadPoint = { x: 0, y: 0, heading: 0, curvature: 0 };
  private readonly target = { ey: 0, speed: 0 };
  private readonly ahead = { ey: 0, speed: 0 };

  constructor(
    params: VehicleParams,
    road: RoadPath,
    reference: Reference,
    tracks: TrackSource,
    options: BaselineOptions = {},
  ) {
    this.params = params;
    this.road = road;
    this.reference = reference;
    this.tracks = tracks;
    this.periodTicks = options.periodTicks ?? 50;
    this.delayTicks = options.delayTicks ?? 50;
    this.dt = this.periodTicks / TICK_HZ;
    this.stanleyGain = options.stanleyGain ?? 0.8;
    this.stanleySoftening = options.stanleySoftening ?? 3;
    this.feedForward = options.curvatureFeedForward ?? 1;
    this.kp = options.speedKp ?? 0.4;
    this.ki = options.speedKi ?? 0.05;
    this.integralMax = options.speedIntegralMax ?? 1.5;
    this.engageTtc = options.aebEngageTtc ?? AEB_TTC_ENGAGE;
    this.releaseTtc = options.aebReleaseTtc ?? AEB_TTC_RELEASE;
    this.compensateDelay = options.aebCompensateDelay ?? true;
    // The brake takes effect after its pure delay and, to be useful, about one lag time constant more.
    this.brakeLatency = params.brakeDelay + params.brakeLag;
    // The body is centred on the wheelbase's overhangs split evenly: the nose and the tail from the CG.
    const overhang = (params.length - params.lf - params.lr) / 2;
    this.noseOffset = params.lf + overhang;
    this.tailOffset = params.lr + overhang;
    this.decelEngage = options.aebDecelEngage ?? AEB_DECEL_ENGAGE;
    this.decelRelease = options.aebDecelRelease ?? AEB_DECEL_RELEASE;
  }

  reset(): void {
    this.integral = 0;
    this.aebActive = false;
    this.aebFirstTick = -1;
    this.engagedBy = '';
    this.ttc = Infinity;
    this.gap = Infinity;
    this.centre.index = -1;
    this.front.index = -1;
  }

  compute(tick: number, vehicle: Vehicle, out: DriverCommand): void {
    const p = this.params;
    const c = vehicle.plant.chassis;
    const x = c[CHASSIS.X] ?? 0;
    const y = c[CHASSIS.Y] ?? 0;
    const psi = c[CHASSIS.PSI] ?? 0;
    const speed = c[CHASSIS.VX] ?? 0;

    this.road.project(x, y, this.centre.index, this.centre);
    this.road.project(x + p.lf * Math.cos(psi), y + p.lf * Math.sin(psi), this.front.index, this.front);

    out.steer = this.steer(psi, speed);
    this.emergencyBrake(tick, speed);
    if (this.aebActive) {
      // The speed PI is frozen while the AEB overrides it: its integral does not wind and the release is smooth.
      out.accel = p.accelMin;
    } else {
      this.reference.at(this.centre.s, this.target);
      out.accel = this.speedControl(this.target.speed, speed);
    }
  }

  /** Stanley at the front axle toward the reference's lateral offset, with a curvature feed-forward. */
  private steer(psi: number, speed: number): number {
    const front = this.front;
    const ds = 1;
    this.reference.at(front.s, this.target);
    this.reference.at(front.s + ds, this.ahead);
    const slope = Math.atan2(this.ahead.ey - this.target.ey, ds);
    const headingError = wrapAngle(front.heading + slope - psi);
    const crossTrack = this.target.ey - front.ey;
    const stanley = Math.atan2(this.stanleyGain * crossTrack, this.stanleySoftening + Math.abs(speed));
    const kappa = this.road.pointAt(front.s, this.point).curvature;
    const wheelbase = this.params.lf + this.params.lr;
    const steer = headingError + stanley + this.feedForward * Math.atan(wheelbase * kappa);
    return Math.max(-this.params.steerMax, Math.min(this.params.steerMax, steer));
  }

  /** PI on speed with conditional anti-windup; the output is an acceleration within the vehicle's range. */
  private speedControl(referenceSpeed: number, speed: number): number {
    const error = referenceSpeed - speed;
    const { accelMin, accelMax } = this.params;
    const unsaturated = this.kp * error + this.integral;
    const command = Math.max(accelMin, Math.min(accelMax, unsaturated));
    const pushingFurther = command !== unsaturated && (unsaturated - command) * error > 0;
    if (!pushingFurther) {
      this.integral = Math.max(
        -this.integralMax,
        Math.min(this.integralMax, this.integral + this.ki * error * this.dt),
      );
    }
    return command;
  }

  /** Looks for the nearest track in the vehicle's path and runs the AEB state machine. */
  private emergencyBrake(tick: number, speed: number): void {
    const p = this.params;
    const s = this.centre.s;
    const ey = this.centre.ey;
    const noseS = s + this.noseOffset;
    const tailS = s - this.tailOffset;
    // Time between the state read here and the brake biting: computation delay, actuator delay and lag.
    const latency = this.brakeLatency + (this.compensateDelay ? this.delayTicks / TICK_HZ : 0);
    const capability = Math.abs(p.accelMin);
    let gap = Infinity;
    let ttc = Infinity;
    let required = 0;
    let stationary = false;
    let nearestId = '';
    for (const t of this.tracks.tracks()) {
      // The track is as old as the sensor's latency: predict it to now.
      const age = Math.max(0, (tick - t.tick) / TICK_HZ);
      const ts = t.s + t.vs * age;
      const tey = t.ey + t.vey * age;
      // Behind the vehicle only when its front edge is behind our tail: a track overlapping the body is contact.
      if (ts + t.length / 2 < tailS) continue;
      const clearance = ts - t.length / 2 - noseS;
      const closing = speed - t.vs;
      const effective = clearance - Math.max(0, closing) * latency;
      const time = closing > MIN_CLOSING_SPEED ? Math.max(0, effective) / closing : Infinity;
      const need = closing > MIN_CLOSING_SPEED ? (effective > 0 ? (closing * closing) / (2 * effective) : Infinity) : 0;
      // In the path now, or by the time the gap closes: a crossing pedestrian steps into the lane.
      const reach = Number.isFinite(time) ? time + latency : 0;
      const half = (t.width + p.width) / 2 + AEB_LATERAL_MARGIN;
      const inPath = Math.abs(tey - ey) < half || Math.abs(tey + t.vey * reach - ey) < half;
      if (!inPath) continue;
      if (clearance < gap) {
        gap = clearance;
        ttc = time;
        required = need;
        stationary = Math.abs(t.vs) < STATIONARY_SPEED;
        nearestId = t.id;
      }
    }
    this.gap = gap;
    this.ttc = ttc;

    if (!this.aebActive) {
      if (ttc < this.engageTtc || required > this.decelEngage * capability) {
        this.aebActive = true;
        this.engagedBy = nearestId;
        if (this.aebFirstTick < 0) this.aebFirstTick = tick;
      }
      return;
    }
    // Never release in contact, whatever the closing speed. A stationary target that engaged the brake, or is within
    // AEB_HOLD_GAP, holds it at standstill: releasing would creep toward it and brake again. Any other stationary
    // track (a far box) does not. A moving one releases when both the time and the required deceleration are comfortable.
    const contact = gap < 0;
    const holds = stationary && (nearestId === this.engagedBy || gap < AEB_HOLD_GAP);
    const clear =
      !Number.isFinite(gap) ||
      (!contact && !holds && ttc > this.releaseTtc && required < this.decelRelease * capability);
    if (clear) this.aebActive = false;
  }
}
