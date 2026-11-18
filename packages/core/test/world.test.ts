import { describe, expect, it } from 'vitest';

import { gustLevel, gustLoads, Obstacles, ticksFor, type Gust } from '../src/index.ts';
import { obstacleMoving, type ObstacleSpec } from '../src/world/obstacles.ts';

describe('crosswind gust', () => {
  const gust: Gust = { start: 1, rise: 0.5, hold: 2, fall: 1, force: 3000, arm: 0.4 };

  it('rises, holds and falls on a trapezoid', () => {
    const at = (s: number) => gustLevel(gust, ticksFor(s));
    expect(at(0.5)).toBe(0);
    expect(at(1.25)).toBeCloseTo(0.5, 12);
    expect(at(2)).toBe(1);
    expect(at(4)).toBeCloseTo(0.5, 12);
    expect(at(5)).toBe(0);
  });

  it('acts at its center of pressure', () => {
    const loads = gustLoads(gust, ticksFor(2), { fy: 0, mz: 0 });
    expect(loads).toEqual({ fy: 3000, mz: 1200 });
  });
});

describe('obstacles', () => {
  it('waits for its trigger, then moves at constant velocity up to its travel', () => {
    const obstacles = new Obstacles([
      {
        id: 'pedestrian',
        kind: 'pedestrian',
        length: 0.5,
        width: 0.5,
        start: { s: 60, ey: -3 },
        velocity: { s: 0, ey: 1.5 },
        trigger: { kind: 'egoReaches', s: 30 },
        travel: 6,
      },
      {
        id: 'cone',
        kind: 'static',
        length: 0.3,
        width: 0.3,
        start: { s: 80, ey: 0 },
        velocity: { s: 0, ey: 0 },
      },
    ]);
    const pedestrian = obstacles.states[0];

    obstacles.update(0, 10);
    expect(pedestrian).toEqual({ s: 60, ey: -3, triggeredAt: -1 });

    obstacles.update(500, 30);
    expect(pedestrian?.triggeredAt).toBe(500);
    obstacles.update(1500, 45);
    expect(pedestrian?.ey).toBeCloseTo(-1.5, 12);
    obstacles.update(10_000, 90);
    expect(pedestrian?.ey).toBeCloseTo(3, 12);
    expect(obstacles.states[1]).toEqual({ s: 80, ey: 0, triggeredAt: 0 });

    obstacles.reset();
    expect(pedestrian).toEqual({ s: 60, ey: -3, triggeredAt: -1 });
  });

  it('places a time-triggered obstacle the same at 1 kHz and at 20 Hz updates', () => {
    const spec = {
      id: 'cut-in',
      kind: 'vehicle' as const,
      length: 4.5,
      width: 1.8,
      start: { s: 0, ey: 3.5 },
      velocity: { s: 20, ey: -1 },
      trigger: { kind: 'time' as const, at: 1.013 },
    };
    const everyTick = new Obstacles([spec]);
    const twentyHz = new Obstacles([spec]);
    for (let tick = 0; tick <= ticksFor(3); tick++) {
      everyTick.update(tick, 0);
      if (tick % 50 === 0) twentyHz.update(tick, 0);
    }
    expect(twentyHz.states[0]).toEqual(everyTick.states[0]);
  });

  it('starts on a time trigger and rejects duplicate ids', () => {
    const spec = {
      id: 'car',
      kind: 'vehicle' as const,
      length: 4.5,
      width: 1.8,
      start: { s: 0, ey: 3.5 },
      velocity: { s: 20, ey: -1 },
      trigger: { kind: 'time' as const, at: 2 },
    };
    const obstacles = new Obstacles([spec]);
    obstacles.update(ticksFor(1.999), 0);
    expect(obstacles.states[0]?.triggeredAt).toBe(-1);
    obstacles.update(ticksFor(2), 0);
    obstacles.update(ticksFor(3), 0);
    expect(obstacles.states[0]?.s).toBeCloseTo(20, 12);
    expect(() => new Obstacles([spec, spec])).toThrow(RangeError);
  });

  it('moves only once triggered, with a nonzero velocity, and before the end of its travel', () => {
    const spec: ObstacleSpec = {
      id: 'walker',
      kind: 'pedestrian',
      length: 0.5,
      width: 0.5,
      start: { s: 10, ey: -3 },
      velocity: { s: 0, ey: 1.5 },
      trigger: { kind: 'time', at: 1 },
      travel: 3,
    };
    // Travel 3 m at 1.5 m/s: moving for 2 s after the trigger at tick 1000, standing from tick 3000 on.
    expect(obstacleMoving(spec, { s: 10, ey: -3, triggeredAt: -1 }, 500)).toBe(false);
    expect(obstacleMoving(spec, { s: 10, ey: -3, triggeredAt: 1000 }, 1000)).toBe(true);
    expect(obstacleMoving(spec, { s: 10, ey: -3, triggeredAt: 1000 }, 2999)).toBe(true);
    expect(obstacleMoving(spec, { s: 10, ey: -3, triggeredAt: 1000 }, 3000)).toBe(false);
    const unlimited: ObstacleSpec = { ...spec, travel: undefined };
    expect(obstacleMoving(unlimited, { s: 10, ey: -3, triggeredAt: 1000 }, 1_000_000)).toBe(true);
    const still: ObstacleSpec = { ...spec, velocity: { s: 0, ey: 0 } };
    expect(obstacleMoving(still, { s: 10, ey: -3, triggeredAt: 0 }, 10)).toBe(false);

    // The world agrees: the position advances exactly while obstacleMoving holds, and stops at the travel.
    const obstacles = new Obstacles([spec]);
    let last = Number.NaN;
    for (let tick = 0; tick <= 4000; tick++) {
      obstacles.update(tick, 0);
      const state = obstacles.states[0];
      if (!state) throw new Error('no state');
      if (tick > 1000) expect(state.ey !== last).toBe(obstacleMoving(spec, state, tick - 1));
      last = state.ey;
    }
    expect(last).toBeCloseTo(0, 12);
  });
});
