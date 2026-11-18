/**
 * The charts' vertical scales (scales.ts): round ends that grow in whole steps with the data and never shrink under
 * their least, and the decimals a tick needs so that two ticks are never written the same.
 */
import { describe, expect, it } from 'vitest';

import { aroundZero, ceilTo, fromZero, tickDigits } from './scales.ts';

describe('the ranges', () => {
  it('go from zero up to the data in whole steps, and to their least without data', () => {
    const range = fromZero(20, 40);
    expect(range(null, null)).toEqual([0, 40]);
    expect(range(0, 39.9)).toEqual([0, 40]);
    expect(range(0, 60)).toEqual([0, 60]);
    expect(range(12, 60.1)).toEqual([0, 80]);
  });

  it('are as far above zero as below it, by the larger of the two sides', () => {
    const range = aroundZero(0.25, 0.5);
    expect(range(null, null)).toEqual([-0.5, 0.5]);
    expect(range(-0.1, 0.2)).toEqual([-0.5, 0.5]);
    expect(range(-0.93, 0.3)).toEqual([-1, 1]);
    expect(range(-0.2, 1.01)).toEqual([-1.25, 1.25]);
  });

  it('round up to a step without stepping past a value that is already on one', () => {
    expect(ceilTo(60, 20)).toBe(60);
    expect(ceilTo(0.75, 0.25)).toBe(0.75);
    expect(ceilTo(0.3, 0.1)).toBeCloseTo(0.3, 12);
  });
});

describe('tickDigits', () => {
  it('gives the decimals that keep two ticks apart', () => {
    expect(tickDigits(5)).toBe(0);
    expect(tickDigits(1)).toBe(0);
    expect(tickDigits(0.5)).toBe(1);
    expect(tickDigits(0.2)).toBe(1);
    expect(tickDigits(0.25)).toBe(2);
    expect(tickDigits(0.05)).toBe(2);
    expect(tickDigits(0.001)).toBe(3);
  });
});
