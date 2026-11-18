/**
 * The baseline controller (Phase 3): Stanley + PI + AEB on small worlds built here, with a track
 * source made from true positions (the scenario runner is not involved).
 */
import { describe, expect, it } from 'vitest';

import {
  BaselineDriver,
  CHASSIS,
  type BaselineOptions,
  type DriverCommand,
  type VehicleParams,
  RoadPath,
  runClosedLoop,
  ticksFor,
  uniformSurface,
  Vehicle,
  VEHICLES,
  type ObstacleTrack,
  type SurfaceId,
  type TrackSource,
} from '../src/index.ts';

const car = VEHICLES.car;

function staticTrack(s: number, ey = 0): ObstacleTrack {
  return { id: 'box', kind: 'static', tick: 0, s, ey, vs: 0, vey: 0, length: 1, width: 1.8 };
}

/** The nose of a body from the CG, computed here from the footprint, independently of the driver. */
function noseOf(p: VehicleParams): number {
  return p.lf + (p.length - p.lf - p.lr) / 2;
}

function source(tracks: readonly ObstacleTrack[]): TrackSource {
  return { tracks: () => tracks };
}

const flat = (speed: number) => ({
  at(_s: number, out: { ey: number; speed: number }) {
    out.ey = 0;
    out.speed = speed;
  },
});

const noTracks = source([]);

interface Result {
  maxEy: number;
  endSpeed: number;
  maxBeta: number;
  hash: number;
  vehicle: Vehicle;
  driver: BaselineDriver;
  stopped: boolean;
}

function drive(
  road: RoadPath,
  surface: SurfaceId,
  speed: number,
  refSpeed: number,
  tracks: TrackSource,
  seconds: number,
  start = { x: 0, y: 0, heading: 0 },
  params: VehicleParams = car,
  options: BaselineOptions = {},
  onStep?: (tick: number, v: Vehicle, d: BaselineDriver) => void,
): Result {
  const vehicle = new Vehicle(params, uniformSurface(surface));
  vehicle.reset(start.x, start.y, start.heading, speed);
  const driver = new BaselineDriver(params, road, flat(refSpeed), tracks, options);
  const proj = { s: 0, ey: 0, heading: 0, curvature: 0, index: -1 };
  let maxEy = 0;
  let maxBeta = 0;
  let hash = 0;
  runClosedLoop(vehicle, driver, {
    ticks: ticksFor(seconds),
    until: (_t, v) => v.speed < 0.05 && driver.aebActive,
    onTick: (t, v) => {
      onStep?.(t, v, driver);
      const c = v.plant.chassis;
      const p = road.project(c[CHASSIS.X] ?? 0, c[CHASSIS.Y] ?? 0, proj.index, proj);
      maxEy = Math.max(maxEy, Math.abs(p.ey));
      const vx = c[CHASSIS.VX] ?? 0;
      if (vx > 1) maxBeta = Math.max(maxBeta, Math.abs(Math.atan2(c[CHASSIS.VY] ?? 0, vx)));
      hash = (Math.imul(hash, 31) + Math.round((c[CHASSIS.X] ?? 0) * 1e6) + Math.round((c[CHASSIS.Y] ?? 0) * 1e6)) | 0;
    },
  });
  return { maxEy, endSpeed: vehicle.speed, maxBeta, hash, vehicle, driver, stopped: vehicle.speed < 0.2 };
}

const arc = new RoadPath({
  start: { x: 0, y: 0, heading: 0 },
  segments: [
    { kind: 'straight', length: 100 },
    { kind: 'arc', length: 500, curvature: 1 / 200 },
  ],
  width: { left: 4, right: 4 },
});

describe('baseline controller', () => {
  it('keeps the lane on an arc of 200 m at 70 km/h dry', () => {
    const v = 70 / 3.6;
    const r = drive(arc, 'dry', v, v, noTracks, 25);
    // Skip the entry transient implicitly: the bound is for the whole run, entry included.
    expect(r.maxEy).toBeLessThan(0.5);
    expect(Math.abs(r.endSpeed - v)).toBeLessThan(0.5);
  });

  it('tracks the reference speed from below and from above', () => {
    const straight = new RoadPath({ segments: [{ kind: 'straight', length: 1000 }], width: { left: 4, right: 4 } });
    const up = drive(straight, 'dry', 10, 20, noTracks, 25);
    expect(Math.abs(up.endSpeed - 20)).toBeLessThan(0.5);
    const down = drive(straight, 'dry', 25, 15, noTracks, 25);
    expect(Math.abs(down.endSpeed - 15)).toBeLessThan(0.5);
    expect(up.maxEy).toBeLessThan(0.1);
  });

  const straight600 = new RoadPath({ segments: [{ kind: 'straight', length: 600 }], width: { left: 4, right: 4 } });
  const boxRear = (boxS: number) => boxS - 0.5;

  /** Drives toward a box and returns the smallest gap between the nose and the box's rear face. */
  function approach(id: 'car' | 'van' | 'truck', kmh: number, boxS: number, options: BaselineOptions = {}) {
    const params = VEHICLES[id];
    const v = kmh / 3.6;
    let minGap = Infinity;
    const r = drive(
      straight600,
      'dry',
      v,
      v,
      source([staticTrack(boxS)]),
      30,
      undefined,
      params,
      options,
      (_t, veh) => {
        const x = veh.plant.chassis[CHASSIS.X] ?? 0;
        minGap = Math.min(minGap, boxRear(boxS) - (x + noseOf(params)));
      },
    );
    return { r, minGap };
  }

  it.each([
    ['car', 50, 150],
    ['van', 50, 150],
    ['truck', 50, 150],
    ['truck', 70, 200],
  ] as const)('stops the %s at %i km/h dry before a box at s = %i m, without contact', (id, kmh, boxS) => {
    const { r, minGap } = approach(id, kmh, boxS);
    expect(r.driver.aebActive).toBe(true);
    expect(r.stopped).toBe(true);
    expect(minGap).toBeGreaterThan(0.3);
  });

  it('holds a stopped truck against a stationary box without creeping', () => {
    const params = VEHICLES.truck;
    const v = 50 / 3.6;
    const vehicle = new Vehicle(params, uniformSurface('dry'));
    vehicle.reset(0, 0, 0, v);
    const driver = new BaselineDriver(params, straight600, flat(v), source([staticTrack(150)]));
    let stopTick = -1;
    let xAtStop = 0;
    let xEnd = 0;
    runClosedLoop(vehicle, driver, {
      ticks: ticksFor(40),
      onTick: (t, veh) => {
        const x = veh.plant.chassis[CHASSIS.X] ?? 0;
        if (stopTick < 0 && veh.speed < 0.05) {
          stopTick = t;
          xAtStop = x;
        }
        xEnd = x;
      },
    });
    expect(stopTick).toBeGreaterThan(0);
    expect(driver.aebActive).toBe(true);
    expect(xEnd - xAtStop).toBeLessThan(0.05);
  });

  it('counts the computation delay: it brakes earlier with a longer delay, later when told to ignore it', () => {
    const base = approach('car', 50, 150, { delayTicks: 50 });
    const slow = approach('car', 50, 150, { delayTicks: 200 });
    expect(slow.minGap).toBeGreaterThan(0.3);
    expect(slow.r.driver.aebFirstTick).toBeLessThan(base.r.driver.aebFirstTick);
    const naive = approach('car', 50, 150, { aebCompensateDelay: false });
    expect(naive.r.driver.aebFirstTick).toBeGreaterThan(base.r.driver.aebFirstTick);
  });

  it('reads tracks with latency: an old track is predicted forward by its age (same engagement as a fresh one)', () => {
    // An oncoming car at -10 m/s from s = 400. A stale track is behind where the car really is, so without the age
    // correction the AEB would engage later; with it, the engagement tick equals that of a fresh-track control.
    const carAt = (t: number) => 400 - 10 * (t / 1000);
    const firstEngagement = (latencyTicks: number): number => {
      let now = 0;
      const tracks: TrackSource = {
        tracks: () => {
          const at = Math.max(0, now - latencyTicks);
          return [
            { id: 'oncoming', kind: 'vehicle', tick: at, s: carAt(at), ey: 0, vs: -10, vey: 0, length: 4, width: 1.8 },
          ];
        },
      };
      let first = -1;
      drive(straight600, 'dry', 50 / 3.6, 50 / 3.6, tracks, 25, undefined, car, {}, (t, _veh, d) => {
        now = t;
        if (first < 0 && d.aebActive) first = t;
      });
      return first;
    };
    const fresh = firstEngagement(0);
    expect(fresh).toBeGreaterThan(0);
    // The skeptic's mutant (age = 0) engaged 100 ticks late at 300 ms: it fails this exact equality.
    expect(firstEngagement(300)).toBe(fresh);
  });

  it('follows a slower lead without contact and releases with hysteresis, without chatter', () => {
    const state = { t: 0 };
    const leadAt = (t: number) => 60 + 8 * (t / 1000);
    const tracks: TrackSource = {
      tracks: () => [
        { id: 'lead', kind: 'vehicle', tick: state.t, s: leadAt(state.t), ey: 0, vs: 8, vey: 0, length: 4, width: 1.8 },
      ],
    };
    let minGap = Infinity;
    let was = false;
    let releases = 0;
    let engagedAt = 0;
    let shortest = Infinity;
    let badRelease = false;
    drive(straight600, 'dry', 50 / 3.6, 50 / 3.6, tracks, 25, undefined, car, {}, (t, veh, d) => {
      state.t = t;
      const x = veh.plant.chassis[CHASSIS.X] ?? 0;
      minGap = Math.min(minGap, leadAt(t) - 2 - (x + noseOf(car)));
      if (d.aebActive && !was) engagedAt = t;
      if (!d.aebActive && was) {
        releases++;
        shortest = Math.min(shortest, t - engagedAt);
        // The true time to collision at the release, computed here from the true positions (not the driver's own).
        const trueGap = leadAt(t) - 2 - (x + noseOf(car));
        const closing = veh.speed - 8;
        if (closing > 0 && trueGap / closing <= 2.5) badRelease = true;
      }
      was = d.aebActive;
    });
    expect(minGap).toBeGreaterThan(0.3);
    expect(releases).toBeGreaterThan(0);
    expect(badRelease).toBe(false);
    // The baseline has no car-following: with the PI asking for the free speed the AEB pulses (a documented limit
    // cycle, gap about 1 m at the end), but each pulse spans many periods: the hysteresis does not chatter.
    expect(shortest).toBeGreaterThanOrEqual(250);
  });

  it('freezes the speed integral under the AEB: the free step after a braking episode matches a run without it', () => {
    const box: ObstacleTrack[] = [];
    const tracks: TrackSource = { tracks: () => box };
    const make = () => new BaselineDriver(car, straight600, flat(50 / 3.6), tracks);
    const vehicle = new Vehicle(car, uniformSurface('dry'));
    const out: DriverCommand = { steer: 0, accel: 0 };
    const free = (d: BaselineDriver, k: number) => {
      vehicle.reset(0, 0, 0, 5);
      box.length = 0;
      d.compute(k * 50, vehicle, out);
      return out.accel;
    };
    const braked = (d: BaselineDriver, k: number) => {
      vehicle.reset(130, 0, 0, 13.9);
      box.length = 0;
      box.push({ ...staticTrack(150), tick: k * 50 });
      d.compute(k * 50, vehicle, out);
    };
    const control = make();
    free(control, 0);
    const reference = free(control, 1);
    const subject = make();
    free(subject, 0);
    for (let k = 1; k <= 40; k++) braked(subject, k);
    expect(subject.aebActive).toBe(true);
    expect(out.accel).toBe(car.accelMin);
    expect(free(subject, 41)).toBe(reference);
  });

  it('resumes after a crossing pedestrian leaves the path, even with a parked box far ahead', () => {
    const v = 50 / 3.6;
    const ped = (t: number): ObstacleTrack => ({
      id: 'ped',
      kind: 'pedestrian',
      tick: t,
      s: 60,
      ey: -6 + 1.5 * (t / 1000),
      vs: 0,
      vey: 1.5,
      length: 0.6,
      width: 0.6,
    });
    let now = 0;
    const tracks: TrackSource = { tracks: () => [ped(now), staticTrack(500)] };
    const straight = new RoadPath({ segments: [{ kind: 'straight', length: 700 }], width: { left: 8, right: 8 } });
    let stoppedAt = -1;
    let resumed = false;
    const vehicle = new Vehicle(car, uniformSurface('dry'));
    vehicle.reset(0, 0, 0, v);
    const driver = new BaselineDriver(car, straight, flat(v), tracks);
    runClosedLoop(vehicle, driver, {
      ticks: ticksFor(30),
      onTick: (t, veh) => {
        now = t;
        if (stoppedAt < 0 && veh.speed < 0.05) stoppedAt = t;
        if (stoppedAt >= 0 && veh.speed > 2) resumed = true;
      },
    });
    expect(stoppedAt).toBeGreaterThan(0);
    expect(resumed).toBe(true);
  });

  it('never releases while a track overlaps the body, whatever the closing speed', () => {
    // Engage on a stopped car with a close box, then replace it by a pedestrian walking along the lane at 0.6 m/s
    // whose body overlaps the nose (clearance < 0): closing speed zero or negative, yet the brake stays held.
    const nose = noseOf(car);
    const tracks: ObstacleTrack[] = [staticTrack(nose + 1)];
    const vehicle = new Vehicle(car, uniformSurface('dry'));
    vehicle.reset(0, 0, 0, 3);
    const driver = new BaselineDriver(car, straight600, flat(10), source(tracks));
    const out: DriverCommand = { steer: 0, accel: 0 };
    driver.compute(0, vehicle, out);
    expect(driver.aebActive).toBe(true);
    vehicle.reset(0, 0, 0, 0);
    for (let k = 1; k <= 60; k++) {
      // The pedestrian's rear edge stays 0.1 m inside the nose, moving away at 0.6 m/s.
      tracks[0] = {
        id: 'ped',
        kind: 'pedestrian',
        tick: k * 50,
        s: nose + 0.2,
        ey: 0,
        vs: 0.6,
        vey: 0,
        length: 0.6,
        width: 0.6,
      };
      driver.compute(k * 50, vehicle, out);
      expect(driver.aebActive).toBe(true);
    }
    // Control: the same pedestrian clear of the body (and moving away) does release.
    tracks[0] = {
      id: 'ped',
      kind: 'pedestrian',
      tick: 3100,
      s: nose + 5,
      ey: 0,
      vs: 0.6,
      vey: 0,
      length: 0.6,
      width: 0.6,
    };
    driver.compute(3100, vehicle, out);
    expect(driver.aebActive).toBe(false);
  });

  it('assumes dry braking: it cannot stop on snow, where wet still stops (the baseline does not know mu)', () => {
    const v = 50 / 3.6;
    const through = (surface: SurfaceId, id: 'car' | 'truck') => {
      const params = VEHICLES[id];
      let minGap = Infinity;
      drive(straight600, surface, v, v, source([staticTrack(150)]), 30, undefined, params, {}, (_t, veh) => {
        const x = veh.plant.chassis[CHASSIS.X] ?? 0;
        minGap = Math.min(minGap, boxRear(150) - (x + noseOf(params)));
      });
      return minGap;
    };
    expect(through('wet', 'car')).toBeGreaterThan(0);
    expect(through('snow', 'car')).toBeLessThan(0);
    expect(through('snow', 'truck')).toBeLessThan(0);
  });

  it('ignores an obstacle outside its path', () => {
    const straight = new RoadPath({ segments: [{ kind: 'straight', length: 400 }], width: { left: 6, right: 6 } });
    const v = 50 / 3.6;
    const r = drive(straight, 'dry', v, v, source([staticTrack(150, 4)]), 12);
    expect(r.driver.aebActive).toBe(false);
    expect(r.driver.aebFirstTick).toBe(-1);
    expect(r.endSpeed).toBeGreaterThan(v - 1);
  });

  it('reports what it does on uniform ice at a speed dry tuning overestimates', () => {
    const v = 70 / 3.6;
    const r = drive(arc, 'ice', v, v, noTracks, 20);
    // No assertion on spinning: the figure is the evidence (M4 compares it with the MPC).
    console.log(
      `baseline on ice, 70 km/h, R=200: max |e_y| ${r.maxEy.toFixed(2)} m, max |beta| ${r.maxBeta.toFixed(3)} rad`,
    );
    expect(Number.isFinite(r.maxBeta)).toBe(true);
    expect(Number.isFinite(r.maxEy)).toBe(true);
  });

  it('is deterministic: same inputs, same trajectory to the bit', () => {
    const v = 70 / 3.6;
    const a = drive(arc, 'dry', v, v, noTracks, 8);
    const b = drive(arc, 'dry', v, v, noTracks, 8);
    expect(a.hash).toBe(b.hash);
    expect(Object.is(a.vehicle.plant.chassis[CHASSIS.X], b.vehicle.plant.chassis[CHASSIS.X])).toBe(true);
    expect(Object.is(a.vehicle.plant.chassis[CHASSIS.PSI], b.vehicle.plant.chassis[CHASSIS.PSI])).toBe(true);
  });

  it('is deterministic on the full command stream, AEB included', () => {
    const run = (): number[] => {
      const stream: number[] = [];
      const v = 50 / 3.6;
      const vehicle = new Vehicle(car, uniformSurface('dry'));
      vehicle.reset(0, 0, 0, v);
      const driver = new BaselineDriver(car, straight600, flat(v), source([staticTrack(150)]));
      runClosedLoop(vehicle, driver, {
        ticks: ticksFor(15),
        onTick: (_t, _v, c) => {
          stream.push(c.steer, c.accel);
        },
      });
      return stream;
    };
    const a = run();
    const b = run();
    expect(a.length).toBe(b.length);
    expect(a.every((x, i) => Object.is(x, b[i]))).toBe(true);
  });
});
