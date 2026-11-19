/**
 * Adaptive resolution of the 3D scene (Phase 4): the scene is drawn at fewer pixels when the display's
 * frames come late, and at more again when they have been on time for a while. Only the drawing's sharpness changes:
 * the simulation runs in the worker and its result does not depend on this (AGENTS.md §2 and §5).
 */

/** Frames averaged before a decision. */
const WINDOW = 40;
/** A mean time between frames above this, ms, is too slow (under about 45 frames a second). */
const SLOW_MS = 22;
/** A mean at or under this, ms, is on time for a 60 Hz display. */
const FAST_MS = 17.5;
const MIN_SCALE = 0.6;
const STEP_DOWN = 0.8;
const STEP_UP = 1.15;
/** Windows on time, in a row, before the first step up; each step down doubles it, so the scale does not swing. */
const GOOD_WINDOWS = 4;
const GOOD_WINDOWS_MAX = 64;

export class AdaptiveResolution {
  /** The pixel ratio to draw at: from MIN_SCALE to the display's (capped by the caller). */
  scale: number;
  /**
   * The frames came late even at the lowest scale: fewer pixels no longer help, and the caller may draw something
   * lighter. It stays set until the caller clears it.
   */
  floor = false;

  private readonly max: number;
  private sum = 0;
  private count = 0;
  private good = 0;
  private needed = GOOD_WINDOWS;

  constructor(max: number) {
    this.max = max;
    this.scale = max;
  }

  /** Takes the time between two frames of the display, ms; true when the scale changed. */
  sample(ms: number): boolean {
    this.sum += ms;
    if (++this.count < WINDOW) return false;
    const mean = this.sum / this.count;
    this.sum = 0;
    this.count = 0;
    if (mean > SLOW_MS) {
      this.good = 0;
      if (this.scale <= MIN_SCALE) {
        this.floor = true;
        return false;
      }
      this.scale = Math.max(MIN_SCALE, this.scale * STEP_DOWN);
      this.needed = Math.min(this.needed * 2, GOOD_WINDOWS_MAX);
      return true;
    }
    if (mean > FAST_MS || this.scale >= this.max) {
      this.good = 0;
      return false;
    }
    if (++this.good < this.needed) return false;
    this.good = 0;
    this.scale = Math.min(this.max, this.scale * STEP_UP);
    return true;
  }
}
