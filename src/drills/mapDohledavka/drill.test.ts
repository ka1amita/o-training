import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { GeneratedProvider, type MapProvider, type RoundContext } from '@/lib/maps/provider.ts';
import { hashJson, seeded, type Rng } from '@/lib/rng.ts';
import type { Crop, Feature, OMap, Vec } from '@/lib/terrain/omap.ts';
import { semanticsOf } from '@/lib/terrain/semantics.ts';
import {
  mapDohledavka as drill, paramsFor, requirementFor, CIRCLE_FRACTION,
  type Control, type MapDobbleRound,
} from './drill.ts';
import { clearanceFrom, wordFor, type ControlKind } from './features.ts';

/**
 * A library of `windows` windows cut from one piece of ground, and nothing else.
 *
 * The shape the real `LibraryProvider` has when a device holds one small bundle: it draws
 * uniformly, it has no memory, and at one window it can only ever answer with the same
 * ground. Standing in for it here keeps the test about the drill rather than about which
 * windows a particular bundle happens to carry.
 */
class Shelf implements MapProvider {
  readonly id: string;

  constructor(
    private readonly ground: { map: OMap; crop: Crop },
    private readonly windows: number,
    /** How far apart the windows are, as a share of one. 0 stacks them almost exactly. */
    private readonly stride = 0.002,
  ) {
    this.id = `shelf:${windows}:${stride}`;
  }

  pick(rng: Rng): { map: OMap; crop: Crop } {
    const { map, crop } = this.ground;
    const step = rng.int(this.windows) * this.stride * crop.size;
    return { map, crop: { ...crop, x: crop.x + step, y: crop.y + step } };
  }
}

/** How much of one card's ground the other also shows. */
const shared = (a: MapDobbleRound['cards'][number], b: MapDobbleRound['cards'][number]): number => {
  if (a.map !== b.map) return 0;
  const w = Math.min(a.crop.x + a.crop.size, b.crop.x + b.crop.size) - Math.max(a.crop.x, b.crop.x);
  const h = Math.min(a.crop.y + a.crop.size, b.crop.y + b.crop.size) - Math.max(a.crop.y, b.crop.y);
  return w > 0 && h > 0 ? (w * h) / (a.crop.size * a.crop.size) : 0;
};

const anySeed = fc.integer({ min: 0, max: 0xffffffff });
const anyLevel = fc.integer({ min: drill.bounds.min, max: drill.bounds.max });
const maps: RoundContext = { maps: new GeneratedProvider() };
const gen = (seed: number, level: number) => drill.generate(seeded(seed), level, maps);

/**
 * The shape a feature is drawn as, whatever its geometry — one point, a line, or the ring
 * of an outline. The tests below ask the map directly rather than through `sitesOf`.
 */
const shapeOf = (feature: Feature): readonly Vec[] =>
  feature.geometry.kind === 'point' ? [feature.geometry.at]
  : feature.geometry.kind === 'polyline' ? feature.geometry.points
  : feature.geometry.rings[0]!;

/** How far the drawn thing is from `p`, which is zero anywhere on it. */
const distanceTo = (feature: Feature, p: Vec): number =>
  clearanceFrom({ shape: shapeOf(feature), reach: 0 }, p);

/**
 * The words on this map that a ring at `p` would hold, ignoring the drill's own view.
 *
 * The two exemptions are restated here rather than imported, because a test that asks the
 * rule about itself cannot catch the rule being wrong: **ground cover** is the wash under
 * everything and not a thing standing in it, and a **form of the ground** does not shadow
 * the symbol that names it.
 */
const GROUND_COVER = new Set<ControlKind>([
  'open', 'thicket', 'cultivated', 'brokenGround', 'boulderField',
  'stonyGround', 'sandyGround', 'rock', 'marsh', 'paved', 'vegetationBoundary',
]);

function wordsInRing(map: OMap, p: Vec, radius: number): Set<ControlKind> {
  const words = new Set<ControlKind>();
  for (const feature of map.features) {
    const word = wordFor(feature.code);
    if (!word) continue;
    if (feature.geometry.kind === 'polygon' && GROUND_COVER.has(word)) continue;
    if (semanticsOf(feature.code)?.reliefBound && feature.geometry.kind === 'point') continue;
    if (distanceTo(feature, p) < radius) words.add(word);
  }
  return words;
}

describe('map dohledavka / generate', () => {
  it('is well formed at every level, for any seed', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        expect(drill.wellFormed(gen(seed, level))).toEqual([]);
      }),
      { numRuns: 50 },
    );
  });

  it('gives the round exactly one answer', () => {
    // Stated apart from wellFormed, so a mistake there cannot hide one here.
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const [a, b] = gen(seed, level).cards;
        const common = a.controls
          .map((c) => c.kind)
          .filter((kind) => b.controls.some((c) => c.kind === kind));
        expect(common).toHaveLength(1);
      }),
      { numRuns: 50 },
    );
  });

  it('circles a feature the map really has', () => {
    // The one rule: the answer comes from the round's structure. A circle whose kind is
    // not what the terrain put there would be a question the card cannot answer, and
    // this asks the terrain directly rather than through `sitesOf`.
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const round = gen(seed, level);
        for (const card of round.cards) {
          for (const control of card.controls) {
            const at = { x: control.x, y: control.y };
            // Drawn: the circle is **on** the thing, whatever it is drawn as — the point
            // itself, a place on the line, a place on the outline.
            const drawn = card.map.features.some(
              (f) => wordFor(f.code) === control.kind && distanceTo(f, at) < 0.001,
            );
            const relief = (card.map.analysis?.landforms ?? []).some(
              (f) =>
                f.kind === control.kind &&
                Math.hypot(f.centre.x - control.x, f.centre.y - control.y) <= f.radius,
            );
            expect(drawn || relief, `${control.kind} at ${control.x},${control.y}`).toBe(true);
          }
        }
      }),
      { numRuns: 40 },
    );
  });

  it('leaves nothing else nameable inside a ring', () => {
    // The drill's version of "no two symbols overlap". Checked here against the terrain's
    // own point and area features, whose positions are exact.
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const round = gen(seed, level);
        for (const card of round.cards) {
          for (const control of card.controls) {
            const words = wordsInRing(card.map, { x: control.x, y: control.y }, round.radius);
            words.delete(control.kind);
            expect([...words], `beside the ${control.kind}`).toEqual([]);
          }
        }
      }),
      { numRuns: 40 },
    );
  });

  it('keeps the circles apart and on the card', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const round = gen(seed, level);
        for (const card of round.cards) {
          for (const c of card.controls) {
            expect(c.x).toBeGreaterThanOrEqual(card.crop.x + round.radius);
            expect(c.y).toBeGreaterThanOrEqual(card.crop.y + round.radius);
            expect(c.x).toBeLessThanOrEqual(card.crop.x + card.crop.size - round.radius);
            expect(c.y).toBeLessThanOrEqual(card.crop.y + card.crop.size - round.radius);
          }
          for (let i = 0; i < card.controls.length; i++) {
            for (let j = i + 1; j < card.controls.length; j++) {
              const p = card.controls[i]!;
              const q = card.controls[j]!;
              expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(2 * round.radius);
            }
          }
        }
      }),
      { numRuns: 40 },
    );
  });

  it('never repeats a kind on one card', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        for (const card of gen(seed, level).cards) {
          const kinds = card.controls.map((c) => c.kind);
          expect(new Set(kinds).size).toBe(kinds.length);
        }
      }),
      { numRuns: 40 },
    );
  });

  it('draws the two cards on different ground', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const [a, b] = gen(seed, level).cards;
        expect(hashJson(a.map)).not.toBe(hashJson(b.map));
      }),
      { numRuns: 40 },
    );
  });

  it('never shows one window twice, however small the library', () => {
    // A `LibraryProvider` picks a window uniformly and has no memory of the last one it
    // gave out, so two cards off a one-bundle library landed on the same window about one
    // round in eight. The same *window* is the one thing two cards may never be: every
    // kind on one is then a kind on the other, and the round has no question in it.
    const ground = new GeneratedProvider().pick(seeded(7), requirementFor(5));

    for (let seed = 0; seed < 30; seed++) {
      for (const level of [1, 5, 10]) {
        for (const windows of [1, 2, 3]) {
          const round = drill.generate(seeded(seed), level, { maps: new Shelf(ground, windows) });
          expect(drill.wellFormed(round)).toEqual([]);
          const [a, b] = round.cards;
          expect(a.map === b.map && a.crop.x === b.crop.x && a.crop.y === b.crop.y).toBe(false);
        }
      }
    }
  });

  it('takes the window that repeats least of the first card', () => {
    // Two windows that are mostly the same hillside offer mostly the same decoys, and the
    // same boulder drawn twice can be matched by where it is rather than by what it is.
    // One big map with four cards' worth of room on it, so a window that shares nothing
    // with the first exists to be found.
    const wanted = requirementFor(5);
    const wide = new GeneratedProvider().pick(seeded(7), {
      ...wanted,
      size: wanted.size * 2,
      minFeatures: { landform: 16, point: 48, line: 8, area: 16 },
    });
    const ground = { map: wide.map, crop: { x: 0, y: 0, size: wanted.size } };
    let worst = 0;
    for (let seed = 0; seed < 30; seed++) {
      const round = drill.generate(seeded(seed), 5, { maps: new Shelf(ground, 2, 1) });
      worst = Math.max(worst, shared(round.cards[0], round.cards[1]));
    }
    expect(worst).toBe(0);
  });

  it('is still a function of the seed when it has to look twice', () => {
    const shelf = () => ({ maps: new Shelf(new GeneratedProvider().pick(seeded(7), requirementFor(5)), 1) });
    for (const level of [1, 5, 10]) {
      expect(drill.generate(seeded(11), level, shelf()))
        .toEqual(drill.generate(seeded(11), level, shelf()));
    }
  });

  it('gives every level the controls it asks for', () => {
    // Fixed seeds, because the count is the one thing generation will trade away: two thin
    // maps cost a control rather than the round. Measured over 1500 rounds at levels 8 and
    // 10 — the hardest, at nine kinds between the cards — it never had to.
    for (const level of [1, 4, 8, 10]) {
      const wanted = paramsFor(level).controls;
      for (let seed = 0; seed < 40; seed++) {
        for (const card of gen(seed, level).cards) {
          expect(card.controls).toHaveLength(wanted);
        }
      }
    }
  });

  it('never falls more than one control short', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const round = gen(seed, level);
        expect(round.cards[0].controls.length).toBeGreaterThanOrEqual(
          paramsFor(level).controls - 1,
        );
        expect(round.cards[1].controls).toHaveLength(round.cards[0].controls.length);
      }),
      { numRuns: 40 },
    );
  });

  it('raises the count and the ground covered with the level', () => {
    expect([1, 2, 3].map((l) => paramsFor(l).controls)).toEqual([3, 3, 3]);
    expect([4, 5, 6, 7].map((l) => paramsFor(l).controls)).toEqual([4, 4, 4, 4]);
    expect([8, 9, 10].map((l) => paramsFor(l).controls)).toEqual([5, 5, 5]);
    expect(paramsFor(10).size).toBeGreaterThan(paramsFor(1).size);
    // Out of range clamps rather than extrapolating into a card nobody could read.
    expect(paramsFor(0)).toEqual(paramsFor(1));
    expect(paramsFor(99)).toEqual(paramsFor(10));
  });

  it('sizes the circle from the card, not from the screen', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const round = gen(seed, level);
        expect(round.radius).toBeCloseTo(round.cards[0].crop.size * CIRCLE_FRACTION, 9);
        expect(round.cards[0].crop.size).toBe(round.cards[1].crop.size);
      }),
      { numRuns: 20 },
    );
  });

  it('does not give the answer away by position', () => {
    // If the shared control sat at the same index on both cards it could be found by
    // counting rather than by reading the map.
    const sameSlot = Array.from({ length: 120 }, (_, s) => gen(s, 5)).filter((round) => {
      const at = (i: 0 | 1) =>
        round.cards[i].controls.findIndex((c) => c.kind === round.shared);
      return at(0) === at(1);
    });
    expect(sameSlot.length).toBeLessThan(50);
  });

  it('spreads the answer over the vocabulary', () => {
    // A drill whose answer is a boulder four times in five is a drill about boulders.
    const shared = new Set(Array.from({ length: 80 }, (_, s) => gen(s, 6).shared));
    expect(shared.size).toBeGreaterThan(6);
  });
});

describe('map dohledavka / determinism', () => {
  it('same seed and level, same round', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        expect(gen(seed, level)).toEqual(gen(seed, level));
      }),
      { numRuns: 15 },
    );
  });

  it('golden: fixed seeds at fixed levels', () => {
    // Over the drill's **decisions** and not the maps that carry them, for the reason
    // `goldenMap` gives: which window each card shows, what is circled on it and where,
    // and which kind the two share. The ground itself is pinned by the terrain golden, and
    // a map that changed would come through here as different sites and different circles.
    const golden = (round: MapDobbleRound) => ({
      cards: round.cards.map((card) => ({ crop: card.crop, controls: card.controls })),
      shared: round.shared,
      radius: round.radius,
    });
    // **Re-pinned once, deliberately**, by the commit that made the answer space the
    // semantic table's: every `controlSite` code now has a word, a line is circled at its
    // junctions and ends as well as its bends, an area at its outline and never in the
    // middle of itself, and the ring rule is by word. Every candidate the drill has to
    // choose from moved, so the rounds did.
    const rounds = [1, 2].flatMap((s) => [1, 5, 9].map((l) => golden(gen(s, l))));
    expect(hashJson(rounds)).toMatchInlineSnapshot(`"26eb6a53"`);
  });
});

describe('map dohledavka / wellFormed detects what it claims to', () => {
  const good = gen(3, 6);
  const decoy = good.cards[0].controls.find((c) => c.kind !== good.shared)!;

  const withControls = (index: 0 | 1, controls: readonly Control[]): MapDobbleRound => ({
    ...good,
    cards: index === 0
      ? [{ ...good.cards[0], controls }, good.cards[1]]
      : [good.cards[0], { ...good.cards[1], controls }],
  });

  it('passes a round it should pass', () => {
    expect(drill.wellFormed(good)).toEqual([]);
  });

  it('catches a circle on nothing', () => {
    const moved = good.cards[0].controls.map((c) =>
      c === decoy ? { ...c, x: c.x + 17.5 } : c,
    );
    expect(drill.wellFormed(withControls(0, moved)).join(' ')).toContain('alone in the circle');
  });

  it('catches a kind circled twice on one card', () => {
    const twice = [...good.cards[0].controls, { ...decoy, x: decoy.x + 400 }];
    expect(drill.wellFormed(withControls(0, twice)).join(' ')).toContain('circles a kind twice');
  });

  it('catches a second kind shared between the cards', () => {
    const alsoOnB = [...good.cards[1].controls, { ...decoy, x: decoy.x + 400 }];
    expect(drill.wellFormed(withControls(1, alsoOnB)).join(' ')).toContain('share 2 kinds');
  });

  it('catches a wrong shared kind', () => {
    const wrong = { ...good, shared: decoy.kind };
    expect(drill.wellFormed(wrong).join(' ')).toContain('but the cards share');
  });

  it('catches two circles drawn on top of each other', () => {
    const other = good.cards[0].controls.find((c) => c !== decoy)!;
    const piled = good.cards[0].controls.map((c) =>
      c === decoy ? { ...c, x: other.x, y: other.y } : c,
    );
    expect(drill.wellFormed(withControls(0, piled)).join(' ')).toContain('collide');
  });

  it('catches both cards being the same ground', () => {
    // The same map is fine — two windows on one big map are two cards. The same *window*
    // on it is not: every kind on one card is then a kind on the other.
    const twins: MapDobbleRound = {
      ...good,
      cards: [
        good.cards[0],
        { ...good.cards[1], map: good.cards[0].map, crop: good.cards[0].crop },
      ],
    };
    expect(drill.wellFormed(twins).join(' ')).toContain('the same ground');
  });

  it('catches cards of different lengths', () => {
    expect(drill.wellFormed(withControls(0, good.cards[0].controls.slice(1))).join(' '))
      .toContain('controls');
  });
});

describe('map dohledavka / score', () => {
  const round = gen(3, 6);
  const right = { kind: round.shared, correct: true };
  const wrong = { kind: 'nothing' as ControlKind, correct: false };

  it('a clean find passes', () => {
    expect(drill.score(round, [right])).toEqual({ correct: 1, total: 1, passed: true });
  });

  it('finding it after a wrong tap still counts, but does not pass', () => {
    expect(drill.score(round, [wrong, right])).toEqual({ correct: 1, total: 1, passed: false });
  });

  it('never finding it scores zero', () => {
    expect(drill.score(round, [wrong])).toEqual({ correct: 0, total: 1, passed: false });
    expect(drill.score(round, [])).toEqual({ correct: 0, total: 1, passed: false });
  });
});
