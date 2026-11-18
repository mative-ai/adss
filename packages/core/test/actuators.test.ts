import { describe, expect, it } from 'vitest';

import { Actuators, ticksFor, TICK_SECONDS, VEHICLES } from '../src/index.ts';

describe('actuators', () => {
  it('holds the truck brake for its pure delay, then follows its lag', () => {
    const p = VEHICLES.truck;
    const act = new Actuators(p, TICK_SECONDS);
    const request = -p.accelMin * p.mass;
    const delay = ticksFor(p.brakeDelay);
    for (let tick = 0; tick < delay; tick++) {
      act.update({ steer: 0, accel: p.accelMin });
      expect(act.brakeForce).toBe(0);
    }
    for (let tick = 0; tick < ticksFor(p.brakeLag); tick++) act.update({ steer: 0, accel: p.accelMin });
    expect(act.brakeForce / request).toBeCloseTo(1 - Math.exp(-1), 3);
  });

  it('limits the steering rate and the steering angle', () => {
    const p = VEHICLES.car;
    const act = new Actuators(p, TICK_SECONDS);
    let previous = 0;
    for (let tick = 0; tick < ticksFor(3); tick++) {
      act.update({ steer: 10, accel: 0 });
      expect(act.steer - previous).toBeLessThanOrEqual(p.steerRateMax * TICK_SECONDS * (1 + 1e-12));
      previous = act.steer;
    }
    expect(act.steer).toBeLessThanOrEqual(p.steerMax);
    expect(act.steer).toBeGreaterThan(p.steerMax * 0.99);
  });

  it('clamps the longitudinal command to the vehicle range', () => {
    const p = VEHICLES.van;
    const act = new Actuators(p, TICK_SECONDS);
    for (let tick = 0; tick < ticksFor(5); tick++) act.update({ steer: 0, accel: 50 });
    expect(act.driveForce).toBeCloseTo(p.accelMax * p.mass, 3);
    expect(act.brakeForce).toBe(0);
  });

  it('rejects a non-finite command', () => {
    const act = new Actuators(VEHICLES.car, TICK_SECONDS);
    expect(() => act.update({ steer: Number.NaN, accel: 0 })).toThrow(RangeError);
    expect(() => act.update({ steer: 0, accel: Infinity })).toThrow(RangeError);
  });
});
