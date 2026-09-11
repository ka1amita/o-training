import { useCallback, useMemo, useState } from 'react';
import Verdict from '@/components/Verdict.tsx';
import type { PlayProps } from '@/drills/types.ts';
import { applyEdits } from '@/lib/terrain/edits.ts';
import MapView from '@/lib/terrain/MapView.tsx';
import Relief from '@/lib/terrain/Relief.tsx';
import type { ContoursAnswer, ContoursRound } from './drill.ts';

export default function Play({
  round, phase, answers, onDone,
}: PlayProps<ContoursRound, ContoursAnswer>) {
  const reviewing = phase === 'review';
  const [picked, setPicked] = useState<number | null>(null);

  const choose = useCallback(
    (index: number) => {
      if (picked !== null) return;
      setPicked(index);
      // Reported the moment it is tapped: the response time is the tap, and the marking
      // that used to be worth pausing for is the review phase now.
      onDone([{ index, correct: index === round.correctIndex }]);
    },
    [picked, round.correctIndex, onDone],
  );

  // In review the pick comes from what was reported rather than from local state: the
  // session holds the record of the round, and this only draws it.
  const chosen = reviewing ? answers?.[0]?.index ?? picked : picked;

  // The options are made here and nowhere else: a round carries the edits that define
  // them, and this is the one place they become ground to look at.
  const options = useMemo(
    () => round.variants.map((v) => applyEdits(v.base, v.edits)),
    [round],
  );
  const answer = options[round.correctIndex]!;

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="mx-auto w-full max-w-[16rem] overflow-hidden rounded-xl border border-line">
        <MapView map={answer} contoursOnly className="block h-full w-full" />
      </div>

      <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0">
        {options.map((option, index) => {
          // Only in review, and it says both things: which one it was, and which one was
          // tapped. A wrong pick unmarked would leave the player to remember it.
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
                aria-label={`relief ${index + 1}`}
                className={`relative block aspect-square w-full overflow-hidden rounded-lg border-2 transition-colors ${
                  state === 'right' ? 'border-good'
                  : state === 'wrong' ? 'border-bad'
                  : 'border-line'
                }`}
              >
                <Relief relief={option.relief} className="block h-full w-full" />
                {state !== 'idle' && <Verdict kind={state} />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
