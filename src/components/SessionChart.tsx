import { useState } from 'react';

/**
 * Median response time, session by session.
 *
 * This is the one number the training literature says should move: the Danish elite study
 * measured decision time falling 27% over six weeks, steeply through about session seven
 * and then flattening. So the chart is a line — change over time — of that alone.
 *
 * Deliberately **one series and one axis**. Accuracy lives in the stat tiles beside it
 * rather than on a second y-scale, because two scales on one frame let the reader draw
 * whatever relationship the scaling happens to suggest.
 */
export const WINDOW = 20;

export interface Point {
  /** 1-based session number, as the player would count it. */
  readonly session: number;
  readonly seconds: number;
}

const W = 320;
const H = 104;
const PAD = { top: 12, right: 38, bottom: 18, left: 6 };

export default function SessionChart({ points }: { points: readonly Point[] }) {
  const [active, setActive] = useState<number | null>(null);

  if (points.length < 2) {
    return (
      <p className="m-0 py-4 text-center text-xs text-muted">
        One more session and the curve starts.
      </p>
    );
  }

  const shown = points.slice(-WINDOW);
  const values = shown.map((p) => p.seconds);
  // Padded rather than zero-based: these are seconds between about 1 and 10, and a
  // zero baseline flattens the whole change into the top of the frame. Both ends of the
  // range are printed so the reader can see it is not zeroed.
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = Math.max(high - low, 0.4);
  const min = low - span * 0.2;
  const max = high + span * 0.2;

  const x = (i: number) =>
    PAD.left + (i / Math.max(1, shown.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) =>
    PAD.top + (1 - (v - min) / (max - min)) * (H - PAD.top - PAD.bottom);

  const line = shown.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.seconds).toFixed(1)}`).join('');
  const last = shown[shown.length - 1]!;
  const current = active === null ? last : shown[active]!;

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img"
        aria-label={`Median response time over the last ${shown.length} sessions, ${low.toFixed(1)} to ${high.toFixed(1)} seconds`}>
        {/* Recessive frame: the range, not a grid. */}
        <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom}
          stroke="var(--color-line)" strokeWidth={1} />

        <path d={line} fill="none" stroke="var(--color-flag)" strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round" />

        {shown.map((p, i) => (
          <circle key={p.session} cx={x(i)} cy={y(p.seconds)} r={active === i ? 4 : 2.5}
            fill="var(--color-flag)" />
        ))}

        {/* Hit targets, wider than the marks they select — a 2.5px dot is not tappable. */}
        {shown.map((p, i) => (
          <rect
            key={`hit-${p.session}`}
            x={x(i) - 8}
            y={0}
            width={16}
            height={H}
            fill="transparent"
            onPointerEnter={() => setActive(i)}
            onPointerDown={() => setActive(i)}
            onPointerLeave={() => setActive(null)}
          />
        ))}

        {/* One direct label, on the point being read — never a number on every point. */}
        <text x={W - PAD.right + 6} y={y(current.seconds) + 4} fontSize={12}
          fill="var(--color-paper)" className="tabular-nums">
          {current.seconds.toFixed(1)}s
        </text>

        <text x={PAD.left} y={H - 5} fontSize={9} fill="var(--color-muted)">
          session {shown[0]!.session}
        </text>
        <text x={W - PAD.right} y={H - 5} fontSize={9} fill="var(--color-muted)" textAnchor="end">
          {last.session}
        </text>
      </svg>

      <figcaption className="mt-1 text-center text-xs text-muted">
        {active === null
          ? 'median response · lower is better'
          : `session ${current.session} · ${current.seconds.toFixed(1)}s`}
      </figcaption>

      {/* The table view, for a screen reader and for anyone who cannot use the colour. */}
      <table className="sr-only">
        <caption>Median response time per session</caption>
        <thead>
          <tr><th scope="col">Session</th><th scope="col">Median seconds</th></tr>
        </thead>
        <tbody>
          {shown.map((p) => (
            <tr key={p.session}><td>{p.session}</td><td>{p.seconds.toFixed(1)}</td></tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
