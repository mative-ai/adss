/**
 * The camera of the 3D scene (camera.ts): it sits behind the vehicle along the road's heading and looks at the road
 * ahead, in three's axes (x, up, −y); the shake after an impact starts from nothing, stays small and dies out.
 */
import { describe, expect, it } from 'vitest';

import {
  CHASE,
  CHASE_ORBIT,
  chaseCamera,
  dragOrbit,
  ORBIT,
  orbitCamera,
  SHAKE_SECONDS,
  shakeOffset,
  ViewCamera,
  zoomOrbit,
} from './camera.ts';

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

describe('the orbit a visitor makes with the mouse', () => {
  it('starts where the chase camera is: the same place and, with its lead, the same look', () => {
    const chase = new Float64Array(6);
    const orbit = new Float64Array(6);
    for (const heading of [0, 1.1, -2.4]) {
      chaseCamera(20, -5, heading, chase);
      orbitCamera(20, -5, heading, CHASE_ORBIT, CHASE.ahead, orbit);
      for (let i = 0; i < 6; i++) expect(orbit[i]).toBeCloseTo(chase[i]!, 9);
    }
  });

  it('looks at the vehicle from where it was asked, turning with the road', () => {
    const out = new Float64Array(6);
    // From the vehicle's right side, level with the point it looks at, 10 m away, on a road heading along +X.
    orbitCamera(20, -5, 0, { azimuth: 90, elevation: 0, distance: 10 }, 0, out);
    expect([...out]).toEqual([
      expect.closeTo(20, 9),
      ORBIT.height,
      expect.closeTo(15, 9),
      20,
      ORBIT.height,
      expect.closeTo(5, 9),
    ]);
    // The simulation's y grows to the left and three's Z is −y: the right side is at +Z.
    expect(out[2]! - out[5]!).toBeCloseTo(10, 9);
    // The same orbit on a road heading along +Y stands ahead of where it stood, by the road's turn.
    orbitCamera(20, -5, Math.PI / 2, { azimuth: 90, elevation: 0, distance: 10 }, 0, out);
    expect(out[0]! - 20).toBeCloseTo(10, 9);
    expect(out[2]! - 5).toBeCloseTo(0, 9);
  });

  it('follows the hand, and stays within its limits', () => {
    const start = { azimuth: 0, elevation: 20, distance: 12 };
    // A drag to the right brings the camera to the vehicle's left; a drag down lifts it.
    expect(dragOrbit(start, 100, 0).azimuth).toBeCloseTo(-100 * ORBIT.turn, 9);
    expect(dragOrbit(start, 0, 50).elevation).toBeCloseTo(20 + 50 * ORBIT.turn, 9);
    expect(dragOrbit(start, 0, 5000).elevation).toBe(ORBIT.elevation.max);
    expect(dragOrbit(start, 0, -5000).elevation).toBe(ORBIT.elevation.min);
    // All the way around is the same place again.
    const around = dragOrbit(start, 360 / ORBIT.turn + 10, 0).azimuth;
    expect(around).toBeCloseTo(dragOrbit(start, 10, 0).azimuth, 9);
    expect(Math.abs(around)).toBeLessThanOrEqual(180);
    // The wheel turned away brings the camera in, toward the visitor takes it out; neither past the limits.
    expect(zoomOrbit(start, -100).distance).toBeLessThan(12);
    expect(zoomOrbit(start, 100).distance).toBeGreaterThan(12);
    expect(zoomOrbit(start, -1e6).distance).toBe(ORBIT.distance.min);
    expect(zoomOrbit(start, 1e6).distance).toBe(ORBIT.distance.max);
    expect(zoomOrbit({ ...start, distance: ORBIT.distance.max }, 100).distance).toBe(ORBIT.distance.max);
  });
});

describe('the camera of a view', () => {
  it('is the chase camera until a visitor takes it, and again when they give it back', () => {
    const view = new ViewCamera();
    const chase = new Float64Array(6);
    const out = new Float64Array(6);
    chaseCamera(3, 4, 0.5, chase);
    expect(view.camera(3, 4, 0.5, 16, out)).toBe(false);
    expect([...out]).toEqual([...chase]);
    view.set({ azimuth: 40, elevation: 30, distance: 9 }, true);
    expect(view.held).toBe(true);
    view.camera(3, 4, 0.5, 16, out);
    view.set(null, true);
    expect(view.held).toBe(false);
    expect(view.camera(3, 4, 0.5, 16, out)).toBe(false);
    expect([...out]).toEqual([...chase]);
  });

  it('brings its look from the road ahead to the vehicle in a moment, and at once when asked', () => {
    const out = new Float64Array(6);
    const eased = new ViewCamera();
    eased.set(CHASE_ORBIT, true);
    // The first frame of an orbit is still close to the chase camera's: the picture does not jump.
    expect(eased.camera(0, 0, 0, 0, out)).toBe(true);
    expect(out[3]).toBeCloseTo(CHASE.ahead, 9);
    let frames = 0;
    while (eased.camera(0, 0, 0, 16, out)) frames++;
    expect(frames).toBeGreaterThan(10);
    expect(frames).toBeLessThan(120);
    expect(out[3]).toBeCloseTo(0, 9);
    expect(out[4]).toBeCloseTo(ORBIT.height, 9);

    const direct = new ViewCamera();
    direct.set(CHASE_ORBIT, false);
    expect(direct.camera(0, 0, 0, 16, out)).toBe(false);
    expect(out[3]).toBeCloseTo(0, 9);
    expect(out[4]).toBeCloseTo(ORBIT.height, 9);
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
