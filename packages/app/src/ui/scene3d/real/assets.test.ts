/**
 * A copy of a model (Phase 8): the parts a vehicle does not carry come off the copy before a material is
 * looked for, and stay in the template the next copy is made from.
 */
import { BufferGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';

import { instantiate } from './assets.ts';
import { CAR_PARTS } from './nominal.ts';

/** A car in two parts: the paint of its body, and a sensor kit in it. */
function template(): Group {
  const named = (name: string) => {
    const material = new MeshBasicMaterial();
    material.name = name;
    return material;
  };
  const body = new Group();
  body.name = 'body';
  body.add(new Mesh(new BufferGeometry(), named('paint')));
  const kit = new Group();
  kit.name = CAR_PARTS.sensors;
  kit.add(new Mesh(new BufferGeometry(), named('sensor_shell')));
  body.add(kit);
  const car = new Group();
  car.name = 'car';
  car.add(body);
  return car;
}

describe('a copy of a model', () => {
  it('takes every material from the set, by its name', () => {
    const set = { paint: new MeshBasicMaterial(), sensor_shell: new MeshBasicMaterial() };
    const copy = instantiate(template(), set, { outline: false, shadows: true });
    const used: unknown[] = [];
    copy.traverse((object) => {
      const part = object as Mesh;
      if (part.isMesh) used.push(part.material);
    });
    expect(used).toEqual([set.paint, set.sensor_shell]);
  });

  it('leaves the named parts off, and the template whole', () => {
    const car = template();
    // A set with no material for the kit: the kit must be gone before the materials are given out.
    const set = { paint: new MeshBasicMaterial() };
    const copy = instantiate(car, set, { outline: false, shadows: true, without: [CAR_PARTS.sensors] });
    expect(copy.getObjectByName(CAR_PARTS.sensors)).toBeUndefined();
    expect(car.getObjectByName(CAR_PARTS.sensors)).toBeDefined();
    expect(() => instantiate(car, set, { outline: false, shadows: true })).toThrow(/sensor_shell/);
  });
});
