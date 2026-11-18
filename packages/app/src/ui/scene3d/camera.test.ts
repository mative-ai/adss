/**
 * The camera of the 3D scene (camera.ts): it sits behind the vehicle along the road's heading and looks at the road
 * ahead, in three's axes (x, up, −y); the shake after an impact starts from nothing, stays small and dies out.
 */
import { describe, expect, it } from 'vitest';

import { CHASE, chaseCamera, SHAKE_SECONDS, shakeOffset } from './camera.ts';

describe('chaseCamera', () => {
  it('sits behind the vehicle and looks ahead of it, whatever the heading', () => {
    const out = new Float64Array(6);
    for (const heading of [0, Math.PI / 2, -0.8, 2.6]) {
      chaseCamera(20, -5, heading, out);
      const forward = [Math.cos(heading), -Math.sin(heading)] as const;
      // From the vehicle to the camera: `back` meters against the heading, on the ground plane (X, Z).
      expect(out[0]! - 20).toBeCloseTo(-CHASE.back * forward[0], 9);
      expect(out[2]! - 5).toBeCloseTo(-CHASE.back * forward[1], 9);
      expect(out[1]).toBe(CHASE.height);
      expect(out[3]! - 20).toBeCloseTo(CHASE.ahead * forward[0], 9);
      expect(out[5]! - 5).toBeCloseTo(CHASE.ahead * forward[1], 9);
      expect(out[4]).toBe(CHASE.lookHeight);
    }
  });
});

describe('shakeOffset', () => {
  it('starts from nothing, stays within a quarter of a meter and is over after SHAKE_SECONDS', () => {
    const out = { side: 1, up: 1 };
    shakeOffset(0, out);
    expect(out).toEqual({ side: 0, up: 0 });
    let moved = false;
    for (let age = 0.005; age < SHAKE_SECONDS; age += 0.005) {
      shakeOffset(age, out);
      expect(Math.abs(out.side)).toBeLessThan(0.25);
      expect(Math.abs(out.up)).toBeLessThan(0.25);
      if (Math.abs(out.side) > 0.05) moved = true;
    }
    expect(moved).toBe(true);
    for (const age of [SHAKE_SECONDS, 2, -1, Number.NaN]) {
      shakeOffset(age, out);
      expect(out).toEqual({ side: 0, up: 0 });
    }
  });
});
