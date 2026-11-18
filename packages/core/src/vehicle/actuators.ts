/**
 * Actuators between a driver command (from the MPC, the baseline or a test) and the wheels: steering with a
 * rate limit and a first-order lag; brake force through a pure delay and a first-order lag; drive force
 * through a first-order lag. Values are in SI units and refer to the whole vehicle.
 */
import type { VehicleParams } from './params.ts';

export interface DriverCommand {
  /** Road-wheel steering angle, rad, positive to the left. */
  steer: number;
  /** Longitudinal acceleration request, m/s²: positive drives, negative brakes. */
  accel: number;
}

function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

export class Actuators {
  /** Actual road-wheel angle. */
  steer = 0;
  /** Actual total brake force, N. */
  brakeForce = 0;
  /** Actual total drive force, N. */
  driveForce = 0;

  private readonly params: VehicleParams;
  private readonly dt: number;
  private readonly brakeQueue: Float64Array;
  private queueIndex = 0;
  private readonly brakeBlend: number;
  private readonly driveBlend: number;

  constructor(params: VehicleParams, dt: number) {
    this.params = params;
    this.dt = dt;
    this.brakeQueue = new Float64Array(Math.round(params.brakeDelay / dt));
    // Exact discretization of a first-order lag over one step.
    this.brakeBlend = 1 - Math.exp(-dt / params.brakeLag);
    this.driveBlend = 1 - Math.exp(-dt / params.driveLag);
  }

  reset(): void {
    this.steer = 0;
    this.brakeForce = 0;
    this.driveForce = 0;
    this.brakeQueue.fill(0);
    this.queueIndex = 0;
  }

  update(command: DriverCommand): void {
    if (!Number.isFinite(command.steer) || !Number.isFinite(command.accel)) {
      throw new RangeError(`Non-finite driver command: steer ${command.steer}, accel ${command.accel}`);
    }
    const p = this.params;

    const target = clamp(command.steer, -p.steerMax, p.steerMax);
    this.steer += this.dt * clamp((target - this.steer) / p.steerLag, -p.steerRateMax, p.steerRateMax);

    const accel = clamp(command.accel, p.accelMin, p.accelMax);
    const brakeRequest = accel < 0 ? -accel * p.mass : 0;
    const driveRequest = accel > 0 ? accel * p.mass : 0;

    let delayed = brakeRequest;
    if (this.brakeQueue.length > 0) {
      delayed = this.brakeQueue[this.queueIndex] ?? 0;
      this.brakeQueue[this.queueIndex] = brakeRequest;
      this.queueIndex = (this.queueIndex + 1) % this.brakeQueue.length;
    }
    this.brakeForce += (delayed - this.brakeForce) * this.brakeBlend;
    this.driveForce += (driveRequest - this.driveForce) * this.driveBlend;
  }
}
