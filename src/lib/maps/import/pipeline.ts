import { ISOM_SCALE } from '@/lib/terrain/isom.ts';
import type { Grid } from '@/lib/terrain/height.ts';
import {
  boundsOf, translated,
  type Crop, type Feature, type MapMeta, type OMap,
} from '@/lib/terrain/omap.ts';
import { NoRelief } from '@/lib/terrain/relief.ts';
import type { IsomCode } from '@/lib/terrain/semantics.ts';
import { saveBundle, type MapBundle } from '../bundle.ts';
import type { WindowRequirement } from '../provider.ts';
import { analyse, scoreWindows } from './analyse.ts';
import { resolveSemantics, type Unresolved } from './codes.ts';
import { attachRelief } from './relief.ts';
import { buildRaster, type RasterInput, type RasterStage } from './raster.ts';
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
 * 4. `raster.ts`  — a picture into a colour mask, cropped and georeferenced
 * 5. `analyse.ts` — landform candidates, barriers, a runnability raster; blobs from a mask
 * 6. `analyse.ts` — a scored window list per requirement
 * 7. `bundle.ts`  — one JSON document, content-hashed
 *
 * There are two entry points and they share the last three stages: `importXmap` for a
 * drawing, optionally with a picture under it, and `importImage` for a picture alone.
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
  /** A picture of the map, under whatever the drawing gives. Step 5, §2.2. */
  readonly raster?: RasterInput;
  /**
   * The scale the cartography was drawn for, when the source does not say.
   *
   * An `.xmap` states its own in `<georeferencing scale=…>`; a picture states nothing, and
   * nothing in the app can recover it from pixels. It is only used by salience — ISOM
   * minimum sizes are paper millimetres — so a wrong guess costs a difficulty ordering and
   * not a map, and 1:15000 is the standard's own scale.
   */
  readonly scale?: number;
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
  /**
   * The pixels the bundle's image should be, when there is one.
   *
   * Cropped, so they are not the file that was handed in — the banner and the margins are
   * gone — and the script writes *these* beside the bundle. A bundle that pointed at the
   * original file would draw the Livelox header inside a pexeso card.
   */
  readonly image?: RasterStage['image'];
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

  // A picture under the drawing, if one was given. The map's extent stays the drawing's:
  // the surveyor decided where the map is, and an image that overruns it is an image with
  // a margin, which `MapView` clips and the window scores never frame.
  const raster = options.raster ? buildRaster(options.raster) : null;
  if (raster) notes.push(...raster.notes);

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
    ...(raster ? { raster: raster.raster } : {}),
    meta,
  };

  return finish(base, options, notes, {
    unresolved: resolution.unresolved,
    codes: resolution.codes,
    resolved: resolution.resolved,
    ...(raster ? { image: raster.image } : {}),
  });
}

/**
 * A picture of a map, with no drawing behind it — the raster tier, §1.3.
 *
 * No features, no heights, and `relief: none`, which is not a gap to be filled in later:
 * a picture of contour lines is not a height field, and pretending otherwise would hand
 * the contours drill a round whose four options are the same ground. What it does have is
 * a mask, and `analyse` reads control sites, moveable blobs and a cover raster off it, so
 * pexeso and map memory get exactly what they get from a vector map — through the same
 * window scorer, which is the point of scoring over the analysis rather than over
 * features.
 */
export function importImage(options: ImportOptions & { raster: RasterInput }): ImportReport {
  const notes: string[] = [];
  const raster = buildRaster(options.raster);
  notes.push(...raster.notes);

  const layer = raster.raster;
  const width = layer.originX + layer.imageWidth * layer.metresPerPixel;
  const height = layer.originY + layer.imageHeight * layer.metresPerPixel;
  const size = Math.max(width, height);
  const scale = options.scale ?? ISOM_SCALE;

  const base: OMap = {
    id: 'unwritten',
    width: size,
    height: size,
    scale,
    // Flat, and it says so. `LibraryProvider` refuses this map to anything that needs
    // relief before a window score is even consulted.
    relief: new NoRelief(size),
    features: [],
    raster: layer,
    meta: {
      name: options.name,
      scale,
      source: 'image',
      ...(options.licence ? { licence: options.licence } : {}),
      ...(options.attribution ? { attribution: options.attribution } : {}),
    },
  };

  return finish(base, options, notes, {
    unresolved: [],
    codes: [],
    resolved: 0,
    image: raster.image,
  });
}

/**
 * The last three stages, which are the same whatever the source was.
 *
 * Analysis, then windows, then the document — and in that order, because the window
 * scores are computed over the analysis and a bundle whose windows were scored against a
 * different analysis than the one it carries is a map that promises ground it does not
 * have.
 */
function finish(
  base: OMap,
  options: ImportOptions,
  notes: string[],
  rest: Omit<ImportReport, 'map' | 'bundle' | 'notes'>,
): ImportReport {
  const analysis = analyse(base);
  notes.push(
    `analysis: ${analysis.landforms.length} landform candidates, ` +
      `${analysis.barriers.length} barriers` +
      (analysis.moveable ? `, ${analysis.moveable.length} blobs from the mask` : ''),
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
    ...rest,
    map: { ...finished, id: bundle.id },
    bundle,
    notes: [...notes, `bundle: ${bundle.id.slice(0, 12)}`],
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
