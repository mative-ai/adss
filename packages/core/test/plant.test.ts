/** The plant's sign conventions, load transfer, rollover limit and behavior near standstill and at the limit. */
import { describe, expect, it } from 'vitest';

import {
  CHASSIS,
  GRAVITY,
  rolloverAccel,
  runOpenLoop,
  ticksFor,
  uniformSurface,
  Vehicle,
  VEHICLES,
  wheelbase,
  type SurfaceId,
  type VehicleId,
} from '../src/index.ts';

const make = (id: VehicleId, surface: SurfaceId = 'dry') => new Vehicle(VEHICLES[id], uniformSurface(surface));
const hold = (steer: number, accel: number) => (_tick: number, _v: Vehicle, out: { steer: number; accel: number }) => {
  out.steer = steer;
  out.accel = accel;
};

describe('load transfer', () => {
  it('loads the front axle under braking and the right-hand wheels in a left turn', () => {
    const vehicle = make('car');
    const staticFront = (VEHICLES.car.mass * GRAVITY * VEHICLES.car.lr) / wheelbase(VEHICLES.car) / 2;

    vehicle.reset(0, 0, 0, 25);
    runOpenLoop(vehicle, { ticks: ticksFor(1), command: hold(0, -6) });
    expect(vehicle.plant.fz[0]).toBeGreaterThan(staticFront * 1.05);

    vehicle.reset(0, 0, 0, 20);
    runOpenLoop(vehicle, { ticks: ticksFor(3), command: hold(0.04, 0) });
    expect(vehicle.plant.chassis[CHASSIS.R]).toBeGreaterThan(0);
    const fz = vehicle.plant.fz;
    expect(fz[1]).toBeGreaterThan(fz[0] ?? 0);
    expect(fz[3]).toBeGreaterThan(fz[2] ?? 0);
  });

  it('places the rollover limit where the static stability factor says', () => {
    expect(rolloverAccel(VEHICLES.car) / GRAVITY).toBeGreaterThan(1);
    expect(rolloverAccel(VEHICLES.van) / GRAVITY).toBeCloseTo(0.78, 2);
    expect(rolloverAccel(VEHICLES.truck) / GRAVITY).toBeCloseTo(0.55, 2);
  });

  it('flags a truck turning past its rollover limit, not a car turning the same way', () => {
    const flagged = (id: VehicleId) => {
      const vehicle = make(id);
      vehicle.reset(0, 0, 0, 22);
      let seen = false;
      runOpenLoop(vehicle, {
        ticks: ticksFor(3),
        command: (tick, v, out) => {
          seen ||= v.plant.overRolloverLimit;
          hold(0.12, 0)(tick, v, out);
        },
      });
      return seen;
    };
    expect(flagged('truck')).toBe(true);
    expect(flagged('car')).toBe(false);
  });
});

describe('near standstill', () => {
  it('starts parked from rest, stays parked in a gust, then drives off', () => {
    const vehicle = make('car');
    vehicle.reset(0, 0, 0, 0);
    runOpenLoop(vehicle, {
      ticks: ticksFor(1),
      command: hold(0, 0),
      loads: (_tick, out) => {
        out.fy = 3000;
        out.mz = 0;
      },
    });
    expect(vehicle.plant.latched).toBe(true);
    expect(vehicle.speed).toBe(0);
    runOpenLoop(vehicle, { ticks: ticksFor(2), command: hold(0, 2) });
    expect(vehicle.speed).toBeGreaterThan(1);
  });

  it('slows down monotonically from 3 m/s to a stop, never going backwards', () => {
    const vehicle = make('van', 'wet');
    vehicle.reset(0, 0, 0, 3);
    let previous = vehicle.speed;
    let rose = 0;
    let minVx = Infinity;
    runOpenLoop(vehicle, {
      ticks: ticksFor(5),
      command: (tick, v, out) => {
        if (v.speed > previous + 1e-9) rose++;
        previous = v.speed;
        minVx = Math.min(minVx, v.plant.chassis[CHASSIS.VX] ?? 0);
        hold(0, -1)(tick, v, out);
      },
    });
    expect(rose).toBe(0);
    expect(minVx).toBeGreaterThanOrEqual(-1e-3);
    expect(vehicle.plant.latched).toBe(true);
  });

  it('turns on the kinematic circle at walking pace', () => {
    const vehicle = make('car');
    const steer = 0.2;
    vehicle.reset(0, 0, 0, 2);
    runOpenLoop(vehicle, {
      ticks: ticksFor(4),
      command: (tick, v, out) => hold(steer, 0.5 * (2 - (v.plant.chassis[CHASSIS.VX] ?? 0)))(tick, v, out),
    });
    const vx = vehicle.plant.chassis[CHASSIS.VX] ?? 0;
    const expected = (vx * Math.tan(vehicle.actuators.steer)) / wheelbase(VEHICLES.car);
    expect((vehicle.plant.chassis[CHASSIS.R] ?? 0) / expected).toBeCloseTo(1, 1);
  });

  it('on ice, never turns harder than the grip allows, even at walking pace', () => {
    const vehicle = make('car', 'ice');
    vehicle.reset(0, 0, 0, 2.5);
    let maxLateral = 0;
    runOpenLoop(vehicle, {
      ticks: ticksFor(3),
      command: (tick, v, out) => {
        const c = v.plant.chassis;
        maxLateral = Math.max(maxLateral, Math.abs((c[CHASSIS.VX] ?? 0) * (c[CHASSIS.R] ?? 0)));
        hold(0.6, 0)(tick, v, out);
      },
    });
    expect(maxLateral).toBeLessThanOrEqual(0.1 * GRAVITY * 1.05);
  });
});

describe('at the limit', () => {
  it('spins on ice, slides backwards, and never loses speed faster than friction allows', () => {
    // Power oversteer: the rear-driven van spins its rear wheels on ice and turns around.
    const vehicle = make('van', 'ice');
    vehicle.reset(0, 0, 0, 12);
    let previous = vehicle.speed;
    let worstDrop = 0;
    let maxYaw = 0;
    let minVx = 0;
    runOpenLoop(vehicle, {
      ticks: ticksFor(8),
      command: (tick, v, out) => {
        const c = v.plant.chassis;
        worstDrop = Math.max(worstDrop, previous - v.speed);
        previous = v.speed;
        maxYaw = Math.max(maxYaw, Math.abs(c[CHASSIS.PSI] ?? 0));
        minVx = Math.min(minVx, c[CHASSIS.VX] ?? 0);
        hold(0.15, VEHICLES.van.accelMax)(tick, v, out);
      },
    });
    expect(maxYaw).toBeGreaterThan(Math.PI);
    expect(minVx).toBeLessThan(-1);
    // One tick at most 0.1·g of deceleration, plus drag: no speed vanishes in a single step.
    expect(worstDrop).toBeLessThan(0.1 * GRAVITY * 1e-3 * 1.5);
  });
});
