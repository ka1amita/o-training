import { useId, useMemo } from 'react';
import { contoursOf, type Contour } from './contours.ts';
import { sampleGrid } from './height.ts';
import { COLOUR, CONTOUR, GREEN_SCREEN, LINE, MARSH, POINT, YELLOW_SCREEN } from './isom.ts';
import { areaOutline, OUTLINE_SLACK } from './shapes.ts';
import type { AreaFeature, LineFeature, PointFeature, Terrain, Vec } from './terrain.ts';

/**
 * The terrain drawn to ISOM 2017-2.
 *
 * SVG rather than canvas, and the reason is Posunute pexeso: a crop is a `viewBox` and
 * nothing else. Two offset windows on one map are two elements sharing one geometry,
 * with no second render and no pixel buffers to hold.
 *
 * Every width and dash comes from `isom.ts` in millimetres of paper. See the note there
 * on why millimetres convert to a window-independent multiple of `unit`.
 */
export const ISOM = COLOUR;

/** A window onto the terrain, in world metres. */
export interface Crop {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

export interface MapViewProps {
  readonly terrain: Terrain;
  /** Defaults to the whole map. */
  readonly crop?: Crop;
  /** Draws a control circle here. */
  readonly control?: Vec;
  readonly contourInterval?: number;
  /** Brown lines on white and nothing else, for the drill about reading relief. */
  readonly contoursOnly?: boolean;
  readonly className?: string;
}

const path = (points: readonly Vec[], close: boolean) =>
  `M${points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L')}${close ? 'Z' : ''}`;

interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

const boxOf = (points: readonly Vec[]): Box => ({
  minX: Math.min(...points.map((p) => p.x)),
  minY: Math.min(...points.map((p) => p.y)),
  maxX: Math.max(...points.map((p) => p.x)),
  maxY: Math.max(...points.map((p) => p.y)),
});

const overlaps = (box: Box, crop: Crop, pad: number): boolean =>
  box.maxX >= crop.x - pad &&
  box.minX <= crop.x + crop.size + pad &&
  box.maxY >= crop.y - pad &&
  box.minY <= crop.y + crop.size + pad;

export default function MapView({
  terrain,
  crop,
  control,
  contourInterval = 5,
  contoursOnly = false,
  className,
}: MapViewProps) {
  const window_ = crop ?? { x: 0, y: 0, size: terrain.size };

  /**
   * Pattern ids are per instance.
   *
   * A pexeso board mounts twelve `MapView`s into one document. With a fixed id every card
   * after the first would silently paint itself with the first card's marsh, at the first
   * card's scale.
   */
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');

  // Traced once per terrain, not per crop: two cards showing the same ground must show
  // the same lines, and re-tracing per window would also cost twice as much.
  const contours = useMemo(() => {
    const grid = sampleGrid(terrain, 96);
    return contoursOf(grid, { interval: contourInterval, resolution: 96, formLines: true });
  }, [terrain, contourInterval]);

  // Scaled to the window so a small crop keeps ordinary map line weights rather than
  // magnifying them into slabs.
  const unit = window_.size / 100;

  /**
   * Only what the window can show.
   *
   * SVG clips the rest anyway, so this changes no pixel — but a pexeso board is twelve
   * crops of a 300 m map, and emitting the whole map twelve times to show a twelfth of it
   * each is work a phone does before the board appears. Measured on a 12-card board:
   * 381 elements without this, 228 with it.
   *
   * It used to save far more, because the contour tracer used to shred every open line
   * into one path per cell — a single 300 m map came out as 175 polylines where it now
   * comes out as 15. See `stitch`.
   */
  const visible = useMemo(() => {
    const pad = window_.size * 0.05;
    return {
      contours: contours.filter((c) => overlaps(boxOf(c.points), window_, pad)),
      areas: terrain.areas.filter((a) =>
        overlaps(
          {
            // The outline wanders outside the ellipse, so the cull box has to allow for it.
            minX: a.x - a.rx * OUTLINE_SLACK,
            maxX: a.x + a.rx * OUTLINE_SLACK,
            minY: a.y - a.ry * OUTLINE_SLACK,
            maxY: a.y + a.ry * OUTLINE_SLACK,
          },
          window_,
          pad,
        ),
      ),
      lines: terrain.lines.filter((l) => overlaps(boxOf(l.points), window_, pad)),
      points: terrain.points.filter((f) =>
        overlaps(
          { minX: f.x - f.size, maxX: f.x + f.size, minY: f.y - f.size, maxY: f.y + f.size },
          window_,
          pad,
        ),
      ),
    };
  }, [contours, terrain, window_.x, window_.y, window_.size]);

  const marshId = `marsh-${uid}`;

  return (
    <svg
      viewBox={`${window_.x} ${window_.y} ${window_.size} ${window_.size}`}
      className={className}
      role="img"
      aria-label="map extract"
    >
      <defs>
        <MarshPattern id={marshId} unit={unit} />
      </defs>

      <rect x={window_.x} y={window_.y} width={window_.size} height={window_.size} fill={COLOUR.ground} />

      {!contoursOnly && visible.areas.map((area, i) => (
        <Area key={i} area={area} marshId={marshId} />
      ))}

      {visible.contours.map((c, i) => (
        <ContourPath key={i} contour={c} unit={unit} />
      ))}

      {!contoursOnly && visible.lines.map((line, i) => (
        <Line key={i} line={line} unit={unit} />
      ))}

      {!contoursOnly && visible.points.map((p, i) => (
        <Point key={i} point={p} unit={unit} />
      ))}

      {control && (
        <circle
          cx={control.x}
          cy={control.y}
          r={unit * 6}
          fill="none"
          stroke={COLOUR.purple}
          strokeWidth={unit * 0.9}
        />
      )}
    </svg>
  );
}

/**
 * 310 indistinct marsh: staggered rows of short horizontal blue dashes.
 *
 * `userSpaceOnUse` in world metres, with the tile sized in `unit`, so the dashes keep
 * their printed size at every crop — the same reason line widths are measured in `unit`.
 */
function MarshPattern({ id, unit }: { id: string; unit: number }) {
  const pitch = MARSH.pitch * unit;
  const row = MARSH.rowSpacing * unit;
  const dash = MARSH.dashLength * unit;
  return (
    <pattern id={id} patternUnits="userSpaceOnUse" width={pitch} height={row * 2}>
      <line
        x1={0} y1={row * 0.5} x2={dash} y2={row * 0.5}
        stroke={COLOUR.blue} strokeWidth={MARSH.width * unit}
      />
      <line
        x1={pitch / 2} y1={row * 1.5} x2={pitch / 2 + dash} y2={row * 1.5}
        stroke={COLOUR.blue} strokeWidth={MARSH.width * unit}
      />
    </pattern>
  );
}

function ContourPath({ contour, unit }: { contour: Contour; unit: number }) {
  const width = (contour.form ? CONTOUR.formWidth : contour.index ? CONTOUR.indexWidth : CONTOUR.width) * unit;
  return (
    <>
      <path
        d={path(contour.points, contour.closed)}
        fill="none"
        stroke={COLOUR.brown}
        strokeWidth={width}
        strokeLinejoin="round"
        strokeLinecap="round"
        {...(contour.form
          ? { strokeDasharray: `${CONTOUR.formDash[0] * unit} ${CONTOUR.formDash[1] * unit}` }
          : {})}
      />
      {contour.tags.map((tag, i) => (
        <line
          key={i}
          x1={tag.x}
          y1={tag.y}
          x2={tag.x + tag.dx * CONTOUR.slopeTagLength * unit}
          y2={tag.y + tag.dy * CONTOUR.slopeTagLength * unit}
          stroke={COLOUR.brown}
          strokeWidth={CONTOUR.slopeTagWidth * unit}
          strokeLinecap="butt"
        />
      ))}
    </>
  );
}

function Area({ area, marshId }: { area: AreaFeature; marshId: string }) {
  const d = path(areaOutline(area), true);
  switch (area.kind) {
    case 'marsh':
      // Never a solid wash. Solid blue is open water, and to whoever is running the two
      // mean opposite things — one is crossable and slow, the other is a detour.
      return <path d={d} fill={`url(#${marshId})`} />;
    case 'open':
      return <path d={d} fill={COLOUR.yellow} opacity={YELLOW_SCREEN.open} />;
    case 'rough':
      return <path d={d} fill={COLOUR.yellow} opacity={YELLOW_SCREEN.rough} />;
    case 'slow':
      return <path d={d} fill={COLOUR.green} opacity={GREEN_SCREEN.slow} />;
    case 'walk':
      return <path d={d} fill={COLOUR.green} opacity={GREEN_SCREEN.walk} />;
    case 'fight':
      return <path d={d} fill={COLOUR.green} opacity={GREEN_SCREEN.fight} />;
    case 'rock':
      return <path d={d} fill={COLOUR.grey} opacity={0.5} />;
  }
}

function Line({ line, unit }: { line: LineFeature; unit: number }) {
  const d = path(line.points, false);
  switch (line.kind) {
    case 'path':
      return (
        <path
          d={d}
          fill="none"
          stroke={COLOUR.black}
          strokeWidth={LINE.pathWidth * unit}
          strokeDasharray={`${LINE.pathDash[0] * unit} ${LINE.pathDash[1] * unit}`}
        />
      );
    case 'stream':
      return <path d={d} fill="none" stroke={COLOUR.blue} strokeWidth={LINE.smallStreamWidth * unit} />;
    case 'fence':
      return <FenceLine line={line} unit={unit} />;
    case 'ride':
      // 508: a light corridor through the forest with a dashed line down it.
      return (
        <>
          <path d={d} fill="none" stroke={COLOUR.ground} strokeWidth={LINE.rideBackground * unit} />
          <path
            d={d}
            fill="none"
            stroke={COLOUR.black}
            strokeWidth={LINE.rideWidth * unit}
            strokeDasharray={`${LINE.rideDash[0] * unit} ${LINE.rideDash[1] * unit}`}
          />
        </>
      );
  }
}

/** 516: a solid line with a tick every 2 mm, which is what tells it from a path. */
function FenceLine({ line, unit }: { line: LineFeature; unit: number }) {
  const spacing = LINE.fenceTickSpacing * unit;
  const half = (LINE.fenceTickLength * unit) / 2;
  const ticks: Vec[] = [];
  const normals: Vec[] = [];

  let carried = spacing / 2;
  for (let i = 1; i < line.points.length; i++) {
    const a = line.points[i - 1]!;
    const b = line.points[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length === 0) continue;
    const ux = (b.x - a.x) / length;
    const uy = (b.y - a.y) / length;
    for (let t = carried; t < length; t += spacing) {
      ticks.push({ x: a.x + ux * t, y: a.y + uy * t });
      normals.push({ x: -uy, y: ux });
    }
    carried = ((carried - length) % spacing + spacing) % spacing;
  }

  return (
    <>
      <path d={path(line.points, false)} fill="none" stroke={COLOUR.black} strokeWidth={LINE.fenceWidth * unit} />
      {ticks.map((p, i) => {
        const n = normals[i]!;
        return (
          <line
            key={i}
            x1={p.x - n.x * half} y1={p.y - n.y * half}
            x2={p.x + n.x * half} y2={p.y + n.y * half}
            stroke={COLOUR.black}
            strokeWidth={LINE.fenceWidth * unit}
          />
        );
      })}
    </>
  );
}

function Point({ point, unit }: { point: PointFeature; unit: number }) {
  switch (point.kind) {
    case 'boulder':
      return <circle cx={point.x} cy={point.y} r={POINT.boulderRadius * unit} fill={COLOUR.black} />;
    case 'knoll':
      return <circle cx={point.x} cy={point.y} r={POINT.knollRadius * unit} fill={COLOUR.brown} />;
    case 'pit': {
      // 112: a brown triangle, apex down.
      const r = POINT.pitRadius * unit;
      return (
        <path
          d={`M${point.x - r * 0.87} ${point.y - r * 0.5}L${point.x + r * 0.87} ${point.y - r * 0.5}L${point.x} ${point.y + r}Z`}
          fill={COLOUR.brown}
        />
      );
    }
    case 'tree':
      return (
        <circle
          cx={point.x} cy={point.y} r={POINT.treeRadius * unit}
          fill="none" stroke={COLOUR.green} strokeWidth={POINT.treeWidth * unit}
        />
      );
    case 'crag': {
      // 202: the tags on the low side are what make it a cliff rather than a stray line.
      const half = Math.max(point.size, POINT.cliffWidth * unit * 3);
      const tag = POINT.cliffTagLength * unit;
      return (
        <>
          <path
            d={`M${point.x - half} ${point.y}L${point.x + half} ${point.y}`}
            stroke={COLOUR.black} strokeWidth={POINT.cliffWidth * unit} strokeLinecap="butt"
          />
          {[-0.5, 0, 0.5].map((t) => (
            <line
              key={t}
              x1={point.x + half * t * 2} y1={point.y}
              x2={point.x + half * t * 2} y2={point.y + tag}
              stroke={COLOUR.black} strokeWidth={POINT.cliffTagWidth * unit}
            />
          ))}
        </>
      );
    }
  }
}
