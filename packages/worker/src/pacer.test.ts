/** The pacing and the frames' cadence (pacer.ts), and the frames' buffers (pool.ts). */
import { describe, expect, it } from 'vitest';

import { FrameCadence, MAX_LAG_TICKS, Pacer } from './pacer.ts';
import { BufferPool } from './pool.ts';

describe('the pacer', () => {
  it('owes the wall time at the rate, nothing while paused', () => {
    const pacer = new Pacer();
    expect(pacer.due(100)).toBe(0);
    pacer.play(100);
    expect(pacer.due(116)).toBe(16);
    pacer.settle(16);
    pacer.setRate(0.5);
    expect(pacer.due(136)).toBe(10);
    pacer.settle(4);
    // What a turn could not simulate stays owed.
    expect(pacer.due(136)).toBe(6);
    pacer.pause();
    expect(pacer.due(1000)).toBe(0);
    expect(() => pacer.setRate(0)).toThrow(RangeError);
    expect(() => pacer.setRate(10)).toThrow(RangeError);
  });

  it('drops a debt it cannot pay, goes into slow motion once, and back after a steady second', () => {
    const pacer = new Pacer();
    pacer.play(0);
    pacer.due(500);
    expect(pacer.settle(500 - MAX_LAG_TICKS - 1)).toBe('slowMotion');
    expect(pacer.slowMotion).toBe(true);
    // The rate it says it runs at is the one it achieves, not the one asked for.
    expect(pacer.achievedRate).toBeCloseTo((500 - MAX_LAG_TICKS - 1) / 500, 12);
    expect(pacer.due(500)).toBe(0);
    pacer.due(1000);
    expect(pacer.settle(500 - MAX_LAG_TICKS - 1)).toBeNull();
    let t = 1000;
    let notice = null;
    while (notice === null && t < 3000) {
      t += 20;
      const due = pacer.due(t);
      notice = pacer.settle(due);
    }
    expect(notice).toBe('realTime');
    expect(pacer.slowMotion).toBe(false);
    expect(pacer.achievedRate).toBeGreaterThan(0.5);
  });

  /** Plays from `from` (ms) and lets a turn fall behind: the notice it gives. */
  const stall = (pacer: Pacer, from: number) => {
    pacer.play(from);
    pacer.due(from + 500);
    return pacer.settle(500 - MAX_LAG_TICKS - 1);
  };

  it('starts a new run out of slow motion, so the new run says when it falls behind', () => {
    const pacer = new Pacer();
    expect(stall(pacer, 0)).toBe('slowMotion');
    pacer.reset();
    expect(pacer.slowMotion).toBe(false);
    expect(pacer.achievedRate).toBe(1);
    expect(stall(pacer, 1000)).toBe('slowMotion');
  });

  it('says no higher rate than it achieves when asked for one in slow motion', () => {
    const pacer = new Pacer();
    stall(pacer, 0);
    const achieved = pacer.achievedRate;
    pacer.setRate(2);
    expect(pacer.achievedRate).toBe(achieved);
    pacer.setRate(0.1);
    expect(pacer.achievedRate).toBe(0.1);
  });
});

describe('the frame cadence', () => {
  /** Frames sent in 10 s of turns `turnMs` apart. */
  const frames = (turnMs: number) => {
    const cadence = new FrameCadence(1000 / 60, 2);
    let sent = 0;
    for (let t = 0; t < 10_000; t += turnMs) {
      if (!cadence.due(t)) continue;
      cadence.sent(t);
      sent++;
    }
    return sent;
  };

  it('keeps 60 frames a second whatever the turns, about 4 ms each', () => {
    // A cadence restarted at each frame sends one every 5 turns of 4 ms: 50 a second.
    for (const turnMs of [4, 4.1, 4.3, 5]) expect(Math.abs(frames(turnMs) - 600)).toBeLessThanOrEqual(1);
  });

  it('starts again from a frame sent after a gap, without a burst', () => {
    const cadence = new FrameCadence(1000 / 60, 2);
    cadence.sent(0);
    cadence.sent(500);
    expect(cadence.due(504)).toBe(false);
    expect(cadence.due(515)).toBe(true);
  });
});

describe('the frame buffers', () => {
  it('lends at most its limit, takes back its own size only', () => {
    const pool = new BufferPool(64, 2);
    const a = pool.take();
    const b = pool.take();
    expect(a?.byteLength).toBe(64);
    expect(b).toBeDefined();
    expect(pool.take()).toBeUndefined();
    expect(pool.give(new ArrayBuffer(32))).toBe(false);
    expect(pool.give(a!)).toBe(true);
    expect(pool.take()).toBe(a);
  });

  it("takes an earlier run's buffer only in place of one it lent, so a reset never adds buffers", () => {
    const pool = new BufferPool(64, 2);
    // The page still holds a buffer of the run before: nothing is lent yet, so it is dropped.
    expect(pool.give(new ArrayBuffer(64))).toBe(false);
    const a = pool.take();
    expect(pool.give(new ArrayBuffer(64))).toBe(true);
    // The old one took its place: the buffer lent comes back to a pool that has its count already.
    expect(pool.give(a!)).toBe(false);
    expect(pool.take()).toBeDefined();
    expect(pool.take()).toBeDefined();
    expect(pool.take()).toBeUndefined();
  });
});
