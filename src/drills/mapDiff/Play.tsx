import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import Verdict from '@/components/Verdict.tsx';
import type { PlayProps } from '@/drills/types.ts';
import { applyEdits } from '@/lib/terrain/edits.ts';
import { Card } from './Card.tsx';
import type { MapDiffAnswer, MapDiffRound } from './drill.ts';
import {
  initialState, mapDiffReduce, type MapDiffEvent, type MapDiffState,
} from './state.ts';

/** Rendering only. Every rule about what a tap means is in `state.ts`. */
export default function Play({
  round, phase, answers, onDone,
}: PlayProps<MapDiffRound, MapDiffAnswer>) {
  const reviewing = phase === 'review';
  const [state, dispatch] = useReducer(
    useCallback((s: MapDiffState, e: MapDiffEvent) => mapDiffReduce(round, s, e), [round]),
    initialState,
  );
  const [remaining, setRemaining] = useState(round.timeLimitMs);

  useEffect(() => {
    if (state.done) onDone([...state.taps]);
  }, [state.done, state.taps, onDone]);

  // The clock is the component's — it is wall time, and `generate` and `score` know
  // nothing about it — but what running out *means* is the reducer's, like every other
  // way this round can end.
  useEffect(() => {
    if (state.done) return;
    const startedAt = performance.now();
    const id = window.setInterval(() => {
      const left = round.timeLimitMs - (performance.now() - startedAt);
      setRemaining(Math.max(0, left));
      if (left <= 0) dispatch({ type: 'timeout' });
    }, 100);
    return () => window.clearInterval(id);
  }, [round, state.done]);

  // The card: the base with the round's edits on it, made here and nowhere else. The round
  // carries the edits; this is the one place they become a map to look at.
  const shown = useMemo(() => applyEdits(round.base, round.edits), [round]);

  // In review the taps come from what was reported — the session holds the record of the
  // round, and this only draws it — with local state as the fallback for a round that
  // ended without one.
  const taps = reviewing ? answers ?? state.taps : state.taps;
  const found = useMemo(
    () => new Set(taps.map((t) => t.target).filter((t) => t !== null)),
    [taps],
  );
  const left = round.targets.length - taps.length;

  // Two cards or one. They are the **same size** whenever both are up: a change is found by
  // comparing them, and two maps at two scales is a comparison of two drawings rather than
  // of two pieces of ground. Smaller when paired so the pair fits one screen.
  const paired = round.withOriginal || reviewing;
  const card = `aspect-square w-full shrink rounded-lg border border-line ${
    paired ? 'max-w-[min(40vh,20rem)]' : 'max-w-[min(52vh,24rem)]'
  }`;

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2">
      {!reviewing && (
        <div className="h-1 w-full shrink-0 overflow-hidden rounded-full bg-ink-soft" aria-hidden>
          <div
            className="h-full bg-flag transition-[width] duration-100 ease-linear"
            style={{ width: `${(remaining / round.timeLimitMs) * 100}%` }}
          />
        </div>
      )}

      <p className="m-0 text-center text-sm text-muted">
        {reviewing
          ? `${found.size} of ${round.targets.length} found.`
          : round.targets.length === 1
            ? 'One thing on this map is not as it was. Tap it.'
            : `${round.targets.length} things are not as they were. ${left} ${left === 1 ? 'tap' : 'taps'} left.`}
      </p>

      <Card
        map={shown}
        crop={round.crop}
        taps={taps}
        tolerance={round.tolerance}
        review={reviewing ? { targets: round.targets, found } : null}
        onTap={reviewing ? null : (at) => dispatch({ type: 'tap', at })}
        className={card}
      />

      {/* The original: an aid at the bottom of the ladder, where the round asks for one
          change and the question is what "different" even means — and then again in every
          reveal, because a change is only legible against what was there. */}
      {paired && (
        <>
          <p className="m-0 text-center text-xs text-muted">The map as it was</p>
          <Card
            map={round.base}
            crop={round.crop}
            taps={[]}
            tolerance={round.tolerance}
            className={card}
          />
        </>
      )}

      {reviewing && (
        <ul className="m-0 flex w-full list-none flex-col gap-1 p-0 text-sm">
          {round.targets.map((target, index) => (
            <li key={index} className="flex items-center gap-2">
              <Verdict kind={found.has(index) ? 'right' : 'wrong'} className="relative shrink-0" />
              <span className={found.has(index) ? '' : 'text-muted'}>{target.word}</span>
            </li>
          ))}
        </ul>
      )}

      {!reviewing && (
        <button
          type="button"
          onClick={() => dispatch({ type: 'give-up' })}
          className="mt-1 shrink-0 rounded-lg border border-line px-4 py-2 text-sm text-muted"
        >
          Nothing else
        </button>
      )}
    </div>
  );
}
