/**
 * The materials of the models (Phase 8), by name. A model's file carries them so that it opens in any
 * glTF viewer; the app does not use their look: it reads the name and gives each part its own material of that name
 * (packages/app/src/ui/scene3d/real/materials.ts), which is how one car is the MPC's, the ghost's or a parked one.
 */
import { LineBasicMaterial, Mesh, MeshStandardMaterial, type BufferGeometry, type Material } from 'three';

interface Look {
  color: number;
  metalness?: number;
  roughness?: number;
  emissive?: number;
  opacity?: number;
}

const LOOKS: Record<string, Look> = {
  paint: { color: 0x4db936, metalness: 0.5, roughness: 0.35 },
  paint_dark: { color: 0x0b0d0c, metalness: 0.4, roughness: 0.3 },
  glass: { color: 0x0c120c, roughness: 0.05, opacity: 0.9 },
  trim: { color: 0x101210, roughness: 0.7 },
  interior: { color: 0x1a1c1a, roughness: 0.9 },
  lamp_front: { color: 0xffffff, emissive: 0xffffff, roughness: 0.2 },
  lamp_rear: { color: 0x7a0a0a, emissive: 0x400000, roughness: 0.2 },
  rubber: { color: 0x0b0b0b, roughness: 0.9 },
  rim: { color: 0xb9bcc0, metalness: 1, roughness: 0.3 },
  rim_dark: { color: 0x2a2c2e, metalness: 0.8, roughness: 0.5 },
  sensor_shell: { color: 0xe9ebe6, roughness: 0.35 },
  sensor_glass: { color: 0x050605, metalness: 0.2, roughness: 0.08 },
  sensor_light: { color: 0x4db936, emissive: 0x4db936, roughness: 0.3 },
  livery: { color: 0x0d230b, roughness: 0.55 },
  livery_light: { color: 0xf7f8f4, roughness: 0.55 },
  cargo: { color: 0xe8eae6, roughness: 0.6 },
  figure: { color: 0xd9ddd2, roughness: 0.6 },
  figure_joint: { color: 0x363c33, roughness: 0.6 },
  fur: { color: 0x4a3526, roughness: 1 },
  fur_light: { color: 0x8a7558, roughness: 1 },
  antler: { color: 0xb9a88a, roughness: 0.8 },
  hoof: { color: 0x1c1a17, roughness: 0.7 },
};

/** The name of the lines a model draws itself with: the app shows them, dashed, on the ghost only. */
export const OUTLINE = 'outline';

/** The materials of one model: one instance per name, so that the file holds each once. */
export function palette(): (name: string) => Material {
  const made = new Map<string, Material>();
  return (name) => {
    let material = made.get(name);
    if (!material) {
      const look = LOOKS[name];
      if (name === OUTLINE) material = new LineBasicMaterial({ color: 0x141812 });
      else if (!look) throw new Error(`No material is named ${name}.`);
      else {
        material = new MeshStandardMaterial({
          color: look.color,
          metalness: look.metalness ?? 0,
          roughness: look.roughness ?? 0.5,
          emissive: look.emissive ?? 0,
          transparent: look.opacity !== undefined,
          opacity: look.opacity ?? 1,
        });
      }
      material.name = name;
      made.set(name, material);
    }
    return material;
  };
}

export function mesh(name: string, geometry: BufferGeometry, material: Material): Mesh {
  const out = new Mesh(geometry, material);
  out.name = name;
  return out;
}
