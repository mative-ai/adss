/**
 * The ground of the realistic scene (ground.ts): a friction coefficient names a kind of surface, a flat mesh becomes a
 * lit one that faces up whatever way around it was built, a zone knows where each of its points is in it, and the road
 * goes straight on past its ends with lines that join.
 */
import { describe, expect, it } from 'vitest';

import { ROAD_SAMPLE } from '@mpc-simulator/worker';

import { RoadGeometry } from '../../roadGeometry.ts';
import { dashMesh, ringMesh, stripMesh, type FlatMesh } from '../geometry.ts';
import {
  groundGeometry,
  LongRoad,
  softShadow,
  straightDashes,
  straightStrip,
  surfaceKind,
  zoneMesh,
} from './ground.ts';

/** A straight road of `length` m along +x. */
function straight(length: number): RoadGeometry {
  const road = new Float64Array((length + 1) * ROAD_SAMPLE);
  for (let i = 0; i <= length; i++) road.set([i, i, 0, 0, 0], i * ROAD_SAMPLE);
  return new RoadGeometry({ road });
}

/** A quarter of a circle of radius 50 m to the left, 78 m long. */
function curve(): RoadGeometry {
  const length = 78;
  const road = new Float64Array((length + 1) * ROAD_SAMPLE);
  for (let i = 0; i <= length; i++) {
    const heading = i / 50;
    road.set([i, 50 * Math.sin(heading), 50 * (1 - Math.cos(heading)), heading, 1 / 50], i * ROAD_SAMPLE);
  }
  return new RoadGeometry({ road });
}

/** The extent of a mesh along the road's x, in the simulation's axes. */
const along = (mesh: FlatMesh) => {
  const xs = Array.from({ length: mesh.positions.length / 3 }, (_, i) => mesh.positions[3 * i] ?? 0);
  return [Math.min(...xs), Math.max(...xs)];
};

describe('surfaceKind', () => {
  it('reads grip, a film of water or ice from the friction coefficient', () => {
    expect(surfaceKind(1)).toBe('dry');
    expect(surfaceKind(0.85)).toBe('dry');
    expect(surfaceKind(0.6)).toBe('wet');
    expect(surfaceKind(0.45)).toBe('wet');
    expect(surfaceKind(0.3)).toBe('ice');
    expect(surfaceKind(0.1)).toBe('ice');
  });
});

describe('groundGeometry', () => {
  /** The Y of each triangle's normal: above 0 it faces up. */
  const facing = (flat: FlatMesh, tile = 1): number[] => {
    const geometry = groundGeometry(flat, tile);
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    if (!index) throw new Error('The ground has an index.');
    const out: number[] = [];
    for (let t = 0; t < index.count; t += 3) {
      const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
      const ux = position.getX(b) - position.getX(a);
      const uz = position.getZ(b) - position.getZ(a);
      const vx = position.getX(c) - position.getX(a);
      const vz = position.getZ(c) - position.getZ(a);
      out.push(uz * vx - ux * vz);
    }
    return out;
  };

  it('turns every triangle to face up, whichever way around the mesh was built', () => {
    // A strip of road and a ring are built the two ways around.
    for (const flat of [
      stripMesh(straight(20), 0, 20, -3.5, 3.5),
      ringMesh(1, 2, 12),
      stripMesh(curve(), 0, 78, -3, 3),
    ]) {
      const ups = facing(flat);
      expect(ups.length).toBe(flat.indices.length / 3);
      expect(ups.every((up) => up > 0)).toBe(true);
    }
  });

  it('gives a normal that points up and texture coordinates in tiles of the ground', () => {
    const geometry = groundGeometry(stripMesh(straight(12), 0, 12, -3, 3), 3);
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      expect([normal.getX(i), normal.getY(i), normal.getZ(i)]).toEqual([0, 1, 0]);
      expect(uv.getX(i)).toBeCloseTo(position.getX(i) / 3, 6);
      expect(uv.getY(i)).toBeCloseTo(position.getZ(i) / 3, 6);
    }
    expect(geometry.getAttribute('uv1')).toBeUndefined();
  });
});

describe('zoneMesh', () => {
  it('knows where each point of the zone is in it: 0 to 1 along and across', () => {
    const { flat, local } = zoneMesh(curve(), 10.5, 40, 0, 3.5);
    expect(local).toHaveLength((flat.positions.length / 3) * 2);
    const us = Array.from({ length: local.length / 2 }, (_, i) => local[2 * i] ?? -1);
    const vs = Array.from({ length: local.length / 2 }, (_, i) => local[2 * i + 1] ?? -1);
    expect(Math.min(...us)).toBe(0);
    expect(Math.max(...us)).toBe(1);
    expect(new Set(vs)).toEqual(new Set([0, 1]));
    // The first quad starts at the zone's start, at its right edge and at its left one.
    expect([...local.subarray(0, 4)]).toEqual([0, 0, 0, 1]);
    // With these coordinates the mesh carries them as a second set, for the mask of the zone's edge.
    expect(groundGeometry(flat, 4, local).getAttribute('uv1').count).toBe(flat.positions.length / 3);
  });
});

describe('LongRoad', () => {
  it('is the road between its ends, and a straight line past them', () => {
    const long = new LongRoad(curve(), 80, 300);
    expect([long.from, long.to]).toEqual([-80, 378]);
    const at = { x: 0, y: 0 };
    const inside = { x: 0, y: 0 };
    long.pointAt(30, 2, at);
    curve().pointAt(30, 2, inside);
    expect(at).toEqual(inside);
    // Before the start the road heads along +x: 80 m back, still 2 m to the left.
    long.pointAt(-80, 2, at);
    expect(at.x).toBeCloseTo(-80, 9);
    expect(at.y).toBeCloseTo(2, 9);
    expect(long.headingAt(-80)).toBe(0);
    // Past the end it keeps the heading it ends with.
    const end = { x: 0, y: 0 };
    long.pointAt(78, 0, end);
    long.pointAt(178, 0, at);
    const heading = long.headingAt(500);
    expect(heading).toBeCloseTo(78 / 50, 9);
    expect(at.x - end.x).toBeCloseTo(100 * Math.cos(heading), 6);
    expect(at.y - end.y).toBeCloseTo(100 * Math.sin(heading), 6);
  });

  it('carries the road and its dashed line on, so that they join the road at its ends', () => {
    const road = straight(40);
    const long = new LongRoad(road, 82.5, 300);
    expect(along(straightStrip(long, long.from, 0, -3.5, 3.5))).toEqual([-82.5, 0]);
    expect(along(straightStrip(long, 40, long.to, -3.5, 3.5))).toEqual([40, 340]);

    // A dash every 7.5 m: on the road the sixth starts at 37.5 m and is cut at the end, 40 m...
    const [, onRoad] = along(dashMesh(road, 0, 40, 0, 3, 4.5, 0.14));
    expect(onRoad).toBe(40);
    // ...and past the end the same dash goes on to 40.5 m, then the next starts at 45 m.
    const after = straightDashes(long, 40, long.to, 0, 3, 4.5, 0.14);
    const starts = Array.from({ length: after.positions.length / 12 }, (_, q) => after.positions[12 * q] ?? 0);
    expect(starts.slice(0, 3)).toEqual([40, 45, 52.5]);
    expect(after.positions[6]).toBe(40.5);
    // Before the start the dashes are on the same multiples of 7.5 m, and none crosses the start.
    const before = straightDashes(long, long.from, 0, 0, 3, 4.5, 0.14);
    expect(along(before)).toEqual([-82.5, -4.5]);
  });
});

describe('softShadow', () => {
  it('is dark at its middle and gone at its rim', () => {
    const texture = softShadow();
    const { data, width } = texture.image as { data: Uint8Array; width: number };
    const at = (i: number, j: number) => data[j * width + i] ?? -1;
    expect(at(width / 2, width / 2)).toBeGreaterThan(245);
    expect(at(0, 0)).toBe(0);
    expect(at(0, width / 2)).toBeLessThan(2);
    expect(at(width / 4, width / 2)).toBeGreaterThan(at(width / 8, width / 2));
  });
});
