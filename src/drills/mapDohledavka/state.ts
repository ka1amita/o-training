import type { ControlKind } from './features.ts';
import type { MapDobbleAnswer, MapDobbleRound } from './drill.ts';

/**
 * Tap rules, as a reducer — the same reason as everywhere else here: a rule kept in the
 * component reads stale state when two taps land before a re-render, and cannot be tested
 * without a DOM.
 *
 * A tap is judged by what the circle is **on**, not by which circle it was, so the shared
 * feature can be claimed from either card — which is what the two-disc game does too.
 */
export interface MapDobbleState {
  readonly answers: readonly MapDobbleAnswer[];
  /** The kind just rejected, held only until the flash clears. */
  readonly wrong: ControlKind | null;
  readonly done: boolean;
}

export type MapDobbleEvent =
  | { readonly type: 'tap'; readonly kind: ControlKind }
  | { readonly type: 'clear-wrong' };

export const initialState: MapDobbleState = { answers: [], wrong: null, done: false };

export function mapDobbleReduce(
  round: MapDobbleRound,
  state: MapDobbleState,
  event: MapDobbleEvent,
): MapDobbleState {
  if (state.done) return state;

  switch (event.type) {
    case 'clear-wrong':
      return state.wrong === null ? state : { ...state, wrong: null };

    case 'tap': {
      // Tapping the same wrong kind again is not a second mistake; it is a player stabbing
      // at a card. Only distinct wrong kinds count against the round.
      if (state.answers.some((a) => a.kind === event.kind)) return state;

      const correct = event.kind === round.shared;
      const answers = [...state.answers, { kind: event.kind, correct }];
      return correct
        ? { ...state, answers, wrong: null, done: true }
        : { ...state, answers, wrong: event.kind };
    }
  }
}
