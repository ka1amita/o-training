import type { Relief } from './relief.ts';
import type { IsomCode } from './semantics.ts';

/**
 * A map, whatever drew it.
 *
 * `Terrain` used to be both the map and the generator's parameters for it: its
 * `landforms` were the height field *and* a list of features. A surveyed map has features
 * and relief and no landform parameters at all, so the two split — the parameters move
 * into `AnalyticRelief` (`relief.ts`), and what is left here is what every source can
 * produce: metres of ground, a relief, and a list of features carrying ISOM codes.
 *
 * Metres, origin top-left, y down — the convention `MapView` already used.
 */
export interface OMap {
  /** Stable identity. `'generated'` until a source has a content hash to give. */
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /**
   * The scale the cartography was drawn for. ISOM widths are paper millimetres at this
   * scale; the generator draws for 1:15000 (see `isom.ts`). The renderer does not read
   * it — a crop is the same map printed larger — but import and salience do.
   */
  readonly scale: number;
  readonly relief: Relief;
  readonly features: readonly Feature[];
  /** The image source, step 5 of the design note. Nothing reads it yet. */
  readonly raster?: RasterLayer;
  /** Precomputed once per map, never per round. Filled by the pipeline, step 4. */
  readonly analysis?: MapAnalysis;
}

export interface Vec {
  readonly x: number;
  readonly y: number;
}

/** A window onto a map, in world metres. A crop is a `viewBox` and nothing else. */
export interface Crop {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

export type Geometry =
  | { readonly kind: 'point'; readonly at: Vec }
  | { readonly kind: 'polyline'; readonly points: readonly Vec[] }
  /** Rings, outer first. */
  | { readonly kind: 'polygon'; readonly rings: readonly (readonly Vec[])[] };

/**
 * The parameters an area was generated from, kept beside its outline.
 *
 * `areaOutline` seeds its wander from **the shape and never the position**, so that
 * moving an area does not also reshape it (see `shapes.ts`). Keeping the parameters means
 * that seed survives a move, and it is what lets a generated area stay a small handful of
 * numbers rather than 28 points that have to be kept consistent with them. An imported
 * area has an outline and no parameters, which is why this is optional.
 */
export interface AreaShape {
  /** Whatever names the symbol to the seed: the generator's `kind`, so its maps do not
   *  all reshape the day the outline is seeded from something else. */
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly rx: number;
  readonly ry: number;
  readonly rotation: number;
}

export interface Feature {
  /** Stable within the map; edits refer to it. */
  readonly id: string;
  /** The semantic key — `semantics.ts` says what it means. */
  readonly code: IsomCode;
  /**
   * The generator's own vocabulary. Absent on an imported feature, which has a code and
   * nothing else, and gone from here once nothing reads it.
   */
  readonly kind?: string;
  readonly geometry: Geometry;
  /** Point features: drawn size in metres. */
  readonly size?: number;
  readonly shape?: AreaShape;
}

/** The image source, §2.2 of the design note. Shaped now, filled in step 5. */
export interface RasterLayer {
  readonly image: ImageBitmap | string;
  readonly metresPerPixel: number;
  /** Per-pixel ISOM colour class at reduced resolution, from the pipeline. */
  readonly mask: Uint8Array;
  readonly maskWidth: number;
  readonly maskHeight: number;
}

/**
 * What a map answers about itself without being re-read, §5.2 of the design note.
 *
 * Only the landform candidates are shaped here — they are what a warp needs to pick a
 * piece of ground to move on a map that has no landform parameters. The barrier set and
 * the runnability raster arrive with the pipeline that can afford to compute them.
 */
export interface MapAnalysis {
  readonly landforms: readonly {
    readonly centre: Vec;
    readonly radius: number;
    readonly amplitude: number;
  }[];
}

export const pointsOf = (map: OMap): readonly Feature[] =>
  map.features.filter((f) => f.geometry.kind === 'point');

export const linesOf = (map: OMap): readonly Feature[] =>
  map.features.filter((f) => f.geometry.kind === 'polyline');

export const areasOf = (map: OMap): readonly Feature[] =>
  map.features.filter((f) => f.geometry.kind === 'polygon');

/**
 * Where a feature *is*, for the checks that ask whether a change happened in the window
 * or on ground that suits it.
 *
 * An area answers with its centre rather than its outline, because that is what the
 * generator placed and what `suits` was asked about when it did.
 */
export function positionOf(feature: Feature): Vec {
  if (feature.shape) return { x: feature.shape.x, y: feature.shape.y };
  const g = feature.geometry;
  if (g.kind === 'point') return g.at;
  if (g.kind === 'polyline') return g.points[Math.floor(g.points.length / 2)] ?? { x: 0, y: 0 };
  const ring = g.rings[0] ?? [];
  if (ring.length === 0) return { x: 0, y: 0 };
  return {
    x: ring.reduce((s, p) => s + p.x, 0) / ring.length,
    y: ring.reduce((s, p) => s + p.y, 0) / ring.length,
  };
}

/** The same feature, slid by (dx, dy). Outline, parameters and position together. */
export function translated(feature: Feature, dx: number, dy: number): Feature {
  const move = (p: Vec): Vec => ({ x: p.x + dx, y: p.y + dy });
  const g = feature.geometry;
  const geometry: Geometry =
    g.kind === 'point' ? { kind: 'point', at: move(g.at) }
    : g.kind === 'polyline' ? { kind: 'polyline', points: g.points.map(move) }
    : { kind: 'polygon', rings: g.rings.map((ring) => ring.map(move)) };
  return {
    ...feature,
    geometry,
    ...(feature.shape ? { shape: { ...feature.shape, x: feature.shape.x + dx, y: feature.shape.y + dy } } : {}),
  };
}

/**
 * The same feature, put at `to`.
 *
 * The position lands on the number given rather than on `from + (to - from)`, because
 * that expression is not exactly `to` in floating point and the position is what the
 * golden hashes see. The outline rides along on the difference; nothing hashes it.
 */
export function movedTo(feature: Feature, to: Vec): Feature {
  const from = positionOf(feature);
  const slid = translated(feature, to.x - from.x, to.y - from.y);
  return {
    ...slid,
    ...(slid.geometry.kind === 'point' ? { geometry: { kind: 'point' as const, at: to } } : {}),
    ...(slid.shape ? { shape: { ...slid.shape, x: to.x, y: to.y } } : {}),
  };
}

/** The box a feature occupies, for culling and for footprints. */
export function boundsOf(feature: Feature): {
  readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number;
} {
  const g = feature.geometry;
  const points =
    g.kind === 'point' ? [g.at]
    : g.kind === 'polyline' ? g.points
    : g.rings.flat();
  const pad = g.kind === 'point' ? (feature.size ?? 0) : 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export const insideCrop = (p: Vec, crop: Crop): boolean =>
  p.x >= crop.x && p.x <= crop.x + crop.size && p.y >= crop.y && p.y <= crop.y + crop.size;

/** The whole map as a window, for a drill that shows all of it. */
export const wholeMap = (map: OMap): Crop => ({ x: 0, y: 0, size: map.width });
