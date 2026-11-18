import { describe, expect, it } from 'vitest';

import {
  CHASSIS,
  RoadPath,
  runOpenLoop,
  surfaceMap,
  ticksFor,
  Vehicle,
  VEHICLES,
  wrapAngle,
  type Projection,
  type RoadPoint,
} from '../src/index.ts';

const point = (): RoadPoint => ({ x: 0, y: 0, heading: 0, curvature: 0 });
const projection = (): Projection => ({ s: 0, ey: 0, heading: 0, curvature: 0, index: -1 });
const width = { left: 5.25, right: 1.75 };

describe('road reference line', () => {
  it('projects onto a straight line', () => {
    const road = new RoadPath({ segments: [{ kind: 'straight', length: 100 }], width });
    expect(road.length).toBe(100);
    const p = road.pointAt(50, point());
    expect([p.x, p.y, p.heading]).toEqual([50, 0, 0]);
    const f = road.project(50.1, 3, -1, projection());
    expect(f.s).toBeCloseTo(50.1, 9);
    expect(f.ey).toBeCloseTo(3, 9);
  });

  it('closes a half circle where geometry says, and projects inside it to the left', () => {
    const radius = 50;
    const road = new RoadPath({ segments: [{ kind: 'arc', length: Math.PI * radius, curvature: 1 / radius }], width });
    const end = road.pointAt(road.length, point());
    expect(end.x).toBeCloseTo(0, 6);
    expect(end.y).toBeCloseTo(2 * radius, 6);
    expect(end.heading).toBeCloseTo(Math.PI, 9);

    // A point 45 m from the center of the left turn, at 45°: inside the curve, so 5 m to the left.
    const theta = Math.PI / 4;
    const f = road.project(45 * Math.sin(theta), radius - 45 * Math.cos(theta), -1, projection());
    expect(f.s).toBeCloseTo(radius * theta, 3);
    expect(f.ey).toBeCloseTo(5, 3);
    expect(f.curvature).toBeCloseTo(1 / radius, 9);
  });

  it('turns a clothoid by the mean curvature times its length', () => {
    const road = new RoadPath({
      segments: [
        { kind: 'straight', length: 20 },
        { kind: 'clothoid', length: 100, curvatureStart: 0, curvatureEnd: 0.02 },
      ],
      width,
    });
    const end = road.pointAt(road.length, point());
    expect(end.heading).toBeCloseTo(1, 9);
    expect(end.curvature).toBeCloseTo(0.02, 9);
    expect(road.pointAt(10, point()).curvature).toBe(0);
  });

  it('tracks a moving point with a hint exactly as a full search does', () => {
    const road = new RoadPath({
      segments: [
        { kind: 'straight', length: 30 },
        { kind: 'arc', length: 60, curvature: 1 / 40 },
        { kind: 'clothoid', length: 50, curvatureStart: 1 / 40, curvatureEnd: -1 / 60 },
      ],
      width,
    });
    const tracked = projection();
    const full = projection();
    const p = point();
    for (let s = 0; s <= road.length; s += 0.04) {
      road.pointAt(s, p);
      const x = p.x - 1.2 * Math.sin(p.heading);
      const y = p.y + 1.2 * Math.cos(p.heading);
      road.project(x, y, tracked.index, tracked);
      road.project(x, y, -1, full);
      expect(tracked.s).toBeCloseTo(full.s, 9);
      expect(tracked.ey).toBeCloseTo(1.2, 3);
    }
  });

  it('recovers from a stale hint on a hairpin, where the local search would stop on the wrong branch', () => {
    // Out 60 m, a 180° turn of radius 12 m, back 60 m: the two straights are 24 m apart.
    const road = new RoadPath({
      segments: [
        { kind: 'straight', length: 60 },
        { kind: 'arc', length: Math.PI * 12, curvature: 1 / 12 },
        { kind: 'straight', length: 60 },
      ],
      width,
    });
    const outbound = road.project(30, 1, -1, projection());
    const inbound = road.project(30, 23, outbound.index, projection());
    expect(inbound.s).toBeCloseTo(60 + Math.PI * 12 + 30, 3);
    expect(inbound.ey).toBeCloseTo(1, 3);
  });

  it('rejects an empty road and non-positive segments', () => {
    expect(() => new RoadPath({ segments: [], width })).toThrow(RangeError);
    expect(() => new RoadPath({ segments: [{ kind: 'straight', length: 0 }], width })).toThrow(RangeError);
  });
});

describe('surface map', () => {
  const road = new RoadPath({ segments: [{ kind: 'straight', length: 300 }], width });
  const zones = [{ from: 10, to: 250, side: 'left' as const, surface: 'ice' as const }];

  it('puts each side of a μ-split zone on its own surface', () => {
    const map = surfaceMap(road, 'dry', zones);
    expect(map.at(0, 20, 1).id).toBe('ice');
    expect(map.at(1, 20, -1).id).toBe('dry');
    expect(map.at(2, 5, 1).id).toBe('dry');
    expect(map.at(3, 260, 1).id).toBe('dry');
  });

  it('gives the same answers after a jump, with or without a reset', () => {
    const map = surfaceMap(road, 'dry', zones);
    map.at(0, 290, 1);
    expect(map.at(0, 20, 1).id).toBe('ice');
    map.reset();
    expect(map.at(0, 290, 1).id).toBe('dry');
  });

  it('follows a wheel off the road and back', () => {
    const map = surfaceMap(road, 'dry', [{ from: 0, to: 300, surface: 'wet' }]);
    for (let y = 0; y <= 40; y += 0.04) map.at(0, 100, y);
    expect(map.at(0, 100, 40).id).toBe('wet');
    for (let y = 40; y >= 0; y -= 0.04) map.at(0, 100, y);
    expect(map.at(0, 100, 0.5).id).toBe('wet');
  });

  it('yaws a braking car toward the high-grip side', () => {
    const vehicle = new Vehicle(VEHICLES.car, surfaceMap(road, 'dry', zones));
    vehicle.reset(0, 0, 0, 25);
    runOpenLoop(vehicle, {
      ticks: ticksFor(1.5),
      command: (_tick, _v, out) => {
        out.steer = 0;
        out.accel = -10;
      },
    });
    // Ice on the left, asphalt on the right: the right wheels brake harder and pull the nose right.
    expect(vehicle.plant.chassis[CHASSIS.PSI] ?? 0).toBeLessThan(-0.05);
  });
});

describe('wrapAngle', () => {
  it('wraps to (−π, π]', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI)).toBe(Math.PI);
    expect(wrapAngle(-Math.PI)).toBe(Math.PI);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(2 * Math.PI + 0.1)).toBeCloseTo(0.1, 12);
    expect(wrapAngle(-2 * Math.PI - 0.1)).toBeCloseTo(-0.1, 12);
  });
});
