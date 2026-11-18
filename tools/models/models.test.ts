/**
 * The models of the realistic scene (Phase 8): what the app relies on in each (the nodes it moves, the
 * materials it replaces by name, the size it scales from), and that the files in the repository are the ones the
 * builder makes today.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Box3, type Group, type Mesh, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { CAR, CAR_PARTS, MOOSE, PEDESTRIAN, TRUCK } from '../../packages/app/src/ui/scene3d/real/nominal.ts';
import { glbJson, MODELS, MODELS_DIR, toGlb, type ModelName } from './glb.ts';
import { OUTLINE } from './materials.ts';
import { wordmark, WORDMARK_ASPECT, wordmarkShapes } from './wordmark.ts';

const names = Object.keys(MODELS) as ModelName[];

/** The materials of a car of no owner, and the ones the sensor kit and the lettering add to it. */
const BODY = ['glass', 'interior', 'lamp_front', 'lamp_rear', OUTLINE, 'paint', 'paint_dark', 'trim'];
const PLAIN = [...BODY, 'rim', 'rim_dark', 'rubber'];
const KIT = ['sensor_glass', 'sensor_light', 'sensor_shell'];
const LIVERY = ['livery', 'livery_light'];

function materialsOf(model: Object3D): Set<string> {
  const out = new Set<string>();
  model.traverse((object) => {
    const material = (object as Mesh).material;
    if (material && !Array.isArray(material)) out.add(material.name);
  });
  return out;
}

function triangles(model: Object3D): number {
  let count = 0;
  model.traverse((object) => {
    const mesh = object as Mesh;
    if (mesh.isMesh) count += (mesh.geometry.getIndex()?.count ?? 0) / 3;
  });
  return count;
}

const size = (model: Group) => {
  model.updateMatrixWorld(true);
  const box = new Box3().setFromObject(model);
  return { box, x: box.max.x - box.min.x, y: box.max.y - box.min.y, z: box.max.z - box.min.z };
};

describe('the vehicles', () => {
  // The car's height is that of the dome of its lidar, which stands 0.35 m over the roof.
  it.each([
    ['car', CAR, 1.75, 2.0],
    ['truck', TRUCK, 3.4, 3.9],
  ] as const)('the %s has the nodes the app moves and stands on its wheels', (name, nominal, low, high) => {
    const model = MODELS[name]();
    for (const node of ['body', 'wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr']) {
      expect(model.getObjectByName(node), node).toBeDefined();
      if (node !== 'body') expect(model.getObjectByName(`${node}_spin`), `${node}_spin`).toBeDefined();
    }
    // The left wheels are at −Z, the front ones ahead, each at the wheel's radius over the ground.
    const front = model.getObjectByName('wheel_fl') as Object3D;
    const rear = model.getObjectByName('wheel_rr') as Object3D;
    expect(front.position.toArray()).toEqual([nominal.axle, nominal.wheelRadius, -nominal.track / 2]);
    expect(rear.position.toArray()).toEqual([-nominal.axle, nominal.wheelRadius, nominal.track / 2]);

    const { box, x, y, z } = size(model);
    expect(box.min.y).toBeCloseTo(0, 2);
    expect(y).toBeGreaterThan(low);
    expect(y).toBeLessThan(high);
    // The footprint is the vehicle's, give or take the bulge of its ends, its mirrors and the car's sensors.
    expect(x).toBeGreaterThan(nominal.length - 0.05);
    expect(x).toBeLessThan(nominal.length + 0.15);
    expect(z).toBeGreaterThan(nominal.width - 0.05);
    expect(z).toBeLessThan(nominal.width + 0.45);
  });

  it('the car is one surface in few materials, light enough to draw four of', () => {
    const car = MODELS.car();
    expect([...materialsOf(car)].sort()).toEqual([...PLAIN, ...KIT, ...LIVERY].sort());
    expect(triangles(car)).toBeLessThan(30_000);
    // One mesh per material in the body and the lines of the ghost, then the lettering and the sensor kit.
    const body = car.getObjectByName('body') as Object3D;
    expect(body.children.map((child) => child.name).sort()).toEqual(
      [...BODY.map((name) => `body_${name}`), CAR_PARTS.livery, CAR_PARTS.sensors].sort(),
    );
  });

  it('the car is the same on its two sides', () => {
    const { box } = size(MODELS.car());
    expect(box.min.z).toBeCloseTo(-box.max.z, 5);
  });

  it('the sensor kit and the lettering come off whole, and leave a car of no owner', () => {
    const car = MODELS.car();
    const kit = car.getObjectByName(CAR_PARTS.sensors) as Object3D;
    const livery = car.getObjectByName(CAR_PARTS.livery) as Object3D;
    expect([...materialsOf(kit)].sort()).toEqual([...KIT, OUTLINE].sort());
    expect([...materialsOf(livery)].sort()).toEqual(LIVERY);
    kit.removeFromParent();
    livery.removeFromParent();
    expect([...materialsOf(car)].sort()).toEqual([...PLAIN].sort());
    // Without the dome of the lidar the car is as tall as its roof.
    const { y } = size(car);
    expect(y).toBeGreaterThan(1.3);
    expect(y).toBeLessThan(1.6);
  });

  it('the sensors stand out of the body no further than its mirrors', () => {
    const car = MODELS.car();
    const kit = new Box3().setFromObject(car.getObjectByName(CAR_PARTS.sensors) as Object3D);
    const whole = size(car).box;
    expect(kit.max.z).toBeLessThan(whole.max.z);
    expect(kit.max.z).toBeLessThan(CAR.width / 2 + 0.1);
    // The lidar on the nose and the one on the tail are the car's two ends, a hand's width past the bumpers at most.
    expect(kit.max.x).toBeLessThan(CAR.length / 2 + 0.08);
    expect(kit.min.x).toBeGreaterThan(-CAR.length / 2 - 0.08);
  });
});

describe("Mative's wordmark", () => {
  it('is seven shapes, with the counters of the a and of the e', () => {
    const shapes = wordmarkShapes();
    expect(shapes).toHaveLength(7);
    expect(shapes.map((shape) => shape.holes.length).sort()).toEqual([0, 0, 0, 0, 0, 1, 1]);
  });

  it('keeps its proportions and faces its reader', () => {
    const flat = wordmark(2, (along, up) => [along, up, 0]);
    flat.computeBoundingBox();
    const box = flat.boundingBox as Box3;
    expect(box.max.x - box.min.x).toBeCloseTo(2, 3);
    // The letters fill the height of the logo's box, less the hair they leave under the baseline.
    expect(box.max.y - box.min.y).toBeLessThanOrEqual(2 * WORDMARK_ASPECT);
    expect(box.max.y - box.min.y).toBeGreaterThan(0.98 * 2 * WORDMARK_ASPECT);
    // Every triangle that has a size turns counterclockwise for a reader at +Z.
    const position = flat.getAttribute('position');
    const index = flat.getIndex();
    if (!index) throw new Error('The wordmark has no index.');
    for (let i = 0; i < index.count; i += 3) {
      const [a, b, c] = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      const twice =
        (position.getX(b) - position.getX(a)) * (position.getY(c) - position.getY(a)) -
        (position.getX(c) - position.getX(a)) * (position.getY(b) - position.getY(a));
      expect(twice).toBeGreaterThan(-1e-9);
    }
  });

  it('reads from left to right on either side of the car, never mirrored', () => {
    const car = MODELS.car();
    car.updateMatrixWorld(true);
    const dark = car.getObjectByName(`${CAR_PARTS.livery}_dark`) as Mesh;
    const position = dark.geometry.getAttribute('position');
    // The dot of the i is the highest point of a door's mark, past the middle of the word: ahead of it on the right
    // door, where the word runs toward the nose, and behind it on the left one.
    const top = { right: { x: 0, y: -Infinity }, left: { x: 0, y: -Infinity } };
    const span = { min: Infinity, max: -Infinity };
    for (let i = 0; i < position.count; i++) {
      const z = position.getZ(i);
      // The marks on the doors: the one on the hood is nearer the middle.
      if (Math.abs(z) < CAR.width / 2 - 0.1) continue;
      const side = z > 0 ? top.right : top.left;
      if (position.getY(i) > side.y) Object.assign(side, { x: position.getX(i), y: position.getY(i) });
      span.min = Math.min(span.min, position.getX(i));
      span.max = Math.max(span.max, position.getX(i));
    }
    const middle = (span.min + span.max) / 2;
    expect(top.right.x).toBeGreaterThan(middle + 0.05);
    expect(top.left.x).toBeLessThan(middle - 0.05);
  });
});

describe('the figures', () => {
  it('the person stands 1.77 m tall, with limbs that swing', () => {
    const model = MODELS.pedestrian();
    for (const node of ['trunk', 'leg_l', 'leg_r', 'arm_l', 'arm_r']) expect(model.getObjectByName(node)).toBeDefined();
    const { box, y } = size(model);
    expect(box.min.y).toBeCloseTo(0, 1);
    expect(y).toBeCloseTo(PEDESTRIAN.height, 1);
  });

  it('the moose is as long as the obstacle and stands on four legs', () => {
    const model = MODELS.moose();
    for (const node of ['trunk', 'leg_fl', 'leg_fr', 'leg_rl', 'leg_rr'])
      expect(model.getObjectByName(node)).toBeDefined();
    const { box, x, y } = size(model);
    expect(box.min.y).toBeCloseTo(0, 1);
    expect(x).toBeCloseTo(MOOSE.length, 0);
    expect(y).toBeGreaterThan(1.8);
    expect(y).toBeLessThan(2.4);
  });
});

describe('the files in the repository', () => {
  it.each(names)('%s.glb is what the builder makes', async (name) => {
    const built = await toGlb(MODELS[name]());
    const stored = new Uint8Array(readFileSync(join(MODELS_DIR, `${name}.glb`)));
    // The same nodes, meshes, materials and buffer sizes; the numbers in the buffers are not compared bit by bit.
    expect(glbJson(stored)).toEqual(glbJson(built));
    expect(stored.byteLength).toBe(built.byteLength);
  });
});
