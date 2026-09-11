import Verdict from '@/components/Verdict.tsx';
import MapView from '@/lib/terrain/MapView.tsx';
import { COLOUR, mm } from '@/lib/terrain/isom.ts';
import { CONTROL_NAMES, type ControlKind } from './features.ts';
import { MIN_CONTROL_GAP, type Control, type MapCard } from './drill.ts';

/**
 * What the reveal says about a card: the kind both cards share, and the kinds that were
 * tapped and were not it. Both cards are given the same one — the answer is a kind of
 * feature, so showing it on one card would be showing half of it.
 */
export interface CardReview {
  readonly shared: ControlKind;
  readonly wrong: readonly ControlKind[];
}

/**
 * One card: a map, with a course overprinted on it.
 *
 * The circles are a second `<svg>` laid over the first rather than something `MapView`
 * draws. Both take the same `viewBox`, so they line up by construction, and the map stays
 * a map — a tap target is not cartography, and a course is not terrain.
 */
export function CardView({
  card,
  radius,
  wrong,
  review,
  onTap,
  className,
}: {
  card: MapCard;
  /** In metres of ground. */
  radius: number;
  /** The kind just rejected, if any. */
  wrong?: ControlKind | null;
  /** Set once the round is over: the card stops taking taps and shows the answer. */
  review?: CardReview | null;
  onTap: (kind: ControlKind) => void;
  className?: string;
}) {
  const { crop } = card;
  const size = crop.size;
  const marked = (control: Control): 'right' | 'wrong' | null =>
    !review ? null
    : control.kind === review.shared ? 'right'
    : review.wrong.includes(control.kind) ? 'wrong'
    : null;
  return (
    <div className={`relative overflow-hidden ${className ?? ''}`}>
      <MapView map={card.map} crop={crop} className="block h-full w-full" />
      <svg
        viewBox={`${crop.x} ${crop.y} ${size} ${size}`}
        className="absolute inset-0 block h-full w-full"
        role="group"
        aria-label="controls"
      >
        {card.controls.map((control) => (
          <ControlMark
            key={control.kind}
            control={control}
            radius={radius}
            // Widths are millimetres of paper, like everything else drawn here; `unit` is
            // a hundredth of the window, exactly as in `MapView`.
            unit={size / 100}
            wrong={wrong === control.kind}
            marked={marked(control)}
            onTap={review ? null : onTap}
          />
        ))}
      </svg>
      {/* The ticks and crosses ride above the map rather than inside the overprint: the
          circles are cartography at millimetres of paper, and a verdict is not. Placed
          at the upper right of the ring it belongs to, so it says which circle without
          covering the feature the circle is about. */}
      {review &&
        card.controls.map((control) => {
          const kind = marked(control);
          if (!kind) return null;
          const at = (v: number, origin: number) => `${((v - origin) / size) * 100}%`;
          return (
            <Verdict
              key={control.kind}
              kind={kind}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{
                left: at(control.x + radius * 0.8, crop.x),
                top: at(control.y - radius * 0.8, crop.y),
              }}
            />
          );
        })}
    </div>
  );
}

function ControlMark({
  control,
  radius,
  unit,
  wrong,
  marked,
  onTap,
}: {
  control: Control;
  radius: number;
  unit: number;
  wrong: boolean;
  /** How the reveal treats this circle, or null while the round is open. */
  marked: 'right' | 'wrong' | null;
  /** Null once the round is over: a card that is being read is not a card being played. */
  onTap: ((kind: ControlKind) => void) | null;
}) {
  const tone = marked === 'right' ? 'text-good' : marked === 'wrong' || wrong ? 'text-bad' : '';
  return (
    <g
      {...(onTap ? { onClick: () => onTap(control.kind) } : {})}
      className={`${onTap ? 'cursor-pointer' : ''} ${tone}`}
      role={onTap ? 'button' : 'img'}
      aria-label={
        marked === 'right' ? `${CONTROL_NAMES[control.kind]} — the shared one`
        : marked === 'wrong' ? `${CONTROL_NAMES[control.kind]} — not shared`
        : CONTROL_NAMES[control.kind]
      }
    >
      {/* The reveal's second ring, outside the control circle: the answer is a circle
          already, so the only thing left to change about it is how much of it there is.
          The tick beside it is what says right rather than merely marked. */}
      {marked && (
        <circle
          cx={control.x}
          cy={control.y}
          // 1.2 and not more: circles stand `MIN_CONTROL_GAP` apart, so two marked rings
          // at 1.25 each would touch, and a reveal that draws its own collision is worse
          // than a smaller ring.
          r={radius * 1.2}
          fill="none"
          stroke="currentColor"
          strokeWidth={mm(0.6) * unit}
          {...(marked === 'wrong'
            ? { strokeDasharray: `${mm(1.5) * unit} ${mm(1) * unit}` }
            : {})}
        />
      )}
      {/* The ring alone is a thin target on a phone; this is what the finger hits. It stops
          at half the gap the generator keeps between circles, so two targets never overlap
          — a tap landing on the wrong control would cost the round rather than miss. */}
      <circle cx={control.x} cy={control.y} r={(radius * MIN_CONTROL_GAP) / 2} fill="transparent" />
      <circle
        cx={control.x}
        cy={control.y}
        r={radius}
        fill="none"
        // 503 control circle, 0.35 mm. A rejected one goes red *and* breaks into dashes:
        // red against purple is a difference two readers in twenty-five cannot see.
        stroke={wrong ? 'currentColor' : COLOUR.purple}
        strokeWidth={mm(wrong ? 0.7 : 0.35) * unit}
        {...(wrong ? { strokeDasharray: `${mm(1.5) * unit} ${mm(1) * unit}` } : {})}
      />
    </g>
  );
}
