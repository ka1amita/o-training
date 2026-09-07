import { useCallback, useEffect, useReducer, useState } from 'react';
import Glyph from '@/components/Glyph.tsx';
import type { PlayProps } from '@/drills/types.ts';
import type { MatchAnswer, MatchRound } from './drill.ts';
import {
  initialState, isTileMatched, matchReduce,
  type MatchEvent, type MatchState,
} from './state.ts';

/** How long a rejected pair stays lit before it clears. */
const WRONG_FLASH_MS = 400;

/**
 * Rendering and timers only. Every rule about what a tap means lives in `state.ts`,
 * where it is tested without a DOM.
 */
export default function Play({ round, onDone }: PlayProps<MatchRound, MatchAnswer>) {
  const [state, dispatch] = useReducer(
    useCallback((s: MatchState, e: MatchEvent) => matchReduce(round, s, e), [round]),
    initialState,
  );
  const [remainingMs, setRemainingMs] = useState(round.timeLimitMs);

  // The reducer refuses every event once done, so this transition happens exactly once.
  useEffect(() => {
    if (state.done) onDone([...state.answers]);
  }, [state.done, state.answers, onDone]);

  useEffect(() => {
    const startedAt = performance.now();
    const id = window.setInterval(() => {
      const left = round.timeLimitMs - (performance.now() - startedAt);
      setRemainingMs(Math.max(0, left));
      if (left <= 0) dispatch({ type: 'timeout' });
    }, 100);
    return () => window.clearInterval(id);
  }, [round]);

  useEffect(() => {
    if (!state.wrong) return;
    const id = window.setTimeout(() => dispatch({ type: 'clear-wrong' }), WRONG_FLASH_MS);
    return () => window.clearTimeout(id);
  }, [state.wrong]);

  const stateOf = (kind: 'symbol' | 'name', value: string): TileState => {
    if (isTileMatched(round, state, kind, value)) return 'matched';
    const isWrong =
      state.wrong && (kind === 'symbol' ? state.wrong.symbolId : state.wrong.name) === value;
    if (isWrong) return 'wrong';
    if (state.selected?.kind === kind && state.selected.value === value) return 'selected';
    return 'idle';
  };

  const fraction = remainingMs / round.timeLimitMs;

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="h-1 overflow-hidden rounded-full bg-ink-soft" aria-hidden>
        <div
          className={`h-full transition-[width] duration-100 ease-linear ${
            fraction < 0.25 ? 'bg-bad' : 'bg-flag'
          }`}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>

      <div className="grid flex-1 grid-cols-2 items-start gap-3">
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {round.symbolOrder.map((id) => (
            <li key={id}>
              <Tile
                state={stateOf('symbol', id)}
                onClick={() => dispatch({ type: 'tap', kind: 'symbol', value: id })}
              >
                <Glyph id={id} className="mx-auto h-12 w-12" />
              </Tile>
            </li>
          ))}
        </ul>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {round.nameOrder.map((name) => (
            <li key={name}>
              <Tile
                state={stateOf('name', name)}
                onClick={() => dispatch({ type: 'tap', kind: 'name', value: name })}
              >
                <span className="block text-sm leading-tight">{name}</span>
              </Tile>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

type TileState = 'idle' | 'selected' | 'matched' | 'wrong';

const TILE: Record<TileState, string> = {
  idle: 'border-line bg-ink-soft',
  selected: 'border-flag bg-ink-soft',
  // Kept in place rather than removed: tiles that vanish reflow the column under a
  // finger already moving towards the next tap.
  matched: 'border-transparent bg-transparent text-muted opacity-30',
  wrong: 'border-bad bg-ink-soft',
};

function Tile({
  state,
  onClick,
  children,
}: {
  state: TileState;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === 'matched'}
      className={`flex min-h-16 w-full items-center justify-center rounded-xl border-2 px-3 py-3 text-center transition-colors ${TILE[state]}`}
    >
      {children}
    </button>
  );
}
