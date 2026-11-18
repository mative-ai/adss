/**
 * `npm run models`: builds every model of the realistic scene and writes it as a binary glTF file in the app's assets
 * (glb.ts). Run it after a change to a model's code, and commit the files with that change.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MODELS, MODELS_DIR, toGlb, type ModelName } from './glb.ts';

mkdirSync(MODELS_DIR, { recursive: true });
for (const name of Object.keys(MODELS) as ModelName[]) {
  const file = await toGlb(MODELS[name]());
  writeFileSync(join(MODELS_DIR, `${name}.glb`), file);
  console.log(`${name}.glb  ${(file.byteLength / 1024).toFixed(1)} kB`);
}
