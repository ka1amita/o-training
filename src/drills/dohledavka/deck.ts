/**
 * Dobble decks are a finite projective plane.
 *
 * For an order `n`, the plane has `n^2 + n + 1` points and the same number of lines; each
 * line holds `n + 1` points, each point lies on `n + 1` lines, and **any two lines meet in
 * exactly one point**. Read lines as cards and points as symbols and that last sentence is
 * the game's only rule. Nothing here is heuristic: the deck either is a projective plane
 * or it is not, which is why the test can be exhaustive rather than sampled.
 */

/** Orders the app offers. Deliberately primes — see `buildDeck`. */
export const ORDERS = [3, 5, 7] as const;
export type Order = (typeof ORDERS)[number];

export const cardCount = (order: number): number => order * order + order + 1;
export const symbolsPerCard = (order: number): number => order + 1;
/** A plane has as many points as lines, so this is the same number — named for the reader. */
export const symbolCount = (order: number): number => cardCount(order);

function isPrime(n: number): boolean {
  if (!Number.isInteger(n) || n < 2) return false;
  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
  return true;
}

/**
 * Builds the deck as arrays of symbol indices.
 *
 * The construction below is the standard one and is only valid for **prime** order. A
 * projective plane also exists for prime *powers* — order 4, 8, 9 — but needs arithmetic
 * in GF(p^k) rather than the `% order` used here. Measured, not assumed: at order 4 this
 * construction yields 16 pairs sharing no symbol at all and 16 sharing two, out of 210;
 * at order 9, 486 share none and 243 share three. A wrong deck is not a crash — it is a
 * card with two right answers, or none, which reads as the game being broken.
 */
export function buildDeck(order: number): number[][] {
  if (!isPrime(order)) {
    throw new Error(
      `order must be prime, got ${order} — this construction needs arithmetic mod a prime`,
    );
  }

  const cards: number[][] = [];

  // One card carrying every "point at infinity".
  cards.push(Array.from({ length: order + 1 }, (_, i) => i));

  // `order` cards through the first of them.
  for (let i = 0; i < order; i++) {
    const card = [0];
    for (let j = 0; j < order; j++) card.push(order + 1 + order * i + j);
    cards.push(card);
  }

  // `order^2` cards, one per (slope, intercept) pair.
  for (let i = 0; i < order; i++) {
    for (let k = 0; k < order; k++) {
      const card = [i + 1];
      for (let j = 0; j < order; j++) {
        card.push(order + 1 + order * j + ((i * j + k) % order));
      }
      cards.push(card);
    }
  }

  return cards;
}

/** The single symbol two cards share. Throws if there is not exactly one. */
export function sharedSymbol(a: readonly number[], b: readonly number[]): number {
  const set = new Set(a);
  const common = b.filter((s) => set.has(s));
  if (common.length !== 1) {
    throw new Error(`cards share ${common.length} symbols, expected exactly 1`);
  }
  return common[0]!;
}
