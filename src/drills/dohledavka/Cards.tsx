import { symbolById } from '@/lib/symbols/index.ts';
import type { DobbleCard, Placed } from './drill.ts';

/**
 * One card, rendered as the unit disc. Shared by the solo drill and both two-player
 * modes, so a change to how a card looks cannot make them disagree.
 */
export function CardView({
  card,
  highlight,
  onTap,
  className,
}: {
  card: DobbleCard;
  /** Symbol to mark as just-rejected, if any. */
  highlight?: string | null;
  onTap: (symbolId: string) => void;
  className?: string;
}) {
  return (
    <svg viewBox="-1 -1 2 2" className={className ?? 'aspect-square w-full'} role="group">
      <circle cx={0} cy={0} r={0.99} className="fill-paper" />
      {card.symbols.map((placed) => (
        <SymbolMark
          key={placed.symbolId}
          placed={placed}
          wrong={highlight === placed.symbolId}
          onTap={onTap}
        />
      ))}
    </svg>
  );
}

function SymbolMark({
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
  // card units. The stroke scales with it, which keeps a big symbol from looking spindly
  // beside a small one.
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
