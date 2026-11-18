/**
 * A road wheel (Phase 8): the tire, a five-spoke rim, the brake disc behind it and a plate that closes
 * the view through. The car and the truck share it, each at its own radius and width.
 */
import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  LatheGeometry,
  LineSegments,
  TorusGeometry,
  Vector2,
  type BufferGeometry,
  type Material,
} from 'three';

import { mesh, OUTLINE } from './materials.ts';
import { at, lineGeometry, merged, path, type Point3 } from './shapes.ts';

/** The tire's section: radius (for a 0.33 m wheel) and position across the tread, from −1 to 1. */
const TIRE: readonly (readonly [number, number])[] = [
  [0.215, -0.84],
  [0.262, -1],
  [0.315, -0.93],
  [0.33, -0.66],
  [0.33, 0.66],
  [0.315, 0.93],
  [0.262, 1],
  [0.215, 0.84],
];

/** A wheel's parts by material, turning about Z, with the outer face toward +Z. */
export function wheelParts(radius: number, width: number): Map<string, BufferGeometry> {
  const k = radius / 0.33;
  const w = width / 2;
  const tire = new LatheGeometry(
    TIRE.map(([r, a]) => new Vector2(r * k, a * w)),
    32,
  ).rotateX(Math.PI / 2);

  const face = 0.72 * w;
  const rim: BufferGeometry[] = [];
  for (let s = 0; s < 5; s++) {
    const a = (s / 5) * 2 * Math.PI + Math.PI / 2;
    const spoke = new BoxGeometry(0.15 * k, 0.046 * k, 0.02);
    rim.push(at(spoke, 0.128 * k * Math.cos(a), 0.128 * k * Math.sin(a), face, 0, 0, a));
  }
  rim.push(at(new CylinderGeometry(0.055 * k, 0.064 * k, 0.035, 20), 0, 0, face + 0.006, Math.PI / 2));
  rim.push(at(new TorusGeometry(0.208 * k, 0.012 * k, 6, 32), 0, 0, face));

  const disc = at(new CylinderGeometry(0.165 * k, 0.165 * k, 0.02, 24), 0, 0, 0.3 * w, Math.PI / 2);
  const plate = at(new CylinderGeometry(0.214 * k, 0.214 * k, 0.02, 24), 0, 0, 0, Math.PI / 2);
  return new Map([
    ['rubber', merged([tire])],
    ['rim', merged(rim)],
    ['rim_dark', merged([disc])],
    ['trim', merged([plate])],
  ]);
}

/**
 * A wheel in its place: the node `name` (the app turns the front ones about Y with the steering), `name_spin` in it
 * (turned about Z as the wheel rolls) and the parts, which face outward on either side of the vehicle. `twin` m
 * inboard a second wheel stands beside the first: a truck's rear axle.
 */
export function wheelNode(
  name: string,
  position: Point3,
  parts: Map<string, BufferGeometry>,
  material: (name: string) => Material,
  radius: number,
  twin = 0,
): Group {
  const node = new Group();
  node.name = name;
  node.position.set(...position);
  const spin = new Group();
  spin.name = `${name}_spin`;
  node.add(spin);
  const side = new Group();
  side.name = `${name}_side`;
  if (position[2] < 0) side.rotation.y = Math.PI;
  spin.add(side);
  for (const offset of twin > 0 ? [0, -twin] : [0]) {
    for (const [key, geometry] of parts) {
      const part = mesh(`${name}_${key}`, geometry, material(key));
      part.position.z = offset;
      side.add(part);
    }
  }
  const circle: Point3[] = Array.from({ length: 25 }, (_, i) => {
    const a = (i / 24) * 2 * Math.PI;
    return [radius * Math.cos(a), radius * Math.sin(a), 0];
  });
  const segments: number[] = [];
  path(circle, segments);
  const outline = new LineSegments(lineGeometry(segments), material(OUTLINE));
  outline.name = `${name}_${OUTLINE}`;
  side.add(outline);
  return node;
}
