import { describe, it, expect } from 'vitest';
import {
  buildDeck, sharedSymbol, cardCount, symbolCount, symbolsPerCard, ORDERS,
} from './deck.ts';

describe.each(ORDERS)('projective plane of order %i', (order) => {
  const deck = buildDeck(order);

  it('has n^2 + n + 1 cards', () => {
    expect(deck).toHaveLength(cardCount(order));
  });

  it('puts n + 1 distinct symbols on every card', () => {
    for (const card of deck) {
      expect(card).toHaveLength(symbolsPerCard(order));
      expect(new Set(card).size).toBe(symbolsPerCard(order));
    }
  });

  it('uses exactly n^2 + n + 1 distinct symbols, numbered without gaps', () => {
    const used = new Set(deck.flat());
    expect(used.size).toBe(symbolCount(order));
    expect(Math.min(...used)).toBe(0);
    expect(Math.max(...used)).toBe(symbolCount(order) - 1);
  });

  it('puts every symbol on exactly n + 1 cards', () => {
    const appearances = new Map<number, number>();
    for (const card of deck) for (const s of card) {
      appearances.set(s, (appearances.get(s) ?? 0) + 1);
    }
    for (const [symbol, count] of appearances) {
      expect(count, `symbol ${symbol}`).toBe(symbolsPerCard(order));
    }
  });

  // The whole game in one assertion. Exhaustive, not sampled: 78 pairs at order 3, 465 at
  // order 5, 1596 at order 7 — all of them, in milliseconds. Anything less would let a
  // construction that is wrong for a handful of pairs through, and those are exactly the
  // pairs a player would meet and find unanswerable.
  it('has exactly one shared symbol for every pair of cards', () => {
    let pairs = 0;
    for (let i = 0; i < deck.length; i++) {
      for (let j = i + 1; j < deck.length; j++) {
        const shared = deck[j]!.filter((s) => deck[i]!.includes(s));
        expect(shared, `cards ${i} and ${j}`).toHaveLength(1);
        expect(sharedSymbol(deck[i]!, deck[j]!)).toBe(shared[0]);
        pairs++;
      }
    }
    expect(pairs).toBe((deck.length * (deck.length - 1)) / 2);
  });
});

describe('buildDeck', () => {
  it('refuses a non-prime order rather than building a broken deck', () => {
    // Order 4 is a prime power, so a plane exists — but not one this construction finds.
    // Unguarded it returns a deck where 16 of 210 pairs share no symbol and 16 share two.
    for (const bad of [4, 6, 8, 9, 1, 0, -3, 2.5]) {
      expect(() => buildDeck(bad), `order ${bad}`).toThrow(/must be prime/);
    }
  });

  it('accepts the smallest real plane, order 2 (the Fano plane)', () => {
    const deck = buildDeck(2);
    expect(deck).toHaveLength(7);
    expect(deck.every((c) => c.length === 3)).toBe(true);
  });

  it('is deterministic', () => {
    expect(buildDeck(5)).toEqual(buildDeck(5));
  });
});

describe('sharedSymbol', () => {
  it('refuses when there is not exactly one', () => {
    expect(() => sharedSymbol([1, 2], [3, 4])).toThrow(/share 0 symbols/);
    expect(() => sharedSymbol([1, 2], [1, 2])).toThrow(/share 2 symbols/);
  });
});
