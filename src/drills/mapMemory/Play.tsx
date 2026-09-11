import { useCallback, useEffect, useMemo, useState } from 'react';
import Verdict from '@/components/Verdict.tsx';
import type { PlayProps } from '@/drills/types.ts';
import { applyEdits } from '@/lib/terrain/edits.ts';
import MapView from '@/lib/terrain/MapView.tsx';
import type { MapMemoryAnswer, MapMemoryRound } from './drill.ts';

/** The drill's own two halves: the extract, then the choice. The review that follows a
 *  choice is the session's phase, not this one. */
type Exposure = 'showing' | 'choosing';

export default function Play({
  round, phase, answers, onDone,
}: PlayProps<MapMemoryRound, MapMemoryAnswer>) {
  const reviewing = phase === 'review';
  const [exposure, setExposure] = useState<Exposure>('showing');
  const [remaining, setRemaining] = useState(round.exposureMs);
  const [picked, setPicked] = useState<number | null>(null);

  useEffect(() => {
    const startedAt = performance.now();
    const id = window.setInterval(() => {
      const left = round.exposureMs - (performance.now() - startedAt);
      setRemaining(Math.max(0, left));
      if (left <= 0) setExposure('choosing');
    }, 80);
    return () => window.clearInterval(id);
  }, [round]);

  const choose = useCallback(
    (index: number) => {
      if (picked !== null) return;
      setPicked(index);
      // Reported on the tap. The pause that used to mark the pick is the review phase.
      onDone([{ index, correct: index === round.correctIndex }]);
    },
    [picked, round.correctIndex, onDone],
  );

  // In review the pick is what was reported; local state is only the fallback.
  const chosen = reviewing ? answers?.[0]?.index ?? picked : picked;

  const options = useMemo(
    () => round.variants.map((v) => applyEdits(v.base, v.edits)),
    [round],
  );
  const answer = options[round.correctIndex]!;

  if (exposure === 'showing') {
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
      <p className="m-0 text-center text-sm text-muted">
        {reviewing ? 'This one.' : 'Which one was it?'}
      </p>
      <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0">
        {options.map((option, index) => {
          // Marked only in review, and both ways round: the extract that was shown, and
          // the one that was taken for it.
          const state =
            !reviewing ? 'idle'
            : index === round.correctIndex ? 'right'
            : index === chosen ? 'wrong'
            : 'idle';
          return (
            <li key={index}>
              <button
                type="button"
                onClick={() => choose(index)}
                disabled={reviewing}
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
