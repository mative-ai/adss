/**
 * What stands beside the road in the realistic scene (Phase 8): conifers set back from it and the
 * marker posts along its edges. They give the eye depth and speed; the run knows nothing of them. Where they stand
 * comes from a hash of their number, never from chance: a road looks the same every time it is drawn.
 */
import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  InstancedMesh,
  Object3D,
  PlaneGeometry,
  type BufferGeometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { Resources } from '../models.ts';
import type { LongRoad } from './ground.ts';

/** Meters of road for each tree of a row, from the road's edge to the nearest tree, and between the two rows. */
const TREE_EVERY = 7;
const TREE_NEAR = 9;
const ROW_STEP = 11;
const ROW_DEPTH = 12;
/** Meters between two posts, and from the road's edge to them. */
const POST_EVERY = 20;
const POST_OFFSET = 0.8;

/** A number from 0 to 1 for the pair (i, salt), the same every time. */
export function unit(i: number, salt: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

export interface Placement {
  /** Along the road and to the left of its line, m. */
  s: number;
  ey: number;
  /** The tree's size over the model's, its turn about the vertical, rad, and its tone, 0 to 1. */
  scale: number;
  turn: number;
  tone: number;
}

/**
 * The trees along a road from `from` to `to` m, with its edges `left` and `right` m from its line: two rows on each
 * side.
 */
export function scatterTrees(from: number, to: number, left: number, right: number): Placement[] {
  const out: Placement[] = [];
  const count = Math.floor((to - from) / TREE_EVERY);
  for (let i = 0; i < count; i++) {
    for (const side of [1, -1]) {
      for (let row = 0; row < 2; row++) {
        const k = 4 * i + (side > 0 ? 0 : 2) + row;
        const away = TREE_NEAR + row * ROW_STEP + unit(k, 2) * ROW_DEPTH;
        out.push({
          s: from + (i + unit(k, 1)) * TREE_EVERY,
          ey: side > 0 ? left + away : -right - away,
          scale: 0.75 + 0.75 * unit(k, 3),
          turn: 2 * Math.PI * unit(k, 4),
          tone: unit(k, 5),
        });
      }
    }
  }
  return out;
}

/** A conifer about 9 m tall: the trunk, and four tiers of branches as one geometry. */
function conifer(): { trunk: BufferGeometry; foliage: BufferGeometry } {
  const tiers: [number, number, number][] = [
    [2.1, 3.3, 3.0],
    [1.65, 3.0, 4.9],
    [1.2, 2.7, 6.6],
    [0.75, 2.4, 8.1],
  ];
  const foliage = mergeGeometries(
    tiers.map(([radius, height, y]) => new ConeGeometry(radius, height, 9).translate(0, y, 0)),
  );
  return { trunk: new CylinderGeometry(0.1, 0.19, 2.4, 6).translate(0, 1.2, 0), foliage };
}

/** The trees of the road: two instanced meshes, the trunks and the branches; only the branches cast a shadow. */
export function trees(
  resources: Resources,
  road: LongRoad,
  left: number,
  right: number,
  trunkMaterial: Material,
  foliageMaterial: Material,
): Object3D[] {
  const placements = scatterTrees(road.from, road.to, left, right);
  const { trunk, foliage } = conifer();
  const trunks = resources.track(new InstancedMesh(resources.track(trunk), trunkMaterial, placements.length));
  const crowns = resources.track(new InstancedMesh(resources.track(foliage), foliageMaterial, placements.length));
  crowns.castShadow = true;
  const place = new Object3D();
  const at = { x: 0, y: 0 };
  const dark = new Color(0x55705a);
  const light = new Color(0xb9d0a8);
  const tone = new Color();
  placements.forEach((tree, i) => {
    road.pointAt(tree.s, tree.ey, at);
    place.position.set(at.x, 0, -at.y);
    place.rotation.y = tree.turn;
    place.scale.setScalar(tree.scale);
    place.updateMatrix();
    trunks.setMatrixAt(i, place.matrix);
    crowns.setMatrixAt(i, place.matrix);
    // The tone multiplies the branches' color: no two trees are quite the same green.
    crowns.setColorAt(i, tone.copy(dark).lerp(light, tree.tone));
  });
  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
  return [trunks, crowns];
}

/** The marker posts along the two edges, each with a reflector that faces the traffic coming up the road. */
export function posts(
  resources: Resources,
  road: LongRoad,
  left: number,
  right: number,
  postMaterial: Material,
  reflectorMaterial: Material,
): Object3D[] {
  const first = Math.ceil(road.from / POST_EVERY);
  const count = Math.floor(road.to / POST_EVERY) - first + 1;
  const body = resources.track(new BoxGeometry(0.035, 1.0, 0.09).translate(0, 0.5, 0));
  const face = resources.track(new PlaneGeometry(0.07, 0.14).rotateY(-Math.PI / 2).translate(-0.02, 0.82, 0));
  const bodies = resources.track(new InstancedMesh(body, postMaterial, 2 * count));
  const reflectors = resources.track(new InstancedMesh(face, reflectorMaterial, 2 * count));
  bodies.castShadow = true;
  const place = new Object3D();
  const at = { x: 0, y: 0 };
  for (let i = 0; i < count; i++) {
    [left + POST_OFFSET, -right - POST_OFFSET].forEach((ey, k) => {
      const s = (first + i) * POST_EVERY;
      road.pointAt(s, ey, at);
      place.position.set(at.x, 0, -at.y);
      place.rotation.y = road.headingAt(s);
      place.updateMatrix();
      bodies.setMatrixAt(2 * i + k, place.matrix);
      reflectors.setMatrixAt(2 * i + k, place.matrix);
    });
  }
  bodies.instanceMatrix.needsUpdate = true;
  reflectors.instanceMatrix.needsUpdate = true;
  return [bodies, reflectors];
}
