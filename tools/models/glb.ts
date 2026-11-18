/**
 * The models of the realistic scene (Phase 8) and their binary glTF. `npm run models` (build.ts) writes
 * each to packages/app/src/assets/models, where the app loads it on demand; models.test.ts checks that the files in the
 * repository are the ones this code builds.
 */
import type { Object3D } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

import { buildCar } from './car.ts';
import { buildMoose, buildPedestrian } from './figures.ts';
import { buildTruck } from './truck.ts';

export const MODELS = { car: buildCar, truck: buildTruck, pedestrian: buildPedestrian, moose: buildMoose } as const;
export type ModelName = keyof typeof MODELS;

/** Where the models live in the app, from the repository's root. */
export const MODELS_DIR = 'packages/app/src/assets/models';

/** The exporter reads its buffers back through the browser's FileReader: Node has the Blob, and this much of the rest. */
function withFileReader(): void {
  const scope = globalThis as { FileReader?: unknown };
  if (scope.FileReader) return;
  scope.FileReader = class {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob): void {
      void blob.arrayBuffer().then((buffer) => {
        this.result = buffer;
        this.onloadend?.();
      });
    }
  };
}

/** A model as a binary glTF file. */
export async function toGlb(model: Object3D): Promise<Uint8Array> {
  withFileReader();
  const out = await new GLTFExporter().parseAsync(model, { binary: true });
  if (!(out instanceof ArrayBuffer)) throw new Error('The exporter did not return a binary file.');
  return new Uint8Array(out);
}

/** The JSON part of a binary glTF file: its nodes, meshes, materials and the sizes of its buffers. */
export function glbJson(file: Uint8Array): unknown {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('Not a binary glTF file.');
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(file.subarray(20, 20 + length)));
}
