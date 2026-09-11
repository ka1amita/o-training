import { useCallback, useEffect, useReducer } from 'react';
import type { PlayProps } from '@/drills/types.ts';
import { CardView } from './Cards.tsx';
import type { DobbleAnswer, DobbleRound } from './drill.ts';
import { dobbleReduce, initialState, type DobbleEvent, type DobbleState } from './state.ts';

const WRONG_FLASH_MS = 350;

/** Rendering only. Every rule about what a tap means is in `state.ts`. */
export default function Play({
  round, phase, answers, onDone,
}: PlayProps<DobbleRound, DobbleAnswer>) {
  const reviewing = phase === 'review';
  const [state, dispatch] = useReducer(
    useCallback((s: DobbleState, e: DobbleEvent) => dobbleReduce(round, s, e), [round]),
    initialState,
  );

  useEffect(() => {
    if (state.done) onDone([...state.answers]);
  }, [state.done, state.answers, onDone]);

  useEffect(() => {
    if (!state.wrong) return;
    const id = window.setTimeout(() => dispatch({ type: 'clear-wrong' }), WRONG_FLASH_MS);
    return () => window.clearTimeout(id);
  }, [state.wrong]);

  // Marked on both cards, because the shared symbol is the answer and one card shows half
  // of it. The wrong picks come from what was reported: the session holds the round's
  // record, this only draws it.
  const review = reviewing
    ? {
        shared: round.shared,
        wrong: (answers ?? []).filter((a) => !a.correct).map((a) => a.symbolId),
      }
    : null;

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4">
      {round.cards.map((card, i) => (
        <CardView
          key={i}
          card={card}
          highlight={state.wrong}
          review={review}
          onTap={(symbolId) => dispatch({ type: 'tap', symbolId })}
          className="aspect-square w-full max-w-[min(46vh,20rem)] shrink"
        />
      ))}
    </div>
  );
}
