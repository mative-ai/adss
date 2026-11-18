/**
 * What lies on the ground of the realistic scene (Phase 8): the flat meshes of geometry.ts made into
 * lit surfaces (a normal that points up, texture coordinates in meters), the kind of surface a friction coefficient
 * stands for, the coordinates of an icy zone's ragged edge, and the soft shadow under a vehicle.
 */
import { BufferAttribute, BufferGeometry, DataTexture, LinearFilter, RedFormat } from 'three';

import type { RoadGeometry } from '../../roadGeometry.ts';
import { stripMesh, stripSpans, type FlatMesh } from '../geometry.ts';

/** What a road surface looks like, by its friction coefficient: grip, a film of water, or ice. */
export type SurfaceKind = 'dry' | 'wet' | 'ice';

export function surfaceKind(mu: number): SurfaceKind {
  if (mu < 0.45) return 'ice';
  return mu < 0.85 ? 'wet' : 'dry';
}

/**
 * A flat mesh as a lit surface. Every triangle is turned to face up, whatever way around it was built, and a point at
 * (x, z) on the ground has the texture coordinates (x, z) / `tile`: a texture then repeats every `tile` m, and joins
 * across meshes. `local`, when given, is a second set of coordinates (two per vertex), for a texture laid once.
 */
export function groundGeometry(flat: FlatMesh, tile: number, local?: Float32Array): BufferGeometry {
  const count = flat.positions.length / 3;
  const normals = new Float32Array(3 * count);
  const uvs = new Float32Array(2 * count);
  for (let i = 0; i < count; i++) {
    normals[3 * i + 1] = 1;
    uvs[2 * i] = (flat.positions[3 * i] ?? 0) / tile;
    uvs[2 * i + 1] = (flat.positions[3 * i + 2] ?? 0) / tile;
  }
  const indices = [...flat.indices];
  const x = (i: number) => flat.positions[3 * i] ?? 0;
  const z = (i: number) => flat.positions[3 * i + 2] ?? 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] ?? 0;
    const b = indices[t + 1] ?? 0;
    const c = indices[t + 2] ?? 0;
    // The Y of (b − a) × (c − a): under 0 the triangle faces down.
    const up = (z(b) - z(a)) * (x(c) - x(a)) - (x(b) - x(a)) * (z(c) - z(a));
    if (up < 0) {
      indices[t + 1] = c;
      indices[t + 2] = b;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(flat.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  if (local) geometry.setAttribute('uv1', new BufferAttribute(local, 2));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * The strip of a zone from `s0` to `s1` and from `e0` to `e1`, with each vertex's place in the zone: 0 to 1 along it
 * and 0 to 1 across it, for the mask of its edge.
 */
export function zoneMesh(
  road: RoadGeometry,
  s0: number,
  s1: number,
  e0: number,
  e1: number,
): { flat: FlatMesh; local: Float32Array } {
  const flat = stripMesh(road, s0, s1, e0, e1);
  const spans = stripSpans(road, s0, s1);
  const first = spans[0]?.[0] ?? s0;
  const last = spans.at(-1)?.[1] ?? s1;
  const local = new Float32Array(8 * spans.length);
  spans.forEach(([from, to], q) => {
    const u0 = (from - first) / (last - first);
    const u1 = (to - first) / (last - first);
    local.set([u0, 0, u0, 1, u1, 1, u1, 0], 8 * q);
  });
  return { flat, local };
}

/** A road's line carried straight on past its two ends: the scene does not stop where the run's road does. */
export class LongRoad {
  private readonly road: RoadGeometry;
  /** Where the long line starts and ends, m along the road (the road's own start is 0). */
  readonly from: number;
  readonly to: number;

  constructor(road: RoadGeometry, before: number, after: number) {
    this.road = road;
    this.from = -before;
    this.to = road.length + after;
  }

  private inside(s: number): number {
    return Math.min(Math.max(s, 0), this.road.length);
  }

  headingAt(s: number): number {
    return this.road.headingAt(this.inside(s));
  }

  /** The world point at `s` and `ey`, on the road or on the straight line that carries it on. */
  pointAt(s: number, ey: number, out: { x: number; y: number }): void {
    const inside = this.inside(s);
    this.road.pointAt(inside, ey, out);
    const heading = this.road.headingAt(inside);
    out.x += Math.cos(heading) * (s - inside);
    out.y += Math.sin(heading) * (s - inside);
  }
}

const P = { x: 0, y: 0 };

function quads(road: LongRoad, pieces: readonly (readonly [number, number])[], e0: number, e1: number): FlatMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [s0, s1] of pieces) {
    const i = positions.length / 3;
    for (const [s, e] of [
      [s0, e0],
      [s0, e1],
      [s1, e1],
      [s1, e0],
    ] as const) {
      road.pointAt(s, e, P);
      positions.push(P.x, 0, -P.y);
    }
    indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }
  return { positions: new Float32Array(positions), indices };
}

/** A straight piece of the long road from `s0` to `s1` and from `e0` to `e1`: one quad, for past the road's ends. */
export const straightStrip = (road: LongRoad, s0: number, s1: number, e0: number, e1: number): FlatMesh =>
  quads(road, [[s0, s1]], e0, e1);

/**
 * The dashes of a line at `ey` on a straight piece from `s0` to `s1`. A dash starts at every multiple of
 * `dash + gap` along the road, so the pieces of one line join whatever their ends.
 */
export function straightDashes(
  road: LongRoad,
  s0: number,
  s1: number,
  ey: number,
  dash: number,
  gap: number,
  width: number,
): FlatMesh {
  const pieces: [number, number][] = [];
  for (let k = Math.floor(s0 / (dash + gap)); k * (dash + gap) < s1; k++) {
    const from = Math.max(s0, k * (dash + gap));
    const to = Math.min(s1, k * (dash + gap) + dash);
    if (to > from) pieces.push([from, to]);
  }
  return quads(road, pieces, ey - width / 2, ey + width / 2);
}

/** A round, soft shadow: 1 at its middle, fading to nothing at its rim. For a material's `alphaMap`. */
export function softShadow(): DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const r = Math.min(1, Math.hypot((i + 0.5) / size - 0.5, (j + 0.5) / size - 0.5) * 2);
      data[j * size + i] = Math.round(255 * (1 - r * r) ** 2);
    }
  }
  const texture = new DataTexture(data, size, size, RedFormat);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
