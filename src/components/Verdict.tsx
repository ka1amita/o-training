import type { CSSProperties } from 'react';

/**
 * The tick or cross laid over a chosen option.
 *
 * Not decoration. The drills marked the right answer green and a wrong pick red and left
 * it at that, which is colour alone — and the two are ΔE 5.8 apart under deuteranopia,
 * measured, well under the 8 that counts as separable. Roughly one man in twelve has some
 * red-green deficiency, so for that reader the feedback simply was not there.
 *
 * The colour stays; this is the second encoding beside it.
 */
export default function Verdict({
  kind,
  className,
  style,
}: {
  kind: 'right' | 'wrong';
  /**
   * Where it sits. The default is the corner of a card, which is what an option in a grid
   * wears; a mark on a map belongs at the feature it is about, and the caller that knows
   * those coordinates places it itself — in percentages of the window, which is a `style`
   * and not a class.
   */
  className?: string;
  style?: CSSProperties;
}) {
  const right = kind === 'right';
  return (
    <span
      role="img"
      aria-label={right ? 'correct' : 'wrong'}
      style={style}
      className={`pointer-events-none flex h-6 w-6 items-center justify-center rounded-full ${
        className ?? 'absolute right-1 top-1'
      } ${right ? 'bg-good' : 'bg-bad'}`}
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="#1c1917" strokeWidth={3.5}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {right ? <path d="M4 13l5 5L20 7" /> : <path d="M6 6l12 12M18 6L6 18" />}
      </svg>
    </span>
  );
}
