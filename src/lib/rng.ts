/**
 * xoshiro128** — a small, fast, well-distributed 32-bit generator.
 *
 * Every generator in this app takes an Rng as a parameter and nothing reaches for
 * Math.random. That is what makes `generate(seeded(s), lvl)` reproducible, which two
 * separate things depend on: the golden tests, and peer-to-peer Dohledávka, where both
 * peers derive an identical deck from a shared seed rather than sending one over the wire.
 */
export interface Rng {
  /** Raw uint32. */
  next(): number;
  /** Uniform in [0, 1). */
  float(): number;
  /** Uniform integer in [0, maxExclusive). Unbiased. */
  int(maxExclusive: number): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  pick<T>(xs: readonly T[]): T;
  /** Fisher–Yates. Returns a new array; the input is not touched. */
  shuffle<T>(xs: readonly T[]): T[];
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/**
 * splitmix32, used only to expand a single seed into the four state words.
 * Seeding xoshiro directly from one number leaves most of the state zero, and a
 * near-zero state produces visibly poor output for the first few dozen draws.
 */
function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export function seeded(seed: number): Rng {
  const mix = splitmix32(seed >>> 0);
  let s0 = mix();
  let s1 = mix();
  let s2 = mix();
  let s3 = mix();
  // An all-zero state is a fixed point that only ever returns 0.
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;

  const next = (): number => {
    const result = (Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0);
    const t = (s1 << 9) >>> 0;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11);
    s0 >>>= 0;
    s1 >>>= 0;
    s2 >>>= 0;
    s3 >>>= 0;
    return result;
  };

  const rng: Rng = {
    next,
    float: () => next() / 0x1_0000_0000,
    int(maxExclusive: number): number {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError(`int() needs a positive integer bound, got ${maxExclusive}`);
      }
      // Rejection sampling. Plain `next() % n` over-represents the low residues
      // whenever n does not divide 2^32 — small, but it would bias a shuffle and
      // therefore which symbol lands where on a Dobble card.
      const limit = 0x1_0000_0000 - (0x1_0000_0000 % maxExclusive);
      let x = next();
      while (x >= limit) x = next();
      return x % maxExclusive;
    },
    range(min: number, max: number): number {
      return min + rng.float() * (max - min);
    },
    pick<T>(xs: readonly T[]): T {
      if (xs.length === 0) throw new RangeError('pick() from an empty array');
      return xs[rng.int(xs.length)]!;
    },
    shuffle<T>(xs: readonly T[]): T[] {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
  return rng;
}

/** A stable structural hash, for golden tests that pin generator output. */
export function hashJson(value: unknown): string {
  const text = JSON.stringify(value);
  // FNV-1a, 32-bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * A per-round seed derived from a session's base seed.
 *
 * Rounds must not simply be consecutive draws from one stream: a player who reloads
 * mid-session has to land on the same round they left, and a P2P peer joining at round 4
 * has to generate round 4 without having generated 0 through 3.
 */
export function deriveSeed(base: number, index: number): number {
  let h = (base ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15;
  return h >>> 0;
}
