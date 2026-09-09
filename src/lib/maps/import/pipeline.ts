import { ISOM_SCALE } from '@/lib/terrain/isom.ts';
import type { Grid } from '@/lib/terrain/height.ts';
import {
  boundsOf, translated,
  type Crop, type Feature, type MapMeta, type OMap,
} from '@/lib/terrain/omap.ts';
import type { IsomCode } from '@/lib/terrain/semantics.ts';
import { saveBundle, type MapBundle } from '../bundle.ts';
import type { WindowRequirement } from '../provider.ts';
import { analyse, scoreWindows } from './analyse.ts';
import { resolveSemantics, type Unresolved } from './codes.ts';
import { attachRelief } from './relief.ts';
import { parseXmap } from './xmap.ts';

/**
 * The import pipeline, end to end, as pure functions over the previous stage's output.
 *
 * `scripts/import-map.mjs` is a shell over this: read a file, call `importXmap`, write
 * JSON. Everything that can be got wrong lives here, where it can be tested, because the
 * failures this pipeline has are the quiet ones — a hillside read upside down, a symbol
 * table half resolved, a window list scored on a map that is not the map.
 *
 * Stages, in order, each in its own module:
 *
 * 1. `xmap.ts`    — the file into geometry in metres
 * 2. `codes.ts`   — symbol codes into the app's own, with a report of what did not resolve
 * 3. `relief.ts`  — a DEM, or contour levels reconstructed from the drawing, or nothing
 * 4. `analyse.ts` — landform candidates, barriers, a runnability raster
 * 5. `analyse.ts` — a scored window list per requirement
 * 6. `bundle.ts`  — one JSON document, content-hashed
 */
export interface ImportOptions {
  readonly name: string;
  readonly licence?: string;
  readonly attribution?: string;
  /** What windows to score. `libraryRequirements()` is what the drills ask for. */
  readonly requirements: readonly WindowRequirement[];
  /** A DEM over the map's square extent, if one was supplied. Beats reconstruction. */
  readonly dem?: Grid;
  /** Metres between contours. ISOM's standard is 5 and no file says which it used. */
  readonly interval?: number;
  /** Bézier flattening tolerance, in metres. */
  readonly tolerance?: number;
  /** Take this square of the map and throw the rest away. See `cropTo`. */
  readonly crop?: Crop;
  /** Resolution of the grid reconstructed from contour lines. */
  readonly resolution?: number;
}

export interface ImportReport {
  readonly map: OMap;
  readonly bundle: MapBundle;
  /** What happened, in order, for the script to print. */
  readonly notes: readonly string[];
  /** Codes with no semantics. They still draw; they are never edit targets. */
  readonly unresolved: readonly Unresolved[];
  readonly codes: readonly IsomCode[];
  readonly resolved: number;
}

export function importXmap(xml: string, options: ImportOptions): ImportReport {
  const notes: string[] = [];

  const parsed = parseXmap(xml, options.tolerance === undefined ? {} : { tolerance: options.tolerance });
  notes.push(
    `parsed: ${parsed.objects.length} objects, ${parsed.symbols.length} symbols, ` +
      `1:${parsed.scale}, ${parsed.width.toFixed(1)} x ${parsed.height.toFixed(1)} m ` +
      `(${parsed.symbolSet || 'no symbol set named'})`,
  );

  const resolution = resolveSemantics(parsed);
  notes.push(
    `semantics: ${resolution.resolved} of ${resolution.features.length} features on ` +
      `${resolution.codes.length} codes; ${resolution.unresolved.length} codes unresolved`,
  );

  const cropped = options.crop ? cropTo(resolution.features, options.crop) : resolution.features;
  const width = options.crop ? options.crop.size : parsed.width;
  const height = options.crop ? options.crop.size : parsed.height;
  if (options.crop) notes.push(`cropped: ${cropped.length} features kept of ${resolution.features.length}`);

  // Square, and padded to the longer side. `Crop` is square and every drill checks its
  // window against `width`; padding is the honest way to keep that true of a real map,
  // and empty ground scores nothing, so no round is ever framed on the padding.
  const size = Math.max(width, height);

  const relief = attachRelief(cropped, size, {
    ...(options.dem ? { dem: options.dem } : {}),
    ...(options.interval === undefined ? {} : { interval: options.interval }),
    ...(options.resolution === undefined ? {} : { resolution: options.resolution }),
  });
  notes.push(`relief: ${relief.note}`);

  const meta: MapMeta = {
    name: options.name,
    scale: parsed.scale,
    source: 'xmap',
    ...(options.licence ? { licence: options.licence } : {}),
    ...(options.attribution ? { attribution: options.attribution } : {}),
  };

  const base: OMap = {
    // Replaced by the content hash the moment the bundle is written. Named rather than
    // left empty so that a map handed straight to a renderer without being written still
    // has an identity.
    id: 'unwritten',
    width: size,
    height: size,
    scale: parsed.scale,
    relief: relief.relief,
    features: cropped,
    meta,
  };

  const analysis = analyse(base);
  notes.push(
    `analysis: ${analysis.landforms.length} landform candidates, ` +
      `${analysis.barriers.length} barriers`,
  );

  const windows = scoreWindows({ ...base, analysis }, analysis, options.requirements);
  notes.push(
    `windows: ${Object.entries(windows)
      .map(([id, list]) => `${id}=${list.length}`)
      .join(' ')}`,
  );

  const finished: OMap = { ...base, analysis, windows };
  const bundle = saveBundle(finished);
  return {
    map: { ...finished, id: bundle.id },
    bundle,
    notes: [...notes, `bundle: ${bundle.id.slice(0, 12)}`],
    unresolved: resolution.unresolved,
    codes: resolution.codes,
    resolved: resolution.resolved,
  };
}

/**
 * A square of the map, and nothing else.
 *
 * Whole features are kept and translated, never clipped. Clipping a polygon correctly is
 * a real algorithm and would gain nothing here: `MapView` culls to its window anyway, and
 * a clipped area would be an area with an edge the surveyor did not draw — which is
 * exactly the kind of invented cartography the rest of this pipeline refuses to do.
 *
 * The crop happens **before** relief and analysis, so the contour levels are reconstructed
 * from the lines that are actually in the bundle rather than from a graph half of which
 * was thrown away afterwards.
 */
export function cropTo(features: readonly Feature[], crop: Crop): Feature[] {
  const out: Feature[] = [];
  for (const feature of features) {
    const box = boundsOf(feature);
    if (box.maxX < crop.x || box.minX > crop.x + crop.size) continue;
    if (box.maxY < crop.y || box.minY > crop.y + crop.size) continue;
    out.push(translated(feature, -crop.x, -crop.y));
  }
  // Ids stay as they were: an id names a feature in this map, and renumbering them after a
  // crop would mean the same map imported twice under different crops shared ids that mean
  // different things.
  return out;
}

/** The scale the app's line widths are written for. Import records the map's own. */
export { ISOM_SCALE };
