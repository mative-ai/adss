/**
 * xoshiro128** (Blackman and Vigna, 2018). Only 32-bit integer operations, so every JavaScript
 * engine produces the same integers and uniforms; normals use Math.log and Math.cos, identical within one
 * engine only. Use one instance per purpose (each sensor, each scenario variant, each test), created with
 * `Prng.create(seed, stream)`.
 */
const TWO_POW_32 = 4294967296;
const GOLDEN = 0x9e3779b9;

/** MurmurHash3's finalizer: spreads every input bit over the whole word. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export class Prng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  /** Box–Muller yields two normals per draw: the second waits here. */
  private spareNormal = Number.NaN;

  private constructor(s0: number, s1: number, s2: number, s3: number) {
    this.s0 = s0;
    this.s1 = s1;
    this.s2 = s2;
    this.s3 = s3;
  }

  /** Stream `stream` of `seed` (both unsigned 32-bit integers): different streams are unrelated sequences. */
  static create(seed: number, stream = 0): Prng {
    let x = fmix32((seed >>> 0) ^ fmix32(Math.imul((stream >>> 0) + 1, GOLDEN)));
    const words = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      x = (x + GOLDEN) >>> 0;
      words[i] = fmix32(x);
    }
    const [a = 0, b = 0, c = 0, d = 0] = words;
    // The all-zero state is the generator's only fixed point.
    return a | b | c | d ? new Prng(a, b, c, d) : new Prng(1, 0, 0, 0);
  }

  /** Raw state, for the reference vectors of the algorithm. */
  static fromState(state: readonly [number, number, number, number]): Prng {
    return new Prng(state[0] >>> 0, state[1] >>> 0, state[2] >>> 0, state[3] >>> 0);
  }

  nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Uniform in [0, 1), with 32 bits of resolution. */
  next(): number {
    return this.nextUint32() / TWO_POW_32;
  }

  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max], both included. */
  integer(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Standard normal (Box–Muller). */
  normal(): number {
    if (!Number.isNaN(this.spareNormal)) {
      const z = this.spareNormal;
      this.spareNormal = Number.NaN;
      return z;
    }
    let u = this.next();
    while (u === 0) u = this.next();
    const radius = Math.sqrt(-2 * Math.log(u));
    const angle = 2 * Math.PI * this.next();
    this.spareNormal = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  }
}
