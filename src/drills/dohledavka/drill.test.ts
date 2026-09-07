import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { hashJson, seeded } from '@/lib/rng.ts';
import { symbolsPerCard } from './deck.ts';
import { dohledavka as drill, orderFor, type DobbleRound, type Placed } from './drill.ts';

const anySeed = fc.integer({ min: 0, max: 0xffffffff });
const anyLevel = fc.integer({ min: drill.bounds.min, max: drill.bounds.max });
const gen = (seed: number, level: number) => drill.generate(seeded(seed), level);

describe('dohledavka / generate', () => {
  it('is well formed at every level, for any seed', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        expect(drill.wellFormed(gen(seed, level))).toEqual([]);
      }),
      { numRuns: 600 },
    );
  });

  it('gives the round exactly one answer', () => {
    // Stated independently of wellFormed, so a mistake there cannot hide one here.
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const round = gen(seed, level);
        const [a, b] = round.cards;
        const common = a.symbols
          .map((s) => s.symbolId)
          .filter((id) => b.symbols.some((s) => s.symbolId === id));
        expect(common).toEqual([round.shared]);
      }),
      { numRuns: 400 },
    );
  });

  it('never lets two symbols on a card overlap', () => {
    // The jitters are tuned rather than derived, so this is the assertion that keeps them
    // honest: a symbol under another cannot be tapped, and if it is the shared one the
    // round is unanswerable.
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        for (const card of gen(seed, level).cards) {
          for (let i = 0; i < card.symbols.length; i++) {
            for (let j = i + 1; j < card.symbols.length; j++) {
              const p = card.symbols[i]!;
              const q = card.symbols[j]!;
              const gap = Math.hypot(p.x - q.x, p.y - q.y) - (p.scale + q.scale) / 2;
              expect(gap).toBeGreaterThan(0);
            }
          }
        }
      }),
      { numRuns: 400 },
    );
  });

  it('keeps every symbol inside the card', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        for (const card of gen(seed, level).cards) {
          for (const s of card.symbols) {
            expect(Math.hypot(s.x, s.y) + s.scale / 2).toBeLessThanOrEqual(1);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('puts order + 1 symbols on each card', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const round = gen(seed, level);
        expect(round.order).toBe(orderFor(level));
        for (const card of round.cards) {
          expect(card.symbols).toHaveLength(symbolsPerCard(round.order));
        }
      }),
    );
  });

  it('raises the order with the level', () => {
    expect([1, 2, 3].map(orderFor)).toEqual([3, 3, 3]);
    expect([4, 5, 6, 7].map(orderFor)).toEqual([5, 5, 5, 5]);
    expect([8, 9, 10].map(orderFor)).toEqual([7, 7, 7]);
  });

  it('does not give the answer away by position', () => {
    // If the shared symbol sat at the same index on both cards it could be found by
    // counting rather than by looking.
    const sameSlot = Array.from({ length: 200 }, (_, s) => gen(s, 5)).filter((round) => {
      const at = (i: 0 | 1) =>
        round.cards[i].symbols.findIndex((sym) => sym.symbolId === round.shared);
      return at(0) === at(1);
    });
    expect(sameSlot.length).toBeLessThan(60);
  });

  it('varies the palette between rounds', () => {
    const palettes = new Set(
      Array.from({ length: 50 }, (_, s) =>
        gen(s, 1).cards[0].symbols.map((x) => x.symbolId).sort().join(),
      ),
    );
    expect(palettes.size).toBeGreaterThan(45);
  });

  it('never draws the same card twice', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const round = gen(seed, level);
        const ids = (i: 0 | 1) => round.cards[i].symbols.map((s) => s.symbolId).sort().join();
        expect(ids(0)).not.toBe(ids(1));
      }),
      { numRuns: 300 },
    );
  });
});

describe('dohledavka / determinism', () => {
  it('same seed and level, same round', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        expect(gen(seed, level)).toEqual(gen(seed, level));
      }),
    );
  });

  // Golden, and load-bearing beyond a refactor guard: two peers derive the same deck from
  // a shared seed rather than sending it, so output drifting would desynchronise a game.
  it('golden: fixed seeds at fixed levels', () => {
    const rounds = [1, 2, 3].flatMap((s) => [1, 5, 9].map((l) => gen(s, l)));
    expect(hashJson(rounds)).toMatchInlineSnapshot(`"a09cda69"`);
  });
});

describe('dohledavka / wellFormed detects what it claims to', () => {
  // A detector that never fires is worth nothing, so each invariant is broken on purpose.
  const good = gen(3, 5);

  /** Replaces one placed symbol, leaving the rest of the round alone. */
  const withSymbol = (at: number, patch: Partial<Placed>): DobbleRound => ({
    ...good,
    cards: [
      { symbols: good.cards[0].symbols.map((s, i) => (i === at ? { ...s, ...patch } : s)) },
      good.cards[1],
    ],
  });

  it('catches a wrong shared symbol', () => {
    expect(drill.wellFormed({ ...good, shared: '1.1' }).join(' ')).toContain('but the cards share');
  });

  it('catches overlapping symbols', () => {
    const first = good.cards[0].symbols[0]!;
    expect(drill.wellFormed(withSymbol(1, { x: first.x, y: first.y })).join(' '))
      .toContain('overlaps');
  });

  it('catches a symbol spilling off the card', () => {
    expect(drill.wellFormed(withSymbol(0, { x: 0.99, y: 0 })).join(' '))
      .toContain('spills outside');
  });

  it('catches a card with the wrong number of symbols', () => {
    const short: DobbleRound = {
      ...good,
      cards: [{ symbols: good.cards[0].symbols.slice(1) }, good.cards[1]],
    };
    expect(drill.wellFormed(short).join(' ')).toContain('expected');
  });

  it('catches an unknown symbol', () => {
    expect(drill.wellFormed(withSymbol(0, { symbolId: '99.9' })).join(' '))
      .toContain('unknown symbol 99.9');
  });

  it('passes a round it should pass', () => {
    expect(drill.wellFormed(good)).toEqual([]);
  });
});

describe('dohledavka / score', () => {
  const round = gen(3, 5);
  const right = { symbolId: round.shared, correct: true };
  const wrong = { symbolId: 'whatever', correct: false };

  it('a clean find passes', () => {
    expect(drill.score(round, [right])).toEqual({ correct: 1, total: 1, passed: true });
  });

  it('finding it after a wrong tap still counts, but does not pass', () => {
    expect(drill.score(round, [wrong, right])).toEqual({ correct: 1, total: 1, passed: false });
  });

  it('never finding it scores zero', () => {
    expect(drill.score(round, [wrong, wrong])).toEqual({ correct: 0, total: 1, passed: false });
    expect(drill.score(round, [])).toEqual({ correct: 0, total: 1, passed: false });
  });
});
