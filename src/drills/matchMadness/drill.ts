import { defineDrill, type Score } from '@/drills/types.ts';
import type { Rng } from '@/lib/rng.ts';
import { CATEGORIES, SYMBOLS, symbolById, symbolsIn } from '@/lib/symbols/index.ts';
import Play from './Play.tsx';

export interface MatchPair {
  readonly symbolId: string;
  readonly name: string;
}

export interface MatchRound {
  readonly pairs: readonly MatchPair[];
  /** Symbol ids in the order shown, shuffled independently of the names. */
  readonly symbolOrder: readonly string[];
  readonly nameOrder: readonly string[];
  readonly timeLimitMs: number;
}

export interface MatchAnswer {
  readonly symbolId: string;
  readonly name: string;
  readonly correct: boolean;
}

export interface MatchParams {
  readonly pairs: number;
  /** Draw every symbol from one IOF category, so the distractors are genuinely alike. */
  readonly sameCategory: boolean;
  readonly msPerPair: number;
}

/**
 * Difficulty has two knobs, and the second is the one that matters.
 *
 * More pairs is only more scanning. Drawing them all from **one IOF category** is what
 * makes the round hard in the way the sport is hard: spur against re-entrant, depression
 * against pit, boulder against boulder cluster. That grouping is already in the symbol
 * numbering, so it is read from the data rather than being a list somebody maintains.
 */
export function paramsFor(level: number): MatchParams {
  const clamped = Math.min(10, Math.max(1, level));
  const pairs = clamped <= 3 ? 4 : clamped <= 6 ? 5 : 6;
  return {
    pairs,
    sameCategory: clamped >= 4,
    // Generous at first and tightening: 6s a pair down to 3s.
    msPerPair: Math.round(6000 - (clamped - 1) * (3000 / 9)),
  };
}

export const matchMadness = defineDrill<MatchRound, MatchAnswer>({
  id: 'match',
  title: 'Match Madness',
  blurb: 'Pair each control symbol with what it means, against the clock.',
  engine: 'symbols',
  bounds: { min: 1, max: 10 },
  roundsPerSession: 8,

  generate(rng: Rng, level: number): MatchRound {
    const params = paramsFor(level);
    const pairs = choosePairs(rng, params);
    return {
      pairs,
      // Shuffled separately, or the two columns would line up.
      symbolOrder: rng.shuffle(pairs.map((p) => p.symbolId)),
      nameOrder: rng.shuffle(pairs.map((p) => p.name)),
      timeLimitMs: params.pairs * params.msPerPair,
    };
  },

  wellFormed(round: MatchRound): string[] {
    const problems: string[] = [];
    const { pairs, symbolOrder, nameOrder } = round;

    if (pairs.length < 2) problems.push('a round needs at least two pairs');

    const ids = pairs.map((p) => p.symbolId);
    const names = pairs.map((p) => p.name);
    if (new Set(ids).size !== ids.length) problems.push('a symbol appears twice');
    // The invariant that makes the round answerable: if two symbols on screen shared a
    // meaning, one of them would have two right answers and the player could not know
    // which. It is why the generator drops duplicate English names.
    if (new Set(names).size !== names.length) problems.push('two symbols share a meaning');

    for (const p of pairs) {
      const symbol = symbolById(p.symbolId);
      if (!symbol) problems.push(`unknown symbol ${p.symbolId}`);
      else if (symbol.name !== p.name) problems.push(`${p.symbolId} is not named "${p.name}"`);
    }

    if (!samePermutation(symbolOrder, ids)) problems.push('symbolOrder is not a permutation');
    if (!samePermutation(nameOrder, names)) problems.push('nameOrder is not a permutation');
    if (round.timeLimitMs <= 0) problems.push('timeLimitMs must be positive');

    return problems;
  },

  score(round: MatchRound, answers: readonly MatchAnswer[]): Score {
    const matched = new Set(answers.filter((a) => a.correct).map((a) => a.symbolId));
    return {
      correct: matched.size,
      total: round.pairs.length,
      // Every pair found, and no wrong tap on the way. A stricter bar than accuracy,
      // which is what lets the staircase settle where a clean round is about a 79% shot.
      passed: matched.size === round.pairs.length && answers.length === round.pairs.length,
    };
  },

  Play,
});

/**
 * Picks the round's pairs. Separate from `generate` so the too-small-pool guard is
 * reachable from a test: through `paramsFor` it never can be, which is exactly the kind
 * of guard that quietly stops working.
 */
export function choosePairs(rng: Rng, params: MatchParams): MatchPair[] {
  const pool = params.sameCategory ? symbolsIn(rng.pick(CATEGORIES)) : SYMBOLS;
  // slice() on a short pool would return a smaller round rather than fail, and a
  // four-pair round at level 9 looks like the drill getting easier as you improve.
  if (pool.length < params.pairs) {
    throw new Error(`asked for ${params.pairs} pairs from a pool of ${pool.length}`);
  }
  return rng.shuffle(pool).slice(0, params.pairs).map((s) => ({ symbolId: s.id, name: s.name }));
}

function samePermutation(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');
}

/** Whether a name is the right meaning for a symbol in this round. */
export function isMatch(round: MatchRound, symbolId: string, name: string): boolean {
  return round.pairs.some((p) => p.symbolId === symbolId && p.name === name);
}
