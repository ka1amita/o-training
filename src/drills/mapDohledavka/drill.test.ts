import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { GeneratedProvider, type RoundContext } from '@/lib/maps/provider.ts';
import { hashJson, seeded } from '@/lib/rng.ts';
import { areasOf, linesOf, pointsOf, positionOf, type OMap } from '@/lib/terrain/omap.ts';
import { CODE_OF } from '@/lib/terrain/semantics.ts';
import {
  mapDohledavka as drill, paramsFor, CIRCLE_FRACTION,
  type Control, type MapDobbleRound,
} from './drill.ts';
import { CONTROL_NAMES, type ControlKind } from './features.ts';

const anySeed = fc.integer({ min: 0, max: 0xffffffff });
const anyLevel = fc.integer({ min: drill.bounds.min, max: drill.bounds.max });
const maps: RoundContext = { maps: new GeneratedProvider() };
const gen = (seed: number, level: number) => drill.generate(seeded(seed), level, maps);

/** Where the map itself says a feature of this kind is, ignoring the drill's own view. */
function positionsOf(map: OMap, kind: ControlKind): { x: number; y: number }[] {
  const code = CODE_OF[kind as keyof typeof CODE_OF];
  return [...pointsOf(map), ...areasOf(map)]
    .filter((f) => f.code === code)
    .map(positionOf);
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
            const exact = positionsOf(card.map, control.kind).some(
              (p) => p.x === control.x && p.y === control.y,
            );
            const online = linesOf(card.map).some(
              (line) =>
                line.code === CODE_OF[control.kind as keyof typeof CODE_OF] &&
                line.geometry.kind === 'polyline' &&
                line.geometry.points.some((p) => p.x === control.x && p.y === control.y),
            );
            const relief = card.map.relief.landforms.some(
              (f) =>
                f.kind === control.kind &&
                Math.hypot(f.x - control.x, f.y - control.y) <= f.radius,
            );
            expect(exact || online || relief).toBe(true);
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
            for (const kind of Object.keys(CONTROL_NAMES) as ControlKind[]) {
              if (kind === control.kind) continue;
              for (const other of positionsOf(card.map, kind)) {
                expect(Math.hypot(other.x - control.x, other.y - control.y))
                  .toBeGreaterThanOrEqual(round.radius);
              }
            }
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
            expect(Math.min(c.x, c.y)).toBeGreaterThanOrEqual(round.radius);
            expect(Math.max(c.x, c.y)).toBeLessThanOrEqual(card.map.width - round.radius);
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
        expect(round.radius).toBeCloseTo(round.cards[0].map.width * CIRCLE_FRACTION, 9);
        expect(round.cards[0].map.width).toBe(round.cards[1].map.width);
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
    const rounds = [1, 2].flatMap((s) => [1, 5, 9].map((l) => gen(s, l)));
    expect(hashJson(rounds)).toMatchInlineSnapshot(`"6a4601f3"`);
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

  it('catches both cards being the same map', () => {
    const twins: MapDobbleRound = {
      ...good,
      cards: [good.cards[0], { ...good.cards[1], map: good.cards[0].map }],
    };
    expect(drill.wellFormed(twins).join(' ')).toContain('the same map');
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
