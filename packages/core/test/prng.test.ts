import { describe, expect, it } from 'vitest';

import { Prng } from '../src/index.ts';

describe('Prng (xoshiro128**)', () => {
  it('matches the reference algorithm from state {1, 2, 3, 4}', () => {
    const rng = Prng.fromState([1, 2, 3, 4]);
    const out = Array.from({ length: 6 }, () => rng.nextUint32());
    expect(out).toEqual([11520, 0, 5927040, 70819200, 2031721883, 1637235492]);
  });

  it('gives the same sequence for the same seed and stream, a different one otherwise', () => {
    const draw = (seed: number, stream: number) => {
      const rng = Prng.create(seed, stream);
      return Array.from({ length: 8 }, () => rng.nextUint32());
    };
    expect(draw(42, 0)).toEqual(draw(42, 0));
    expect(draw(42, 0)).not.toEqual(draw(42, 1));
    expect(draw(42, 0)).not.toEqual(draw(43, 0));
  });

  it('draws uniforms in [0, 1) and standard normals', () => {
    const rng = Prng.create(7, 3);
    let min = 1;
    let max = 0;
    let sum = 0;
    let sumSq = 0;
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      const u = rng.next();
      min = Math.min(min, u);
      max = Math.max(max, u);
      const z = rng.normal();
      sum += z;
      sumSq += z * z;
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThan(1);
    expect(Math.abs(sum / n)).toBeLessThan(0.02);
    expect(Math.abs(sumSq / n - 1)).toBeLessThan(0.02);
  });

  it('draws integers in a closed range', () => {
    const rng = Prng.create(1);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(rng.integer(2, 4));
    expect([...seen].sort()).toEqual([2, 3, 4]);
  });
});
