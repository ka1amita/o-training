import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { seeded, hashJson } from './rng.ts';

const anySeed = fc.integer({ min: 0, max: 0xffffffff });

describe('seeded', () => {
  it('is deterministic: one seed, one stream', () => {
    fc.assert(
      fc.property(anySeed, (s) => {
        const a = Array.from({ length: 50 }, () => seeded(s).next());
        const b = Array.from({ length: 50 }, () => seeded(s).next());
        expect(a).toEqual(b);
      }),
    );
  });

  it('produces different streams for different seeds', () => {
    const draw = (s: number) => Array.from({ length: 8 }, () => seeded(s).next()).join(',');
    const streams = new Set(Array.from({ length: 200 }, (_, i) => draw(i)));
    expect(streams.size).toBe(200);
  });

  it('never returns a fixed point, including from seed 0', () => {
    for (const seed of [0, 1, 0xffffffff]) {
      const r = seeded(seed);
      const drawn = new Set(Array.from({ length: 100 }, () => r.next()));
      expect(drawn.size).toBeGreaterThan(90);
    }
  });

  it('float() stays in [0, 1)', () => {
    fc.assert(
      fc.property(anySeed, (s) => {
        const r = seeded(s);
        for (let i = 0; i < 100; i++) {
          const f = r.float();
          expect(f).toBeGreaterThanOrEqual(0);
          expect(f).toBeLessThan(1);
        }
      }),
    );
  });

  it('int() stays in range', () => {
    fc.assert(
      fc.property(anySeed, fc.integer({ min: 1, max: 1000 }), (s, n) => {
        const r = seeded(s);
        for (let i = 0; i < 50; i++) {
          const v = r.int(n);
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThan(n);
        }
      }),
    );
  });

  it('int() rejects a non-positive bound rather than returning NaN', () => {
    const r = seeded(1);
    expect(() => r.int(0)).toThrow(RangeError);
    expect(() => r.int(-3)).toThrow(RangeError);
    expect(() => r.int(2.5)).toThrow(RangeError);
  });

  it('int() is close to uniform', () => {
    // A modulo-biased generator skews the low buckets; 6 buckets over 60k draws
    // puts every count within a couple of percent of 10k.
    const r = seeded(12345);
    const counts = new Array<number>(6).fill(0);
    for (let i = 0; i < 60_000; i++) counts[r.int(6)]! += 1;
    for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(600);
  });

  it('shuffle() permutes without mutating its input', () => {
    fc.assert(
      fc.property(anySeed, fc.array(fc.integer(), { minLength: 1, maxLength: 40 }), (s, xs) => {
        const before = [...xs];
        const out = seeded(s).shuffle(xs);
        expect(xs).toEqual(before);
        expect([...out].sort((a, b) => a - b)).toEqual([...xs].sort((a, b) => a - b));
      }),
    );
  });

  it('shuffle() actually moves things', () => {
    const xs = Array.from({ length: 20 }, (_, i) => i);
    const moved = Array.from({ length: 20 }, (_, s) => seeded(s).shuffle(xs)).filter(
      (out) => out.join() !== xs.join(),
    );
    expect(moved.length).toBe(20);
  });

  it('pick() refuses an empty array', () => {
    expect(() => seeded(1).pick([])).toThrow(RangeError);
  });
});

describe('hashJson', () => {
  it('is stable and distinguishes structure', () => {
    expect(hashJson({ a: 1 })).toBe(hashJson({ a: 1 }));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
    expect(hashJson([1, 2])).not.toBe(hashJson([2, 1]));
  });

  // Pins the stream itself. If a refactor changes what seed 1 produces, two devices
  // stop agreeing on a Dobble deck — and nothing else in the suite would notice.
  it('golden: the uint32 stream for a fixed seed', () => {
    const r = seeded(1);
    const draws = Array.from({ length: 16 }, () => r.next());
    expect(hashJson(draws)).toMatchInlineSnapshot(`"311a74f6"`);
  });
});
