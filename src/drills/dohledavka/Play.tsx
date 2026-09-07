import { useCallback, useEffect, useReducer } from 'react';
import type { PlayProps } from '@/drills/types.ts';
import { symbolById } from '@/lib/symbols/index.ts';
import type { DobbleAnswer, DobbleCard, DobbleRound, Placed } from './drill.ts';
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
        <Card
          key={i}
          card={card}
          wrong={state.wrong}
          onTap={(symbolId) => dispatch({ type: 'tap', symbolId })}
        />
      ))}
    </div>
  );
}

function Card({
  card,
  wrong,
  onTap,
}: {
  card: DobbleCard;
  wrong: string | null;
  onTap: (symbolId: string) => void;
}) {
  return (
    <svg
      viewBox="-1 -1 2 2"
      className="aspect-square w-full max-w-[min(46vh,20rem)] shrink"
      role="group"
    >
      <circle cx={0} cy={0} r={0.99} className="fill-paper" />
      {card.symbols.map((placed) => (
        <Symbol key={placed.symbolId} placed={placed} wrong={wrong === placed.symbolId} onTap={onTap} />
      ))}
    </svg>
  );
}

function Symbol({
  placed,
  wrong,
  onTap,
}: {
  placed: Placed;
  wrong: boolean;
  onTap: (symbolId: string) => void;
}) {
  const symbol = symbolById(placed.symbolId);
  if (!symbol) return null;
  // The glyphs are drawn for a 200-unit box, so scale/200 puts one in a box of `scale`
  // card units. The stroke scales with it, which is what keeps a big symbol from looking
  // spindly next to a small one.
  const transform =
    `translate(${placed.x} ${placed.y}) rotate(${placed.rotation}) scale(${placed.scale / 200})`;
  return (
    <g
      transform={transform}
      onClick={() => onTap(placed.symbolId)}
      className={`cursor-pointer ${wrong ? 'text-bad' : 'text-ink'}`}
      role="button"
      aria-label={symbol.name}
    >
      {/* The strokes alone are too thin to hit reliably; this is the tap target, and it
          matches the box the overlap invariant reasons about. */}
      <circle cx={0} cy={0} r={100} fill="transparent" />
      <g dangerouslySetInnerHTML={{ __html: symbol.svg }} />
    </g>
  );
}
