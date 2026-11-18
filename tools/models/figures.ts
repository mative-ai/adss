/**
 * The figures that cross the road (Phase 8): a person on foot, as a test mannequin, and a moose. Each
 * faces +X and stands on the ground. Their limbs are nodes that hang from the hip or the shoulder (`leg_*`, `arm_*`):
 * the app swings them about Z with the distance the figure has covered. Materials by name: materials.ts.
 */
import {
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Shape,
  SphereGeometry,
  Vector2,
  type BufferGeometry,
  type Material,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import { mesh, palette } from './materials.ts';
import { at, merged, mirrored, type Point3 } from './shapes.ts';

type Parts = Map<string, BufferGeometry[]>;

const adder = (parts: Parts) => (name: string, geometry: BufferGeometry) => {
  const list = parts.get(name) ?? [];
  list.push(geometry);
  parts.set(name, list);
};

/** A node named `name` at `pivot`, holding the parts as one mesh per material. */
function limb(name: string, pivot: Point3, parts: Parts, material: (name: string) => Material): Group {
  const node = new Group();
  node.name = name;
  node.position.set(...pivot);
  for (const [key, list] of parts) node.add(mesh(`${name}_${key}`, merged(list), material(key)));
  return node;
}

const ball = (radius: number, sx = 1, sy = 1, sz = 1) => new SphereGeometry(radius, 14, 10).scale(sx, sy, sz);

/** A person on foot, 1.77 m tall. Left is −Z. */
export function buildPedestrian(): Group {
  const material = palette();
  const root = new Group();
  root.name = 'pedestrian';

  const trunk: Parts = new Map();
  const add = adder(trunk);
  add('figure', at(ball(1, 0.13, 0.11, 0.17), 0, 0.96, 0));
  // The torso: a waist, a chest and the shoulders, less deep than it is wide.
  const torso = new LatheGeometry(
    [
      [0.125, 0],
      [0.14, 0.14],
      [0.168, 0.32],
      [0.15, 0.45],
      [0.06, 0.52],
    ].map(([r, y]) => new Vector2(r, y)),
    16,
  ).scale(0.7, 1, 1);
  add('figure', at(torso, 0, 1.0, 0));
  add('figure_joint', at(new CylinderGeometry(0.048, 0.055, 0.1, 12), 0, 1.56, 0));
  add('figure', at(ball(0.105, 0.95, 1.12, 0.9), 0, 1.65, 0));
  root.add(limb('trunk', [0, 0, 0], trunk, material));

  for (const [suffix, z] of [
    ['l', -1],
    ['r', 1],
  ] as const) {
    const leg: Parts = new Map();
    const toLeg = adder(leg);
    toLeg('figure', at(new CapsuleGeometry(0.075, 0.36, 4, 10), 0, -0.22, 0));
    toLeg('figure_joint', at(ball(0.064), 0, -0.46, 0));
    toLeg('figure', at(new CapsuleGeometry(0.056, 0.34, 4, 10), 0, -0.67, 0));
    toLeg('figure_joint', at(new RoundedBoxGeometry(0.26, 0.085, 0.1, 2, 0.03), 0.05, -0.885, 0));
    root.add(limb(`leg_${suffix}`, [0, 0.93, z * 0.095], leg, material));

    const arm: Parts = new Map();
    const toArm = adder(arm);
    toArm('figure_joint', at(ball(0.066), 0, 0, 0));
    toArm('figure', at(new CapsuleGeometry(0.045, 0.26, 4, 10), 0, -0.18, 0));
    toArm('figure_joint', at(ball(0.042), 0, -0.34, 0));
    toArm('figure', at(new CapsuleGeometry(0.039, 0.24, 4, 10), 0, -0.49, 0));
    toArm('figure_joint', at(ball(0.046, 0.8, 1.1, 0.6), 0, -0.67, 0));
    root.add(limb(`arm_${suffix}`, [0, 1.44, z * 0.215], arm, material));
  }
  return root;
}

/** One antler, on the right: a palm with its tines, thin, spreading out and up from the head. */
function antler(): BufferGeometry {
  // (fore and aft, outward) from the head.
  const edge: [number, number][] = [
    [-0.04, 0],
    [0.04, 0],
    [0.06, 0.2],
    [0.18, 0.28],
    [0.3, 0.22],
    [0.2, 0.36],
    [0.34, 0.42],
    [0.2, 0.5],
    [0.3, 0.62],
    [0.1, 0.6],
    [0.05, 0.72],
    [-0.06, 0.58],
    [-0.16, 0.6],
    [-0.1, 0.42],
    [-0.06, 0.2],
  ];
  const shape = new Shape();
  edge.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  shape.closePath();
  const palm = new ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: false });
  // Outward becomes +Z, the thickness is up and down, and the far end is lifted.
  palm.rotateX(Math.PI / 2).rotateX(-0.4);
  return palm;
}

/** A moose, 2.3 m from the tail to the nose and about 1.9 m at the shoulder. Left is −Z. */
export function buildMoose(): Group {
  const material = palette();
  const root = new Group();
  root.name = 'moose';
  // Lengths along the animal, from natural proportions to the 2.3 m of the obstacle.
  const k = 0.85;

  const trunk: Parts = new Map();
  const add = adder(trunk);
  add('fur', at(new CapsuleGeometry(0.36, 0.95 * k, 6, 16).scale(1, 1, 0.92), -0.15 * k, 1.42, 0, 0, 0, Math.PI / 2));
  add('fur', at(ball(0.34, 1.15 * k, 1, 0.82), 0.4 * k, 1.66, 0));
  add('fur', at(ball(0.33, 1.0 * k, 0.95, 0.92), -0.72 * k, 1.45, 0));
  add('fur', at(new CylinderGeometry(0.19, 0.26, 0.62 * k, 14), 0.84 * k, 1.53, 0, 0, 0, -Math.PI / 2 + 0.2));
  add('fur', at(new CapsuleGeometry(0.13, 0.36 * k, 5, 12), 1.2 * k, 1.42, 0, 0, 0, Math.PI / 2 - 0.25));
  add('fur', at(ball(0.14, 1.2 * k, 1, 0.95), 1.42 * k, 1.33, 0));
  add('fur', at(ball(0.06, 1, 1.8, 1), 1.1 * k, 1.19, 0));
  add('fur', at(ball(0.07), -1.06 * k, 1.5, 0));
  const ear = at(new ConeGeometry(0.05, 0.16, 8), 1.0 * k, 1.68, 0.13, 0.5);
  add('fur', ear);
  add('fur', mirrored(ear));
  const palm = at(antler(), 1.02 * k, 1.74, 0.1);
  add('antler', palm);
  add('antler', mirrored(palm));
  root.add(limb('trunk', [0, 0, 0], trunk, material));

  for (const [name, x, z] of [
    ['leg_fl', 0.42 * k, -0.2],
    ['leg_fr', 0.42 * k, 0.2],
    ['leg_rl', -0.64 * k, -0.2],
    ['leg_rr', -0.64 * k, 0.2],
  ] as const) {
    const leg: Parts = new Map();
    const toLeg = adder(leg);
    toLeg('fur', at(new CapsuleGeometry(0.085, 0.4, 4, 10), 0, -0.25, 0));
    toLeg('fur_light', at(ball(0.068), 0, -0.52, 0));
    toLeg('fur_light', at(new CapsuleGeometry(0.048, 0.5, 4, 10), 0, -0.83, 0));
    toLeg('hoof', at(new CylinderGeometry(0.058, 0.066, 0.1, 10), 0, -1.15, 0));
    root.add(limb(name, [x, 1.2, z], leg, material));
  }
  return root;
}
