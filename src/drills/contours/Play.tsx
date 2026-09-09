import { useCallback, useEffect, useState } from 'react';
import Verdict from '@/components/Verdict.tsx';
import type { PlayProps } from '@/drills/types.ts';
import MapView from '@/lib/terrain/MapView.tsx';
import Relief from '@/lib/terrain/Relief.tsx';
import type { ContoursAnswer, ContoursRound } from './drill.ts';

/** How long the chosen option is marked before the round is reported. */
const FEEDBACK_MS = 700;

export default function Play({ round, onDone }: PlayProps<ContoursRound, ContoursAnswer>) {
  const [picked, setPicked] = useState<number | null>(null);

  const choose = useCallback(
    (index: number) => {
      // First answer only. A second tap during the feedback pause would otherwise report
      // the round twice.
      setPicked((current) => (current === null ? index : current));
    },
    [],
  );

  useEffect(() => {
    if (picked === null) return;
    const id = window.setTimeout(
      () => onDone([{ index: picked, correct: picked === round.correctIndex }]),
      FEEDBACK_MS,
    );
    return () => window.clearTimeout(id);
  }, [picked, round.correctIndex, onDone]);

  const answer = round.options[round.correctIndex]!;

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="mx-auto w-full max-w-[16rem] overflow-hidden rounded-xl border border-line">
        <MapView map={answer} contoursOnly className="block h-full w-full" />
      </div>

      <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0">
        {round.options.map((option, index) => {
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
