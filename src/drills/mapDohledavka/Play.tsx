import { useCallback, useEffect, useReducer } from 'react';
import type { PlayProps } from '@/drills/types.ts';
import { CardView } from './Cards.tsx';
import type { MapDobbleAnswer, MapDobbleRound } from './drill.ts';
import {
  initialState, mapDobbleReduce, type MapDobbleEvent, type MapDobbleState,
} from './state.ts';

const WRONG_FLASH_MS = 400;

/** Rendering only. Every rule about what a tap means is in `state.ts`. */
export default function Play({ round, onDone }: PlayProps<MapDobbleRound, MapDobbleAnswer>) {
  const [state, dispatch] = useReducer(
    useCallback((s: MapDobbleState, e: MapDobbleEvent) => mapDobbleReduce(round, s, e), [round]),
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
    <div className="flex flex-1 flex-col items-center justify-center gap-3">
      {round.cards.map((card, i) => (
        <CardView
          key={i}
          card={card}
          radius={round.radius}
          wrong={state.wrong}
          onTap={(kind) => dispatch({ type: 'tap', kind })}
          className="aspect-square w-full max-w-[min(45vh,22rem)] shrink rounded-lg border border-line"
        />
      ))}
    </div>
  );
}
