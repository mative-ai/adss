/**
 * The flat geometry of the 3D scene (Phase 4), as plain arrays so that it is tested without a GPU: the
 * strips of road and of its surfaces, the lane lines, the hatch of a slippery zone, the rings under the obstacles and the
 * ribbons of the plans. Everything lies on the ground.
 *
 * Axes: the simulation's x, y (y to the left of x) and up are three's X, −Z and Y. A heading ψ is then a rotation of ψ
 * about Y, and a point (x, y) on the ground is (x, 0, −y).
 */
import { ROAD_SAMPLE_STEP } from '@mpc-simulator/worker';

import type { RoadGeometry } from '../roadGeometry.ts';

/** Triangles on the ground: three coordinates per vertex, three vertices per triangle by index. */
export interface FlatMesh {
  readonly positions: Float32Array;
  readonly indices: number[];
}

class Builder {
  private readonly positions: number[] = [];
  private readonly indices: number[] = [];

  /** A quad through four points of the ground (simulation x, y), in order around its edge. */
  quad(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): void {
    const i = this.positions.length / 3;
    this.positions.push(ax, 0, -ay, bx, 0, -by, cx, 0, -cy, dx, 0, -dy);
    this.indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }

  build(): FlatMesh {
    return { positions: new Float32Array(this.positions), indices: this.indices };
  }
}

const A = { x: 0, y: 0 };
const B = { x: 0, y: 0 };
const C = { x: 0, y: 0 };
const D = { x: 0, y: 0 };

/** A quad of the road between two distances along it and two offsets from its line. */
function roadQuad(builder: Builder, road: RoadGeometry, sa: number, sb: number, e0: number, e1: number): void {
  road.pointAt(sa, e0, A);
  road.pointAt(sa, e1, B);
  road.pointAt(sb, e1, C);
  road.pointAt(sb, e0, D);
  builder.quad(A.x, A.y, B.x, B.y, C.x, C.y, D.x, D.y);
}

/** The pieces a strip of road from `s0` to `s1` is cut in, one per sample of the road: [from, to] along it, m. */
export function stripSpans(road: RoadGeometry, s0: number, s1: number): [number, number][] {
  const spans: [number, number][] = [];
  const to = Math.min(road.length, s1);
  let s = Math.max(0, s0);
  while (s < to) {
    const next = Math.min(to, (Math.floor(s / ROAD_SAMPLE_STEP + 1e-9) + 1) * ROAD_SAMPLE_STEP);
    spans.push([s, next]);
    s = next;
  }
  return spans;
}

/**
 * The strip of road from `s0` to `s1` and from `e0` to `e1` (e_y, left positive): a quad for each of its spans, with
 * its corners at (from, e0), (from, e1), (to, e1) and (to, e0), in that order.
 */
export function stripMesh(road: RoadGeometry, s0: number, s1: number, e0: number, e1: number): FlatMesh {
  const builder = new Builder();
  for (const [from, to] of stripSpans(road, s0, s1)) roadQuad(builder, road, from, to, e0, e1);
  return builder.build();
}

/** A dashed line along the road at `ey`: dashes of `dash` m every `dash + gap`, `width` m wide. */
export function dashMesh(
  road: RoadGeometry,
  s0: number,
  s1: number,
  ey: number,
  dash: number,
  gap: number,
  width: number,
): FlatMesh {
  const builder = new Builder();
  const to = Math.min(road.length, s1);
  for (let s = Math.max(0, s0); s < to; s += dash + gap) {
    roadQuad(builder, road, s, Math.min(to, s + dash), ey - width / 2, ey + width / 2);
  }
  return builder.build();
}

/**
 * The hatch of a zone from `s0` to `s1` and from `e0` to `e1`: stripes at 45° (one every `spacing` m along the road,
 * `width` m thick), cut at the zone's two ends as the top view's are.
 */
export function hatchMesh(
  road: RoadGeometry,
  s0: number,
  s1: number,
  e0: number,
  e1: number,
  spacing: number,
  width: number,
): FlatMesh {
  const builder = new Builder();
  const slant = e1 - e0;
  if (!(slant > 0) || !(spacing > 0)) return builder.build();
  const clamp = (s: number) => Math.min(s1, Math.max(s0, s));
  for (let start = s0 - slant; start < s1; start += spacing) {
    // The stripe runs from (start, e0) to (start + slant, e1): keep the part of it inside the zone.
    const t0 = Math.max(0, (s0 - start) / slant);
    const t1 = Math.min(1, (s1 - start) / slant);
    if (t1 - t0 < 1e-6) continue;
    const sa = start + slant * t0;
    const sb = start + slant * t1;
    const ea = e0 + slant * t0;
    const eb = e0 + slant * t1;
    road.pointAt(clamp(sa - width / 2), ea, A);
    road.pointAt(clamp(sa + width / 2), ea, B);
    road.pointAt(clamp(sb + width / 2), eb, C);
    road.pointAt(clamp(sb - width / 2), eb, D);
    builder.quad(A.x, A.y, B.x, B.y, C.x, C.y, D.x, D.y);
  }
  return builder.build();
}

/**
 * A ring on the ground around the origin, from `inner` to `outer` m, in `segments` pieces. With `dashes` it is broken
 * into that many dashes, each as long as the gap after it; 0 gives the whole ring.
 */
export function ringMesh(inner: number, outer: number, segments: number, dashes = 0): FlatMesh {
  const builder = new Builder();
  for (let i = 0; i < segments; i++) {
    if (dashes > 0 && Math.floor((i * 2 * dashes) / segments) % 2 === 1) continue;
    const a = (i / segments) * 2 * Math.PI;
    const b = ((i + 1) / segments) * 2 * Math.PI;
    builder.quad(
      inner * Math.cos(a),
      inner * Math.sin(a),
      outer * Math.cos(a),
      outer * Math.sin(a),
      outer * Math.cos(b),
      outer * Math.sin(b),
      inner * Math.cos(b),
      inner * Math.sin(b),
    );
  }
  return builder.build();
}

/** The indices of a ribbon of `points` points: two vertices per point (left, right), two triangles per step. */
export function ribbonIndices(points: number): number[] {
  const indices: number[] = [];
  for (let k = 0; k + 1 < points; k++) {
    const i = 2 * k;
    indices.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
  }
  return indices;
}

/**
 * Writes a ribbon along a plan's points (x, y pairs in world coordinates): for each point its left and its right
 * vertex, `halfWidth` m from it across the direction of the path, into `positions` (three values per vertex) and, when
 * given, the distance along the path over `period` into `uvs` (two values per vertex), so that a repeating texture
 * dashes the ribbon evenly whatever the spacing of the points. Returns the path's length, m.
 */
export function writeRibbon(
  points: Float64Array,
  halfWidth: number,
  positions: Float32Array,
  uvs?: Float32Array,
  period = 1,
): number {
  const count = points.length / 2;
  let length = 0;
  // The direction where the points coincide (a vehicle at rest) is the last one that was defined, or +x.
  let tx = 1;
  let ty = 0;
  for (let k = 0; k < count; k++) {
    const x = points[2 * k] ?? 0;
    const y = points[2 * k + 1] ?? 0;
    const before = Math.max(k - 1, 0);
    const after = Math.min(k + 1, count - 1);
    const dx = (points[2 * after] ?? 0) - (points[2 * before] ?? 0);
    const dy = (points[2 * after + 1] ?? 0) - (points[2 * before + 1] ?? 0);
    const norm = Math.hypot(dx, dy);
    if (norm > 1e-6) {
      tx = dx / norm;
      ty = dy / norm;
    }
    if (k > 0) length += Math.hypot(x - (points[2 * k - 2] ?? 0), y - (points[2 * k - 1] ?? 0));
    // Left of the direction (tx, ty) is (−ty, tx). Written value by value: this runs for every plan of every frame.
    const p = 6 * k;
    positions[p] = x - ty * halfWidth;
    positions[p + 1] = 0;
    positions[p + 2] = -(y + tx * halfWidth);
    positions[p + 3] = x + ty * halfWidth;
    positions[p + 4] = 0;
    positions[p + 5] = -(y - tx * halfWidth);
    if (uvs) {
      const u = 4 * k;
      uvs[u] = length / period;
      uvs[u + 1] = 0;
      uvs[u + 2] = length / period;
      uvs[u + 3] = 1;
    }
  }
  return length;
}
