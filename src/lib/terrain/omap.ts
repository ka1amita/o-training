import type { LandformKind, Relief, Warp } from './relief.ts';
import type { Colour, IsomCode } from './semantics.ts';

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
  /** Where the map came from. Absent on a generated one, which came from a seed. */
  readonly meta?: MapMeta;
  /**
   * Windows the pipeline scored, keyed by `WindowRequirement.id`.
   *
   * On the map rather than beside it because they *are* a fact about the map: which of
   * its ground can answer which drill's question. `LibraryProvider` picks from this list
   * instead of searching two kilometres of forest on a phone.
   */
  readonly windows?: Readonly<Record<string, readonly Crop[]>>;
}

/**
 * What a map says about itself.
 *
 * `licence` and `attribution` cost nothing and are what a member-tier product needs the
 * day a map owner asks. `scale` is the scale the cartography was drawn for — the renderer
 * does not read it, import and salience do.
 */
/**
 * Which discipline a map was drawn for.
 *
 * Not decoration: it is what makes `Semantics.barrierStrict` mean something. An
 * impassable wall on a forest map is expensive and on a sprint map is a disqualification,
 * and the symbol cannot say which — only the map can. Forest unless something says
 * otherwise, because everything imported so far is.
 */
export type MapType = 'forest' | 'sprint';

export interface MapMeta {
  readonly name: string;
  readonly scale: number;
  readonly source: 'xmap' | 'ocad' | 'image';
  readonly licence?: string;
  readonly attribution?: string;
  /** The standard the source's own codes were in, once import has recognised it. The
   *  features carry canon codes; this says what they were aliased from. */
  readonly symbolSet?: string;
  /** Defaults to `'forest'` wherever it is absent, including in bundles written before
   *  it existed — which is the honest reading, since every one of them is a forest map. */
  readonly mapType?: MapType;
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
  /**
   * The colour class the source inked it in, for a code `semantics.ts` does not know.
   *
   * Absent on a generated feature, whose code is always in the table. It travels with the
   * feature rather than sitting in a per-map table because it is what makes an unknown
   * symbol drawable at all, and a feature that reached the renderer without its map would
   * otherwise be invisible.
   */
  readonly colour?: Colour;
}

/**
 * The image source, §2.2 of the design note.
 *
 * A picture of a map, plus the one thing that makes a picture readable to the app: a
 * **colour mask**, one ISOM class per cell at about a metre, from `maps/import/raster.ts`.
 * An image-only map has no features and no heights, and the mask is the whole of what is
 * known about it — where the ground is runnable, where a control could sit, whether an
 * edit is plausible.
 *
 * `image` is a URL and not an `ImageBitmap` as §2.2 sketched: the renderer is SVG, an
 * `<image href>` takes a URL, and an `ImageBitmap` would need a canvas to get back out of.
 * It is either a `data:` URL or a path resolved against the bundle it came from — a
 * sibling PNG under `public/maps/`, so a 2 MB picture does not sit inside a JSON document
 * that has to be parsed before the first round.
 *
 * `patches` and `warps` are **edits, as the renderer has to paint them**. Nothing that
 * scores or validates a round may read them: the answer comes from the `Edit` list, and
 * these are what `applyEdits` leaves behind so that the picture agrees with it.
 */
export interface RasterLayer {
  /** `data:` URL, or a path relative to the bundle. Resolved by `loadBundle`. */
  readonly image: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly metresPerPixel: number;
  /** Map metres of the image's top-left corner: an image may outrun the map's extent. */
  readonly originX: number;
  readonly originY: number;
  /** One ISOM colour class per cell — `MASK` in `isom.ts` — row-major from the origin. */
  readonly mask: Uint8Array;
  readonly maskWidth: number;
  readonly maskHeight: number;
  readonly metresPerCell: number;
  /** Where an edit cut something out of the picture, and what to paint over it. */
  readonly patches?: readonly RasterPatch[];
  /**
   * Warps this layer has been through, in order.
   *
   * Recorded rather than applied: `classAt` carries a point back through them before it
   * reads a cell, and the renderer resamples the pixels by the same chain, so the mask and
   * the picture agree by construction. Rewriting the mask instead would copy four million
   * cells for a two-kilometre map on every one of the thirty-six draws a round can make.
   */
  readonly warps?: readonly Warp[];
}

/**
 * A disc of the image, painted out in a flat colour.
 *
 * A moved blob is a cut and paste: the symbol is drawn again at its new place from the
 * style table, and the pixels it came from are covered with what surrounds them — white
 * forest under a boulder, which is what a surveyor would have drawn had the boulder never
 * been there. `fill` is a `MASK` class, so the renderer and the mask agree by
 * construction rather than by a second table of colours.
 */
export interface RasterPatch {
  readonly at: Vec;
  readonly radius: number;
  readonly fill: number;
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
    /**
     * What form the source knows this to be, and how it lies — when it knows.
     *
     * A generated map was *built* from named landforms and hands them over as they are; a
     * curvature candidate off a surveyed hillside is a piece of ground that bends, with no
     * name and no axis, so these are absent there. A warp needs none of them.
     *
     * Map dohledavka does: it circles things a control description could name, and on a
     * map that names none of its landforms it simply offers no relief answers. That is
     * honest rather than a gap — a card asking "spur or re-entrant?" about a candidate
     * nobody classified would have no answer of its own.
     */
    readonly kind?: LandformKind;
    /** Radians. Only meaningful with `elongation`. */
    readonly rotation?: number;
    /** 1 is round; above 1 stretches along `rotation`, making a spur or a re-entrant. */
    readonly elongation?: number;
  }[];
  /**
   * Where a control could sit on a map that has no features to sit on — the raster tier.
   *
   * Filled only for an image-only map: a map with vector features already answers this
   * from the semantic table, and two answers would be two places for it to be wrong.
   */
  readonly controlSites?: readonly Vec[];
  /**
   * Blobs an edit may move, as `Feature`s that are deliberately **not** in `features`.
   *
   * The picture already draws them; putting them in `features` would draw every boulder
   * twice, once as ink and once as a symbol. They live here, `proposeEdit` offers them,
   * and `applyEdits` materialises a move as a patch over the pixels plus the symbol drawn
   * again at its new place.
   */
  readonly moveable?: readonly Feature[];
  /**
   * Contour ink per coarse cell, 0 to 1: the raster tier's only word about relief.
   *
   * A proxy for relief *detail*, never for height. A map with brown all over it still has
   * `relief: none` and the contours drill still declines it — there is no height field to
   * be had from a picture of contour lines without tracing them, which is an offline job
   * with different tools (§1.3).
   */
  readonly brown?: readonly number[];
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
