/**
 * The top view's geometry (drawScene.ts): the road runs up the screen whatever its heading and its left stays on the
 * left, the ego sits where the view puts it, and the road line is read back from the scene's samples.
 */
import { describe, expect, it } from 'vitest';

import { ROAD_SAMPLE, type SceneInfo } from '@mpc-simulator/worker';

import { MAIN_VIEW, MINI_VIEW, viewMatrix, type ViewMatrix } from './drawScene.ts';
import { RoadGeometry } from './roadGeometry.ts';

const project = (m: ViewMatrix, x: number, y: number) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });

describe('viewMatrix', () => {
  it('puts the ego at its place and the road ahead up the screen, whatever the heading', () => {
    for (const heading of [0, Math.PI / 2, -0.7, 2.5]) {
      const m = viewMatrix(400, 640, 12, -3, heading);
      const ego = project(m, 12, -3);
      expect(ego.x).toBeCloseTo(200, 9);
      expect(ego.y).toBeCloseTo(640 * MAIN_VIEW.egoAt, 9);
      const ahead = project(m, 12 + 10 * Math.cos(heading), -3 + 10 * Math.sin(heading));
      expect(ahead.x).toBeCloseTo(200, 9);
      expect(ahead.y).toBeCloseTo(640 * MAIN_VIEW.egoAt - 10 * m.scale, 9);
      // The left of the heading is the left of the screen.
      const beside = project(m, 12 - 2 * Math.sin(heading), -3 + 2 * Math.cos(heading));
      expect(beside.x).toBeCloseTo(200 - 2 * m.scale, 9);
      expect(beside.y).toBeCloseTo(640 * MAIN_VIEW.egoAt, 9);
    }
  });

  it('spans the meters of road its view asks for, from the bottom edge to the top one', () => {
    const m = viewMatrix(400, 640, 0, 0, 0);
    expect(m.scale * MAIN_VIEW.span).toBeCloseTo(640, 9);
  });

  it('frames the mini-map wider than the main view, with the ego at its own place', () => {
    const m = viewMatrix(140, 180, 5, 7, 1.2, MINI_VIEW);
    expect(MINI_VIEW.span).toBeGreaterThan(2 * MAIN_VIEW.span);
    expect(m.scale * MINI_VIEW.span).toBeCloseTo(180, 9);
    const ego = project(m, 5, 7);
    expect(ego.x).toBeCloseTo(70, 9);
    expect(ego.y).toBeCloseTo(180 * MINI_VIEW.egoAt, 9);
  });
});

/** A scene with a road line of `count` points along a circle of radius 50 m, one meter apart in s. */
function bend(count: number): SceneInfo {
  const road = new Float64Array(count * ROAD_SAMPLE);
  for (let i = 0; i < count; i++) {
    const heading = i / 50;
    road.set([i, 50 * Math.sin(heading), 50 * (1 - Math.cos(heading)), heading, 1 / 50], i * ROAD_SAMPLE);
  }
  return { road } as unknown as SceneInfo;
}

describe('RoadGeometry', () => {
  it('reads the road back between its samples, and beside it to the left', () => {
    const geometry = new RoadGeometry(bend(40));
    expect(geometry.count).toBe(40);
    expect(geometry.headingAt(10)).toBeCloseTo(0.2, 12);
    expect(geometry.headingAt(10.5)).toBeCloseTo(0.21, 12);
    const p = { x: 0, y: 0 };
    geometry.pointAt(0, 0, p);
    expect([p.x, p.y]).toEqual([0, 0]);
    // Left of a road heading along +x is +y.
    geometry.pointAt(0, 3.5, p);
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(3.5, 12);
    // On a left bend, a point to the right of the line lies outside the circle: farther from its center (0, 50).
    geometry.pointAt(20, -1.75, p);
    expect(Math.hypot(p.x, p.y - 50)).toBeCloseTo(51.75, 2);
  });

  it('holds its ends: a point past the road keeps the heading of the last sample', () => {
    const geometry = new RoadGeometry(bend(40));
    expect(geometry.headingAt(-5)).toBeCloseTo(0, 12);
    expect(geometry.headingAt(400)).toBeCloseTo(39 / 50, 12);
  });
});
