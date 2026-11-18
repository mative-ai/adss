/**
 * What stands beside the road (dressing.ts): the trees are where they were the last time the road was drawn, on both
 * sides of it, and none stands on the road or where a figure waits to cross.
 */
import { describe, expect, it } from 'vitest';

import { scatterTrees, unit } from './dressing.ts';

describe('unit', () => {
  it('gives the same number from 0 to 1 for the same pair, and another for another', () => {
    const values = Array.from({ length: 400 }, (_, i) => unit(i, 3));
    expect(values).toEqual(Array.from({ length: 400 }, (_, i) => unit(i, 3)));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(new Set(values).size).toBeGreaterThan(390);
    expect(unit(7, 1)).not.toBe(unit(7, 2));
    // Spread over the whole range, not bunched.
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.6);
  });
});

describe('scatterTrees', () => {
  const trees = scatterTrees(-82.5, 700, 3.5, 3.5);

  it('places the same trees every time', () => {
    expect(scatterTrees(-82.5, 700, 3.5, 3.5)).toEqual(trees);
  });

  it('plants two rows on each side, all along the road', () => {
    // A tree every 7 m in each of the four rows.
    expect(trees).toHaveLength(Math.floor(782.5 / 7) * 4);
    const left = trees.filter((tree) => tree.ey > 0);
    expect(left).toHaveLength(trees.length / 2);
    expect(Math.min(...trees.map((tree) => tree.s))).toBeLessThan(-70);
    expect(Math.max(...trees.map((tree) => tree.s))).toBeGreaterThan(690);
  });

  it('keeps every tree well off the road: a figure waits to cross up to 2 m from its edge', () => {
    for (const tree of trees) {
      expect(Math.abs(tree.ey)).toBeGreaterThanOrEqual(3.5 + 9);
      expect(Math.abs(tree.ey)).toBeLessThan(3.5 + 9 + 11 + 12);
      expect(tree.scale).toBeGreaterThanOrEqual(0.75);
      expect(tree.scale).toBeLessThan(1.5);
    }
  });

  it('follows the edges of a road that is wider on one side', () => {
    const wide = scatterTrees(0, 200, 5.25, 2.25);
    expect(Math.min(...wide.filter((tree) => tree.ey > 0).map((tree) => tree.ey))).toBeGreaterThanOrEqual(5.25 + 9);
    expect(Math.max(...wide.filter((tree) => tree.ey < 0).map((tree) => tree.ey))).toBeLessThanOrEqual(-2.25 - 9);
  });
});
