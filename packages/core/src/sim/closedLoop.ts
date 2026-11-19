/**
 * Runs a vehicle under a controller: the plant at 1 kHz, the controller every `periodTicks`, and each command
 * taking effect `delayTicks` after the state it was computed from (the computation delay is configuration,
 * never a measured time: AGENTS.md §5).
 */
import type { DriverCommand } from '../vehicle/actuators.ts';
import type { ExternalLoads } from '../vehicle/plant.ts';
import type { Vehicle } from '../vehicle/vehicle.ts';

export interface Controller {
  readonly periodTicks: number;
  readonly delayTicks: number;
  /** Writes the command computed from the vehicle's state at `tick` into `out`. */
  compute(tick: number, vehicle: Vehicle, out: DriverCommand): void;
}

export interface ClosedLoopOptions {
  readonly ticks: number;
  /** Called after each tick with the command that was in force. */
  onTick?(tick: number, vehicle: Vehicle, command: Readonly<DriverCommand>): void;
  loads?(tick: number, out: ExternalLoads): void;
  /** Stops the run early when it returns true, checked after each tick. */
  until?(tick: number, vehicle: Vehicle): boolean;
}

export function runClosedLoop(vehicle: Vehicle, controller: Controller, options: ClosedLoopOptions): number {
  const pending: { at: number; steer: number; accel: number }[] = [];
  const applied: DriverCommand = { steer: vehicle.actuators.steer, accel: 0 };
  const computed: DriverCommand = { steer: 0, accel: 0 };
  const loads: ExternalLoads = { fy: 0, mz: 0 };
  let tick = 0;
  while (tick < options.ticks) {
    if (tick % controller.periodTicks === 0) {
      controller.compute(tick, vehicle, computed);
      pending.push({ at: tick + controller.delayTicks, steer: computed.steer, accel: computed.accel });
    }
    while (pending.length > 0 && (pending[0]?.at ?? Infinity) <= tick) {
      const next = pending.shift();
      if (next) {
        applied.steer = next.steer;
        applied.accel = next.accel;
      }
    }
    options.loads?.(tick, loads);
    vehicle.step(applied, loads);
    options.onTick?.(tick, vehicle, applied);
    tick++;
    if (options.until?.(tick, vehicle)) break;
  }
  return tick;
}
