/**
 * The flat geometry of the 3D scene (geometry.ts): the strips follow the road's samples and lie on the ground in three's
 * axes (x, 0, −y), the dashes and the hatch stay inside their stretch, a ring is whole or dashed, and a plan's ribbon
 * has its left on the left with a dash that follows the distance along the path.
 */
import { describe, expect, it } from 'vitest';

import { ROAD_SAMPLE } from '@mpc-simulator/worker';

import { RoadGeometry } from '../roadGeometry.ts';
import {
  dashMesh,
  hatchMesh,
  ribbonIndices,
  ringMesh,
  stripMesh,
  stripSpans,
  writeRibbon,
  type FlatMesh,
} from './geometry.ts';

/** A straight road of `length` m along +x. */
function straight(length: number): RoadGeometry {
  const road = new Float64Array((length + 1) * ROAD_SAMPLE);
  for (let i = 0; i <= length; i++) road.set([i, i, 0, 0, 0], i * ROAD_SAMPLE);
  return new RoadGeometry({ road });
}

/** The extent of a mesh in the simulation's x and y, and whether it all lies on the ground. */
function extent(mesh: FlatMesh) {
  const xs: number[] = [];
  const ys: number[] = [];
  let flat = true;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    xs.push(mesh.positions[i] ?? 0);
    if (mesh.positions[i + 1] !== 0) flat = false;
    ys.push(-(mesh.positions[i + 2] ?? 0));
  }
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), flat };
}

/** The area of a mesh's triangles, m². */
function area(mesh: FlatMesh): number {
  let sum = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [mesh.indices[i] ?? 0, mesh.indices[i + 1] ?? 0, mesh.indices[i + 2] ?? 0];
    const at = (v: number, k: number) => mesh.positions[3 * v + k] ?? 0;
    sum += Math.abs((at(b, 0) - at(a, 0)) * (at(c, 2) - at(a, 2)) - (at(c, 0) - at(a, 0)) * (at(b, 2) - at(a, 2))) / 2;
  }
  return sum;
}

describe('stripSpans', () => {
  it('cuts a stretch at the samples of the road, and keeps inside the road', () => {
    const road = straight(40);
    expect(stripSpans(road, 10, 13)).toEqual([
      [10, 11],
      [11, 12],
      [12, 13],
    ]);
    // A stretch that starts and ends between two samples has a short piece at each end.
    expect(stripSpans(road, 10.5, 12.25)).toEqual([
      [10.5, 11],
      [11, 12],
      [12, 12.25],
    ]);
    expect(stripSpans(road, -5, 2)).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(stripSpans(road, 39, 60)).toEqual([[39, 40]]);
    expect(stripSpans(road, 20, 20)).toEqual([]);
  });
});

describe('stripMesh', () => {
  it('covers the stretch of road it is asked for, a quad per sample, on the ground', () => {
    const mesh = stripMesh(straight(40), 10, 30, -3.5, 3.5);
    expect(mesh.indices).toHaveLength(20 * 6);
    expect(extent(mesh)).toEqual({ x0: 10, x1: 30, y0: -3.5, y1: 3.5, flat: true });
    expect(area(mesh)).toBeCloseTo(20 * 7, 4);
  });

  it('stops at the ends of the road, and starts between two samples when asked', () => {
    const mesh = stripMesh(straight(40), -5, 99, 0, 2);
    expect(extent(mesh)).toMatchObject({ x0: 0, x1: 40 });
    const part = stripMesh(straight(40), 10.5, 12.25, 0, 2);
    expect(extent(part)).toMatchObject({ x0: 10.5, x1: 12.25 });
    expect(area(part)).toBeCloseTo(1.75 * 2, 5);
  });
});

describe('dashMesh', () => {
  it('lays dashes of the length and the width asked for, with their gaps', () => {
    const mesh = dashMesh(straight(40), 0, 36, 1.75, 3, 6, 0.15);
    // A dash every 9 m from 0 to 36: four of them.
    expect(mesh.indices).toHaveLength(4 * 6);
    expect(area(mesh)).toBeCloseTo(4 * 3 * 0.15, 5);
    const e = extent(mesh);
    expect(e.y0).toBeCloseTo(1.675, 5);
    expect(e.y1).toBeCloseTo(1.825, 5);
  });
});

describe('hatchMesh', () => {
  it('keeps every stripe inside its zone', () => {
    const mesh = hatchMesh(straight(60), 20, 40, -3.5, 3.5, 1.6, 0.3);
    expect(mesh.indices.length).toBeGreaterThan(6 * 10);
    const e = extent(mesh);
    expect(e.x0).toBeGreaterThanOrEqual(20);
    expect(e.x1).toBeLessThanOrEqual(40);
    expect(e.y0).toBeGreaterThanOrEqual(-3.5);
    expect(e.y1).toBeLessThanOrEqual(3.5);
    expect(e.flat).toBe(true);
  });

  it('is empty for a zone without width', () => {
    expect(hatchMesh(straight(60), 20, 40, 1, 1, 1.6, 0.3).indices).toHaveLength(0);
  });
});

describe('ringMesh', () => {
  it('is whole, or broken into dashes as long as their gaps', () => {
    const whole = ringMesh(1, 1.2, 48);
    expect(whole.indices).toHaveLength(48 * 6);
    const dashed = ringMesh(1, 1.2, 48, 8);
    expect(dashed.indices).toHaveLength(24 * 6);
    expect(area(dashed)).toBeCloseTo(area(whole) / 2, 6);
    const e = extent(whole);
    expect(e.x1).toBeCloseTo(1.2, 5);
    expect(e.y0).toBeCloseTo(-1.2, 5);
  });
});

describe('writeRibbon', () => {
  it('puts the left vertex on the left of the path, and measures the path for the dash', () => {
    // A path along +x, then turning to +y: 3 m, then 4 m.
    const points = new Float64Array([0, 0, 3, 0, 3, 4]);
    const positions = new Float32Array(18);
    const uvs = new Float32Array(12);
    expect(writeRibbon(points, 0.5, positions, uvs, 2)).toBeCloseTo(7, 9);
    // First point, heading +x: left is +y, which is −Z.
    expect([...positions.slice(0, 6)]).toEqual([0, 0, -0.5, 0, 0, 0.5]);
    // Last point, heading +y: left is −x.
    expect([...positions.slice(12, 18)]).toEqual([2.5, 0, -4, 3.5, 0, -4]);
    expect([...uvs]).toEqual([0, 0, 0, 1, 1.5, 0, 1.5, 1, 3.5, 0, 3.5, 1]);
  });

  it('keeps a direction where the points coincide: a vehicle at rest gives no NaN', () => {
    const positions = new Float32Array(18);
    expect(writeRibbon(new Float64Array([5, 2, 5, 2, 5, 2]), 0.25, positions)).toBe(0);
    expect([...positions]).toEqual([5, 0, -2.25, 5, 0, -1.75, 5, 0, -2.25, 5, 0, -1.75, 5, 0, -2.25, 5, 0, -1.75]);
  });

  it('has the indices of two triangles for each step of the path', () => {
    expect(ribbonIndices(3)).toEqual([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4]);
    expect(ribbonIndices(1)).toEqual([]);
  });
});
