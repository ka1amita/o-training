import type { PexesoAnswer, PexesoRound } from './drill.ts';

/**
 * The flip / compare / hide rules, as a reducer.
 *
 * The case that breaks most memory games is a third card tapped while two are still face
 * up. Ignoring it makes the board feel dead for the length of an animation; here the
 * outstanding pair is resolved first and the third card flips, so a fast player is never
 * blocked and no tap is silently dropped.
 */
export interface PexesoState {
  /** Card indices currently face up and not yet resolved. At most two. */
  readonly flipped: readonly number[];
  readonly matched: ReadonlySet<number>;
  readonly answers: readonly PexesoAnswer[];
  readonly done: boolean;
}

export type PexesoEvent =
  | { readonly type: 'flip'; readonly index: number }
  /** The pause after a wrong pair has elapsed. */
  | { readonly type: 'resolve' }
  | { readonly type: 'timeout' };

export const initialState: PexesoState = {
  flipped: [],
  matched: new Set(),
  answers: [],
  done: false,
};

/** Clears an unmatched pair off the table. Matched cards stay up. */
function resolve(state: PexesoState): PexesoState {
  return state.flipped.length === 2 ? { ...state, flipped: [] } : state;
}

export function pexesoReduce(
  round: PexesoRound,
  state: PexesoState,
  event: PexesoEvent,
): PexesoState {
  if (state.done) return state;

  switch (event.type) {
    case 'resolve':
      return resolve(state);

    case 'timeout':
      return { ...state, done: true, flipped: [] };

    case 'flip': {
      const { index } = event;
      if (index < 0 || index >= round.cards.length) return state;
      if (state.matched.has(index)) return state;

      // Two already up: settle them, then treat this as a first flip.
      const base = state.flipped.length === 2 ? resolve(state) : state;
      if (base.flipped.includes(index)) return base;

      if (base.flipped.length === 0) return { ...base, flipped: [index] };

      const first = base.flipped[0]!;
      const matched = round.cards[first]!.pairId === round.cards[index]!.pairId;
      const answers = [...base.answers, { a: first, b: index, matched }];

      if (!matched) return { ...base, flipped: [first, index], answers };

      const nextMatched = new Set(base.matched).add(first).add(index);
      return {
        ...base,
        flipped: [],
        matched: nextMatched,
        answers,
        done: nextMatched.size === round.cards.length,
      };
    }
  }
}
