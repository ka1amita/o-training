import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { loadBundle, type MapBundle } from '@/lib/maps/bundle.ts';
import {
  AdjustedProvider, GeneratedProvider, LibraryProvider, type RoundContext,
} from '@/lib/maps/provider.ts';
import { hashJson, seeded } from '@/lib/rng.ts';
import { applyEdits, difference } from '@/lib/terrain/edits.ts';
import { MIN_SALIENCE } from '@/lib/terrain/enrich.ts';
import { pointsOf, positionOf, type Vec } from '@/lib/terrain/omap.ts';
import Play from './Play.tsx';
import {
  mapDiff as drill, budgetFor, requirementFor, targetsFor, timeLimitFor,
  MAX_TARGET_FRACTION, type MapDiffAnswer, type MapDiffRound,
} from './drill.ts';
import { targetAt } from './state.ts';

/**
 * The discrepancy drill, on all three kinds of ground.
 *
 * What has to hold is the thing this app has always asked of a round: **one tap, one
 * interpretation**. Here that is a geometric claim rather than a combinatorial one — the
 * targets are discs and the discs must not meet — so most of what follows measures
 * distances, and the one property that matters most is the one that fires random taps at a
 * round and counts how many of them could be read two ways.
 */
const generated: RoundContext = { maps: new GeneratedProvider() };

const bundleJson = JSON.parse(
  readFileSync(new URL('../../../public/maps/forest-sample.json', import.meta.url), 'utf8'),
) as MapBundle;
const forest = loadBundle(bundleJson);
const library = new LibraryProvider([forest]);
const real: RoundContext = { maps: library };
const adjusted: RoundContext = { maps: new AdjustedProvider(library, 1) };

const anySeed = fc.integer({ min: 0, max: 0xffffffff });
const anyLevel = fc.integer({ min: drill.bounds.min, max: drill.bounds.max });
const gen = (seed: number, level: number, ctx: RoundContext = generated): MapDiffRound =>
  drill.generate(seeded(seed), level, ctx);

const LEVELS = [1, 5, 10];
/** Generated ground is made to order, so it can be asked more often than a bundle. */
const GENERATED_SEEDS = 40;
const LIBRARY_SEEDS = 20;

/** Every ground a round can be on, and how many seeds each is worth asking. */
const GROUNDS: readonly { name: string; ctx: RoundContext; seeds: number }[] = [
  { name: 'generated', ctx: generated, seeds: GENERATED_SEEDS },
  { name: 'forest sample', ctx: real, seeds: LIBRARY_SEEDS },
  { name: 'adjusted forest sample', ctx: adjusted, seeds: LIBRARY_SEEDS },
];

describe('map vs reality / generate', () => {
  it('is well formed at every level, for any seed', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        expect(drill.wellFormed(gen(seed, level))).toEqual([]);
      }),
      { numRuns: 120 },
    );
  });

  it('is well formed on every ground the app can put it on', () => {
    const counts: string[] = [];
    for (const ground of GROUNDS) {
      for (const level of LEVELS) {
        let good = 0;
        const ks: number[] = [];
        for (let seed = 0; seed < ground.seeds; seed++) {
          const round = gen(seed, level, ground.ctx);
          const problems = drill.wellFormed(round);
          expect(problems, `${ground.name} level ${level} seed ${seed}`).toEqual([]);
          good++;
          ks.push(round.targets.length);
        }
        const mean = ks.reduce((sum, k) => sum + k, 0) / ks.length;
        counts.push(
          `${ground.name} level ${level}: ${good}/${ground.seeds} well formed, `
          + `k = ${mean.toFixed(2)} (asked ${targetsFor(level)}), least ${Math.min(...ks)}`,
        );
        expect(good).toBe(ground.seeds);
      }
    }
    console.log(counts.join('\n'));
  });

  it('is deterministic: the same seed, level and provider give the same round', () => {
    for (const ground of GROUNDS) {
      for (const level of LEVELS) {
        expect(hashJson(gen(9, level, ground.ctx)), `${ground.name} ${level}`)
          .toBe(hashJson(gen(9, level, ground.ctx)));
      }
    }
  });

  it('asks for more changes and less time for each of them, higher up', () => {
    const ks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(targetsFor);
    expect(ks).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    // The budget asks for more than the round keeps, because a fifth of what is proposed
    // lands on top of something already claimed or is too big to be a place — and never
    // less, or the level could not reach its own `k`.
    for (let level = 1; level <= 10; level++) {
      const budget = budgetFor(level);
      const slots = budget.adds + budget.removes + budget.swaps + budget.moves;
      expect(slots, `level ${level}`).toBeGreaterThan(targetsFor(level));
      expect(budget.adds).toBeGreaterThanOrEqual(Math.ceil(targetsFor(level) / 2));
    }
    // All four operations by the top of the ladder: an added symbol is the loudest
    // question and a swapped one the quietest, and a full card asks both.
    const top = budgetFor(10);
    expect(Math.min(top.adds, top.removes, top.swaps, top.moves)).toBeGreaterThan(0);
    expect(timeLimitFor(1, 1)).toBeGreaterThan(timeLimitFor(10, 1));
    expect(timeLimitFor(10, 5)).toBeGreaterThan(timeLimitFor(10, 1));
  });

  it('changes the card and never the window it is cut from', () => {
    for (const level of LEVELS) {
      const round = gen(4, level);
      const shown = applyEdits(round.base, round.edits);
      expect(shown).not.toBe(round.base);
      // The base is what the provider handed over, untouched: the card is made from it
      // and the answer key is the difference between the two.
      expect(round.base.width).toBe(shown.width);
      expect(round.crop.size).toBe(requirementFor(level).crop);
    }
  });
});

describe('map vs reality / one tap, one answer', () => {
  /**
   * The invariant, measured where it lives: no point on the card is inside two targets.
   *
   * `wellFormed` asserts the same thing as a distance between centres, which is the
   * algebra; this fires taps at the card and counts the interpretations, which is the
   * geometry. Both, because the algebra is what the drill enforces and a mistake in it
   * would be invisible to a test that asked it about itself.
   */
  const ambiguous = (round: MapDiffRound, taps: readonly Vec[]): number => {
    let worst = 0;
    for (const at of taps) {
      const hits = round.targets.filter((target) =>
        Math.hypot(target.at.x - at.x, target.at.y - at.y) - target.radius <= round.tolerance,
      ).length;
      worst = Math.max(worst, hits);
    }
    return worst;
  };

  const lattice = (round: MapDiffRound, steps: number): Vec[] => {
    const out: Vec[] = [];
    for (let j = 0; j <= steps; j++) {
      for (let i = 0; i <= steps; i++) {
        out.push({
          x: round.crop.x + (i * round.crop.size) / steps,
          y: round.crop.y + (j * round.crop.size) / steps,
        });
      }
    }
    return out;
  };

  it('no tap anywhere on the card can be read as two changes', () => {
    for (const ground of GROUNDS) {
      for (const level of LEVELS) {
        for (let seed = 0; seed < ground.seeds; seed++) {
          const round = gen(seed, level, ground.ctx);
          expect(
            ambiguous(round, lattice(round, 120)),
            `${ground.name} level ${level} seed ${seed}`,
          ).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('and `targetAt` agrees with the discs the round carries', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }), (seed, level, u, v) => {
          const round = gen(seed, level);
          const at = {
            x: round.crop.x + u * round.crop.size,
            y: round.crop.y + v * round.crop.size,
          };
          const found = targetAt(round, at);
          const inside = round.targets.findIndex((target) =>
            Math.hypot(target.at.x - at.x, target.at.y - at.y) - target.radius <= round.tolerance);
          expect(found).toBe(inside === -1 ? null : inside);
        }),
      { numRuns: 200 },
    );
  });

  it('a tapper with no idea where to look scores near nothing', () => {
    // The number that says the score is a measurement rather than a lottery: `k` taps
    // thrown uniformly at the card, counted as the drill would count them.
    const lines: string[] = [];
    for (const ground of GROUNDS) {
      for (const level of LEVELS) {
        let hits = 0;
        let targets = 0;
        let passed = 0;
        const rng = seeded(0xbeef + level);
        for (let seed = 0; seed < ground.seeds; seed++) {
          const round = gen(seed, level, ground.ctx);
          const answers: MapDiffAnswer[] = [];
          for (let tap = 0; tap < round.targets.length; tap++) {
            const at = {
              x: round.crop.x + rng.range(0, round.crop.size),
              y: round.crop.y + rng.range(0, round.crop.size),
            };
            answers.push({ at, target: targetAt(round, at) });
          }
          const score = drill.score(round, answers);
          hits += score.correct;
          targets += score.total;
          if (score.passed) passed++;
        }
        lines.push(
          `${ground.name} level ${level}: random tapper ${hits}/${targets} `
          + `(${((100 * hits) / targets).toFixed(1)}%), passed ${passed}/${ground.seeds}`,
        );
        expect(hits / targets).toBeLessThan(0.2);
      }
    }
    console.log(lines.join('\n'));
  });
});

describe('map vs reality / every change can be found', () => {
  it('is inside the card and loud enough to see', () => {
    for (const ground of GROUNDS) {
      for (const level of LEVELS) {
        for (let seed = 0; seed < ground.seeds; seed++) {
          const round = gen(seed, level, ground.ctx);
          for (const edit of round.edits) {
            const report = difference({ base: round.base, edits: [edit] }, round.crop);
            expect(report.visible, `${ground.name} ${level} ${seed}`).toBe(true);
            expect(report.salience).toBeGreaterThanOrEqual(MIN_SALIENCE);
          }
        }
      }
    }
  });

  it('is a place on the card rather than the card', () => {
    for (const level of LEVELS) {
      for (let seed = 0; seed < GENERATED_SEEDS; seed++) {
        for (const target of gen(seed, level).targets) {
          expect(target.radius).toBeLessThanOrEqual(180 * MAX_TARGET_FRACTION);
          expect(target.radius).toBeGreaterThan(0);
        }
      }
    }
  });

  it('is named in the words a control description uses', () => {
    const words = new Set<string>();
    for (const ground of GROUNDS) {
      for (const level of LEVELS) {
        for (let seed = 0; seed < ground.seeds; seed++) {
          for (const target of gen(seed, level, ground.ctx).targets) words.add(target.word);
        }
      }
    }
    // Every word says what happened and what it happened to, and none of them fell back
    // to the "feature" of a code the answer space cannot name.
    for (const word of words) {
      expect(word, word).toMatch(/^(new .+|.+ gone|.+ moved|.+ drawn as .+|the ground has moved)$/);
    }
    expect([...words].some((w) => w.startsWith('new '))).toBe(true);
    console.log(`${words.size} distinct words: ${[...words].sort().slice(0, 12).join(', ')}…`);
  });

  it('really does put the change on the card it draws', () => {
    // The card is `base + edits`, so an added boulder is a feature the base does not have
    // and stands where the target says. Read off the two maps, which is what a test may do
    // and the drill may not.
    const round = gen(12, 10);
    const shown = applyEdits(round.base, round.edits);
    const added = round.edits.filter((e) => e.op === 'add');
    expect(added.length).toBeGreaterThan(0);
    for (const edit of added) {
      const now = pointsOf(shown).find((f) => f.id === edit.feature.id);
      expect(now).toBeDefined();
      expect(pointsOf(round.base).some((f) => f.id === edit.feature.id)).toBe(false);
      const at = positionOf(now!);
      expect(targetAt(round, at)).not.toBeNull();
    }
  });
});

describe('map vs reality / score', () => {
  const round = gen(3, 9);
  const hitOn = (index: number): MapDiffAnswer => ({
    at: round.targets[index]!.at,
    target: index,
  });

  it('is the changes found over the changes there were', () => {
    expect(round.targets.length).toBeGreaterThanOrEqual(2);
    expect(drill.score(round, [])).toEqual({
      correct: 0, total: round.targets.length, passed: false,
    });
    const all = round.targets.map((_, i) => hitOn(i));
    expect(drill.score(round, all)).toEqual({
      correct: round.targets.length, total: round.targets.length, passed: true,
    });
  });

  it('passes at three quarters of them, rounded up', () => {
    const k = round.targets.length;
    const needed = Math.ceil(0.75 * k);
    const enough = round.targets.slice(0, needed).map((_, i) => hitOn(i));
    expect(drill.score(round, enough).passed).toBe(true);
    if (needed > 1) {
      expect(drill.score(round, enough.slice(0, needed - 1)).passed).toBe(false);
    }
  });

  it('counts a change once however often it was tapped', () => {
    expect(drill.score(round, [hitOn(0), hitOn(0), hitOn(0)]).correct).toBe(1);
  });

  it('ignores a tap that found nothing, and one that names a target the round has not', () => {
    const nowhere: MapDiffAnswer = { at: { x: 0, y: 0 }, target: null };
    const bogus: MapDiffAnswer = { at: { x: 0, y: 0 }, target: 99 };
    expect(drill.score(round, [nowhere, bogus, hitOn(1)]).correct).toBe(1);
  });
});

describe('map vs reality / wellFormed detects what it claims to', () => {
  const good = gen(6, 10);

  it('passes a round it should pass', () => {
    expect(drill.wellFormed(good)).toEqual([]);
    expect(good.targets.length).toBeGreaterThanOrEqual(2);
  });

  it('catches a round with nothing changed', () => {
    expect(drill.wellFormed({ ...good, edits: [], targets: [] }).join(' '))
      .toContain('no answer');
  });

  it('catches a target without its edit', () => {
    expect(drill.wellFormed({ ...good, targets: good.targets.slice(1) }).join(' '))
      .toContain('targets for');
  });

  it('catches two targets one tap could answer', () => {
    const piled = good.targets.map((t, i) => (i === 0 ? { ...t, at: good.targets[1]!.at } : t));
    expect(drill.wellFormed({ ...good, targets: piled }).join(' '))
      .toContain('can be answered by one tap');
  });

  it('catches a target that is the whole card', () => {
    const huge = good.targets.map((t, i) => (i === 0 ? { ...t, radius: good.crop.size } : t));
    expect(drill.wellFormed({ ...good, targets: huge }).join(' '))
      .toContain('rather than a place on it');
  });

  it('catches a target off the card', () => {
    const away = good.targets.map((t, i) =>
      (i === 0 ? { ...t, at: { x: good.crop.x - 500, y: good.crop.y - 500 } } : t));
    expect(drill.wellFormed({ ...good, targets: away }).join(' ')).toContain('off the card');
  });

  it('catches a change that does not show inside the card', () => {
    // The window moved rather than the edit: the same edits, framed somewhere they cannot
    // be seen, which is the failure `difference().visible` exists to catch.
    const elsewhere = {
      ...good,
      crop: { x: 0, y: 0, size: good.crop.size },
      targets: [],
      edits: good.edits,
    };
    expect(drill.wellFormed(elsewhere).join(' ')).toContain('not inside the card');
  });

  it('catches a window that runs off the map', () => {
    const off = { ...good, crop: { ...good.crop, x: good.base.width - 1 } };
    expect(drill.wellFormed(off).join(' ')).toContain('runs off the map');
  });
});

describe('map vs reality / golden', () => {
  it('fixed seeds at fixed levels', () => {
    // Over the drill's **decisions** and not the map that carries them, as `goldenMap` and
    // every other drill's golden are: the window, what was changed, where the changes are
    // and what they are called. The ground is pinned by the terrain golden, and a map that
    // changed would come through here as different edits in different places.
    const golden = (round: MapDiffRound) => ({
      crop: round.crop,
      edits: round.edits,
      targets: round.targets,
      tolerance: round.tolerance,
      timeLimitMs: round.timeLimitMs,
      withOriginal: round.withOriginal,
    });
    const rounds = [1, 2].flatMap((s) => [1, 5, 9].map((l) => golden(gen(s, l))));
    expect(hashJson(rounds)).toMatchInlineSnapshot(`"cc1a705e"`);
  });
});

describe('map vs reality / Play draws both phases', () => {
  const render = (round: MapDiffRound, phase: 'play' | 'review', answers?: MapDiffAnswer[]) =>
    renderToStaticMarkup(createElement(Play, {
      round, level: 5, phase, answers, onDone: () => {},
    }));

  it('draws the card in play, and the reveal with every change on it', () => {
    const round = gen(5, 10);
    const playing = render(round, 'play');
    expect(playing).toContain('<svg');
    expect(playing).toContain('taps left');
    // Nothing is marked while playing: a verdict on the card would let a player feel
    // their way to a change instead of reading the map.
    expect(playing).not.toContain('aria-label="correct"');
    expect(playing).not.toContain('aria-label="wrong"');

    const answers: MapDiffAnswer[] = [{ at: round.targets[0]!.at, target: 0 }];
    const reviewing = render(round, 'review', answers);
    expect(reviewing).toContain('aria-label="correct"');
    expect(reviewing).toContain('aria-label="wrong"');
    for (const target of round.targets) expect(reviewing).toContain(target.word);
    expect(reviewing).toContain('The map as it was');
    // And it takes no more taps.
    expect(reviewing).not.toContain('Nothing else');
  });

  it('puts the original beside the card at the bottom of the ladder and not above it', () => {
    expect(render(gen(5, 1), 'play')).toContain('The map as it was');
    expect(render(gen(5, 10), 'play')).not.toContain('The map as it was');
  });
});
