import { defineDrill, type Score } from '@/drills/types.ts';
import type { Rng } from '@/lib/rng.ts';
import { SYMBOLS, symbolById } from '@/lib/symbols/index.ts';
import { buildDeck, sharedSymbol, symbolCount, symbolsPerCard, type Order } from './deck.ts';
import Play from './Play.tsx';

/** A symbol placed on a card. Coordinates are in card units: the card is the unit disc. */
export interface Placed {
  readonly symbolId: string;
  readonly x: number;
  readonly y: number;
  /** Box side in card units. Treated as a circle of radius scale/2 for overlap. */
  readonly scale: number;
  readonly rotation: number;
}

export interface DobbleCard {
  readonly symbols: readonly Placed[];
}

export interface DobbleRound {
  readonly order: number;
  readonly cards: readonly [DobbleCard, DobbleCard];
  /** The one symbol both cards carry. */
  readonly shared: string;
}

export interface DobbleAnswer {
  readonly symbolId: string;
  readonly correct: boolean;
}

/** Order rises with level: more symbols per card, and more to rule out. */
export function orderFor(level: number): Order {
  const clamped = Math.min(10, Math.max(1, level));
  return clamped <= 3 ? 3 : clamped <= 7 ? 5 : 7;
}

interface Layout {
  readonly ring: number;
  readonly scale: number;
  readonly centre: boolean;
}

const ANGLE_JITTER = 0.18; // as a fraction of the gap between neighbours
const RADIUS_JITTER = 0.05;
const SCALE_JITTER = 0.15;

/**
 * Symbol size is **derived from the geometry, not chosen**, so the no-overlap invariant
 * holds by construction rather than by having been tuned until the test stopped failing.
 * A first version did pick the sizes by hand and the property test rejected it at order 3
 * within ten cases.
 *
 * Two constraints bind, both taken at their worst case:
 *
 *  - Two neighbours on the ring are closest when they jitter towards each other and both
 *    fall to the inner radius, which leaves a chord of
 *    `2 * (ring - RADIUS_JITTER) * sin(gap * (1 - 2 * ANGLE_JITTER) / 2)`.
 *  - The centre symbol and a ring symbol are closest when the centre drifts outwards and
 *    the ring symbol inwards, leaving `ring - 2 * RADIUS_JITTER`.
 *
 * Each must be at least two maximum radii, and a symbol is at most `scale * (1 +
 * SCALE_JITTER)` across. Non-adjacent ring symbols are never the binding pair: the angle
 * jitter is under half a gap, so neighbours cannot pass each other.
 */
function layoutFor(count: number): Layout {
  const centre = count > 4;
  const ring = count <= 4 ? 0.58 : count <= 6 ? 0.62 : 0.66;
  const onRing = centre ? count - 1 : count;

  const gap = (2 * Math.PI) / onRing;
  const chord = 2 * (ring - RADIUS_JITTER) * Math.sin((gap * (1 - 2 * ANGLE_JITTER)) / 2);
  const limits = [chord / (1 + SCALE_JITTER)];
  if (centre) limits.push((ring - 2 * RADIUS_JITTER) / (1 + SCALE_JITTER));

  return { ring, centre, scale: Math.min(...limits) };
}

function placeCard(rng: Rng, symbolIds: readonly string[]): DobbleCard {
  const layout = layoutFor(symbolIds.length);
  const onRing = layout.centre ? symbolIds.slice(1) : symbolIds;
  const gap = (2 * Math.PI) / onRing.length;
  // A whole-card rotation, so the ring does not sit in the same place on every card.
  const phase = rng.range(0, 2 * Math.PI);

  const placed: Placed[] = [];

  if (layout.centre) {
    placed.push({
      symbolId: symbolIds[0]!,
      x: rng.range(-RADIUS_JITTER, RADIUS_JITTER),
      y: rng.range(-RADIUS_JITTER, RADIUS_JITTER),
      scale: layout.scale * rng.range(1 - SCALE_JITTER, 1 + SCALE_JITTER),
      rotation: rng.range(0, 360),
    });
  }

  onRing.forEach((symbolId, i) => {
    const angle = phase + i * gap + rng.range(-gap * ANGLE_JITTER, gap * ANGLE_JITTER);
    const radius = layout.ring + rng.range(-RADIUS_JITTER, RADIUS_JITTER);
    placed.push({
      symbolId,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      scale: layout.scale * rng.range(1 - SCALE_JITTER, 1 + SCALE_JITTER),
      rotation: rng.range(0, 360),
    });
  });

  return { symbols: placed };
}

export const dohledavka = defineDrill<DobbleRound, DobbleAnswer>({
  id: 'dohledavka',
  title: 'Dohledavka',
  blurb: 'Two cards share exactly one symbol. Find it.',
  engine: 'symbols',
  bounds: { min: 1, max: 10 },
  roundsPerSession: 12,
  multiplayer: true,
  // Single player only: `MatchPage` runs its own rounds and shows the same reveal on a
  // host-timed pause, because a two-player game cannot wait for either player to tap.
  review: true,

  generate(rng: Rng, level: number): DobbleRound {
    const order = orderFor(level);
    const deck = buildDeck(order);

    // A fresh slice of the symbol library each round, so order 3 is not always the same
    // thirteen glyphs.
    const palette = rng.shuffle(SYMBOLS).slice(0, symbolCount(order));

    const first = rng.int(deck.length);
    let second = rng.int(deck.length - 1);
    if (second >= first) second += 1; // uniform over the other cards, without rejection

    const a = deck[first]!;
    const b = deck[second]!;
    const shared = palette[sharedSymbol(a, b)]!.id;

    // Shuffled so the shared symbol is not in the same slot on both cards, which would
    // give it away by position rather than by looking.
    return {
      order,
      cards: [
        placeCard(rng, rng.shuffle(a).map((i) => palette[i]!.id)),
        placeCard(rng, rng.shuffle(b).map((i) => palette[i]!.id)),
      ],
      shared,
    };
  },

  wellFormed(round: DobbleRound): string[] {
    const problems: string[] = [];
    const perCard = symbolsPerCard(round.order);

    round.cards.forEach((card, index) => {
      const ids = card.symbols.map((s) => s.symbolId);
      if (ids.length !== perCard) {
        problems.push(`card ${index} has ${ids.length} symbols, expected ${perCard}`);
      }
      if (new Set(ids).size !== ids.length) problems.push(`card ${index} repeats a symbol`);
      for (const id of ids) if (!symbolById(id)) problems.push(`unknown symbol ${id}`);

      for (const s of card.symbols) {
        if (Math.hypot(s.x, s.y) + s.scale / 2 > 1) {
          problems.push(`card ${index}: ${s.symbolId} spills outside the card`);
        }
        if (s.scale <= 0) problems.push(`card ${index}: ${s.symbolId} has no size`);
      }

      // Overlap. A symbol hidden under another cannot be tapped, and if it is the shared
      // one the round has no answer at all.
      for (let i = 0; i < card.symbols.length; i++) {
        for (let j = i + 1; j < card.symbols.length; j++) {
          const p = card.symbols[i]!;
          const q = card.symbols[j]!;
          if (Math.hypot(p.x - q.x, p.y - q.y) < (p.scale + q.scale) / 2) {
            problems.push(`card ${index}: ${p.symbolId} overlaps ${q.symbolId}`);
          }
        }
      }
    });

    const [a, b] = round.cards;
    const common = a.symbols
      .map((s) => s.symbolId)
      .filter((id) => b.symbols.some((s) => s.symbolId === id));
    if (common.length !== 1) {
      problems.push(`cards share ${common.length} symbols, expected exactly 1`);
    } else if (common[0] !== round.shared) {
      problems.push(`shared is ${round.shared} but the cards share ${common[0]}`);
    }

    return problems;
  },

  // The round is not needed: whether a tap was right was already decided when it was
  // recorded, by the reducer that knows what the shared symbol is.
  score(_round: DobbleRound, answers: readonly DobbleAnswer[]): Score {
    const found = answers.some((a) => a.correct);
    return {
      correct: found ? 1 : 0,
      total: 1,
      // Found it, and did not tap anything else on the way.
      passed: found && answers.length === 1,
    };
  },

  Play,
});
