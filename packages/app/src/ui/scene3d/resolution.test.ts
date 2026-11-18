/**
 * Adaptive resolution (resolution.ts): frames that come late lower the pixel ratio down to its floor, frames on time
 * raise it again up to the display's, and each step down makes the next step up wait longer.
 */
import { describe, expect, it } from 'vitest';

import { AdaptiveResolution } from './resolution.ts';

/** Feeds `frames` frames `ms` apart; the number of changes of scale. */
function feed(resolution: AdaptiveResolution, ms: number, frames: number): number {
  let changes = 0;
  for (let i = 0; i < frames; i++) if (resolution.sample(ms)) changes++;
  return changes;
}

describe('AdaptiveResolution', () => {
  it('starts at the display ratio and stays there while the frames are on time', () => {
    const resolution = new AdaptiveResolution(2);
    expect(feed(resolution, 16.7, 600)).toBe(0);
    expect(resolution.scale).toBe(2);
  });

  it('steps down while the frames are late, and never under its floor', () => {
    const resolution = new AdaptiveResolution(2);
    expect(feed(resolution, 30, 40)).toBe(1);
    expect(resolution.scale).toBeCloseTo(1.6, 9);
    feed(resolution, 30, 4000);
    expect(resolution.scale).toBe(0.6);
    expect(feed(resolution, 30, 400)).toBe(0);
  });

  it('steps up again only after a while on time, and waits longer after each step down', () => {
    const resolution = new AdaptiveResolution(2);
    feed(resolution, 30, 40);
    // One step down doubled the wait: 8 windows of 40 frames on time, not 4.
    expect(feed(resolution, 16.7, 7 * 40)).toBe(0);
    expect(feed(resolution, 16.7, 40)).toBe(1);
    expect(resolution.scale).toBeCloseTo(1.84, 9);
    // The next step reaches the display ratio and stops there.
    feed(resolution, 16.7, 8 * 40);
    expect(resolution.scale).toBe(2);
    expect(feed(resolution, 16.7, 2000)).toBe(0);
  });

  it('says when fewer pixels no longer help, until it is heard', () => {
    const resolution = new AdaptiveResolution(2);
    // Six late windows bring the scale from 2 to its floor: so far each has still stepped down.
    feed(resolution, 30, 6 * 40);
    expect(resolution.scale).toBe(0.6);
    expect(resolution.floor).toBe(false);
    // One more, at the floor: there is nothing left to step down to.
    expect(feed(resolution, 30, 40)).toBe(0);
    expect(resolution.floor).toBe(true);
    // It stays said while the frames are on time again, and is not said again until the next late window.
    feed(resolution, 16.7, 40);
    expect(resolution.floor).toBe(true);
    resolution.floor = false;
    feed(resolution, 16.7, 40);
    expect(resolution.floor).toBe(false);
    feed(resolution, 30, 40);
    expect(resolution.floor).toBe(true);
  });

  it('does not count a window that is neither late nor on time', () => {
    const resolution = new AdaptiveResolution(2);
    feed(resolution, 30, 40);
    feed(resolution, 16.7, 7 * 40);
    // A window in between starts the count again.
    expect(feed(resolution, 20, 40)).toBe(0);
    expect(feed(resolution, 16.7, 7 * 40)).toBe(0);
    expect(resolution.scale).toBeCloseTo(1.6, 9);
  });
});
