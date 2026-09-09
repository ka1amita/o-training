import MapView from '@/lib/terrain/MapView.tsx';
import { COLOUR, mm } from '@/lib/terrain/isom.ts';
import { CONTROL_NAMES, type ControlKind } from './features.ts';
import { MIN_CONTROL_GAP, type Control, type MapCard } from './drill.ts';

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
  onTap,
  className,
}: {
  card: MapCard;
  /** In metres of ground. */
  radius: number;
  /** The kind just rejected, if any. */
  wrong?: ControlKind | null;
  onTap: (kind: ControlKind) => void;
  className?: string;
}) {
  const { size } = card.terrain;
  return (
    <div className={`relative overflow-hidden ${className ?? ''}`}>
      <MapView terrain={card.terrain} className="block h-full w-full" />
      <svg
        viewBox={`0 0 ${size} ${size}`}
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
            onTap={onTap}
          />
        ))}
      </svg>
    </div>
  );
}

function ControlMark({
  control,
  radius,
  unit,
  wrong,
  onTap,
}: {
  control: Control;
  radius: number;
  unit: number;
  wrong: boolean;
  onTap: (kind: ControlKind) => void;
}) {
  return (
    <g
      onClick={() => onTap(control.kind)}
      className={`cursor-pointer ${wrong ? 'text-bad' : ''}`}
      role="button"
      aria-label={CONTROL_NAMES[control.kind]}
    >
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
