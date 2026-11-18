/**
 * 64-bit fingerprint of floating-point data, as 16 hex digits: two 32-bit lanes with different mixing
 * constants over the IEEE-754 words. Trajectory and golden hashes use it (CLAUDE.md §8): equal runs give
 * equal fingerprints, and a change in any bit of any value changes it. Not cryptographic.
 */
function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

function finalize(h: number, length: number): number {
  h ^= length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class Fingerprint {
  private h1 = 0x9747b28c;
  private h2 = 0x2545f491;
  private words = 0;
  private readonly scratch = new Float64Array(1);

  add(data: Float64Array): this {
    // JavaScript engines are little-endian on every supported platform, so the word order is fixed.
    const words = new Uint32Array(data.buffer, data.byteOffset, data.length * 2);
    let h1 = this.h1;
    let h2 = this.h2;
    for (let i = 0; i < words.length; i++) {
      const w = words[i] ?? 0;
      let k1 = Math.imul(w, 0xcc9e2d51);
      k1 = Math.imul(rotl(k1, 15), 0x1b873593);
      h1 = Math.imul(rotl(h1 ^ k1, 13), 5) + 0xe6546b64;
      let k2 = Math.imul(w, 0x85ebca77);
      k2 = Math.imul(rotl(k2, 17), 0xc2b2ae3d);
      h2 = Math.imul(rotl(h2 ^ k2, 11), 9) + 0x27d4eb2f;
    }
    this.h1 = h1;
    this.h2 = h2;
    this.words += words.length;
    return this;
  }

  addNumber(value: number): this {
    this.scratch[0] = value;
    return this.add(this.scratch);
  }

  digest(): string {
    const a = finalize(this.h1, this.words);
    const b = finalize(this.h2 ^ a, this.words);
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }
}
