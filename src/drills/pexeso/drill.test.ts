import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { hashJson, seeded } from '@/lib/rng.ts';
import { pexeso as drill, paramsFor, attemptBudget, CROP_SIZE, type PexesoRound } from './drill.ts';
import { initialState, pexesoReduce, type PexesoEvent, type PexesoState } from './state.ts';

const anySeed = fc.integer({ min: 0, max: 0xffffffff });
const anyLevel = fc.integer({ min: 1, max: 10 });
const gen = (seed: number, level: number) => drill.generate(seeded(seed), level);

describe('pexeso / generate', () => {
  it('is well formed at every level, for any seed', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        expect(drill.wellFormed(gen(seed, level))).toEqual([]);
      }),
      { numRuns: 120 },
    );
  });

  it('shows the control on both cards of every pair', () => {
    // The only thing a pair shares outright. Stated apart from wellFormed so a mistake
    // there cannot hide one here.
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const round = gen(seed, level);
        for (const card of round.cards) {
          const { x, y, size } = card.crop;
          expect(card.control.x).toBeGreaterThanOrEqual(x);
          expect(card.control.x).toBeLessThanOrEqual(x + size);
          expect(card.control.y).toBeGreaterThanOrEqual(y);
          expect(card.control.y).toBeLessThanOrEqual(y + size);
        }
      }),
      { numRuns: 120 },
    );
  });

  it('offsets a pair by exactly the shift the level asks for', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const round = gen(seed, level);
        for (let id = 0; id < round.pairs; id++) {
          const [a, b] = round.cards.filter((c) => c.pairId === id);
          expect(Math.hypot(a!.crop.x - b!.crop.x, a!.crop.y - b!.crop.y)).toBeCloseTo(round.shift, 6);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('always leaves the two windows overlapping', () => {
    // Past a full crop of offset the cards share no ground and the pair is unmatchable.
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const round = gen(seed, level);
        expect(round.shift).toBeLessThan(round.cropSize);
        for (let id = 0; id < round.pairs; id++) {
          const [a, b] = round.cards.filter((c) => c.pairId === id);
          const overlapX = CROP_SIZE - Math.abs(a!.crop.x - b!.crop.x);
          const overlapY = CROP_SIZE - Math.abs(a!.crop.y - b!.crop.y);
          expect(overlapX).toBeGreaterThan(0);
          expect(overlapY).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('gives each pair its own terrain', () => {
    const round = gen(5, 9);
    const shapes = new Set(round.terrains.map((t) => hashJson(t)));
    expect(shapes.size).toBe(round.pairs);
  });

  it('lays out on a phone: 6, 8 or 12 cards, never a ragged row', () => {
    for (let level = 1; level <= 10; level++) {
      expect([3, 4, 6]).toContain(paramsFor(level).pairs);
    }
  });

  it('shifts further apart as the level rises', () => {
    expect(gen(1, 10).shift).toBeGreaterThan(gen(1, 1).shift);
  });

  it('shuffles the board', () => {
    const inOrder = Array.from({ length: 40 }, (_, s) => gen(s, 5)).filter((r) =>
      r.cards.every((c, i) => c.pairId === Math.floor(i / 2)),
    );
    expect(inOrder.length).toBeLessThan(4);
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
    expect(hashJson([1, 2].flatMap((s) => [1, 6, 10].map((l) => gen(s, l))))).toMatchInlineSnapshot(`"b68e7404"`);
  });
});

describe('pexeso / wellFormed detects what it claims to', () => {
  const good = gen(3, 5);
  const withCards = (cards: PexesoRound['cards']): PexesoRound => ({ ...good, cards });

  it('catches a control outside a crop', () => {
    const cards = good.cards.map((c, i) =>
      i === 0 ? { ...c, control: { x: c.crop.x - 50, y: c.control.y } } : c,
    );
    expect(drill.wellFormed(withCards(cards)).join(' ')).toContain('control is outside a crop');
  });

  it('catches a crop off the edge of the map', () => {
    const cards = good.cards.map((c, i) => (i === 0 ? { ...c, crop: { ...c.crop, x: -20 } } : c));
    expect(drill.wellFormed(withCards(cards)).join(' ')).toContain('runs off the map');
  });

  it('catches a pair whose two windows are identical', () => {
    const [first] = good.cards.filter((c) => c.pairId === 0);
    const cards = good.cards.map((c) => (c.pairId === 0 ? { ...c, crop: first!.crop } : c));
    expect(drill.wellFormed(withCards(cards)).join(' ')).toContain('the same window');
  });

  it('catches a card with no twin', () => {
    expect(drill.wellFormed(withCards(good.cards.slice(1))).join(' ')).toContain('cards for');
  });

  it('passes a round it should pass', () => {
    expect(drill.wellFormed(good)).toEqual([]);
  });
});

describe('pexeso / flipping', () => {
  const round = gen(3, 5);
  const twin = (index: number) =>
    round.cards.findIndex((c, i) => i !== index && c.pairId === round.cards[index]!.pairId);
  const other = (index: number) =>
    round.cards.findIndex((c) => c.pairId !== round.cards[index]!.pairId);

  const flip = (index: number): PexesoEvent => ({ type: 'flip', index });
  const run = (events: PexesoEvent[], from: PexesoState = initialState) =>
    events.reduce((s, e) => pexesoReduce(round, s, e), from);

  it('a first flip turns one card up and compares nothing', () => {
    const s = run([flip(0)]);
    expect(s.flipped).toEqual([0]);
    expect(s.answers).toHaveLength(0);
  });

  it('a matching pair stays up and counts once', () => {
    const s = run([flip(0), flip(twin(0))]);
    expect(s.matched.has(0)).toBe(true);
    expect(s.matched.has(twin(0))).toBe(true);
    expect(s.flipped).toEqual([]);
    expect(s.answers).toEqual([{ a: 0, b: twin(0), matched: true }]);
  });

  it('a wrong pair stays up until it is resolved', () => {
    const s = run([flip(0), flip(other(0))]);
    expect(s.flipped).toHaveLength(2);
    expect(s.matched.size).toBe(0);
    expect(s.answers).toEqual([{ a: 0, b: other(0), matched: false }]);
    expect(pexesoReduce(round, s, { type: 'resolve' }).flipped).toEqual([]);
  });

  it('a third tap while two are up resolves them and flips the third', () => {
    // The case that breaks most memory games. Ignoring it makes the board feel dead;
    // dropping the tap silently is worse.
    const third = round.cards.findIndex((_, i) => i !== 0 && i !== other(0));
    const s = run([flip(0), flip(other(0)), flip(third)]);
    expect(s.flipped).toEqual([third]);
    expect(s.answers).toHaveLength(1);
  });

  it('tapping the same face-up card again does nothing', () => {
    const s = run([flip(0), flip(0)]);
    expect(s.flipped).toEqual([0]);
    expect(s.answers).toHaveLength(0);
  });

  it('a matched card is inert', () => {
    const s = run([flip(0), flip(twin(0))]);
    expect(pexesoReduce(round, s, flip(0))).toBe(s);
  });

  it('an index off the board is ignored', () => {
    expect(pexesoReduce(round, initialState, flip(-1))).toBe(initialState);
    expect(pexesoReduce(round, initialState, flip(round.cards.length))).toBe(initialState);
  });

  it('finishes when the last pair lands, and a clean board passes', () => {
    let s = initialState;
    const done = new Set<number>();
    for (let i = 0; i < round.cards.length; i++) {
      if (done.has(i)) continue;
      const t = twin(i);
      done.add(i);
      done.add(t);
      s = run([flip(i), flip(t)], s);
    }
    expect(s.done).toBe(true);
    expect(s.answers).toHaveLength(round.pairs);
    expect(drill.score(round, s.answers)).toEqual({
      correct: round.pairs,
      total: round.pairs,
      passed: true,
    });
  });

  it('accepts nothing once it is done', () => {
    let s = initialState;
    for (let i = 0; i < round.cards.length; i++) {
      const t = twin(i);
      if (s.matched.has(i)) continue;
      s = run([flip(i), flip(t)], s);
    }
    expect(pexesoReduce(round, s, flip(0))).toBe(s);
  });

  it('a timeout ends it with the pairs already found', () => {
    const s = run([flip(0), flip(twin(0)), { type: 'timeout' }]);
    expect(s.done).toBe(true);
    expect(drill.score(round, s.answers)).toEqual({
      correct: 1,
      total: round.pairs,
      passed: false,
    });
  });

  it('too many attempts costs the pass but not the pairs', () => {
    const wasteful = Array.from({ length: attemptBudget(round.pairs) + 1 }, () => ({
      a: 0, b: 1, matched: true,
    }));
    const score = drill.score(round, wasteful.slice(0, round.pairs).concat(wasteful));
    expect(score.passed).toBe(false);
  });

  it('never records a card as matched without a matching answer', () => {
    const anyFlip = fc.integer({ min: 0, max: round.cards.length - 1 }).map(flip);
    fc.assert(
      fc.property(fc.array(anyFlip, { maxLength: 60 }), (events) => {
        const s = run(events);
        expect(s.matched.size).toBe(s.answers.filter((a) => a.matched).length * 2);
        expect(s.flipped.length).toBeLessThanOrEqual(2);
        expect(s.done).toBe(s.matched.size === round.cards.length);
      }),
    );
  });
});
