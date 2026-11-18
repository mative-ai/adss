/**
 * The colors of the 3D scene, light and dark, from the design tokens (styles/brand.css): one
 * green for the MPC and the trajectory it chose, the clay and night neutrals for everything else. They mirror the top
 * view's palette (drawScene.ts), so the two views and their one legend say the same thing.
 */

export interface ScenePalette {
  /** The background and the fog that fades the far road into it. */
  sky: number;
  ground: number;
  /** The road at full grip (μ = 1) and where it has none (μ = 0): a surface takes the color between them by its μ. */
  asphalt: number;
  slippery: number;
  line: number;
  hatch: number;
  post: number;
  ego: number;
  cabin: number;
  wheel: number;
  ghost: number;
  ghostEdge: number;
  obstacle: number;
  /** The plans that were not chosen, and the ring of an obstacle the sensor does not track. */
  plan: number;
  chosen: number;
  chosenEdge: number;
  shadow: number;
}

export const SCENE_LIGHT: ScenePalette = {
  sky: 0xf7f8f4,
  ground: 0xe3e7dd,
  asphalt: 0x8c9584,
  slippery: 0xd0d6c8,
  line: 0xf7f8f4,
  hatch: 0xf7f8f4,
  post: 0xf7f8f4,
  ego: 0x4db936,
  cabin: 0x0d230b,
  wheel: 0x141812,
  ghost: 0xf7f8f4,
  ghostEdge: 0x141812,
  obstacle: 0x141812,
  plan: 0x141812,
  chosen: 0x4db936,
  chosenEdge: 0x0d230b,
  shadow: 0x141812,
};

export const SCENE_DARK: ScenePalette = {
  sky: 0x090c08,
  ground: 0x0e130d,
  asphalt: 0x33402f,
  slippery: 0x6c7566,
  line: 0xd0d6c8,
  hatch: 0xb0b8a6,
  post: 0xb0b8a6,
  ego: 0x4db936,
  cabin: 0x0d230b,
  wheel: 0x090c08,
  ghost: 0xd0d6c8,
  ghostEdge: 0xf7f8f4,
  obstacle: 0xf7f8f4,
  plan: 0xf7f8f4,
  chosen: 0x70c75e,
  chosenEdge: 0x090c08,
  shadow: 0x000000,
};

/** The share of the way from `asphalt` to `slippery` a surface of friction `mu` takes: none at μ ≥ 1, all at μ = 0. */
export const slipperiness = (mu: number): number => Math.min(Math.max(1 - mu, 0), 1);
