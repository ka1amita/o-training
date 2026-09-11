import Verdict from '@/components/Verdict.tsx';
import { symbolById } from '@/lib/symbols/index.ts';
import type { DobbleCard, Placed } from './drill.ts';

/**
 * What the reveal says about a card: the symbol the two cards share, and the ones that
 * were tapped and were not it. The shared symbol is marked on **both** cards, because
 * that is what the round asked — one of them is half an answer.
 *
 * `wrong` is empty in a two-player game: only a correct tap is ever reported there.
 */
export interface CardReview {
  readonly shared: string;
  readonly wrong: readonly string[];
}

/**
 * One card, rendered as the unit disc. Shared by the solo drill and both two-player
 * modes, so a change to how a card looks cannot make them disagree.
 */
export function CardView({
  card,
  highlight,
  review,
  onTap,
  className,
}: {
  card: DobbleCard;
  /** Symbol to mark as just-rejected, if any. */
  highlight?: string | null;
  /** Set once the round is decided: the card shows the answer and takes no more taps. */
  review?: CardReview | null;
  onTap: (symbolId: string) => void;
  className?: string;
}) {
  const marked = (symbolId: string): 'right' | 'wrong' | null =>
    !review ? null
    : symbolId === review.shared ? 'right'
    : review.wrong.includes(symbolId) ? 'wrong'
    : null;
  return (
    // The disc is wrapped so the ticks have something to be positioned against: a verdict
    // is html over the card, not a glyph on it.
    <div className={`relative ${className ?? 'aspect-square w-full'}`}>
      <svg viewBox="-1 -1 2 2" className="block h-full w-full" role="group">
        <circle cx={0} cy={0} r={0.99} className="fill-paper" />
        {card.symbols.map((placed) => (
          <SymbolMark
            key={placed.symbolId}
            placed={placed}
            wrong={highlight === placed.symbolId}
            marked={marked(placed.symbolId)}
            onTap={review ? null : onTap}
          />
        ))}
      </svg>
      {review &&
        card.symbols.map((placed) => {
          const kind = marked(placed.symbolId);
          if (!kind) return null;
          // The disc spans -1..1 across the box, so a symbol's own coordinates are its
          // place on it. The glyph is drawn for a 200-unit box at `scale / 200`, so it
          // reaches half of `scale` from its centre; the mark sits up and to the right of
          // that, clear of the strokes it is about.
          const reach = placed.scale / 2;
          return (
            <Verdict
              key={placed.symbolId}
              kind={kind}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{
                left: `${((placed.x + reach * 0.8 + 1) / 2) * 100}%`,
                top: `${((placed.y - reach * 0.8 + 1) / 2) * 100}%`,
              }}
            />
          );
        })}
    </div>
  );
}

function SymbolMark({
  placed,
  wrong,
  marked,
  onTap,
}: {
  placed: Placed;
  wrong: boolean;
  /** How the reveal treats this symbol, or null while the round is open. */
  marked: 'right' | 'wrong' | null;
  /** Null once the round is decided: a card being read is not a card being played. */
  onTap: ((symbolId: string) => void) | null;
}) {
  const symbol = symbolById(placed.symbolId);
  if (!symbol) return null;
  // The glyphs are drawn for a 200-unit box, so scale/200 puts one in a box of `scale`
  // card units. The stroke scales with it, which keeps a big symbol from looking spindly
  // beside a small one.
  const transform =
    `translate(${placed.x} ${placed.y}) rotate(${placed.rotation}) scale(${placed.scale / 200})`;
  const tone =
    marked === 'right' ? 'text-good' : marked === 'wrong' || wrong ? 'text-bad' : 'text-ink';
  return (
    <g
      transform={transform}
      {...(onTap ? { onClick: () => onTap(placed.symbolId) } : {})}
      className={`${onTap ? 'cursor-pointer' : ''} ${tone}`}
      role={onTap ? 'button' : 'img'}
      aria-label={
        marked === 'right' ? `${symbol.name} — the shared one`
        : marked === 'wrong' ? `${symbol.name} — not shared`
        : symbol.name
      }
    >
      {/* The strokes alone are too thin to hit reliably; this is the tap target, and it
          matches the box the overlap invariant reasons about. */}
      <circle cx={0} cy={0} r={100} fill="transparent" />
      {/* The reveal's ring, on the target's own box so it frames the glyph whatever the
          glyph is. Dashed when it is a wrong pick: the tick and the cross carry the
          verdict, and this only says which symbol they are about. */}
      {marked && (
        <circle
          cx={0}
          cy={0}
          r={100}
          fill="none"
          stroke="currentColor"
          strokeWidth={9}
          {...(marked === 'wrong' ? { strokeDasharray: '26 18' } : {})}
        />
      )}
      <g dangerouslySetInnerHTML={{ __html: symbol.svg }} />
    </g>
  );
}
