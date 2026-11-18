/**
 * A vehicle as the controllers see it: a driver command in, the plant state out. It chains the actuators,
 * the brake distribution, the ABS and the plant, one 1 kHz tick per `step`.
 *
 * Brake distribution follows the current axle loads (as EBD does), so under hard braking both axles reach
 * their grip together and the ABS regulates each wheel around its own peak.
 */
import { TICK_SECONDS } from '../sim/clock.ts';
import { Abs } from './abs.ts';
import { Actuators, type DriverCommand } from './actuators.ts';
import type { VehicleParams } from './params.ts';
import { Plant, type ExternalLoads, type PlantInputs, type SurfaceSource } from './plant.ts';
import type { Surface } from './surfaces.ts';

export interface VehicleOptions {
  /** Anti-lock braking, on by default. */
  readonly abs?: boolean;
}

const NO_LOADS: Readonly<ExternalLoads> = Object.freeze({ fy: 0, mz: 0 });

export class Vehicle {
  readonly params: VehicleParams;
  readonly plant: Plant;
  readonly actuators: Actuators;
  readonly abs: Abs;
  private readonly inputs: PlantInputs = {
    steer: 0,
    driveTorque: new Float64Array(4),
    brakeTorque: new Float64Array(4),
  };

  /** `surfaces` must belong to this vehicle alone (see SurfaceSource). */
  constructor(params: VehicleParams, surfaces: SurfaceSource, options: VehicleOptions = {}) {
    this.params = params;
    this.plant = new Plant(params, surfaces, TICK_SECONDS);
    this.actuators = new Actuators(params, TICK_SECONDS);
    this.abs = new Abs(options.abs ?? true);
  }

  reset(x: number, y: number, heading: number, speed: number): void {
    this.plant.reset(x, y, heading, speed);
    this.actuators.reset();
    this.abs.reset();
  }

  get speed(): number {
    return this.plant.speed;
  }

  step(command: DriverCommand, loads: Readonly<ExternalLoads> = NO_LOADS): void {
    const p = this.params;
    const plant = this.plant;
    const act = this.actuators;
    act.update(command);
    this.abs.update(plant.kappa, plant.surfaces, plant.speed, TICK_SECONDS);

    const fz = plant.fz;
    const front = (fz[0] ?? 0) + (fz[1] ?? 0);
    const total = front + (fz[2] ?? 0) + (fz[3] ?? 0);
    const shareFront = total > 0 ? front / total : p.lr / (p.lf + p.lr);
    const halfRadius = p.wheelRadius / 2;
    const brakeFront = act.brakeForce * shareFront * halfRadius;
    const brakeRear = act.brakeForce * (1 - shareFront) * halfRadius;
    const brake = this.inputs.brakeTorque;
    for (let i = 0; i < 4; i++) {
      const request = i < 2 ? brakeFront : brakeRear;
      brake[i] = this.abs.torque(i, request, fz[i] ?? 0, plant.surfaces[i] as Surface, p.wheelRadius);
    }

    const drivePerWheel = act.driveForce * halfRadius;
    const drive = this.inputs.driveTorque;
    const frontDriven = p.drivenAxle === 'front';
    drive[0] = frontDriven ? drivePerWheel : 0;
    drive[1] = frontDriven ? drivePerWheel : 0;
    drive[2] = frontDriven ? 0 : drivePerWheel;
    drive[3] = frontDriven ? 0 : drivePerWheel;

    this.inputs.steer = act.steer;
    plant.step(this.inputs, loads);
  }
}
