/**
 * The models of the realistic scene (Phase 8): binary glTF files made by tools/models, fetched on
 * demand (never before the access check, and only the ones a run needs) and kept for as long as the scene lives. A
 * model is a template: `instantiate` copies its nodes for one vehicle or obstacle and gives every part the material
 * of its name from a set (materials.ts); the geometry is shared by all the copies.
 */
import type { Group, LineSegments, Material, Mesh, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import carUrl from '../../../assets/models/car.glb?url';
import mooseUrl from '../../../assets/models/moose.glb?url';
import pedestrianUrl from '../../../assets/models/pedestrian.glb?url';
import truckUrl from '../../../assets/models/truck.glb?url';
import { OUTLINE, type MaterialSet } from './materials.ts';

const URLS = { car: carUrl, truck: truckUrl, pedestrian: pedestrianUrl, moose: mooseUrl } as const;
export type ModelName = keyof typeof URLS;

export class Models {
  private readonly loader = new GLTFLoader();
  private readonly loaded = new Map<ModelName, Group>();
  private readonly loading = new Map<ModelName, Promise<void>>();

  /** The template of a model, when it has been loaded. */
  get(name: ModelName): Group | undefined {
    return this.loaded.get(name);
  }

  /** Whether every one of `names` is loaded. */
  has(names: readonly ModelName[]): boolean {
    return names.every((name) => this.loaded.has(name));
  }

  /** Loads the models of `names` that are not loaded yet; rejects when one cannot be fetched or read. */
  async load(names: readonly ModelName[]): Promise<void> {
    await Promise.all(
      names.map((name) => {
        if (this.loaded.has(name)) return undefined;
        let pending = this.loading.get(name);
        if (!pending) {
          pending = this.loader.loadAsync(URLS[name]).then((file) => {
            this.loaded.set(name, file.scene);
          });
          this.loading.set(name, pending);
        }
        return pending;
      }),
    );
  }

  dispose(): void {
    for (const template of this.loaded.values()) {
      template.traverse((object) => {
        const item = object as Mesh;
        if (!item.geometry) return;
        item.geometry.dispose();
        (item.material as Material).dispose();
      });
    }
    this.loaded.clear();
  }
}

/**
 * A copy of a model with the materials of `set`. The model's own lines are shown only with `outline` (the ghost),
 * dashed; with `shadows` the copy casts a shadow and takes those of the others.
 */
export function instantiate(template: Group, set: MaterialSet, options: { outline: boolean; shadows: boolean }): Group {
  const copy = template.clone(true);
  copy.traverse((object: Object3D) => {
    const lines = object as LineSegments;
    if (lines.isLineSegments) {
      const dashed = set[OUTLINE];
      lines.visible = options.outline && dashed !== undefined;
      if (lines.visible && dashed) {
        lines.material = dashed;
        // The dashes are measured along each line: the geometry is the template's, and takes them once.
        if (!lines.geometry.getAttribute('lineDistance')) lines.computeLineDistances();
      }
      return;
    }
    const part = object as Mesh;
    if (!part.isMesh) return;
    const name = (part.material as Material).name;
    const material = set[name];
    if (!material) throw new Error(`The model ${template.name} has a part in "${name}", which this set lacks.`);
    part.material = material;
    part.castShadow = options.shadows;
    part.receiveShadow = options.shadows;
  });
  return copy;
}
