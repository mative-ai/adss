/**
 * The scenario run (Phase 3): determinism from (scenario, seed), the object sensor's latency,
 * noise, range and visibility, collisions between oriented bodies, the metrics on crafted cases, and a ghost
 * that sees its own triggers. The controllers here are small scripted ones, so the tests exercise the world and
 * not the MPC.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CHASSIS,
  laneFriction,
  overrideScenario,
  parseScenario,
  rectanglesOverlap,
  roadCorridor,
  RoadPath,
  runScenario,
  RUN_RECORD,
  RUN_RECORD_SIZE,
  ScenarioRun,
  SURFACES,
  TICK_HZ,
  TRACK_LOG_SIZE,
  VEHICLES,
  wheelbase,
  wrapAngle,
  type Controller,
  type ControllerContext,
  type ControllerFactory,
  type Projection,
  type Scenario,
  type ScenarioJson,
} from '../src/index.ts';

const read = (id: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../scenarios/${id}.json`, import.meta.url), 'utf8'));

const car = VEHICLES.car;
/** Body front ahead of the center of gravity, m. */
const FRONT = car.lf + (car.length - wheelbase(car)) / 2;

/** Constant steering and acceleration, no delay unless asked. */
const constant =
  (accel: number, steer = 0, delayTicks = 0): ControllerFactory =>
  (): Controller => ({
    periodTicks: 50,
    delayTicks,
    compute(_tick, _vehicle, out) {
      out.steer = steer;
      out.accel = accel;
    },
  });

/** Brakes fully from the first report of an obstacle moving across the road. */
const brakeOnCrossing: ControllerFactory = (context) => {
  let braking = false;
  return {
    periodTicks: 50,
    delayTicks: 50,
    compute(_tick, _vehicle, out) {
      if (context.tracks.tracks().some((track) => Math.abs(track.vey) > 0.5)) braking = true;
      out.steer = 0;
      out.accel = braking ? -10 : 0;
    },
  };
};

/** Follows the lane's center with curvature feed-forward and a PD on the road errors. */
const laneKeeper: ControllerFactory = (context: ControllerContext) => {
  const projection: Projection = { s: 0, ey: 0, heading: 0, curvature: 0, index: -1 };
  return {
    periodTicks: 10,
    delayTicks: 0,
    compute(_tick, vehicle, out) {
      const c = vehicle.plant.chassis;
      const p = context.road.project(c[CHASSIS.X] ?? 0, c[CHASSIS.Y] ?? 0, projection.index, projection);
      const epsi = wrapAngle((c[CHASSIS.PSI] ?? 0) - p.heading);
      out.steer = wheelbase(context.params) * p.curvature - 0.15 * (p.ey - context.lane.center) - 1.0 * epsi;
      out.accel = 0;
    },
  };
};

function straight(overrides: Partial<ScenarioJson> = {}): Scenario {
  return parseScenario({
    id: 'crafted',
    vehicle: 'car',
    speed: { initial: 36, reference: 36 },
    duration: 8,
    road: { segments: [{ kind: 'straight', length: 300 }], width: { left: 3.5, right: 3.5 } },
    lane: { center: -1.75, width: 3.5 },
    surface: { base: 'dry' },
    sensor: { range: 1000 },
    ...overrides,
  });
}

const block = (id: string, s: number, ey: number, length = 1, width = 1) => ({
  id,
  kind: 'static' as const,
  length,
  width,
  start: { s, ey },
  velocity: { s: 0, ey: 0 },
});

describe('scenario run determinism', () => {
  const pedestrian = parseScenario(read('pedestrian'));

  it('gives the same fingerprint for the same seed, ego and ghost', () => {
    const a = runScenario(pedestrian, { seed: 7, ego: brakeOnCrossing, ghost: constant(0) });
    const b = runScenario(pedestrian, { seed: 7, ego: brakeOnCrossing, ghost: constant(0) });
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.ego.records).toEqual(a.ego.records);
    expect(b.ego.trackLog).toEqual(a.ego.trackLog);
  });

  it('draws different sensor noise for a different seed', () => {
    const a = runScenario(pedestrian, { seed: 1, ego: constant(0) });
    const b = runScenario(pedestrian, { seed: 2, ego: constant(0) });
    // The controller ignores the tracks, so the vehicle runs the same: only the noise differs.
    expect(b.ego.records).toEqual(a.ego.records);
    expect(b.ego.trackLog.length).toBe(a.ego.trackLog.length);
    expect(b.ego.trackLog).not.toEqual(a.ego.trackLog);
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it('can be stepped tick by tick to the same result', () => {
    const run = new ScenarioRun(pedestrian, { seed: 3, ego: brakeOnCrossing });
    let ticks = 0;
    while (run.step()) ticks++;
    expect(ticks).toBeGreaterThan(0);
    expect(run.result().fingerprint).toBe(runScenario(pedestrian, { seed: 3, ego: brakeOnCrossing }).fingerprint);
  });

  it('rejects a seed that is not an unsigned 32-bit integer', () => {
    expect(() => new ScenarioRun(pedestrian, { seed: -1, ego: constant(0) })).toThrow(RangeError);
    expect(() => new ScenarioRun(pedestrian, { seed: 1.5, ego: constant(0) })).toThrow(RangeError);
  });
});

describe('object sensor', () => {
  it('reports the state latency ticks ago, the spec velocity while moving, and nothing out of range', () => {
    const scenario = straight({
      sensor: { period: 50, latency: 100, range: 60 },
      obstacles: [
        {
          ...block('walker', 40, -4, 0.5, 0.5),
          kind: 'pedestrian',
          velocity: { s: 0, ey: 1 },
          trigger: { kind: 'time', at: 0.2 },
          travel: 2,
        },
        block('far', 250, 0),
      ],
    });
    const run = new ScenarioRun(scenario, { seed: 1, ego: constant(-10) });
    const seen: { tick: number; ey: number; vey: number }[] = [];
    while (run.step()) {
      const sensor = run.ego.sensor;
      const tick = run.now - 1;
      if (sensor.lastPublication !== tick) continue;
      expect(sensor.tracks().map((t) => t.id)).toEqual(['walker']);
      const track = sensor.tracks()[0];
      if (track) seen.push({ tick, ey: track.ey, vey: track.vey });
    }
    // Trigger at 0.2 s, 1 m/s for 2 m: the state 100 ticks before each publication.
    const expected = (tick: number) => -4 + Math.min(Math.max(tick - 100 - 200, 0), 2000) / 1000;
    for (const { tick, ey } of seen) expect(ey).toBeCloseTo(expected(tick), 12);
    const at = (tick: number) => seen.find((s) => s.tick === tick)?.vey;
    expect(at(250)).toBe(0);
    expect(at(1000)).toBe(1);
    expect(at(2350)).toBe(0);
  });

  it('stamps each track with the tick of its state: its age is the latency plus the time since publication', () => {
    const latency = 120;
    const scenario = straight({
      sensor: { period: 50, latency, range: 1000 },
      obstacles: [block('post', 150, 4)],
    });
    const run = new ScenarioRun(scenario, { seed: 1, ego: constant(0) });
    let checked = 0;
    let early = 0;
    while (run.step()) {
      const tick = run.now - 1;
      const sensor = run.ego.sensor;
      const track = sensor.tracks()[0];
      if (!track) continue;
      const published = sensor.lastPublication;
      if (published >= latency) {
        // A reader at `tick` sees a track (tick − track.tick)/TICK_HZ seconds old.
        expect((tick - track.tick) / TICK_HZ).toBeCloseTo((latency + tick - published) / TICK_HZ, 12);
        checked++;
      } else {
        // Before the buffer fills, the oldest state there is: tick 0.
        expect(track.tick).toBe(0);
        early++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(early).toBe(150);
  });

  it('hides an afterTrigger obstacle until its trigger and applies the same noise to both vehicles', () => {
    const scenario = straight({
      sensor: { period: 50, latency: 0, noise: { position: 0.3, velocity: 0.3 }, range: 1000 },
      obstacles: [
        { ...block('hidden', 120, -1.75), trigger: { kind: 'egoReaches', s: 30 }, visibility: 'afterTrigger' },
        block('post', 150, 4),
      ],
    });
    // The ego stops before s 30; the ghost drives on and uncovers the hidden obstacle.
    const result = runScenario(scenario, { seed: 5, ego: constant(-8), ghost: constant(0) });
    const rows = (log: Float64Array, index: number) => {
      const out: number[][] = [];
      for (let k = 0; k < log.length; k += TRACK_LOG_SIZE) {
        if (log[k + 1] === index) out.push(Array.from(log.subarray(k, k + TRACK_LOG_SIZE)));
      }
      return out;
    };
    const ghost = result.ghost;
    expect(ghost).not.toBeNull();
    expect(rows(result.ego.trackLog, 0)).toEqual([]);
    expect(rows(ghost?.trackLog ?? new Float64Array(), 0).length).toBeGreaterThan(0);
    // The visible post: same ticks, same noisy values for ego and ghost.
    const egoPost = rows(result.ego.trackLog, 1);
    const ghostPost = rows(ghost?.trackLog ?? new Float64Array(), 1);
    expect(egoPost.length).toBeGreaterThan(10);
    expect(ghostPost.slice(0, egoPost.length)).toEqual(egoPost);
    expect(egoPost.some((row) => row[2] !== 150)).toBe(true);
  });
});

describe('collisions', () => {
  it('stops the run at the first contact between the body and an obstacle', () => {
    const scenario = straight({ obstacles: [block('box', 50, -1.75)] });
    const run = new ScenarioRun(scenario, { seed: 1, ego: constant(0) });
    while (run.step());
    const result = run.result();
    const hit = result.ego.events.find((e) => e.kind === 'collision');
    expect(result.ego.end).toBe('collision');
    expect(hit?.kind === 'collision' && hit.obstacle).toBe('box');
    // The front touches the box's rear (s 49.5) within one tick of travel, about 1 cm at 10 m/s.
    expect(run.ego.pose.s + FRONT).toBeGreaterThanOrEqual(49.5);
    expect(run.ego.pose.s + FRONT).toBeLessThan(49.5 + 0.011);
    expect(hit?.tick).toBe(run.ego.ticks);
    const m = result.ego.metrics;
    expect(m.collided).toBe(true);
    expect(m.collisionObstacle).toBe('box');
    expect(m.impactSpeed).toBeGreaterThan(9);
    expect(m.impactSpeed).toBeLessThan(10);
    // A static obstacle on a straight: the closing speed is the ego's own speed.
    expect(m.impactSpeed).toBeCloseTo(m.egoImpactSpeed ?? 0, 9);
    expect(hit?.kind === 'collision' && hit.speed).toBe(m.impactSpeed);
    expect(m.minTtc).toBe(0);
    expect(m.duration).toBe(result.ego.ticks / TICK_HZ);
  });

  it('measures the impact speed as the closing speed along the road relative to the obstacle', () => {
    // A car ahead at 5 m/s, the ego at 10 m/s: contact at a closing speed of 5 m/s.
    const scenario = straight({
      obstacles: [{ ...block('slow', 30, -1.75, 4.4, 1.8), kind: 'vehicle', velocity: { s: 5, ey: 0 } }],
    });
    const result = runScenario(scenario, { seed: 1, ego: constant(0) });
    const m = result.ego.metrics;
    expect(m.collisionObstacle).toBe('slow');
    expect(m.egoImpactSpeed).toBeGreaterThan(9);
    expect(m.impactSpeed).toBeCloseTo((m.egoImpactSpeed ?? 0) - 5, 6);
  });

  it('gives a negative impact speed when a faster obstacle strikes the ego from behind', () => {
    // The ego starts at s 30 at 10 m/s; a car 20 m behind at 25 m/s closes 15 m/s and strikes its rear.
    const scenario = straight({
      egoStart: 30,
      obstacles: [{ ...block('fast', 10, -1.75, 4.4, 1.8), kind: 'vehicle', velocity: { s: 25, ey: 0 } }],
    });
    const result = runScenario(scenario, { seed: 1, ego: constant(0) });
    const m = result.ego.metrics;
    const hit = result.ego.events.find((e) => e.kind === 'collision');
    expect(m.collisionObstacle).toBe('fast');
    expect(m.egoImpactSpeed).toBeGreaterThan(9);
    expect(m.impactSpeed).toBeLessThan(0);
    expect(m.impactSpeed).toBeCloseTo((m.egoImpactSpeed ?? 0) - 25, 6);
    // The collision event carries the same signed value.
    expect(hit?.kind === 'collision' && hit.speed).toBe(m.impactSpeed);
  });

  it('tells a graze from a near miss at the side of the body', () => {
    const side = -1.75 + car.width / 2 + 0.5;
    const run = (ey: number) =>
      runScenario(straight({ duration: 7, obstacles: [block('post', 50, ey)] }), { seed: 1, ego: constant(0) });
    expect(run(side + 0.03).ego.metrics.collided).toBe(false);
    expect(run(side - 0.03).ego.metrics.collided).toBe(true);
  });

  it('detects a collision on a curve, with the obstacle oriented along the road', () => {
    const scenario = straight({
      duration: 16,
      road: {
        segments: [
          { kind: 'straight', length: 20 },
          { kind: 'arc', length: 150, curvature: 0.01 },
        ],
        width: { left: 3.5, right: 3.5 },
      },
      obstacles: [block('box', 120, -1.75, 4, 1)],
    });
    const result = runScenario(scenario, { seed: 1, ego: laneKeeper });
    const m = result.ego.metrics;
    expect(m.maxLateralDeviation).toBeLessThan(0.2);
    expect(m.collisionObstacle).toBe('box');
    const s = result.ego.records;
    const last = s.length - RUN_RECORD_SIZE;
    expect(s[last + RUN_RECORD.S] ?? 0).toBeGreaterThan(110);
    expect(s[last + RUN_RECORD.S] ?? 0).toBeLessThan(120 - 2 - FRONT + 0.2);
  });

  it('separates rotated rectangles only when an axis separates them', () => {
    const a = { x: 0, y: 0, heading: 0, halfLength: 2, halfWidth: 1 };
    expect(rectanglesOverlap(a, { x: 3.4, y: 0, heading: Math.PI / 4, halfLength: 1, halfWidth: 1 })).toBe(true);
    expect(rectanglesOverlap(a, { x: 3.5, y: 0, heading: Math.PI / 4, halfLength: 1, halfWidth: 1 })).toBe(false);
    expect(rectanglesOverlap(a, { x: 0, y: 1.9, heading: Math.PI / 2, halfLength: 1, halfWidth: 0.5 })).toBe(true);
  });
});

describe('run metrics', () => {
  it('agree with the run on its length: duration, ticks and the last record share the final tick', () => {
    const scenario = straight({ duration: 3 });
    const result = runScenario(scenario, { seed: 1, ego: constant(0) });
    const ego = result.ego;
    expect(ego.end).toBe('duration');
    expect(ego.ticks).toBe(3 * TICK_HZ);
    expect(ego.metrics.duration).toBe(3);
    const last = ego.records.length - RUN_RECORD_SIZE;
    expect(ego.records[last + RUN_RECORD.TICK]).toBe(ego.ticks);
    // The distance covers every step of the run, the last one included: 3 s coasting from 10 m/s.
    expect(ego.metrics.distance).toBeGreaterThan(29);
    expect(ego.metrics.distance).toBeLessThanOrEqual(30 + 1e-9);
  });

  it('records the final state even when the duration is not a multiple of the record period', () => {
    for (const [duration, recordEvery] of [
      [3.005, 10],
      [2, 7],
    ] as const) {
      const result = runScenario(straight({ duration }), { seed: 1, ego: constant(0), recordEvery });
      const ego = result.ego;
      const ticks = Math.round(duration * TICK_HZ);
      expect(ticks % recordEvery).not.toBe(0);
      expect(ego.end).toBe('duration');
      expect(ego.ticks).toBe(ticks);
      expect(ego.metrics.duration).toBe(ticks / TICK_HZ);
      const rows = ego.records.length / RUN_RECORD_SIZE;
      // One row per period from tick 0, plus the final row.
      expect(rows).toBe(Math.floor((ticks - 1) / recordEvery) + 2);
      expect(ego.records[(rows - 1) * RUN_RECORD_SIZE + RUN_RECORD.TICK]).toBe(ticks);
      expect(ego.records[(rows - 2) * RUN_RECORD_SIZE + RUN_RECORD.TICK]).toBe(
        Math.floor((ticks - 1) / recordEvery) * recordEvery,
      );
    }
  });

  it('measures a straight stop from 20 m/s', () => {
    const scenario = straight({ speed: { initial: 72, reference: 72 }, obstacles: [block('ahead', 100, -1.75)] });
    const result = runScenario(scenario, { seed: 1, ego: constant(-6) });
    const m = result.ego.metrics;
    expect(m.collided).toBe(false);
    // v²/2a plus the brake's 50 ms delay and 100 ms lag at 20 m/s.
    expect(m.stoppingDistance).toBeGreaterThan(20 ** 2 / 12 + 20 * 0.1);
    expect(m.stoppingDistance).toBeLessThan(20 ** 2 / 12 + 20 * 0.2);
    expect(m.distance).toBeCloseTo(m.stoppingDistance ?? 0, 1);
    expect(m.finalSpeed).toBeLessThan(0.1);
    expect(m.maxLateralDeviation).toBeLessThan(1e-9);
    expect(m.peakLateralAccel).toBeLessThan(1e-6);
    expect(m.maxSideslip).toBeLessThan(1e-9);
    // The gap only shrinks slower than the speed: the minimum comes before the brake bites.
    const initial = (100 - 0.5 - FRONT) / 20;
    expect(m.minTtc).toBeLessThanOrEqual(initial);
    expect(m.minTtc).toBeGreaterThan(initial - 0.1);
  });

  it('has no TTC without an obstacle in the path, nor a stopping distance without strong braking', () => {
    const scenario = straight({ obstacles: [block('aside', 60, 2.5)] });
    const m = runScenario(scenario, { seed: 1, ego: constant(-2) }).ego.metrics;
    expect(m.minTtc).toBeNull();
    expect(m.stoppingDistance).toBeNull();
  });

  it('measures lateral acceleration, sideslip and deviation at least as large as the records show', () => {
    const scenario = straight({ duration: 4, speed: { initial: 54, reference: 54 } });
    const result = runScenario(scenario, { seed: 1, ego: constant(0, 0.05) });
    const m = result.ego.metrics;
    const r = result.ego.records;
    let ay = 0;
    let beta = 0;
    let deviation = 0;
    for (let k = 0; k < r.length; k += RUN_RECORD_SIZE) {
      ay = Math.max(ay, Math.abs(r[k + RUN_RECORD.AY] ?? 0));
      beta = Math.max(beta, Math.abs(Math.atan2(r[k + RUN_RECORD.VY] ?? 0, r[k + RUN_RECORD.VX] ?? 1)));
      deviation = Math.max(deviation, Math.abs((r[k + RUN_RECORD.EY] ?? 0) + 1.75));
    }
    expect(ay).toBeGreaterThan(3);
    expect(m.peakLateralAccel).toBeGreaterThanOrEqual(ay);
    expect(m.maxSideslip).toBeGreaterThanOrEqual(beta);
    expect(m.maxSideslip).toBeGreaterThan(0);
    expect(m.maxLateralDeviation).toBeGreaterThanOrEqual(deviation);
    expect(m.maxLateralDeviation).toBeGreaterThan(5);
  });
});

describe('ghost', () => {
  it('triggers its own obstacles: the ego stops short, the ghost drives on', () => {
    const pedestrian = overrideScenario(parseScenario(read('pedestrian')), { triggerDistance: { pedestrian: 20 } });
    const run = new ScenarioRun(pedestrian, { seed: 1, ego: constant(-10), ghost: constant(0) });
    while (run.step());
    const result = run.result();
    expect(result.ego.events.some((e) => e.kind === 'trigger')).toBe(false);
    expect(result.ghost?.events.some((e) => e.kind === 'trigger' && e.obstacle === 'pedestrian')).toBe(true);
    expect(run.ego.obstacles.states[0]?.triggeredAt).toBe(-1);
    expect(run.ego.obstacles.states[0]?.ey).toBe(-4);
    expect(run.ghost?.obstacles.states[0]?.triggeredAt).toBeGreaterThan(0);
    expect(run.ghost?.obstacles.states[0]?.ey).toBeGreaterThan(-4);
    expect(result.ego.metrics.collided).toBe(false);
    expect(result.ghost?.metrics.collided).toBe(true);
  });
});

describe('controller views of the v1 scenarios', () => {
  const dry = SURFACES.dry.mu;
  const ice = SURFACES.ice.mu;
  const bounds = (scenario: Scenario, s: number) => {
    const out = { left: Number.NaN, right: Number.NaN };
    roadCorridor(new RoadPath(scenario.road)).bounds(s, out);
    return out;
  };

  it('mu-split: the left wheel track on ice from s 30, so the lane expects their mean', () => {
    const muSplit = parseScenario(read('mu-split'));
    const friction = laneFriction(muSplit, car);
    expect(friction.at(0)).toBe(dry);
    expect(friction.at(29.99)).toBe(dry);
    expect(friction.at(30)).toBeCloseTo((dry + ice) / 2, 12);
    expect(friction.at(30)).toBeCloseTo(0.55, 12);
    expect(friction.at(399)).toBeCloseTo(0.55, 12);
    expect(bounds(muSplit, 100)).toEqual({ left: 5.25, right: -2.25 });
    // Elsewhere across the road: the opposite lane all on ice, both tracks on dry a metre to the right.
    expect(friction.at(100, muSplit.lane.center)).toBe(friction.at(100));
    expect(friction.at(100, 3.5)).toBe(ice);
    expect(friction.at(100, -1)).toBe(dry);
  });

  it('ice: ice under both tracks from s 140 to 175, dry elsewhere', () => {
    const iceCurve = parseScenario(read('ice'));
    const friction = laneFriction(iceCurve, car);
    for (const s of [0, 100, 139.99, 175, 200, 399]) expect(friction.at(s)).toBe(dry);
    for (const s of [140, 157.5, 174.99]) expect(friction.at(s)).toBe(ice);
    expect(bounds(iceCurve, 0)).toEqual({ left: 3.5, right: -3.5 });
    expect(bounds(iceCurve, 200)).toEqual({ left: 3.5, right: -3.5 });
  });

  it('pedestrian and moose: dry everywhere, between edges 3.5 m on each side', () => {
    for (const id of ['pedestrian', 'moose']) {
      const scenario = parseScenario(read(id));
      const friction = laneFriction(scenario, car);
      for (const s of [0, 60, 249]) expect(friction.at(s)).toBe(dry);
      expect(bounds(scenario, 60)).toEqual({ left: 3.5, right: -3.5 });
    }
  });

  it('gives controllers no access to the scenario, only to what they may know', () => {
    let keys: string[] = [];
    const spy: ControllerFactory = (context) => {
      keys = Object.keys(context).sort();
      return constant(0)(context);
    };
    runScenario(straight({ duration: 0.01 }), { seed: 1, ego: spy });
    expect(keys).toEqual(['corridor', 'friction', 'lane', 'mu', 'params', 'reference', 'road', 'tracks']);
  });
});
