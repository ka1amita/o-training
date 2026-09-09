import { useCallback, useEffect, useReducer, useState } from 'react';
import type { PlayProps } from '@/drills/types.ts';
import MapView from '@/lib/terrain/MapView.tsx';
import type { PexesoAnswer, PexesoRound } from './drill.ts';
import { initialState, pexesoReduce, type PexesoEvent, type PexesoState } from './state.ts';

/** How long a wrong pair stays up before it turns back over. */
const HOLD_MS = 900;

export default function Play({ round, onDone }: PlayProps<PexesoRound, PexesoAnswer>) {
  const [state, dispatch] = useReducer(
    useCallback((s: PexesoState, e: PexesoEvent) => pexesoReduce(round, s, e), [round]),
    initialState,
  );
  const [remainingMs, setRemainingMs] = useState(round.timeLimitMs);

  useEffect(() => {
    if (state.done) onDone([...state.answers]);
  }, [state.done, state.answers, onDone]);

  useEffect(() => {
    const startedAt = performance.now();
    const id = window.setInterval(() => {
      const left = round.timeLimitMs - (performance.now() - startedAt);
      setRemainingMs(Math.max(0, left));
      if (left <= 0) dispatch({ type: 'timeout' });
    }, 200);
    return () => window.clearInterval(id);
  }, [round]);

  useEffect(() => {
    if (state.flipped.length !== 2) return;
    const id = window.setTimeout(() => dispatch({ type: 'resolve' }), HOLD_MS);
    return () => window.clearTimeout(id);
  }, [state.flipped]);

  const columns = round.cards.length % 4 === 0 ? 4 : 3;
  const fraction = remainingMs / round.timeLimitMs;

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="h-1 overflow-hidden rounded-full bg-ink-soft" aria-hidden>
        <div
          className={`h-full ${fraction < 0.25 ? 'bg-bad' : 'bg-flag'}`}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>

      <ul
        className="m-0 grid list-none gap-2 p-0"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {round.cards.map((card, index) => {
          const isMatched = state.matched.has(index);
          const isUp = isMatched || state.flipped.includes(index);
          return (
            <li key={index}>
              <button
                type="button"
                onClick={() => dispatch({ type: 'flip', index })}
                disabled={isMatched}
                aria-label={isUp ? `map extract, pair ${card.pairId}` : 'face down'}
                className={`block aspect-square w-full overflow-hidden rounded-lg border-2 transition-colors ${
                  isMatched ? 'border-good opacity-70' : isUp ? 'border-flag' : 'border-line bg-ink-soft'
                }`}
              >
                {isUp ? (
                  <MapView
                    map={round.maps[card.pairId]!}
                    crop={card.crop}
                    control={card.control}
                    className="block h-full w-full"
                  />
                ) : (
                  <span className="block h-full w-full" />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
