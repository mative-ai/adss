/**
 * Geometry helpers of the model builder (Phase 8): smooth curves through points, surfaces sampled on a
 * grid and split by material, patches lifted off a surface, mirror images and lines. The builder runs in Node when a
 * model is authored and writes the glTF files the app loads: nothing here reaches the bundle.
 *
 * Axes are the scene's (packages/app/src/ui/scene3d/geometry.ts): X forward, Y up, Z to the right. A model stands on
 * the ground at its origin and faces +X.
 */
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export type Point2 = readonly [number, number];
export type Point3 = [number, number, number];

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** A smooth curve through points of increasing x (Catmull-Rom tangents), constant beyond its two ends. */
export function curve(points: readonly Point2[]): (x: number) => number {
  const at = (i: number): Point2 => points[Math.min(Math.max(i, 0), points.length - 1)] as Point2;
  return (x) => {
    const last = points.length - 1;
    if (x <= at(0)[0]) return at(0)[1];
    if (x >= at(last)[0]) return at(last)[1];
    let i = 0;
    while (x > at(i + 1)[0]) i++;
    const [x1, y1] = at(i);
    const [x2, y2] = at(i + 1);
    const [x0, y0] = at(i - 1);
    const [x3, y3] = at(i + 2);
    const m1 = i === 0 ? (y2 - y1) / (x2 - x1) : (y2 - y0) / (x2 - x0);
    const m2 = i + 2 > last ? (y2 - y1) / (x2 - x1) : (y3 - y1) / (x3 - x1);
    const h = x2 - x1;
    const t = (x - x1) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y1 + (t3 - 2 * t2 + t) * h * m1 + (3 * t2 - 2 * t3) * y2 + (t3 - t2) * h * m2;
  };
}

/** `n` steps from `a` to `b` (n + 1 values), bunched toward `a` for a power above 1. */
export function steps(a: number, b: number, n: number, power = 1): number[] {
  return Array.from({ length: n + 1 }, (_, i) => lerp(a, b, (i / n) ** power));
}

/** A quadratic and a cubic Bézier in the plane, at `t`. */
export function quad(p0: Point2, c: Point2, p1: Point2, t: number): [number, number] {
  const s = 1 - t;
  return [s * s * p0[0] + 2 * s * t * c[0] + t * t * p1[0], s * s * p0[1] + 2 * s * t * c[1] + t * t * p1[1]];
}
export function cubic(p0: Point2, c1: Point2, c2: Point2, p1: Point2, t: number): [number, number] {
  const s = 1 - t;
  const a = s * s * s;
  const b = 3 * s * s * t;
  const c = 3 * s * t * t;
  const d = t * t * t;
  return [a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1]];
}

/** A surface: the point at (u, v). With u growing forward and v growing up a side, it faces +Z. */
export type Surface = (u: number, v: number) => Point3;

/** A surface sampled at `nu` × `nv` points, with a normal at each. */
export interface Grid {
  readonly nu: number;
  readonly nv: number;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
}

function quads(nu: number, nv: number, keep: (i: number, j: number) => boolean): number[] {
  const index: number[] = [];
  for (let i = 0; i + 1 < nu; i++) {
    for (let j = 0; j + 1 < nv; j++) {
      if (!keep(i, j)) continue;
      const a = i * nv + j;
      const b = (i + 1) * nv + j;
      index.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  return index;
}

/**
 * Samples a surface at every (u, v) of `us` × `vs`. The normals are those of the triangles around each point; on the
 * plane of symmetry (z = 0) they are kept in it, so that the mirrored half meets this one without a crease.
 */
export function sampleGrid(surface: Surface, us: readonly number[], vs: readonly number[]): Grid {
  const nu = us.length;
  const nv = vs.length;
  const positions = new Float32Array(3 * nu * nv);
  us.forEach((u, i) => vs.forEach((v, j) => positions.set(surface(u, v), 3 * (i * nv + j))));
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(quads(nu, nv, () => true));
  geometry.computeVertexNormals();
  const normals = new Float32Array(geometry.getAttribute('normal').array);
  geometry.dispose();
  // Where a part of the section has no size (the glass over the hood) its points coincide and their triangles have
  // no area: such a point takes the normal of the nearest point of its section that has one.
  const sized = (k: number) => Math.hypot(normals[3 * k] ?? 0, normals[3 * k + 1] ?? 0, normals[3 * k + 2] ?? 0) > 0.5;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const k = i * nv + j;
      if (sized(k)) continue;
      for (let d = 1; d < nv; d++) {
        const near = [j - d, j + d].find((n) => n >= 0 && n < nv && sized(i * nv + n));
        if (near === undefined) continue;
        normals.copyWithin(3 * k, 3 * (i * nv + near), 3 * (i * nv + near) + 3);
        break;
      }
    }
  }
  for (let k = 0; k < nu * nv; k++) {
    if (Math.abs(positions[3 * k + 2] ?? 0) > 1e-6) continue;
    const nx = normals[3 * k] ?? 0;
    const ny = normals[3 * k + 1] ?? 0;
    const length = Math.hypot(nx, ny);
    if (length < 1e-9) continue;
    normals[3 * k] = nx / length;
    normals[3 * k + 1] = ny / length;
    normals[3 * k + 2] = 0;
  }
  return { nu, nv, positions, normals };
}

/** The triangles of `index` as a geometry holding only the points they use. */
function compact(grid: Grid, index: number[]): BufferGeometry {
  const slot = new Map<number, number>();
  const positions: number[] = [];
  const normals: number[] = [];
  const out: number[] = [];
  for (const k of index) {
    let at = slot.get(k);
    if (at === undefined) {
      at = slot.size;
      slot.set(k, at);
      for (let c = 0; c < 3; c++) {
        positions.push(grid.positions[3 * k + c] ?? 0);
        normals.push(grid.normals[3 * k + c] ?? 0);
      }
    }
    out.push(at);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setIndex(out);
  return geometry;
}

/** A grid as one geometry. */
export const gridGeometry = (grid: Grid): BufferGeometry =>
  compact(
    grid,
    quads(grid.nu, grid.nv, () => true),
  );

/** A grid as one geometry for each material: `material(i, j)` names the quad from point (i, j) to (i + 1, j + 1). */
export function gridGeometries(grid: Grid, material: (i: number, j: number) => string): Map<string, BufferGeometry> {
  const names = new Set<string>();
  for (let i = 0; i + 1 < grid.nu; i++) for (let j = 0; j + 1 < grid.nv; j++) names.add(material(i, j));
  const out = new Map<string, BufferGeometry>();
  for (const name of names) {
    out.set(
      name,
      compact(
        grid,
        quads(grid.nu, grid.nv, (i, j) => material(i, j) === name),
      ),
    );
  }
  return out;
}

/** A grid moved `distance` m along its normals: a patch that sits just over the surface it was sampled from. */
export function lifted(grid: Grid, distance: number): Grid {
  const positions = grid.positions.map((p, k) => p + (grid.normals[k] ?? 0) * distance);
  return { ...grid, positions };
}

/** A three.js primitive ready to merge with the others: no texture coordinates, and indexed. */
export function plain(geometry: BufferGeometry): BufferGeometry {
  geometry.deleteAttribute('uv');
  return geometry.getIndex() ? geometry : mergeVertices(geometry);
}

/** Turns a geometry about X, then Y, then Z (rad) and moves it to (x, y, z). */
export function at(geometry: BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): BufferGeometry {
  if (rx !== 0) geometry.rotateX(rx);
  if (ry !== 0) geometry.rotateY(ry);
  if (rz !== 0) geometry.rotateZ(rz);
  return geometry.translate(x, y, z);
}

/**
 * The mirror image across the plane of symmetry (z to −z), still facing out: its triangles are turned the other way
 * around, which takes an index (a primitive that has none is given one first).
 */
export function mirrored(geometry: BufferGeometry): BufferGeometry {
  const copy = plain(geometry.clone()).scale(1, 1, -1);
  const index = copy.getIndex();
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      const b = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, b);
    }
  }
  return copy;
}

export function merged(geometries: BufferGeometry[]): BufferGeometry {
  const out = mergeGeometries(geometries.map(plain), false);
  if (!out) throw new Error('The geometries do not merge: their attributes differ.');
  return out;
}

/** A geometry with its mirror image. */
export const symmetric = (geometry: BufferGeometry): BufferGeometry => merged([geometry, mirrored(geometry)]);

/** Adds the segments of a path through `points` to `segments` (six values each). */
export function path(points: readonly Point3[], segments: number[]): void {
  for (let i = 0; i + 1 < points.length; i++) segments.push(...(points[i] as Point3), ...(points[i + 1] as Point3));
}

/** Line segments (six values each) as a geometry, with their mirror image when `both`. */
export function lineGeometry(segments: readonly number[], both = false): BufferGeometry {
  const all = [...segments];
  if (both)
    for (let i = 0; i < segments.length; i += 3)
      all.push(segments[i] ?? 0, segments[i + 1] ?? 0, -(segments[i + 2] ?? 0));
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(all, 3));
  return geometry;
}
