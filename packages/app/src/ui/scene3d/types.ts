/**
 * What the 3D view asks of a scene (Phases 4 and 8): the low-poly scene (world.ts) and the realistic one
 * (real/realWorld.ts) both answer to it, and Scene3D.tsx drives either the same way. A scene draws what a frame holds
 * and computes no physics.
 */
import type { SceneInfo } from '@mpc-simulator/worker';

import type { FrameView } from '../../sim/frame.ts';
import type { RoadGeometry } from '../roadGeometry.ts';
import type { Orbit } from './camera.ts';

export interface World {
  /** The drawing is behind what the scene holds (a new size, theme or run): the next `render` brings it up to date. */
  stale: boolean;
  setTheme(dark: boolean): void;
  /** Sizes the drawing: CSS pixels, and the device pixels drawn for each. */
  resize(width: number, height: number, pixelRatio: number): void;
  /** Builds the scene of a run; the one before it is freed. */
  load(info: SceneInfo, road: RoadGeometry): void;
  /** Moves everything to where a frame says it is. */
  update(frame: FrameView): void;
  /** Starts the camera's shake: the ego's impact. */
  shake(): void;
  /** Draws the scene, `elapsed` ms after the frame before; true while something still moves by itself. */
  render(elapsed: number): boolean;
  /** Looks at the vehicle from the place a visitor chose with the mouse, or follows it from behind again (null). */
  orbit(view: Orbit | null): void;
  dispose(): void;
  /** Leaves out what moves only for effect: the lean of a body under acceleration. */
  setReducedMotion?(reduced: boolean): void;
  /** Gives up some of the look for speed; false when there is nothing left to give up. */
  degrade?(): boolean;
  /** Looks at the scene from a fixed place around the vehicle or an obstacle, or follows the vehicle again (null). */
  inspect?(view: Inspection | null): void;
}

/** A place to look from, for the development server: degrees around and above the target, and meters from it. */
export interface Inspection {
  azimuth: number;
  elevation: number;
  distance: number;
  /** The ego, or the obstacle of this number. */
  target: 'ego' | number;
}
