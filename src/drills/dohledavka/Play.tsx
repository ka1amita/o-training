import { useCallback, useEffect, useReducer } from 'react';
import type { PlayProps } from '@/drills/types.ts';
import { CardView } from './Cards.tsx';
import type { DobbleAnswer, DobbleRound } from './drill.ts';
import { dobbleReduce, initialState, type DobbleEvent, type DobbleState } from './state.ts';

const WRONG_FLASH_MS = 350;

/** Rendering only. Every rule about what a tap means is in `state.ts`. */
export default function Play({ round, onDone }: PlayProps<DobbleRound, DobbleAnswer>) {
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

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4">
      {round.cards.map((card, i) => (
        <CardView
          key={i}
          card={card}
          highlight={state.wrong}
          onTap={(symbolId) => dispatch({ type: 'tap', symbolId })}
          className="aspect-square w-full max-w-[min(46vh,20rem)] shrink"
        />
      ))}
    </div>
  );
}
