/**
 * The "true" vehicle (the plant): a two-track model with four wheels, so that μ-split braking produces its
 * yaw moment. The MPC predicts with a simpler single-track model: the difference is deliberate.
 *
 * Body frame: x forward, y left, z up; yaw ψ counter-clockwise. Wheels are FL, FR, RL, RR (0..3).
 * One `step` advances one 1 kHz tick:
 * - vertical loads come from the static distribution plus quasi-static load transfer, driven by lagged
 *   accelerations so that loads and tire forces never form an algebraic loop; a lifted wheel hands its load
 *   to the other wheel of its axle, so the total stays the vehicle's weight;
 * - tire forces are computed once per step and held while RK4 integrates the chassis: first order in the
 *   force–state coupling, accurate at 1 kHz;
 * - wheel speeds are updated semi-implicitly in the tire force, with brake and rolling-resistance torques as
 *   Coulomb friction that can stop a wheel but never turn it backwards;
 * - below 3 m/s the lateral and yaw dynamics blend into the kinematic model, within the available grip;
 *   below 0.05 m/s with the brakes holding, the vehicle latches at standstill.
 */
import { AIR_DENSITY, GRAVITY, rolloverAccel, wheelbase, type VehicleParams } from './params.ts';
import type { Surface } from './surfaces.ts';
import { tireForces } from './tire.ts';

/** Chassis state indices. */
export const CHASSIS = {
  X: 0,
  Y: 1,
  PSI: 2,
  VX: 3,
  VY: 4,
  R: 5,
  /** Lagged body accelerations that drive the load transfer. */
  AX_LAG: 6,
  AY_LAG: 7,
} as const;
export const CHASSIS_SIZE = 8;

const { X, Y, PSI, VX, VY, R, AX_LAG, AY_LAG } = CHASSIS;

/** Floor of the slip denominators, m/s: keeps slips finite and the tire non-stiff near standstill. */
const SLIP_SPEED_FLOOR = 1;
const LOAD_TRANSFER_LAG = 0.15;
/** Speed band where lateral and yaw dynamics blend from kinematic (below) to dynamic (above). */
const KINEMATIC_FULL = 1;
const DYNAMIC_FULL = 3;
const KINEMATIC_LAG = 0.05;
const STOP_SPEED = 0.05;
/** A wheel counts as lifted below this share of its static load. */
const LIFT_SHARE = 0.01;

/**
 * The surface under each wheel. Use one per vehicle: implementations may keep a search hint per wheel, and
 * `reset` forgets it when the vehicle is placed somewhere new.
 */
export interface SurfaceSource {
  at(wheel: number, x: number, y: number): Surface;
  reset(): void;
}

export interface PlantInputs {
  /** Road-wheel angle of both front wheels. */
  steer: number;
  /** Drive torque per wheel, N·m. */
  readonly driveTorque: Float64Array;
  /** Brake torque magnitude per wheel, N·m. */
  readonly brakeTorque: Float64Array;
}

/** External loads at the center of gravity, such as a crosswind gust. */
export interface ExternalLoads {
  fy: number;
  mz: number;
}

function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

export class Plant {
  readonly params: VehicleParams;
  readonly chassis = new Float64Array(CHASSIS_SIZE);
  /** Wheel angular speeds, rad/s, never negative. */
  readonly omega = new Float64Array(4);
  /** Outputs of the last step, per wheel. Forces are in the wheel frame. */
  readonly fz = new Float64Array(4);
  readonly kappa = new Float64Array(4);
  readonly alpha = new Float64Array(4);
  readonly fx = new Float64Array(4);
  readonly fy = new Float64Array(4);
  readonly lifted = [false, false, false, false];
  readonly surfaces: Surface[] = [];
  /** Body accelerations from the forces of the last step, m/s². */
  ax = 0;
  ay = 0;
  latched = false;
  /** The lateral acceleration is past `rolloverAccel`: the vehicle would start to tip. */
  overRolloverLimit = false;

  private readonly surfaceSource: SurfaceSource;
  private readonly dt: number;
  private readonly wheelX: Float64Array;
  private readonly wheelY: Float64Array;
  private readonly staticFz: Float64Array;
  private readonly corneringPerLoadFront: number;
  private readonly corneringPerLoadRear: number;
  private readonly shareFront: number;
  private readonly rolloverLimit: number;
  /** Yaw acceleration per m/s² of lateral grip: m·max(lf, lr)/Iz. */
  private readonly yawGripArm: number;
  private readonly force = new Float64Array(2);
  private readonly k1 = new Float64Array(CHASSIS_SIZE);
  private readonly k2 = new Float64Array(CHASSIS_SIZE);
  private readonly k3 = new Float64Array(CHASSIS_SIZE);
  private readonly k4 = new Float64Array(CHASSIS_SIZE);
  private readonly stage = new Float64Array(CHASSIS_SIZE);
  // Held constant over the RK4 stages of a step.
  private fxBody = 0;
  private fyBody = 0;
  private mzBody = 0;
  private steer = 0;
  private dynamicWeight = 1;
  private gripAccel = GRAVITY;

  constructor(params: VehicleParams, surfaces: SurfaceSource, dt: number) {
    this.params = params;
    this.surfaceSource = surfaces;
    this.dt = dt;
    const halfTrack = params.track / 2;
    this.wheelX = Float64Array.of(params.lf, params.lf, -params.lr, -params.lr);
    this.wheelY = Float64Array.of(halfTrack, -halfTrack, halfTrack, -halfTrack);
    const L = wheelbase(params);
    const axleFront = (params.mass * GRAVITY * params.lr) / L;
    const axleRear = (params.mass * GRAVITY * params.lf) / L;
    this.staticFz = Float64Array.of(axleFront / 2, axleFront / 2, axleRear / 2, axleRear / 2);
    this.corneringPerLoadFront = params.corneringStiffnessFront / axleFront;
    this.corneringPerLoadRear = params.corneringStiffnessRear / axleRear;
    this.shareFront = params.lr / L;
    this.rolloverLimit = rolloverAccel(params);
    this.yawGripArm = (params.mass * Math.max(params.lf, params.lr)) / params.yawInertia;
    this.reset(0, 0, 0, 0);
  }

  /** Places the vehicle at (x, y) with heading `psi`, moving straight at `speed` with the wheels rolling. */
  reset(x: number, y: number, psi: number, speed: number): void {
    this.surfaceSource.reset();
    this.chassis.fill(0);
    this.chassis[X] = x;
    this.chassis[Y] = y;
    this.chassis[PSI] = psi;
    this.chassis[VX] = Math.max(0, speed);
    this.omega.fill(Math.max(0, speed) / this.params.wheelRadius);
    this.fz.set(this.staticFz);
    this.lifted.fill(false);
    this.kappa.fill(0);
    this.alpha.fill(0);
    this.fx.fill(0);
    this.fy.fill(0);
    this.ax = 0;
    this.ay = 0;
    this.fxBody = 0;
    this.fyBody = 0;
    this.mzBody = 0;
    this.latched = false;
    this.overRolloverLimit = false;
    this.steer = 0;
    this.dynamicWeight = 1;
    this.updateSurfaces();
  }

  get speed(): number {
    return Math.hypot(this.chassis[VX] ?? 0, this.chassis[VY] ?? 0);
  }

  step(inputs: PlantInputs, loads: ExternalLoads): void {
    const p = this.params;
    const c = this.chassis;
    const dt = this.dt;
    let driveTotal = 0;
    let brakeTotal = 0;
    for (let i = 0; i < 4; i++) {
      driveTotal += inputs.driveTorque[i] ?? 0;
      brakeTotal += inputs.brakeTorque[i] ?? 0;
    }
    // The same holding torque decides both releasing and latching within a step.
    const holding = brakeTotal + this.rollingTorque();

    if (this.latched) {
      if (driveTotal <= holding) {
        this.holdStill();
        return;
      }
      this.latched = false;
    }

    this.updateLoads();
    this.steer = inputs.steer;
    const cosSteer = Math.cos(inputs.steer);
    const sinSteer = Math.sin(inputs.steer);
    const psi = c[PSI] ?? 0;
    const cosPsi = Math.cos(psi);
    const sinPsi = Math.sin(psi);
    const vx = c[VX] ?? 0;
    const vy = c[VY] ?? 0;
    const r = c[R] ?? 0;
    const radius = p.wheelRadius;

    let fxSum = 0;
    let fySum = 0;
    let mzSum = 0;
    let muSum = 0;
    for (let i = 0; i < 4; i++) {
      const xi = this.wheelX[i] ?? 0;
      const yi = this.wheelY[i] ?? 0;
      const front = i < 2;
      const cd = front ? cosSteer : 1;
      const sd = front ? sinSteer : 0;
      const vwx = vx - r * yi;
      const vwy = vy + r * xi;
      const vLong = vwx * cd + vwy * sd;
      const vLat = -vwx * sd + vwy * cd;
      const denom = Math.max(Math.abs(vLong), SLIP_SPEED_FLOOR);
      const omega = this.omega[i] ?? 0;
      const kappa = (omega * radius - vLong) / denom;
      const alpha = Math.atan(vLat / denom);
      const surface = this.surfaceSource.at(
        i,
        (c[X] ?? 0) + xi * cosPsi - yi * sinPsi,
        (c[Y] ?? 0) + xi * sinPsi + yi * cosPsi,
      );
      this.surfaces[i] = surface;
      muSum += surface.mu;

      const fz = this.fz[i] ?? 0;
      const corneringPerLoad = front ? this.corneringPerLoadFront : this.corneringPerLoadRear;
      const slope = tireForces(kappa, alpha, fz, surface, corneringPerLoad, this.force);
      const fxw = this.force[0] ?? 0;
      const fyw = this.force[1] ?? 0;
      this.kappa[i] = kappa;
      this.alpha[i] = alpha;
      this.fx[i] = fxw;
      this.fy[i] = fyw;

      const fxb = fxw * cd - fyw * sd;
      const fyb = fxw * sd + fyw * cd;
      fxSum += fxb;
      fySum += fyb;
      mzSum += xi * fyb - yi * fxb;

      // Implicit in the tire force: J·ω̇ = T − R·Fx(ω), with dFx/dω = slope·R/denom.
      const inertia = p.wheelInertia + (dt * radius * radius * slope) / denom;
      const friction = (inputs.brakeTorque[i] ?? 0) + p.rollingResistance * fz * radius;
      const free = omega + (dt * ((inputs.driveTorque[i] ?? 0) - radius * fxw)) / inertia;
      const stop = (dt * friction) / inertia;
      this.omega[i] = free > stop ? free - stop : 0;
    }
    this.gripAccel = (muSum / 4) * GRAVITY;

    const drag = 0.5 * AIR_DENSITY * p.dragArea * vx * Math.abs(vx);
    this.fxBody = fxSum - drag;
    this.fyBody = fySum + loads.fy;
    this.mzBody = mzSum + loads.mz;
    this.ax = this.fxBody / p.mass;
    this.ay = this.fyBody / p.mass;

    const speed = Math.hypot(vx, vy);
    this.dynamicWeight = clamp((speed - KINEMATIC_FULL) / (DYNAMIC_FULL - KINEMATIC_FULL), 0, 1);
    this.integrate();
    this.overRolloverLimit = Math.abs(c[AY_LAG] ?? 0) > this.rolloverLimit;

    if (this.speed < STOP_SPEED && driveTotal <= holding) {
      this.latched = true;
      this.holdStill();
    }
  }

  private integrate(): void {
    const c = this.chassis;
    const s = this.stage;
    const h = this.dt;
    this.derivative(c, this.k1);
    for (let j = 0; j < CHASSIS_SIZE; j++) s[j] = (c[j] ?? 0) + 0.5 * h * (this.k1[j] ?? 0);
    this.derivative(s, this.k2);
    for (let j = 0; j < CHASSIS_SIZE; j++) s[j] = (c[j] ?? 0) + 0.5 * h * (this.k2[j] ?? 0);
    this.derivative(s, this.k3);
    for (let j = 0; j < CHASSIS_SIZE; j++) s[j] = (c[j] ?? 0) + h * (this.k3[j] ?? 0);
    this.derivative(s, this.k4);
    for (let j = 0; j < CHASSIS_SIZE; j++) {
      c[j] =
        (c[j] ?? 0) + (h / 6) * ((this.k1[j] ?? 0) + 2 * (this.k2[j] ?? 0) + 2 * (this.k3[j] ?? 0) + (this.k4[j] ?? 0));
    }
  }

  private derivative(s: Float64Array, out: Float64Array): void {
    const p = this.params;
    const psi = s[PSI] ?? 0;
    const vx = s[VX] ?? 0;
    const vy = s[VY] ?? 0;
    const r = s[R] ?? 0;
    const cos = Math.cos(psi);
    const sin = Math.sin(psi);
    out[X] = vx * cos - vy * sin;
    out[Y] = vx * sin + vy * cos;
    out[PSI] = r;
    out[VX] = this.fxBody / p.mass + r * vy;
    let dvy = this.fyBody / p.mass - r * vx;
    let dr = this.mzBody / p.yawInertia;
    const w = this.dynamicWeight;
    if (w < 1) {
      // Kinematic targets, within the grip: the turn never asks for more than μ·g of lateral acceleration.
      const grip = this.gripAccel;
      let yawRate = (vx * Math.tan(this.steer)) / wheelbase(p);
      if (vx > 0.1) yawRate = clamp(yawRate, -grip / vx, grip / vx);
      const lateral = clamp((yawRate * p.lr - vy) / KINEMATIC_LAG, -grip, grip);
      const yawGrip = grip * this.yawGripArm;
      const yaw = clamp((yawRate - r) / KINEMATIC_LAG, -yawGrip, yawGrip);
      dvy = w * dvy + (1 - w) * lateral;
      dr = w * dr + (1 - w) * yaw;
    }
    out[VY] = dvy;
    out[R] = dr;
    out[AX_LAG] = (this.ax - (s[AX_LAG] ?? 0)) / LOAD_TRANSFER_LAG;
    out[AY_LAG] = (this.ay - (s[AY_LAG] ?? 0)) / LOAD_TRANSFER_LAG;
  }

  /**
   * Quasi-static load transfer from the lagged accelerations; pitch and roll are not states. Accelerating
   * forward loads the rear axle; turning left (ay > 0) loads the right-hand wheels. A wheel never carries a
   * negative load: when it lifts, the other wheel of its axle takes the whole axle load.
   */
  private updateLoads(): void {
    const p = this.params;
    const weight = p.mass * GRAVITY;
    const longitudinal = (p.mass * (this.chassis[AX_LAG] ?? 0) * p.cgHeight) / wheelbase(p);
    const front = clamp(2 * (this.staticFz[0] ?? 0) - longitudinal, 0, weight);
    const rear = weight - front;
    const lateral = (p.mass * (this.chassis[AY_LAG] ?? 0) * p.cgHeight) / p.track;
    const transferFront = clamp(lateral * this.shareFront, -front / 2, front / 2);
    const transferRear = clamp(lateral * (1 - this.shareFront), -rear / 2, rear / 2);
    this.setLoad(0, front / 2 - transferFront);
    this.setLoad(1, front / 2 + transferFront);
    this.setLoad(2, rear / 2 - transferRear);
    this.setLoad(3, rear / 2 + transferRear);
  }

  private setLoad(wheel: number, fz: number): void {
    this.fz[wheel] = fz;
    this.lifted[wheel] = fz < LIFT_SHARE * (this.staticFz[wheel] ?? 0);
  }

  private rollingTorque(): number {
    let total = 0;
    for (let i = 0; i < 4; i++) total += this.params.rollingResistance * (this.fz[i] ?? 0) * this.params.wheelRadius;
    return total;
  }

  private holdStill(): void {
    const c = this.chassis;
    c[VX] = 0;
    c[VY] = 0;
    c[R] = 0;
    // Load transfer settles at rest.
    const settle = Math.exp(-this.dt / LOAD_TRANSFER_LAG);
    c[AX_LAG] = (c[AX_LAG] ?? 0) * settle;
    c[AY_LAG] = (c[AY_LAG] ?? 0) * settle;
    this.omega.fill(0);
    this.kappa.fill(0);
    this.alpha.fill(0);
    this.fx.fill(0);
    this.fy.fill(0);
    this.ax = 0;
    this.ay = 0;
    this.overRolloverLimit = false;
    this.updateLoads();
  }

  private updateSurfaces(): void {
    const c = this.chassis;
    const cosPsi = Math.cos(c[PSI] ?? 0);
    const sinPsi = Math.sin(c[PSI] ?? 0);
    for (let i = 0; i < 4; i++) {
      const xi = this.wheelX[i] ?? 0;
      const yi = this.wheelY[i] ?? 0;
      this.surfaces[i] = this.surfaceSource.at(
        i,
        (c[X] ?? 0) + xi * cosPsi - yi * sinPsi,
        (c[Y] ?? 0) + xi * sinPsi + yi * cosPsi,
      );
    }
  }
}
