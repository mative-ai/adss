/**
 * The run's history for the charts (telemetry.ts): the rows of the frames land in one time column for the two vehicles,
 * in the units the charts show; a vehicle that ended leaves `null` from there on; the decision layer's cycles keep their
 * own times; a new run empties everything.
 */
import { describe, expect, it } from 'vitest';

import { FRAME, frameLayout, VEHICLE, VEHICLE_SIZE } from '@mpc-simulator/worker';

import { G } from './frame.ts';
import { slotAt, Telemetry } from './telemetry.ts';

const layout = frameLayout(1, 8);

interface Row {
  tick: number;
  vx?: number;
  steer?: number;
  ax?: number;
  ay?: number;
}

/** A frame with these telemetry rows of the ego and of the ghost. */
function frame(ego: Row[], ghost: Row[] = []): Float64Array {
  const data = new Float64Array(layout.length);
  const write = (rows: Row[], at: number) =>
    rows.forEach((row, i) => {
      const base = at + i * VEHICLE_SIZE;
      data[base + VEHICLE.TICK] = row.tick;
      data[base + VEHICLE.VX] = row.vx ?? 0;
      data[base + VEHICLE.STEER] = row.steer ?? 0;
      data[base + VEHICLE.AX] = row.ax ?? 0;
      data[base + VEHICLE.AY] = row.ay ?? 0;
    });
  data[FRAME.EGO_ROWS] = ego.length;
  data[FRAME.GHOST_ROWS] = ghost.length;
  write(ego, layout.egoTelemetry);
  write(ghost, layout.ghostTelemetry);
  return data;
}

describe('Telemetry', () => {
  it('keeps the rows of the frames in the units the charts show', () => {
    const telemetry = new Telemetry();
    telemetry.readFrame(
      frame(
        [
          { tick: 0, vx: 10 },
          { tick: 10, vx: 20, steer: Math.PI / 6, ax: -G, ay: G / 2 },
        ],
        [{ tick: 0, vx: 5 }],
      ),
      layout,
    );
    telemetry.readFrame(frame([{ tick: 20, vx: 30 }], [{ tick: 10, vx: 6 }]), layout);
    expect(telemetry.time).toEqual([0, 0.01, 0.02]);
    expect(telemetry.ego.speed).toEqual([36, 72, 108]);
    expect(telemetry.ego.steer[1]).toBeCloseTo(30, 12);
    expect(telemetry.ego.ax[1]).toBeCloseTo(-1, 12);
    expect(telemetry.ego.ay[1]).toBeCloseTo(0.5, 12);
    // The ghost's rows share the ego's slots; the slot it has not reached yet is empty.
    expect(telemetry.ghost.speed).toEqual([18, 21.6, null]);
  });

  it('leaves null where a vehicle has ended, and keeps the time of the grid in a slot the two share', () => {
    const telemetry = new Telemetry();
    // The ego ends at tick 14, between two ticks of the grid; the ghost goes on to tick 30.
    telemetry.readFrame(frame([{ tick: 0 }, { tick: 10 }, { tick: 14, vx: 1 }], [{ tick: 0 }, { tick: 10 }]), layout);
    expect(telemetry.time).toEqual([0, 0.01, 0.014]);
    telemetry.readFrame(
      frame(
        [],
        [
          { tick: 20, vx: 2 },
          { tick: 30, vx: 3 },
        ],
      ),
      layout,
    );
    expect(telemetry.time).toEqual([0, 0.01, 0.02, 0.03]);
    expect(telemetry.ego.speed).toEqual([0, 0, 3.6, null]);
    expect(telemetry.ghost.speed).toEqual([0, 0, 7.2, 10.8]);
    // Every column is as long as the time column: a chart draws them against it.
    for (const vehicle of [telemetry.ego, telemetry.ghost]) {
      for (const column of [vehicle.speed, vehicle.steer, vehicle.ax, vehicle.ay]) expect(column).toHaveLength(4);
    }
  });

  it('keeps the cycles of the decision layer, with a gap where the maneuver closes on nothing', () => {
    const telemetry = new Telemetry();
    telemetry.addDecision(0, null, 4.5);
    telemetry.addDecision(50, 2.25, 6);
    expect(telemetry.decisionTime).toEqual([0, 0.05]);
    expect(telemetry.ttc).toEqual([null, 2.25]);
    expect(telemetry.stepMs).toEqual([4.5, 6]);
  });

  it('changes its version with every addition, and not with a frame without rows', () => {
    const telemetry = new Telemetry();
    const start = telemetry.version;
    telemetry.readFrame(frame([]), layout);
    expect(telemetry.version).toBe(start);
    telemetry.readFrame(frame([{ tick: 0 }]), layout);
    telemetry.addDecision(0, null, 1);
    expect(telemetry.version).toBe(start + 2);
  });

  it('is emptied by a new run, and fills again from the first slot', () => {
    const telemetry = new Telemetry();
    telemetry.readFrame(frame([{ tick: 0 }, { tick: 10 }], [{ tick: 0 }]), layout);
    telemetry.addDecision(0, 1, 1);
    const before = telemetry.version;
    telemetry.clear();
    expect(telemetry.version).toBeGreaterThan(before);
    expect(telemetry.time).toEqual([]);
    expect(telemetry.ego.speed).toEqual([]);
    expect(telemetry.ghost.ay).toEqual([]);
    expect(telemetry.ttc).toEqual([]);
    telemetry.readFrame(frame([{ tick: 0, vx: 1 }]), layout);
    expect(telemetry.time).toEqual([0]);
    expect(telemetry.ego.speed).toEqual([3.6]);
  });
});

describe('slotAt', () => {
  it('finds the slot at or before a time', () => {
    const times = [0, 0.01, 0.02, 0.05];
    expect(slotAt(times, -1)).toBe(-1);
    expect(slotAt(times, 0)).toBe(0);
    expect(slotAt(times, 0.015)).toBe(1);
    expect(slotAt(times, 0.05)).toBe(3);
    expect(slotAt(times, 9)).toBe(3);
    expect(slotAt([], 1)).toBe(-1);
  });
});
