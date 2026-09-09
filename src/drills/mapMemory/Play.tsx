import { useCallback, useEffect, useMemo, useState } from 'react';
import Verdict from '@/components/Verdict.tsx';
import type { PlayProps } from '@/drills/types.ts';
import { applyEdits } from '@/lib/terrain/edits.ts';
import MapView from '@/lib/terrain/MapView.tsx';
import type { MapMemoryAnswer, MapMemoryRound } from './drill.ts';

const FEEDBACK_MS = 700;

type Phase = 'showing' | 'choosing';

export default function Play({ round, onDone }: PlayProps<MapMemoryRound, MapMemoryAnswer>) {
  const [phase, setPhase] = useState<Phase>('showing');
  const [remaining, setRemaining] = useState(round.exposureMs);
  const [picked, setPicked] = useState<number | null>(null);

  useEffect(() => {
    const startedAt = performance.now();
    const id = window.setInterval(() => {
      const left = round.exposureMs - (performance.now() - startedAt);
      setRemaining(Math.max(0, left));
      if (left <= 0) setPhase('choosing');
    }, 80);
    return () => window.clearInterval(id);
  }, [round]);

  const choose = useCallback((index: number) => {
    setPicked((current) => (current === null ? index : current));
  }, []);

  useEffect(() => {
    if (picked === null) return;
    const id = window.setTimeout(
      () => onDone([{ index: picked, correct: picked === round.correctIndex }]),
      FEEDBACK_MS,
    );
    return () => window.clearTimeout(id);
  }, [picked, round.correctIndex, onDone]);

  const options = useMemo(
    () => round.variants.map((v) => applyEdits(v.base, v.edits)),
    [round],
  );
  const answer = options[round.correctIndex]!;

  if (phase === 'showing') {
    return (
      <div className="flex flex-1 flex-col items-center gap-4">
        <div className="h-1 w-full overflow-hidden rounded-full bg-ink-soft" aria-hidden>
          <div
            className="h-full bg-flag transition-[width] duration-75 ease-linear"
            style={{ width: `${(remaining / round.exposureMs) * 100}%` }}
          />
        </div>
        <p className="m-0 text-sm text-muted">Look.</p>
        <div className="w-full max-w-[20rem] overflow-hidden rounded-xl border border-line">
          <MapView
            map={answer}
            crop={round.crop}
            className="block h-full w-full"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-3">
      <p className="m-0 text-center text-sm text-muted">Which one was it?</p>
      <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0">
        {options.map((option, index) => {
          const state =
            picked === null ? 'idle'
            : index === round.correctIndex ? 'right'
            : index === picked ? 'wrong'
            : 'idle';
          return (
            <li key={index}>
              <button
                type="button"
                onClick={() => choose(index)}
                aria-label={`extract ${index + 1}`}
                className={`relative block aspect-square w-full overflow-hidden rounded-lg border-2 transition-colors ${
                  state === 'right' ? 'border-good'
                  : state === 'wrong' ? 'border-bad'
                  : 'border-line'
                }`}
              >
                {/* The identical window on every candidate: only the ground differs. */}
                <MapView map={option} crop={round.crop} className="block h-full w-full" />
                {state !== 'idle' && <Verdict kind={state} />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
