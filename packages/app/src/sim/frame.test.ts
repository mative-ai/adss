/**
 * Reading a worker frame (frame.ts): the offsets of the protocol land in the right fields, a run without a ghost
 * reads without one, a plan with no feasibility check reads as such, and a buffer of another run is not a frame.
 */
import { describe, expect, it } from 'vitest';

import {
  FLAG,
  FRAME,
  frameLayout,
  OBSTACLE_SIZE,
  PLAN,
  PLAN_HEADER,
  VEHICLE,
  VEHICLE_SIZE,
} from '@mpc-simulator/worker';

import { createFrameView, isFrameOf, readFrame, readoutOf } from './frame.ts';

const layout = frameLayout(1, 8);

const FIELDS = ['X', 'Y', 'PSI', 'VX', 'VY', 'R', 'S', 'EY', 'STEER', 'AX', 'AY'] as const;

/** A frame with distinct values in every field the view reads, so that a wrong offset shows. */
function sample(flags: number): Float64Array {
  const data = new Float64Array(layout.length);
  data[FRAME.TICK] = 3300;
  data[FRAME.RATE] = 0.5;
  data[FRAME.FLAGS] = flags;
  const vehicle = (at: number, base: number) => {
    FIELDS.forEach((key, i) => {
      data[at + VEHICLE[key]] = base + i;
    });
  };
  vehicle(layout.ego, 100);
  vehicle(layout.ghost, 200);
  data.set([70, -4.5, 0.1, 71, -4.4, 1], layout.obstacles);
  for (let b = 0; b < 4; b++) {
    const at = layout.plans + b * layout.planSize;
    data[at + PLAN.SOLVED] = b === 3 ? 0 : 1;
    data[at + PLAN.FEASIBLE] = b === 1 ? Number.NaN : b === 2 ? 0 : 1;
    data[at + PLAN.CHOSEN] = b === 0 ? 1 : 0;
    for (let k = 0; k < 2 * layout.planPoints; k++) data[at + PLAN_HEADER + k] = b * 1000 + k;
  }
  return data;
}

describe('readFrame', () => {
  it('puts every field of the protocol where the views read it', () => {
    expect(OBSTACLE_SIZE).toBe(6);
    const view = createFrameView(layout);
    readFrame(sample(FLAG.GHOST | FLAG.PLAYING), layout, view);
    expect([view.tick, view.rate, view.playing, view.done, view.hasGhost]).toEqual([3300, 0.5, true, false, true]);
    expect(view.ego).toEqual(Object.fromEntries(FIELDS.map((key, i) => [key.toLowerCase(), 100 + i])));
    expect(view.ghost.x).toBe(200);
    expect(view.ghost.ay).toBe(210);
    expect(view.obstacles[0]).toEqual({ x: 70, y: -4.5, heading: 0.1, s: 71, ey: -4.4, detected: true });
    expect(view.plans.map((p) => [p.solved, p.feasible, p.chosen])).toEqual([
      [true, true, true],
      [true, null, false],
      [true, false, false],
      [false, true, false],
    ]);
    expect(Array.from(view.plans[2]!.points.subarray(0, 3))).toEqual([2000, 2001, 2002]);
    expect(view.plans[3]!.points).toHaveLength(2 * layout.planPoints);
  });

  it('reads the end flags, and leaves the ghost alone when the run has none', () => {
    const view = createFrameView(layout);
    readFrame(sample(FLAG.GHOST | FLAG.DONE | FLAG.EGO_ENDED | FLAG.GHOST_ENDED), layout, view);
    expect([view.done, view.egoEnded, view.ghostEnded, view.playing]).toEqual([true, true, true, false]);
    const alone = sample(0);
    alone.fill(Number.NaN, layout.ghost, layout.ghost + VEHICLE_SIZE);
    readFrame(alone, layout, view);
    expect(view.hasGhost).toBe(false);
    // The NaN block of a missing ghost is never copied: the last values stay.
    expect(view.ghost.x).toBe(200);
    expect(readoutOf(view).ghostSpeedKmh).toBeNull();
  });

  it('recognizes only the buffers of its own run', () => {
    expect(isFrameOf(new Float64Array(layout.length), layout)).toBe(true);
    expect(isFrameOf(new Float64Array(frameLayout(1, 20).length), layout)).toBe(false);
  });
});

describe('readoutOf', () => {
  it('gives the units people read: km/h, degrees, g, seconds', () => {
    const view = createFrameView(layout);
    readFrame(sample(FLAG.GHOST), layout, view);
    view.ego.vx = 10;
    view.ego.vy = 0;
    view.ego.steer = Math.PI / 36;
    view.ego.ax = -9.81;
    view.ego.ay = 4.905;
    expect(readoutOf(view)).toMatchObject({ time: 3.3, speedKmh: 36, steerDeg: 5, axG: -1, ayG: 0.5, s: 106 });
    view.ghost.vx = 3;
    view.ghost.vy = 4;
    expect(readoutOf(view).ghostSpeedKmh).toBeCloseTo(18, 12);
  });
});
