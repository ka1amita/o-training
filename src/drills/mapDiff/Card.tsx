import type { PointerEvent as ReactPointerEvent } from 'react';
import Verdict from '@/components/Verdict.tsx';
import { COLOUR, mm } from '@/lib/terrain/isom.ts';
import MapView from '@/lib/terrain/MapView.tsx';
import type { Crop, OMap, Vec } from '@/lib/terrain/omap.ts';
import type { MapDiffAnswer, Target } from './drill.ts';

/** What the reveal draws on the card: every change, and whether it was found. */
export interface CardReview {
  readonly targets: readonly Target[];
  /** Indices of the targets that were tapped. */
  readonly found: ReadonlySet<number>;
}

/**
 * One card: a window of a map, with the taps made on it laid over the top.
 *
 * The overlay is a second `<svg>` sharing the map's `viewBox`, exactly as Mapova
 * dohledavka's course is — so a mark is placed in **metres of ground** and lines up by
 * construction rather than by arithmetic. That is also what makes the pointer conversion
 * one line: the element is square and so is the window, so the fraction of the box a
 * pointer landed at is the fraction of the window it landed at.
 */
export function Card({
  map,
  crop,
  taps,
  tolerance,
  review,
  onTap,
  className,
}: {
  map: OMap;
  crop: Crop;
  /** Every tap made so far, drawn as it was made: neutral, and never marked while playing. */
  taps: readonly MapDiffAnswer[];
  /** Metres. Half of what makes a tap target, the other half being the change's own size. */
  tolerance: number;
  /** Set once the round is over. The card stops taking taps and shows every change. */
  review?: CardReview | null;
  onTap?: ((at: Vec) => void) | null;
  className?: string;
}) {
  const size = crop.size;
  // Widths are millimetres of paper, as everywhere else drawn here; `unit` is a hundredth
  // of the window, exactly as in `MapView`.
  const unit = size / 100;
  const at = (v: number, origin: number) => `${((v - origin) / size) * 100}%`;

  /**
   * A pointer, as metres of ground.
   *
   * The one place this drill crosses from pixels to the map, and it crosses in the safe
   * direction: a *question* is turned into map coordinates, and the answer to it is then
   * decided by `state.ts` against the round's own discs. Nothing reads what was drawn.
   */
  const tapped = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!onTap) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    onTap({
      x: crop.x + ((event.clientX - box.left) / box.width) * size,
      y: crop.y + ((event.clientY - box.top) / box.height) * size,
    });
  };

  return (
    <div className={`relative overflow-hidden ${className ?? ''}`}>
      <MapView map={map} crop={crop} className="block h-full w-full" />
      <svg
        viewBox={`${crop.x} ${crop.y} ${size} ${size}`}
        className={`absolute inset-0 block h-full w-full ${onTap ? 'cursor-crosshair' : ''}`}
        {...(onTap ? { onPointerDown: tapped, role: 'button' } : { role: 'group' })}
        aria-label={onTap ? 'tap where the map differs' : 'what changed'}
      >
        {/* The taps, drawn as they were made. Neutral on purpose: nothing is marked right
            or wrong until the round is over, so a player cannot feel their way to a change
            by tapping around it — and there are only as many taps as there are changes. */}
        {taps.map((tap, index) => (
          <circle
            key={index}
            cx={tap.at.x}
            cy={tap.at.y}
            r={tolerance}
            fill="none"
            stroke={COLOUR.purple}
            strokeWidth={mm(0.35) * unit}
          />
        ))}

        {/* The reveal's ring is the target the tap had to land in, at its true size: a
            player who missed by a little should be able to see that it was by a little. */}
        {review?.targets.map((target, index) => {
          const hit = review.found.has(index);
          return (
            <circle
              key={index}
              cx={target.at.x}
              cy={target.at.y}
              r={target.radius + tolerance}
              fill="none"
              stroke="currentColor"
              strokeWidth={mm(0.6) * unit}
              className={hit ? 'text-good' : 'text-bad'}
              {...(hit ? {} : { strokeDasharray: `${mm(1.5) * unit} ${mm(1) * unit}` })}
            />
          );
        })}
      </svg>

      {/* Ticks and crosses ride above the map rather than inside the overlay: a ring is
          cartography at millimetres of paper and a verdict is not. Placed at the upper
          right of the ring so it says which change without covering it. */}
      {review?.targets.map((target, index) => (
        <Verdict
          key={index}
          kind={review.found.has(index) ? 'right' : 'wrong'}
          className="absolute -translate-x-1/2 -translate-y-1/2"
          style={{
            left: at(target.at.x + (target.radius + tolerance) * 0.8, crop.x),
            top: at(target.at.y - (target.radius + tolerance) * 0.8, crop.y),
          }}
        />
      ))}
    </div>
  );
}
