/**
 * Milestone M3 (Phase 2): the RTI-MPC drives the car through the ISO 3888-2 double lane change
 * at 60 km/h on dry asphalt without touching a cone (the course is in scenario/isoLaneChange.ts).
 */
import { describe, expect, it } from 'vitest';

import {
  CHASSIS,
  isoLaneChange,
  MpcDriver,
  RoadPath,
  runClosedLoop,
  ticksFor,
  uniformSurface,
  Vehicle,
  VEHICLES,
} from '../src/index.ts';

const car = VEHICLES.car;
const speed = 60 / 3.6;

describe('M3 ISO 3888-2 double lane change at 60 km/h on dry asphalt', () => {
  it('passes every cone gate with the MPC', () => {
    const course = isoLaneChange(car, speed);
    const road = new RoadPath({ segments: [{ kind: 'straight', length: 400 }], width: { left: 6, right: 3 } });
    const vehicle = new Vehicle(car, uniformSurface('dry'));
    vehicle.reset(0, 0, 0, speed);
    const driver = new MpcDriver(car, 1, road, course.corridor, course.reference);

    let steps = 0;
    const counted = {
      periodTicks: driver.periodTicks,
      delayTicks: driver.delayTicks,
      compute: (tick: number, v: Vehicle, out: { steer: number; accel: number }) => {
        steps++;
        driver.compute(tick, v, out);
      },
    };

    let hits = 0;
    let worst = 0;
    runClosedLoop(vehicle, counted, {
      ticks: ticksFor(12),
      until: (_tick, v) => (v.plant.chassis[CHASSIS.X] ?? 0) > course.end,
      onTick: (_tick, v) => {
        const outside = course.outside(v);
        if (outside > 0) hits++;
        worst = Math.max(worst, outside);
      },
    });

    expect(vehicle.plant.chassis[CHASSIS.X] ?? 0).toBeGreaterThan(course.end);
    expect(hits, `a corner left its lane by up to ${(worst * 100).toFixed(1)} cm`).toBe(0);
    expect(steps).toBeGreaterThan(100);
  }, 60_000);

  // M3's timing (the solve's p95 under 5 ms in Node) belongs to `npm run bench:qp`, not to a test (AGENTS.md §6):
  // the benchmark measures this course with the MPC's solver.
});
