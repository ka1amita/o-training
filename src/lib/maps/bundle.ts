import type { Contour, SlopeTag } from '@/lib/terrain/contours.ts';
import type { Grid } from '@/lib/terrain/height.ts';
import type { Crop, Feature, MapAnalysis, MapMeta, OMap, Vec } from '@/lib/terrain/omap.ts';
import {
  ContourRelief, GridRelief, NoRelief, type Relief,
} from '@/lib/terrain/relief.ts';
import { decodeFloats, encodeFloats, sha256 } from './codec.ts';

/**
 * One normalised document per imported map, §4.1 of the design note.
 *
 * The pipeline in `scripts/import-map.mjs` writes it and the app reads it, and **this
 * module is the only thing that knows its shape** — which is what lets the format have a
 * version number that means something. `format: 1` is checked on load and a bundle that
 * does not carry it is refused rather than half-read.
 *
 * Everything expensive is precomputed here: the height field, the analysis, and the
 * windows each drill's requirement could be satisfied by. A phone opening a bundle
 * decodes arrays; it does not read a two-kilometre map looking for somewhere to put a
 * round.
 *
 * Bundles are JSON and live under `public/maps/`. They are **never** in the PWA precache
 * — see `vite.config.ts`, whose `globPatterns` deliberately does not list `json`. A DEM
 * for one map is bigger than the whole app, and a precache is what a cold offline launch
 * has to fetch first.
 */
export interface MapBundle {
  readonly format: 1;
  /** sha-256 of the payload, which is everything below in the order written here. */
  readonly id: string;
  readonly meta: MapMeta;
  readonly width: number;
  readonly height: number;
  readonly features: readonly Feature[];
  readonly relief: BundleRelief;
  /** Step 5. Declared so the format has a place for it; the pipeline does not fill it. */
  readonly raster?: BundleRaster;
  readonly analysis: MapAnalysis;
  /** Keyed by `WindowRequirement.id` — what `LibraryProvider.pick` chooses from. */
  readonly windows: Readonly<Record<string, readonly Crop[]>>;
}

export type BundleRelief =
  /** A DEM. `n + 1` samples a side over the map's own square extent, base64 Float32. */
  | { readonly kind: 'grid'; readonly n: number; readonly values: string }
  /** Drawn contour lines with assigned levels, plus the grid rasterised from them. */
  | {
      readonly kind: 'contours';
      readonly interval: number;
      readonly lines: readonly BundleContour[];
      readonly grid: { readonly n: number; readonly values: string };
    }
  /** No height field: the levels could not be resolved, or the source had none. */
  | { readonly kind: 'none' };

export interface BundleContour {
  readonly level: number;
  readonly closed: boolean;
  readonly index: boolean;
  readonly form: boolean;
  /** base64 Float32, x and y interleaved. */
  readonly points: string;
  /** base64 Float32, x, y, dx, dy per tag. */
  readonly tags: string;
}

/** §2.2, shaped now and filled by step 5. Nothing in the app reads it yet. */
export interface BundleRaster {
  /** data: URL or a path beside the bundle. */
  readonly png: string;
  readonly metresPerPixel: number;
  /** base64 bytes, one ISOM colour class per pixel. */
  readonly mask: string;
  readonly maskWidth: number;
  readonly maskHeight: number;
}

/**
 * A map is stored square.
 *
 * `Crop` is square, `wholeMap` reads `width`, and every drill that checks a window against
 * the map compares against `width` — the whole engine assumes a square extent, and a real
 * map is not. Rather than widen all of that for the first bundle, the importer pads the
 * map to its own longer side and leaves the margin empty: the windows are chosen by score,
 * and empty ground scores nothing, so no round is ever framed on the padding.
 */
const square = (bundle: MapBundle): number => Math.max(bundle.width, bundle.height);

export function loadBundle(json: unknown): OMap {
  const bundle = validate(json);
  return {
    id: bundle.id,
    width: bundle.width,
    height: bundle.height,
    scale: bundle.meta.scale,
    relief: reliefOf(bundle),
    features: bundle.features,
    analysis: bundle.analysis,
    meta: bundle.meta,
    windows: bundle.windows,
  };
}

function reliefOf(bundle: MapBundle): Relief {
  const size = square(bundle);
  const relief = bundle.relief;
  if (relief.kind === 'none') return new NoRelief(size);
  if (relief.kind === 'grid') return new GridRelief(gridOf(relief.n, relief.values, size));
  return new ContourRelief({
    interval: relief.interval,
    lines: relief.lines.map(contourOf),
    grid: gridOf(relief.grid.n, relief.grid.values, size),
  });
}

function gridOf(n: number, encoded: string, size: number): Grid {
  const values = decodeFloats(encoded);
  if (values.length !== (n + 1) * (n + 1)) {
    throw new Error(`bundle: grid says n=${n} and carries ${values.length} samples`);
  }
  // min and max are derived rather than stored: they are a fact about the array, and a
  // stored pair that disagreed with it would be a bundle that traces contours nobody
  // can see.
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { n, size, values, min, max };
}

function contourOf(line: BundleContour): Contour {
  const flat = decodeFloats(line.points);
  const points: Vec[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) points.push({ x: flat[i]!, y: flat[i + 1]! });
  const flatTags = decodeFloats(line.tags);
  const tags: SlopeTag[] = [];
  for (let i = 0; i + 3 < flatTags.length; i += 4) {
    tags.push({ x: flatTags[i]!, y: flatTags[i + 1]!, dx: flatTags[i + 2]!, dy: flatTags[i + 3]! });
  }
  return {
    level: line.level,
    points,
    closed: line.closed,
    index: line.index,
    form: line.form,
    tags,
  };
}

/**
 * A map, back into a bundle.
 *
 * Takes an `OMap` and not a pile of pipeline output, because the pipeline's last stage
 * hands back a finished map — the analysis and the windows are already on it. It refuses
 * a map with neither, since a bundle without them is one the app would have to analyse on
 * the device, which is the thing the whole offline pipeline exists to avoid.
 *
 * Field order is the hash: `id` is sha-256 over the payload serialised in exactly the
 * order written here, so re-importing an unchanged map gives an unchanged id and the
 * goldens over library rounds (§5.2) survive a re-import.
 */
export function saveBundle(map: OMap): MapBundle {
  if (!map.meta) throw new Error('bundle: a map needs meta before it can be written');
  if (!map.analysis) throw new Error(`bundle: ${map.meta.name} has no analysis`);
  const payload = {
    format: 1 as const,
    meta: map.meta,
    width: map.width,
    height: map.height,
    features: map.features,
    relief: reliefFrom(map.relief),
    analysis: map.analysis,
    windows: map.windows ?? {},
  };
  return { ...payload, id: sha256(JSON.stringify(payload)) };
}

function reliefFrom(relief: Relief): BundleRelief {
  if (relief instanceof GridRelief) {
    return { kind: 'grid', n: relief.grid.n, values: encodeFloats(relief.grid.values) };
  }
  if (relief instanceof ContourRelief) {
    return {
      kind: 'contours',
      interval: relief.interval,
      lines: relief.lines.map(contourTo),
      grid: { n: relief.grid.n, values: encodeFloats(relief.grid.values) },
    };
  }
  // An `AnalyticRelief` reaching here is a generated map being written to a bundle, which
  // nothing does: the generator is a source of its own and its maps are a seed, not a
  // file. Saying so beats writing a bundle whose relief is silently flat.
  if (relief.kind !== 'none') {
    throw new Error(`bundle: a ${relief.kind} relief has no bundle form`);
  }
  return { kind: 'none' };
}

function contourTo(line: Contour): BundleContour {
  const points = new Float32Array(line.points.length * 2);
  line.points.forEach((p, i) => {
    points[i * 2] = p.x;
    points[i * 2 + 1] = p.y;
  });
  const tags = new Float32Array(line.tags.length * 4);
  line.tags.forEach((t, i) => {
    tags[i * 4] = t.x;
    tags[i * 4 + 1] = t.y;
    tags[i * 4 + 2] = t.dx;
    tags[i * 4 + 3] = t.dy;
  });
  return {
    level: line.level,
    closed: line.closed,
    index: line.index,
    form: line.form,
    points: encodeFloats(points),
    tags: encodeFloats(tags),
  };
}

// ---------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------

/**
 * What `loadBundle` insists on before it decodes anything.
 *
 * A bundle arrives over the network from a host we do not control, and a drill that
 * generates a round from a half-decoded map fails somewhere far from here. Every check is
 * a shape check — nothing here judges whether a map is *good*, which is what the window
 * scores are for.
 */
function validate(json: unknown): MapBundle {
  const bundle = json as MapBundle;
  if (!bundle || typeof bundle !== 'object') throw new Error('bundle: not an object');
  if (bundle.format !== 1) throw new Error(`bundle: format ${String(bundle.format)}, expected 1`);
  if (typeof bundle.id !== 'string' || bundle.id.length === 0) throw new Error('bundle: no id');
  if (!bundle.meta || typeof bundle.meta.scale !== 'number') throw new Error('bundle: no scale');
  if (!(bundle.width > 0) || !(bundle.height > 0)) throw new Error('bundle: no extent');
  if (!Array.isArray(bundle.features)) throw new Error('bundle: no features');
  if (!bundle.relief || typeof bundle.relief.kind !== 'string') throw new Error('bundle: no relief');
  if (!bundle.analysis || !Array.isArray(bundle.analysis.landforms)) {
    throw new Error('bundle: no analysis');
  }
  if (!bundle.windows || typeof bundle.windows !== 'object') throw new Error('bundle: no windows');
  return bundle;
}

/** Whether a bundle's id is the hash of what it carries. Cheap, and not automatic: a
 *  bundle is refused for being malformed, but a wrong id is a provenance question. */
export function idMatches(bundle: MapBundle): boolean {
  const { id: _id, ...payload } = bundle;
  return sha256(JSON.stringify(payload)) === bundle.id;
}
