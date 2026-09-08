import { useMemo } from 'react';
import { contoursOf } from './contours.ts';
import { sampleGrid } from './height.ts';
import type { AreaFeature, LineFeature, PointFeature, Terrain, Vec } from './terrain.ts';

/**
 * The terrain drawn in ISOM colours.
 *
 * SVG rather than canvas, and the reason is Posunute pexeso: a crop is a `viewBox` and
 * nothing else. Two offset windows on one map are two elements sharing one geometry,
 * with no second render and no pixel buffers to hold.
 */
export const ISOM = {
  ground: '#ffffff',
  brown: '#d15c00',
  blue: '#00a0c8',
  green: '#00a03c',
  yellow: '#ffba00',
  grey: '#b0b0b0',
  black: '#000000',
  /** Course overprint. Purple on paper, and the anchor a pexeso pair shares. */
  purple: '#e4007c',
} as const;

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

  // Traced once per terrain, not per crop: two cards showing the same ground must show
  // the same lines, and re-tracing per window would also cost twice as much.
  const contours = useMemo(() => {
    const grid = sampleGrid(terrain, 96);
    return contoursOf(grid, { interval: contourInterval, resolution: 96 });
  }, [terrain, contourInterval]);

  // Scaled to the window so a small crop keeps ordinary map line weights rather than
  // magnifying them into slabs.
  const unit = window_.size / 100;

  /**
   * Only what the window can show.
   *
   * SVG clips the rest anyway, so this changes no pixel — but a pexeso board is twelve
   * crops of a 300 m map and the full trace is over 150 contour paths each. Emitting
   * eighteen hundred elements to display a couple of hundred is the difference between a
   * board that appears and one a phone thinks about first.
   */
  const visible = useMemo(() => {
    const pad = window_.size * 0.05;
    return {
      contours: contours.filter((c) => overlaps(boxOf(c.points), window_, pad)),
      areas: terrain.areas.filter((a) =>
        overlaps(
          { minX: a.x - a.rx, maxX: a.x + a.rx, minY: a.y - a.ry, maxY: a.y + a.ry },
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

  return (
    <svg
      viewBox={`${window_.x} ${window_.y} ${window_.size} ${window_.size}`}
      className={className}
      role="img"
      aria-label="map extract"
    >
      <rect x={window_.x} y={window_.y} width={window_.size} height={window_.size} fill={ISOM.ground} />

      {!contoursOnly && visible.areas.map((area, i) => (
        <Area key={i} area={area} unit={unit} />
      ))}

      {visible.contours.map((c, i) => (
        <path
          key={i}
          d={path(c.points, c.closed)}
          fill="none"
          stroke={ISOM.brown}
          strokeWidth={unit * 0.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
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
          stroke={ISOM.purple}
          strokeWidth={unit * 0.9}
        />
      )}
    </svg>
  );
}

function Area({ area, unit }: { area: AreaFeature; unit: number }) {
  const common = {
    cx: area.x,
    cy: area.y,
    rx: area.rx,
    ry: area.ry,
    transform: `rotate(${(area.rotation * 180) / Math.PI} ${area.x} ${area.y})`,
  };
  switch (area.kind) {
    case 'marsh':
      // Marsh is blue horizontal dashes over the ground, not a solid wash; solid blue is
      // a lake, and the two mean opposite things to whoever is running.
      return (
        <ellipse
          {...common}
          fill="none"
          stroke={ISOM.blue}
          strokeWidth={area.ry * 2}
          strokeDasharray={`${unit * 2.4} ${unit * 2.4}`}
          opacity={0.55}
        />
      );
    case 'open':
      return <ellipse {...common} fill={ISOM.yellow} opacity={0.8} />;
    case 'thicket':
      return <ellipse {...common} fill={ISOM.green} opacity={0.45} />;
    case 'rock':
      return <ellipse {...common} fill={ISOM.grey} opacity={0.5} />;
  }
}

function Line({ line, unit }: { line: LineFeature; unit: number }) {
  const d = path(line.points, false);
  switch (line.kind) {
    case 'path':
      return (
        <path d={d} fill="none" stroke={ISOM.black} strokeWidth={unit * 0.5}
          strokeDasharray={`${unit * 2} ${unit * 1.2}`} />
      );
    case 'stream':
      return <path d={d} fill="none" stroke={ISOM.blue} strokeWidth={unit * 0.7} />;
    case 'fence':
      return <path d={d} fill="none" stroke={ISOM.black} strokeWidth={unit * 0.45} />;
    case 'ride':
      return <path d={d} fill="none" stroke={ISOM.green} strokeWidth={unit * 1.6} opacity={0.5} />;
  }
}

function Point({ point, unit }: { point: PointFeature; unit: number }) {
  const r = Math.max(point.size, unit * 1.2);
  switch (point.kind) {
    case 'boulder':
      return <circle cx={point.x} cy={point.y} r={r * 0.5} fill={ISOM.black} />;
    case 'knoll':
      return <circle cx={point.x} cy={point.y} r={r * 0.5} fill={ISOM.brown} />;
    case 'pit':
      return (
        <path
          d={`M${point.x - r * 0.6} ${point.y - r * 0.6}L${point.x} ${point.y + r * 0.7}L${point.x + r * 0.6} ${point.y - r * 0.6}Z`}
          fill={ISOM.brown}
        />
      );
    case 'tree':
      return (
        <circle cx={point.x} cy={point.y} r={r * 0.55} fill="none"
          stroke={ISOM.green} strokeWidth={unit * 0.5} />
      );
    case 'crag':
      return (
        <path d={`M${point.x - r} ${point.y}L${point.x + r} ${point.y}`}
          stroke={ISOM.black} strokeWidth={unit * 0.9} strokeLinecap="butt" />
      );
  }
}
