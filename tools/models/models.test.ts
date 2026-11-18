/**
 * The models of the realistic scene (Phase 8): what the app relies on in each (the nodes it moves, the
 * materials it replaces by name, the size it scales from), and that the files in the repository are the ones the
 * builder makes today.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Box3, type Group, type Mesh, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { CAR, MOOSE, PEDESTRIAN, TRUCK } from '../../packages/app/src/ui/scene3d/real/nominal.ts';
import { glbJson, MODELS, MODELS_DIR, toGlb, type ModelName } from './glb.ts';
import { OUTLINE } from './materials.ts';

const names = Object.keys(MODELS) as ModelName[];

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
  it.each([
    ['car', CAR, 1.3, 1.6],
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
    // The footprint is the vehicle's, give or take the bulge of its ends and its mirrors.
    expect(x).toBeGreaterThan(nominal.length - 0.05);
    expect(x).toBeLessThan(nominal.length + 0.15);
    expect(z).toBeGreaterThan(nominal.width - 0.05);
    expect(z).toBeLessThan(nominal.width + 0.45);
  });

  it('the car is one surface in few materials, light enough to draw four of', () => {
    const car = MODELS.car();
    expect([...materialsOf(car)].sort()).toEqual(
      ['glass', 'interior', 'lamp_front', 'lamp_rear', OUTLINE, 'paint', 'rim', 'rim_dark', 'rubber', 'trim'].sort(),
    );
    expect(triangles(car)).toBeLessThan(30_000);
    // One mesh per material in the body, and the lines of the ghost.
    const body = car.getObjectByName('body') as Object3D;
    expect(body.children.map((child) => child.name).sort()).toEqual(
      ['glass', 'interior', 'lamp_front', 'lamp_rear', OUTLINE, 'paint', 'trim'].map((name) => `body_${name}`).sort(),
    );
  });

  it('the car is the same on its two sides', () => {
    const { box } = size(MODELS.car());
    expect(box.min.z).toBeCloseTo(-box.max.z, 5);
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
