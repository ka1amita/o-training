import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { GeneratedProvider, type RoundContext } from '@/lib/maps/provider.ts';
import { hashJson, seeded } from '@/lib/rng.ts';
import { CATEGORIES, SMALLEST_CATEGORY, symbolsIn } from '@/lib/symbols/index.ts';
import {
  matchMadness as drill,
  paramsFor,
  isMatch,
  choosePairs,
  type MatchRound,
} from './drill.ts';

const anySeed = fc.integer({ min: 0, max: 0xffffffff });
const anyLevel = fc.integer({ min: drill.bounds.min, max: drill.bounds.max });
const maps: RoundContext = { maps: new GeneratedProvider() };
const gen = (seed: number, level: number) => drill.generate(seeded(seed), level, maps);

describe('match madness / generate', () => {
  it('is well formed at every level, for any seed', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        expect(drill.wellFormed(gen(seed, level))).toEqual([]);
      }),
      { numRuns: 500 },
    );
  });

  it('gives every symbol on screen exactly one right answer', () => {
    // The invariant the whole drill rests on. Stated independently of wellFormed(), so a
    // mistake in that function cannot hide a mistake in the generator.
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const round = gen(seed, level);
        for (const symbolId of round.symbolOrder) {
          const matches = round.nameOrder.filter((n) => isMatch(round, symbolId, n));
          expect(matches).toHaveLength(1);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('asks for the number of pairs the level calls for', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        expect(gen(seed, level).pairs).toHaveLength(paramsFor(level).pairs);
      }),
    );
  });

  it('draws from a single category once the level calls for it', () => {
    fc.assert(
      fc.property(anySeed, fc.integer({ min: 4, max: 10 }), (seed, level) => {
        const round = gen(seed, level);
        const cats = new Set(
          round.pairs.map((p) => CATEGORIES.find((c) => symbolsIn(c).some((s) => s.id === p.symbolId))),
        );
        expect(cats.size).toBe(1);
      }),
      { numRuns: 200 },
    );
  });

  it('mixes categories below level 4 — otherwise the easy levels are not easier', () => {
    const mixed = Array.from({ length: 60 }, (_, s) => gen(s, 1)).filter((round) => {
      const cats = new Set(
        round.pairs.map((p) => CATEGORIES.find((c) => symbolsIn(c).some((s) => s.id === p.symbolId))),
      );
      return cats.size > 1;
    });
    expect(mixed.length).toBeGreaterThan(50);
  });

  it('shuffles the columns independently, so they do not line up', () => {
    const aligned = Array.from({ length: 100 }, (_, s) => gen(s, 1)).filter((r) =>
      r.symbolOrder.every((id, i) => r.pairs.find((p) => p.symbolId === id)!.name === r.nameOrder[i]),
    );
    // A handful of accidental alignments is expected; a hundred would mean one shuffle.
    expect(aligned.length).toBeLessThan(10);
  });

  it('never asks a category for more symbols than it has', () => {
    // The guard in generate() protects this, but the real fix is the numbers agreeing.
    const widest = Math.max(...Array.from({ length: 10 }, (_, i) => paramsFor(i + 1).pairs));
    expect(widest).toBeLessThanOrEqual(SMALLEST_CATEGORY);
  });

  it('refuses rather than silently shrinking when the pool is too small', () => {
    // Unreachable through paramsFor, which is why it is reached directly: a guard that
    // no test can trigger is a guard nothing would notice the removal of.
    expect(() =>
      choosePairs(seeded(1), { pairs: 20, sameCategory: true, msPerPair: 3000 }),
    ).toThrow(/asked for 20 pairs from a pool of \d+/);
    expect(() =>
      choosePairs(seeded(1), { pairs: 6, sameCategory: true, msPerPair: 3000 }),
    ).not.toThrow();
  });

  it('tightens the clock as the level rises', () => {
    const perPair = Array.from({ length: 10 }, (_, i) => paramsFor(i + 1).msPerPair);
    expect(perPair[0]).toBe(6000);
    expect(perPair[9]).toBe(3000);
    expect([...perPair].sort((a, b) => b - a)).toEqual(perPair);
  });
});

describe('match madness / determinism', () => {
  it('same seed and level, same round', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        expect(gen(seed, level)).toEqual(gen(seed, level));
      }),
    );
  });

  it('different seeds give different rounds', () => {
    const rounds = new Set(Array.from({ length: 100 }, (_, s) => hashJson(gen(s, 1))));
    expect(rounds.size).toBeGreaterThan(90);
  });

  // Golden. Pins the generator's output so a refactor that shifts it is loud.
  it('golden: fixed seeds at fixed levels', () => {
    const rounds = [1, 2, 3].flatMap((s) => [1, 5, 9].map((l) => gen(s, l)));
    expect(hashJson(rounds)).toMatchInlineSnapshot(`"c447f35d"`);
  });
});

describe('match madness / wellFormed detects what it claims to', () => {
  // A detector that never fires is worth nothing, so each invariant is broken on purpose.
  const good = gen(7, 1);
  const broken = (patch: Partial<MatchRound>): MatchRound => ({ ...good, ...patch });

  it('catches two symbols sharing a meaning', () => {
    const name = good.pairs[0]!.name;
    const pairs = good.pairs.map((p, i) => (i === 1 ? { ...p, name } : p));
    const problems = drill.wellFormed(
      broken({ pairs, nameOrder: pairs.map((p) => p.name) }),
    );
    expect(problems).toContain('two symbols share a meaning');
  });

  it('catches a repeated symbol', () => {
    const pairs = good.pairs.map((p, i) => (i === 1 ? { ...p, symbolId: good.pairs[0]!.symbolId } : p));
    expect(drill.wellFormed(broken({ pairs, symbolOrder: pairs.map((p) => p.symbolId) })))
      .toContain('a symbol appears twice');
  });

  it('catches a name that is not the symbol s own', () => {
    const pairs = good.pairs.map((p, i) => (i === 0 ? { ...p, name: 'Not a real meaning' } : p));
    expect(drill.wellFormed(broken({ pairs, nameOrder: pairs.map((p) => p.name) })).join(' '))
      .toContain('is not named');
  });

  it('catches an unknown symbol', () => {
    const pairs = good.pairs.map((p, i) => (i === 0 ? { ...p, symbolId: '99.9' } : p));
    expect(drill.wellFormed(broken({ pairs, symbolOrder: pairs.map((p) => p.symbolId) })))
      .toContain('unknown symbol 99.9');
  });

  it('catches a column that is not a permutation of the pairs', () => {
    expect(drill.wellFormed(broken({ nameOrder: ['x', 'y', 'z', 'w'] })))
      .toContain('nameOrder is not a permutation');
    expect(drill.wellFormed(broken({ symbolOrder: ['x', 'y', 'z', 'w'] })))
      .toContain('symbolOrder is not a permutation');
  });

  it('catches a non-positive clock', () => {
    expect(drill.wellFormed(broken({ timeLimitMs: 0 }))).toContain('timeLimitMs must be positive');
  });

  it('passes a round it should pass', () => {
    expect(drill.wellFormed(good)).toEqual([]);
  });
});

describe('match madness / score', () => {
  const round = gen(11, 1);
  const right = round.pairs.map((p) => ({ ...p, correct: true }));

  it('a clean round passes', () => {
    expect(drill.score(round, right)).toEqual({
      correct: round.pairs.length,
      total: round.pairs.length,
      passed: true,
    });
  });

  it('a wrong tap costs the pass but not the pair', () => {
    const withMistake = [
      { symbolId: round.pairs[0]!.symbolId, name: round.pairs[1]!.name, correct: false },
      ...right,
    ];
    const score = drill.score(round, withMistake);
    expect(score.correct).toBe(round.pairs.length);
    expect(score.passed).toBe(false);
  });

  it('running out of time scores the pairs actually found', () => {
    const score = drill.score(round, right.slice(0, 2));
    expect(score).toEqual({ correct: 2, total: round.pairs.length, passed: false });
  });

  it('counts a pair once even if it is somehow reported twice', () => {
    expect(drill.score(round, [...right, right[0]!]).correct).toBe(round.pairs.length);
  });

  it('an empty round scores zero rather than throwing', () => {
    expect(drill.score(round, [])).toEqual({
      correct: 0,
      total: round.pairs.length,
      passed: false,
    });
  });
});
