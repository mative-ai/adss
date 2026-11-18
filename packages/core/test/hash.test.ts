import { describe, expect, it } from 'vitest';

import { Fingerprint } from '../src/index.ts';

describe('Fingerprint', () => {
  const data = Float64Array.from({ length: 1000 }, (_, i) => Math.sin(i) * 1e3);

  it('is 16 hex digits and the same for the same data', () => {
    const a = new Fingerprint().add(data).digest();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(new Fingerprint().add(data.slice()).digest()).toBe(a);
  });

  it('changes when a single bit of a single value changes', () => {
    const changed = data.slice();
    const words = new Uint32Array(changed.buffer);
    words[1234] = (words[1234] ?? 0) ^ 1;
    expect(new Fingerprint().add(changed).digest()).not.toBe(new Fingerprint().add(data).digest());
  });

  it('depends on order and on length', () => {
    expect(new Fingerprint().addNumber(1).addNumber(2).digest()).not.toBe(
      new Fingerprint().addNumber(2).addNumber(1).digest(),
    );
    expect(new Fingerprint().addNumber(0).digest()).not.toBe(new Fingerprint().addNumber(0).addNumber(0).digest());
  });
});
