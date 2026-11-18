/**
 * The history of a run for the charts (Phase 4): the telemetry rows the frames carry (100 Hz, the ego's
 * and the ghost's) and the decision layer's cycles (20 Hz), kept in the units the charts show: seconds, km/h, degrees,
 * g, milliseconds. It only stores what the worker sent; nothing here is computed physics.
 *
 * The two vehicles share one time column. Their rows fall on the same ticks (both record every 10 ticks from tick 0),
 * so row i of each lies in slot i; a vehicle that ended has `null` from there on. Only a vehicle's last row can fall
 * between two ticks of the grid (a collision): it takes the slot after its last one, and when the other vehicle goes on
 * that slot keeps the grid's time, so that last sample is drawn up to 9 ms late.
 */
import { FRAME, VEHICLE, VEHICLE_SIZE, type FrameLayout } from '@mpc-simulator/worker';

import { G, TICK_HZ } from './frame.ts';

export type Column = (number | null)[];

/** A vehicle's columns, one value per slot of `Telemetry.time`. */
export interface VehicleSeries {
  /** Speed of the center of gravity, km/h. */
  readonly speed: Column;
  /** Actual road-wheel angle, degrees. */
  readonly steer: Column;
  /** Longitudinal and lateral acceleration, g. */
  readonly ax: Column;
  readonly ay: Column;
}

const series = (): VehicleSeries => ({ speed: [], steer: [], ax: [], ay: [] });
const COLUMNS = ['speed', 'steer', 'ax', 'ay'] as const;

export class Telemetry {
  /** Changes whenever a row or a decision is added, or the history is cleared: a chart redraws when it does. */
  version = 0;
  /** Time of each slot, s. */
  readonly time: number[] = [];
  readonly ego = series();
  readonly ghost = series();
  /** Time of each control cycle of the decision layer, s. */
  readonly decisionTime: number[] = [];
  /** Smallest time to collision along the plan of the maneuver in force, s; null when it closes on nothing. */
  readonly ttc: Column = [];
  /** Time the control step took in the worker, ms: measured on this device, it changes nothing in the run. */
  readonly stepMs: number[] = [];

  private egoRows = 0;
  private ghostRows = 0;

  /** Empties the history: a new run. */
  clear(): void {
    this.time.length = 0;
    for (const vehicle of [this.ego, this.ghost]) for (const column of COLUMNS) vehicle[column].length = 0;
    this.decisionTime.length = 0;
    this.ttc.length = 0;
    this.stepMs.length = 0;
    this.egoRows = 0;
    this.ghostRows = 0;
    this.version++;
  }

  /** Adds the telemetry rows of a frame (FRAME layout): the ego's, then the ghost's. */
  readFrame(data: Float64Array, layout: FrameLayout): void {
    const egoRows = data[FRAME.EGO_ROWS] ?? 0;
    const ghostRows = data[FRAME.GHOST_ROWS] ?? 0;
    for (let i = 0; i < egoRows; i++)
      this.addRow(this.ego, this.egoRows++, data, layout.egoTelemetry + i * VEHICLE_SIZE);
    for (let i = 0; i < ghostRows; i++) {
      this.addRow(this.ghost, this.ghostRows++, data, layout.ghostTelemetry + i * VEHICLE_SIZE);
    }
    if (egoRows + ghostRows > 0) this.version++;
  }

  /** Adds a control cycle of the decision layer: its tick, the TTC of the maneuver in force and the step's time. */
  addDecision(tick: number, ttc: number | null, stepMs: number): void {
    this.decisionTime.push(tick / TICK_HZ);
    this.ttc.push(ttc);
    this.stepMs.push(stepMs);
    this.version++;
  }

  private addRow(vehicle: VehicleSeries, slot: number, data: Float64Array, at: number): void {
    const time = (data[at + VEHICLE.TICK] ?? 0) / TICK_HZ;
    if (slot === this.time.length) {
      this.time.push(time);
      for (const other of [this.ego, this.ghost]) for (const column of COLUMNS) other[column].push(null);
    } else {
      // The slot is the other vehicle's too: the later time is the grid's.
      this.time[slot] = Math.max(this.time[slot] ?? 0, time);
    }
    vehicle.speed[slot] = Math.hypot(data[at + VEHICLE.VX] ?? 0, data[at + VEHICLE.VY] ?? 0) * 3.6;
    vehicle.steer[slot] = ((data[at + VEHICLE.STEER] ?? 0) * 180) / Math.PI;
    vehicle.ax[slot] = (data[at + VEHICLE.AX] ?? 0) / G;
    vehicle.ay[slot] = (data[at + VEHICLE.AY] ?? 0) / G;
  }
}

/** The slot at or before `time` in a column of increasing times; -1 when there is none. */
export function slotAt(times: readonly number[], time: number): number {
  let low = 0;
  let high = times.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((times[mid] ?? 0) <= time) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}
