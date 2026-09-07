import type { DobbleAnswer, DobbleRound } from './drill.ts';

/**
 * Tap rules for Dohledavka, as a reducer — same reason as Match Madness: a rule kept in
 * the component reads stale state when two taps land before a re-render, and cannot be
 * tested without a DOM.
 */
export interface DobbleState {
  readonly answers: readonly DobbleAnswer[];
  /** The symbol just rejected, held only until the flash clears. */
  readonly wrong: string | null;
  readonly done: boolean;
}

export type DobbleEvent =
  | { readonly type: 'tap'; readonly symbolId: string }
  | { readonly type: 'clear-wrong' }
  | { readonly type: 'timeout' };

export const initialState: DobbleState = { answers: [], wrong: null, done: false };

export function dobbleReduce(
  round: DobbleRound,
  state: DobbleState,
  event: DobbleEvent,
): DobbleState {
  if (state.done) return state;

  switch (event.type) {
    case 'clear-wrong':
      return state.wrong === null ? state : { ...state, wrong: null };

    case 'timeout':
      return { ...state, done: true, wrong: null };

    case 'tap': {
      // Tapping the same wrong symbol again is not a second mistake; it is a player
      // stabbing at a card. Only distinct wrong symbols count against the round.
      if (state.answers.some((a) => a.symbolId === event.symbolId)) return state;

      const correct = event.symbolId === round.shared;
      const answers = [...state.answers, { symbolId: event.symbolId, correct }];
      return correct
        ? { ...state, answers, wrong: null, done: true }
        : { ...state, answers, wrong: event.symbolId };
    }
  }
}
