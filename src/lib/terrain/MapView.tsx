import { useEffect, useId, useMemo, useState } from 'react';
import type { Contour } from './contours.ts';
import {
  CLASS_CSS, COLOUR, CONTOUR, MARSH, MASK_CLASSES, POINT, styleFor,
  type LineStyle, type PointStyle,
} from './isom.ts';
import type { IsomCode } from './semantics.ts';
import {
  areasOf, boundsOf, linesOf, pointsOf,
  type Crop, type Feature, type OMap, type RasterLayer, type Vec,
} from './omap.ts';
import { warpDisplacement } from './relief.ts';

/**
 * A map drawn to ISOM 2017-2.
 *
 * SVG rather than canvas, and the reason is Posunute pexeso: a crop is a `viewBox` and
 * nothing else. Two offset windows on one map are two elements sharing one geometry,
 * with no second render and no pixel buffers to hold.
 *
 * Every width and dash comes from `isom.ts` in millimetres of paper, and which of them a
 * feature gets comes from its **ISOM code**, through the style table there. A generated
 * boulder and an imported one are the same row.
 */
export const ISOM = COLOUR;

export interface MapViewProps {
  readonly map: OMap;
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
  map,
  crop,
  control,
  contourInterval = 5,
  contoursOnly = false,
  className,
}: MapViewProps) {
  const window_ = crop ?? { x: 0, y: 0, size: map.width };

  /**
   * Pattern ids are per instance.
   *
   * A pexeso board mounts twelve `MapView`s into one document. With a fixed id every card
   * after the first would silently paint itself with the first card's marsh, at the first
   * card's scale.
   */
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');

  // Traced once per relief, not per crop: two cards showing the same ground must show the
  // same lines, and re-tracing per window would also cost twice as much. The relief holds
  // the cache now, so twelve cards over six maps trace six times rather than twelve.
  const contours = map.relief.contours(contourInterval);

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
    const showing = (f: Feature) => overlaps(boundsOf(f), window_, pad);
    return {
      contours: contours.filter((c) => overlaps(boxOf(c.points), window_, pad)),
      areas: areasOf(map).filter(showing),
      lines: linesOf(map).filter(showing),
      points: pointsOf(map).filter(showing),
    };
  }, [contours, map, window_.x, window_.y, window_.size]);

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

      {/* The picture, under everything. Nothing at all when the map has none, which is
          what keeps a generated map's markup exactly what it was. */}
      {!contoursOnly && map.raster && <RasterUnderlay raster={map.raster} />}

      {!contoursOnly && <Areas areas={visible.areas} marshId={marshId} />}

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
 * How much wider than the blob a patch is painted.
 *
 * A dot on a scanned map has an anti-aliased rim a pixel or two across, and a patch drawn
 * at exactly the blob's radius leaves a grey ring where the boulder was — which is a tell
 * far easier to spot than the boulder that moved.
 */
const PATCH_PAD = 1.4;

/**
 * The map as it was photographed, in world metres, under whatever was drawn on top.
 *
 * A crop is still only a `viewBox`: the image is placed once at its own origin and the
 * SVG clips it, so a pexeso pair is two `<image>` elements over one file the browser
 * decodes once, exactly as two crops of a vector map are two views of one geometry.
 *
 * Everything an edit does to the picture arrives here as data — a patch to paint, a warp
 * to resample — because the answer comes from the edit list and never from pixels
 * (`AGENTS.md`). This component is the only thing in the app that reads either.
 */
function RasterUnderlay({ raster }: { raster: RasterLayer }) {
  const source = useWarpedImage(raster);
  return (
    <>
      <image
        href={source}
        x={raster.originX}
        y={raster.originY}
        width={raster.imageWidth * raster.metresPerPixel}
        height={raster.imageHeight * raster.metresPerPixel}
        preserveAspectRatio="none"
      />
      {(raster.patches ?? []).map((patch, i) => (
        <circle
          key={i}
          cx={patch.at.x}
          cy={patch.at.y}
          r={patch.radius * PATCH_PAD}
          fill={CLASS_CSS[MASK_CLASSES[patch.fill] ?? 'white']}
        />
      ))}
    </>
  );
}

/**
 * The picture, displaced through the warps the edits left on it.
 *
 * §3.1 says a raster warps like a DEM does: every pixel of the result is sampled from
 * where it came from, through the **inverse** of the same compact bump `warpDisplacement`
 * gives the height field and the features. So the ground in the picture moves exactly as
 * far as the ground in the relief, which is the whole reason a warp is one operation with
 * one definition.
 *
 * A canvas rather than an SVG filter: `feDisplacementMap` reads its offsets from another
 * image and cannot be handed a formula, and building that image is the same loop with an
 * extra encode. The design note guessed `useMemo`; it has to be an effect, because the
 * image has to be **decoded** before it can be resampled and decoding is asynchronous.
 * Until it is, and anywhere there is no canvas at all — a test, a server render — the
 * plain picture is drawn, which is the map with its ground unmoved and never a wrong map.
 */
function useWarpedImage(raster: RasterLayer): string {
  const [warped, setWarped] = useState<string | null>(null);
  // Serialised rather than compared by identity: `applyEdits` builds a new layer on every
  // render of a variant, so the array is a different array each time and an effect keyed
  // on it would resample a two-megapixel image on every keystroke elsewhere on the page.
  const signature = JSON.stringify(raster.warps ?? []);

  useEffect(() => {
    const warps = JSON.parse(signature) as readonly Parameters<typeof warpDisplacement>[0][];
    if (warps.length === 0) {
      setWarped(null);
      return;
    }
    if (typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;

    let live = true;
    const image = new Image();
    image.onload = () => {
      if (!live) return;
      const { width, height } = image;
      canvas.width = width;
      canvas.height = height;
      context.drawImage(image, 0, 0);
      try {
        const from = context.getImageData(0, 0, width, height);
        const to = context.createImageData(width, height);
        const m = raster.metresPerPixel;
        for (let j = 0; j < height; j++) {
          for (let i = 0; i < width; i++) {
            let x = raster.originX + (i + 0.5) * m;
            let y = raster.originY + (j + 0.5) * m;
            for (const warp of warps) {
              const d = warpDisplacement(warp, x, y);
              x -= d.x;
              y -= d.y;
            }
            const si = Math.min(width - 1, Math.max(0, Math.floor((x - raster.originX) / m)));
            const sj = Math.min(height - 1, Math.max(0, Math.floor((y - raster.originY) / m)));
            const s = (sj * width + si) * 4;
            const t = (j * width + i) * 4;
            to.data[t] = from.data[s]!;
            to.data[t + 1] = from.data[s + 1]!;
            to.data[t + 2] = from.data[s + 2]!;
            to.data[t + 3] = from.data[s + 3]!;
          }
        }
        context.putImageData(to, 0, 0);
        setWarped(canvas.toDataURL('image/png'));
      } catch {
        // A cross-origin picture taints the canvas and `getImageData` throws. The
        // unwarped map is still the right ground for three of four options and a wrong
        // one for the fourth, which a blank card is not.
        setWarped(null);
      }
    };
    image.src = raster.image;
    return () => {
      live = false;
    };
  }, [raster.image, raster.metresPerPixel, raster.originX, raster.originY, signature]);

  return warped ?? raster.image;
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

/**
 * One path per **symbol**, not one per feature.
 *
 * Vegetation is generated as overlapping lobes so a green reads as one sprawling region,
 * and drawn as separate translucent shapes those overlaps composite twice — every chain
 * showed its own construction as a string of darker lenses. Collecting a symbol's
 * outlines into a single path makes the overlap a union: one fill, one opacity applied
 * once. It also emits one element where there were five.
 *
 * Keyed by code rather than by the generator's `kind`, for the same reason the style table
 * is: an imported 406 and a generated `slow` are one symbol and have to composite as one.
 * The colour rides along in the key because it is what an *unknown* code is drawn in, and
 * two symbols a map inked differently are two symbols however little the table knows.
 *
 * Order is the ISOM drawing order, so a marsh reads over the vegetation it sits in rather
 * than under whichever patch happened to be generated last. A code the list does not name
 * — a real map arrives with about a hundred of them — draws after those, in the order the
 * map itself gives it.
 */
const AREA_ORDER: readonly IsomCode[] = ['401', '403', '406', '408', '410', '214', '310'];

function Areas({ areas, marshId }: { areas: readonly Feature[]; marshId: string }) {
  const groups = new Map<string, Feature[]>();
  for (const area of areas) {
    const key = `${area.code}\u0000${area.colour ?? ''}`;
    const alike = groups.get(key);
    if (alike) alike.push(area);
    else groups.set(key, [area]);
  }
  const keys = [...groups.keys()];
  const rank = (key: string) => {
    const at = AREA_ORDER.indexOf(groups.get(key)![0]!.code);
    return at < 0 ? AREA_ORDER.length : at;
  };
  // A stable sort, so two unknown codes keep the order the map gave them.
  keys.sort((a, b) => rank(a) - rank(b));

  return (
    <>
      {keys.map((key) => {
        const alike = groups.get(key)!;
        const first = alike[0]!;
        const style = styleFor(first.code, {
          ...(first.colour ? { colour: first.colour } : {}),
          geometry: 'area',
        });
        if (style?.geometry !== 'area') return null;
        // Holes are filled evenodd, so an imported polygon with rings inside it draws as
        // one. Two features of a symbol still union, because they do not nest.
        const d = alike
          .flatMap((a) => (a.geometry.kind === 'polygon' ? a.geometry.rings : []))
          .map((ring) => path(ring, true))
          .join('');
        if (d === '') return null;
        if (style.pattern === 'marsh') {
          return <path key={key} d={d} fill={`url(#${marshId})`} fillRule="evenodd" />;
        }
        return (
          <path key={key} d={d} fill={style.fill} opacity={style.opacity} fillRule="evenodd" />
        );
      })}
    </>
  );
}

function Line({ line, unit }: { line: Feature; unit: number }) {
  const style = styleFor(line.code, { ...(line.colour ? { colour: line.colour } : {}), geometry: 'line' });
  if (style?.geometry !== 'line' || line.geometry.kind !== 'polyline') return null;
  const points = line.geometry.points;
  const d = path(points, false);
  return (
    <>
      {style.casing && (
        <path d={d} fill="none" stroke={style.casing.stroke} strokeWidth={style.casing.width * unit} />
      )}
      <path
        d={d}
        fill="none"
        stroke={style.stroke}
        strokeWidth={style.width * unit}
        {...(style.dash
          ? { strokeDasharray: `${style.dash[0] * unit} ${style.dash[1] * unit}` }
          : {})}
      />
      {style.ticks && <Ticks points={points} style={style} unit={unit} />}
    </>
  );
}

/** 516: a tick every 2 mm, which is what tells a fence from a path. */
function Ticks({
  points, style, unit,
}: { points: readonly Vec[]; style: LineStyle; unit: number }) {
  const spacing = style.ticks!.spacing * unit;
  const half = (style.ticks!.length * unit) / 2;
  const ticks: Vec[] = [];
  const normals: Vec[] = [];

  let carried = spacing / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
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
      {ticks.map((p, i) => {
        const n = normals[i]!;
        return (
          <line
            key={i}
            x1={p.x - n.x * half} y1={p.y - n.y * half}
            x2={p.x + n.x * half} y2={p.y + n.y * half}
            stroke={style.stroke}
            strokeWidth={style.width * unit}
          />
        );
      })}
    </>
  );
}

function Point({ point, unit }: { point: Feature; unit: number }) {
  const style = styleFor(point.code, { ...(point.colour ? { colour: point.colour } : {}), geometry: 'point' });
  if (style?.geometry !== 'point' || point.geometry.kind !== 'point') return null;
  const { at } = point.geometry;
  switch (style.shape) {
    case 'disc':
      return <circle cx={at.x} cy={at.y} r={style.radius * unit} fill={style.colour} />;
    case 'triangle': {
      // 112: a brown triangle, apex down.
      const r = style.radius * unit;
      return (
        <path
          d={`M${at.x - r * 0.87} ${at.y - r * 0.5}L${at.x + r * 0.87} ${at.y - r * 0.5}L${at.x} ${at.y + r}Z`}
          fill={style.colour}
        />
      );
    }
    case 'ring':
      return (
        <circle
          cx={at.x} cy={at.y} r={style.radius * unit}
          fill="none" stroke={style.colour} strokeWidth={(style.width ?? 0) * unit}
        />
      );
    case 'cliff':
      return <Cliff at={at} size={point.size ?? 0} style={style} unit={unit} />;
  }
}

/** 202: the tags on the low side are what make it a cliff rather than a stray line. */
function Cliff({
  at, size, style, unit,
}: { at: Vec; size: number; style: PointStyle; unit: number }) {
  const half = Math.max(size, style.radius * unit * 3);
  const tag = POINT.cliffTagLength * unit;
  return (
    <>
      <path
        d={`M${at.x - half} ${at.y}L${at.x + half} ${at.y}`}
        stroke={style.colour} strokeWidth={style.radius * unit} strokeLinecap="butt"
      />
      {[-0.5, 0, 0.5].map((t) => (
        <line
          key={t}
          x1={at.x + half * t * 2} y1={at.y}
          x2={at.x + half * t * 2} y2={at.y + tag}
          stroke={style.colour} strokeWidth={(style.width ?? 0) * unit}
        />
      ))}
    </>
  );
}
