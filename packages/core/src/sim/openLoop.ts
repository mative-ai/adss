/**
 * Runs a vehicle on a scripted command, tick by tick, and records its state: the M1 acceptance tests, the
 * CLI and any open-loop experiment use it. The record is the chassis state and the wheel speeds every
 * `recordEvery` ticks; its fingerprint is the run's trajectory hash.
 */
import { Fingerprint } from '../math/hash.ts';
import type { DriverCommand } from '../vehicle/actuators.ts';
import { CHASSIS_SIZE, type ExternalLoads } from '../vehicle/plant.ts';
import type { Vehicle } from '../vehicle/vehicle.ts';

export const RECORD_SIZE = CHASSIS_SIZE + 4;

export interface OpenLoopOptions {
  readonly ticks: number;
  readonly recordEvery?: number;
  /** Writes the command for `tick` into `out`. */
  command(tick: number, vehicle: Vehicle, out: DriverCommand): void;
  /** Writes the external loads for `tick` into `out`; none by default. */
  loads?(tick: number, out: ExternalLoads): void;
  /** Stops the run early when it returns true, checked after each tick. */
  until?(tick: number, vehicle: Vehicle): boolean;
}

export interface OpenLoopResult {
  /** Ticks actually run. */
  readonly ticks: number;
  readonly hash: string;
  /** RECORD_SIZE values per record: the chassis state, then the four wheel speeds. */
  readonly records: Float64Array;
}

export function runOpenLoop(vehicle: Vehicle, options: OpenLoopOptions): OpenLoopResult {
  const every = options.recordEvery ?? 10;
  const records = new Float64Array((Math.floor(options.ticks / every) + 1) * RECORD_SIZE);
  const command: DriverCommand = { steer: 0, accel: 0 };
  const loads: ExternalLoads = { fy: 0, mz: 0 };
  let count = 0;
  const record = () => {
    records.set(vehicle.plant.chassis, count * RECORD_SIZE);
    records.set(vehicle.plant.omega, count * RECORD_SIZE + CHASSIS_SIZE);
    count++;
  };

  record();
  let tick = 0;
  while (tick < options.ticks) {
    options.command(tick, vehicle, command);
    options.loads?.(tick, loads);
    vehicle.step(command, loads);
    tick++;
    if (tick % every === 0) record();
    if (options.until?.(tick, vehicle)) break;
  }

  const used = records.subarray(0, count * RECORD_SIZE);
  return { ticks: tick, hash: new Fingerprint().add(used).digest(), records: used };
}
