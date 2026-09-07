import { isMatch, type MatchAnswer, type MatchRound } from './drill.ts';

/**
 * The tile-selection rules, as a reducer.
 *
 * This was inside the component to begin with, reading `selected` and `matched` out of a
 * closure — which meant two taps landing before a re-render both saw the same stale
 * state, and the round could not finish. A reducer always sees the state as it is, so
 * that class of bug cannot happen here, and every rule below is testable without a DOM.
 */
export type Sel =
  | { readonly kind: 'symbol'; readonly value: string }
  | { readonly kind: 'name'; readonly value: string };

export interface WrongPair {
  readonly symbolId: string;
  readonly name: string;
}

export interface MatchState {
  readonly selected: Sel | null;
  readonly matched: ReadonlySet<string>;
  /** The pair just rejected, held only until the flash clears. */
  readonly wrong: WrongPair | null;
  readonly answers: readonly MatchAnswer[];
  readonly done: boolean;
}

export type MatchEvent =
  | { readonly type: 'tap'; readonly kind: 'symbol' | 'name'; readonly value: string }
  | { readonly type: 'clear-wrong' }
  | { readonly type: 'timeout' };

export const initialState: MatchState = {
  selected: null,
  matched: new Set(),
  wrong: null,
  answers: [],
  done: false,
};

/** The meanings already paired off, derived rather than stored as a second set to sync. */
export function matchedNames(round: MatchRound, state: MatchState): ReadonlySet<string> {
  return new Set(round.pairs.filter((p) => state.matched.has(p.symbolId)).map((p) => p.name));
}

export function isTileMatched(
  round: MatchRound,
  state: MatchState,
  kind: 'symbol' | 'name',
  value: string,
): boolean {
  return kind === 'symbol' ? state.matched.has(value) : matchedNames(round, state).has(value);
}

export function matchReduce(
  round: MatchRound,
  state: MatchState,
  event: MatchEvent,
): MatchState {
  // Once the round is over nothing can change it — not a late tap, not a timer that
  // fired on its way out. This is what keeps `answers` from growing past the round.
  if (state.done) return state;

  switch (event.type) {
    case 'clear-wrong':
      return state.wrong === null ? state : { ...state, wrong: null };

    case 'timeout':
      return { ...state, done: true, selected: null, wrong: null };

    case 'tap': {
      const { kind, value } = event;
      // A tile already paired off is inert; tapping it must not become a selection that
      // the next tap then tries to match.
      if (isTileMatched(round, state, kind, value)) return state;

      // Nothing held, or re-picking within the same column: just move the selection.
      if (!state.selected || state.selected.kind === kind) {
        return { ...state, selected: { kind, value } as Sel, wrong: null };
      }

      const symbolId = kind === 'symbol' ? value : state.selected.value;
      const name = kind === 'name' ? value : state.selected.value;
      const correct = isMatch(round, symbolId, name);
      const answers = [...state.answers, { symbolId, name, correct }];

      if (!correct) {
        return { ...state, selected: null, wrong: { symbolId, name }, answers };
      }

      const matched = new Set(state.matched).add(symbolId);
      return {
        ...state,
        selected: null,
        wrong: null,
        matched,
        answers,
        done: matched.size === round.pairs.length,
      };
    }
  }
}
