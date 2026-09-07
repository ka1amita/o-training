import { symbolById } from '@/lib/symbols/index.ts';

/**
 * One IOF control-description symbol. The generated SVG bodies use `currentColor`, so a
 * glyph takes the colour of whatever it sits in and needs no variants.
 */
export default function Glyph({ id, className }: { id: string; className?: string }) {
  const symbol = symbolById(id);
  if (!symbol) return null;
  return (
    <svg
      viewBox="-100 -100 200 200"
      className={className}
      role="img"
      aria-label={symbol.name}
      // The source glyphs are stroked at a fixed width for a 200-unit box; letting the
      // stroke scale with the box is what keeps a small glyph from turning into a blob.
      vectorEffect="non-scaling-stroke"
      dangerouslySetInnerHTML={{ __html: symbol.svg }}
    />
  );
}
