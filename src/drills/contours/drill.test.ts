import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { hashJson, seeded } from '@/lib/rng.ts';
import { maxHeightDifference } from '@/lib/terrain/height.ts';
import { goldenMap } from '@/lib/terrain/golden.ts';
import type { GeneratedMap } from '@/lib/terrain/terrain.ts';
import {
  contours as drill, distanceFor, OPTIONS, MIN_HEIGHT_DIFFERENCE, type ContoursRound,
} from './drill.ts';
import {
  mapMemory, CROP_SIZE, paramsFor as memoryParams, type MapMemoryRound,
} from '@/drills/mapMemory/drill.ts';
import { applyEdits, difference } from '@/lib/terrain/edits.ts';

const anySeed = fc.integer({ min: 0, max: 0xffffffff });
const anyLevel = fc.integer({ min: 1, max: 10 });
const gen = (seed: number, level: number) => drill.generate(seeded(seed), level);

/** What a round would actually show, made from its edits. */
const materialise = (round: ContoursRound | MapMemoryRound) =>
  round.variants.map((v) => applyEdits(v.base, v.edits) as GeneratedMap);

/**
 * The generator's decisions, not the shape of the round. See `goldenMap` — the field
 * names here are part of the hash and are frozen, so they are not the round's own.
 */
const golden = (round: ContoursRound) => ({
  options: materialise(round).map(goldenMap),
  correctIndex: round.correctIndex,
});

describe('contours / generate', () => {
  it('is well formed at every level, for any seed', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        expect(drill.wellFormed(gen(seed, level))).toEqual([]);
      }),
      { numRuns: 80 },
    );
  });

  it('gives the round exactly one right relief', () => {
    // Stated apart from wellFormed. A distractor whose moved landform barely dents the
    // shading is a second correct answer, and it is invisible while playing.
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const round = gen(seed, level);
        // Materialised on purpose: `wellFormed` reads the edits, and this reads the
        // ground they produce, so a mistake in one cannot hide a mistake in the other.
        const options = materialise(round);
        const answer = options[round.correctIndex]!;
        const identical = options.filter(
          (o, i) =>
            i !== round.correctIndex &&
            maxHeightDifference(answer.relief, o.relief) < MIN_HEIGHT_DIFFERENCE,
        );
        expect(identical).toHaveLength(0);
      }),
      { numRuns: 80 },
    );
  });

  it('offers four reliefs and points at one of them', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const round = gen(seed, level);
        expect(round.variants).toHaveLength(OPTIONS);
        expect(round.correctIndex).toBeGreaterThanOrEqual(0);
        expect(round.correctIndex).toBeLessThan(OPTIONS);
      }),
    );
  });

  it('puts the answer in every slot across many rounds', () => {
    // A correct index that favoured one position would be learnable without looking.
    const seen = new Set(Array.from({ length: 80 }, (_, s) => gen(s, 5).correctIndex));
    expect(seen.size).toBe(OPTIONS);
  });

  it('carries no features that have no relief', () => {
    // Boulders and paths say nothing about the shape of the ground, and on a card that is
    // only about the ground they are noise the player has to learn to ignore.
    const round = gen(4, 6);
    for (const option of materialise(round)) expect(option.features).toHaveLength(0);
  });

  it('moves the landform less as the level rises', () => {
    const distances = Array.from({ length: 10 }, (_, i) => distanceFor(i + 1));
    expect(distances[0]).toBe(70);
    expect(distances[9]).toBe(20);
    expect([...distances].sort((a, b) => b - a)).toEqual(distances);
  });

  it('is harder at level 10 than at level 1, measured on the relief', () => {
    const spread = (level: number) => {
      const round = gen(9, level);
      const options = materialise(round);
      const answer = options[round.correctIndex]!;
      return Math.min(
        ...options
          .filter((_, i) => i !== round.correctIndex)
          .map((o) => maxHeightDifference(answer.relief, o.relief)),
      );
    };
    expect(spread(10)).toBeLessThan(spread(1));
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        expect(gen(seed, level)).toEqual(gen(seed, level));
      }),
      { numRuns: 40 },
    );
  });

  it('golden: fixed seeds at fixed levels', () => {
    expect(hashJson([1, 2].flatMap((s) => [1, 5, 10].map((l) => golden(gen(s, l))))))
      .toMatchInlineSnapshot(`"9818605d"`);
  });
});

describe('contours / wellFormed detects what it claims to', () => {
  const good = gen(3, 5);

  it('catches a distractor identical to the answer', () => {
    const answer = good.variants[good.correctIndex]!;
    const broken: ContoursRound = {
      ...good,
      variants: good.variants.map((v, i) => (i === good.correctIndex ? v : answer)),
    };
    expect(drill.wellFormed(broken).join(' ')).toContain('differs from the answer by only');
  });

  it('catches a correctIndex pointing nowhere', () => {
    expect(drill.wellFormed({ ...good, correctIndex: 9 }).join(' ')).toContain('is not an option');
  });

  it('catches the wrong number of options', () => {
    expect(drill.wellFormed({ ...good, variants: good.variants.slice(1) }).join(' '))
      .toContain('options, expected');
  });

  it('passes a round it should pass', () => {
    expect(drill.wellFormed(good)).toEqual([]);
  });
});

describe('contours / score', () => {
  const round = gen(3, 5);
  it('the first tap decides', () => {
    expect(drill.score(round, [{ index: round.correctIndex, correct: true }]))
      .toEqual({ correct: 1, total: 1, passed: true });
    expect(drill.score(round, [{ index: 0, correct: false }, { index: 1, correct: true }]))
      .toEqual({ correct: 0, total: 1, passed: false });
  });

  it('no answer scores zero rather than throwing', () => {
    expect(drill.score(round, [])).toEqual({ correct: 0, total: 1, passed: false });
  });
});

describe('map memory / generate', () => {
  const memGen = (seed: number, level: number) => mapMemory.generate(seeded(seed), level);
  const goldenMemory = (round: MapMemoryRound) => ({
    options: materialise(round).map(goldenMap),
    correctIndex: round.correctIndex,
    crop: round.crop,
    exposureMs: round.exposureMs,
  });

  it('is well formed at every level, for any seed', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        expect(mapMemory.wellFormed(memGen(seed, level))).toEqual([]);
      }),
      { numRuns: 80 },
    );
  });

  it('makes every distractor differ inside the window', () => {
    // The failure this drill is most exposed to: a feature moved off-screen leaves two
    // identical cards, and the round then has two right answers.
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const round = memGen(seed, level);
        round.variants.forEach((variant, index) => {
          if (index === round.correctIndex) return;
          expect(difference(variant, round.crop).visible).toBe(true);
        });
      }),
      { numRuns: 80 },
    );
  });

  it('keeps the window on the map', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const round = memGen(seed, level);
        const size = round.base.width;
        expect(round.crop.x).toBeGreaterThanOrEqual(0);
        expect(round.crop.y).toBeGreaterThanOrEqual(0);
        expect(round.crop.x + CROP_SIZE).toBeLessThanOrEqual(size);
        expect(round.crop.y + CROP_SIZE).toBeLessThanOrEqual(size);
      }),
      { numRuns: 80 },
    );
  });

  it('shows every candidate through the same window', () => {
    const round = memGen(11, 5);
    expect(round.crop.size).toBe(CROP_SIZE);
  });

  it('gives less time and less to notice as the level rises', () => {
    const easy = memoryParams(1);
    const hard = memoryParams(10);
    expect(easy.exposureMs).toBe(6000);
    expect(hard.exposureMs).toBe(1800);
    expect(hard.distance).toBeLessThan(easy.distance);
  });

  it('catches a distractor identical inside the window', () => {
    const good = memGen(3, 5);
    const answer = good.variants[good.correctIndex]!;
    const broken = {
      ...good,
      variants: good.variants.map((v, i) => (i === good.correctIndex ? v : answer)),
    };
    expect(mapMemory.wellFormed(broken).join(' ')).toContain('identical to the answer');
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        expect(memGen(seed, level)).toEqual(memGen(seed, level));
      }),
      { numRuns: 30 },
    );
  });

  it('golden: fixed seeds at fixed levels', () => {
    expect(hashJson([1, 2].flatMap((s) => [1, 5, 10].map((l) => goldenMemory(memGen(s, l))))))
      .toMatchInlineSnapshot(`"34ec53bd"`);
  });
});
