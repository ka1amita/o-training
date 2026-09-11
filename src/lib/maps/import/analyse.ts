import { sampleGridAt, type Grid } from '@/lib/terrain/height.ts';
import { insideCrop, positionOf, type Crop, type OMap } from '@/lib/terrain/omap.ts';
import { semanticsOf } from '@/lib/terrain/semantics.ts';
import { requirementId, type WindowRequirement } from '../provider.ts';
import { rasterAnalysis } from './raster.ts';

/**
 * Stage four: what a map can answer about itself without being re-read.
 *
 * The analysis itself now lives in `terrain/analysis.ts` and is re-exported here under its
 * own names, because the generated map needs the same answers from the same code — see
 * that module. What stays is stage five, the window scoring, which is the half that reads
 * a `WindowRequirement`: `terrain/` may not depend on the provider, and this is the layer
 * that may.
 */
import {
  analyse as analyseDrawing, drawnExtent, RUNNABILITY_GRID,
  type Analysis, type AnalysisOptions, type Box,
} from '@/lib/terrain/analysis.ts';

export { RUNNABILITY_GRID, type Analysis, type AnalysisOptions };

/**
 * Stage four, with the one answer a drawing cannot give.
 *
 * The analysis of what is *drawn* is `terrain/analysis.ts`, shared with the generator. A
 * picture has nothing drawn to ask, so the pipeline reads what it can off the colour mask
 * instead — and only then: a vectorised map's own symbols are a better answer to every one
 * of these questions than a blob filter is, and two answers to one question are two places
 * for it to be wrong. A boulder would be both a `Feature` and a blob, and a window would
 * count it twice.
 */
export function analyse(map: OMap, options: AnalysisOptions = {}): Analysis {
  const drawn = analyseDrawing(map, options);
  const fromMask = map.raster && map.features.length === 0
    ? rasterAnalysis(map.raster, Math.max(map.width, map.height), RUNNABILITY_GRID)
    : null;
  if (!fromMask) return drawn;
  return {
    ...drawn,
    runnability: fromMask.runnability,
    controlSites: fromMask.controlSites,
    moveable: fromMask.moveable,
    brown: fromMask.brown,
  };
}

// ---------------------------------------------------------------------------------------
// Stage five: which windows onto this map answer which drill's question
// ---------------------------------------------------------------------------------------

/**
 * Candidate window centres, as a fraction of the step between them.
 *
 * A quarter of the window: fine enough that a good piece of ground is not missed between
 * two candidates, coarse enough that a two-kilometre map is thousands of candidates rather
 * than millions. Every window is scored, so this is the whole cost of the stage.
 */
const WINDOW_STRIDE = 0.25;

/** The share of contour ink a window is scored as fully detailed at. Eyeballed against
 *  the mask of a 1:10000 forest map, where a busy hillside runs about a tenth brown. */
const DETAIL_TARGET = 0.1;

/** How many windows per requirement a bundle carries. */
export const WINDOWS_KEPT = 32;

/**
 * How much of a window may lie outside the ground the surveyor drew.
 *
 * A map is stored square, padded to its longer side, and the padding is nothing at all —
 * not white forest, not out of bounds, just the edge of the paper. A card framed on it has
 * a blank strip down one side, which is not a hard round, it is a card missing a corner.
 *
 * The pipeline used to argue that empty ground scores nothing and so no window would ever
 * be framed there. It was wrong, and the forest sample says by how much: the top window of
 * every one of its fifteen requirement lists began at `y: 0` on a map whose drawn ground
 * starts at y = 68.7 m, up to a quarter of the card being paper. Empty padding costs a
 * *point* of score, and a window that holds the busiest ground on the map still wins with
 * that point gone.
 *
 * A twentieth, rather than nothing at all: a surveyor's own boundary is ragged, and a
 * window that clips a metre of it at one corner shows a card nobody would question.
 */
const MAX_PADDING = 0.05;

/**
 * A window's score, and the shape of what a requirement is asking for.
 *
 * Deliberately not a single number until the last line: each part is a fact about the
 * ground that a person can check on the contact sheet, and a window that scores badly
 * should be readable as *why*. The parts are the requirement's own terms — a drill states
 * what it needs and this says how well a piece of map gives it.
 */
export interface WindowScore {
  readonly crop: Crop;
  /** Metres between the lowest and highest point inside it. */
  readonly reliefRange: number;
  readonly features: number;
  readonly controlSites: number;
  /** Landform candidates inside it — pieces of ground a warp could pick up. */
  readonly landforms: number;
  /** Fraction of the window covered by something less runnable than white forest. */
  readonly cover: number;
  /** Fraction of the window outside the ground the surveyor drew. `MAX_PADDING`. */
  readonly outside: number;
  readonly score: number;
}

/**
 * The best windows on a map, per requirement, deterministically ordered.
 *
 * The whole reason the pipeline exists: `LibraryProvider.pick` takes one of these with the
 * rng rather than searching a map on the device, and because the list is written in the
 * bundle a round is a function of `(seed, level, bundle id)` exactly as it is a function
 * of `(seed, level)` for the generator.
 *
 * Ties are broken by position, so re-importing an unchanged map gives an unchanged list —
 * which is what keeps a golden over a library round pinned to the bundle rather than to
 * the sort implementation.
 */
export function scoreWindows(
  map: OMap,
  analysis: Analysis,
  requirements: readonly WindowRequirement[],
): Record<string, Crop[]> {
  const out: Record<string, Crop[]> = {};
  for (const requirement of requirements) {
    const id = requirementId(requirement);
    out[id] = bestWindows(map, analysis, requirement).map((w) => w.crop);
  }
  return out;
}

export function bestWindows(
  map: OMap,
  analysis: Analysis,
  requirement: WindowRequirement,
  keep = WINDOWS_KEPT,
): WindowScore[] {
  const size = Math.min(requirement.size, map.width, map.height);
  const stride = Math.max(1, size * WINDOW_STRIDE);
  const grid = map.relief.kind === 'none' ? null : map.relief.sampleGrid(96);
  const drawn = drawnExtent(map);

  const scored: WindowScore[] = [];
  for (const y of offsets(drawn.minY, drawn.maxY, size, map.height, stride)) {
    for (const x of offsets(drawn.minX, drawn.maxX, size, map.width, stride)) {
      const crop: Crop = { x, y, size };
      const window_ = scoreWindow(map, analysis, requirement, crop, grid, drawn);
      if (window_.score > 0) scored.push(window_);
    }
  }
  scored.sort((a, b) => b.score - a.score || a.crop.y - b.crop.y || a.crop.x - b.crop.x);
  return scored.slice(0, keep);
}

/**
 * Where the candidate windows start along one axis: **at the drawing, not at the origin**.
 *
 * A padded map's drawing begins somewhere inside it, and a lattice laid from (0, 0) puts
 * every candidate at the same offset into the padding — on the forest sample, a stride of
 * 75 m against a top margin of 68.7 m, so the best window of each list was the one that
 * cleared the margin by six metres and the rest of the row scored zero without ever having
 * been the ground the surveyor drew. The last offset is pinned to the far edge of the
 * drawing for the same reason, or the strip the stride cannot reach is never offered.
 *
 * Clamped into the map, because a window is a `Crop` and a crop is inside the map.
 */
function offsets(low: number, high: number, size: number, extent: number, stride: number): number[] {
  const last = Math.min(Math.max(high - size, 0), Math.max(extent - size, 0));
  const first = Math.min(Math.max(low, 0), last);
  const out: number[] = [];
  for (let at = first; at < last - 1e-6; at += stride) out.push(at);
  out.push(last);
  return out;
}

function scoreWindow(
  map: OMap,
  analysis: Analysis,
  requirement: WindowRequirement,
  crop: Crop,
  grid: Grid | null,
  drawn: Box,
): WindowScore {
  let features = 0;
  let controlSites = 0;
  const landforms = analysis.landforms.filter((l) => insideCrop(l.centre, crop)).length;
  for (const feature of map.features) {
    if (!insideCrop(positionOf(feature), crop)) continue;
    features++;
    if (semanticsOf(feature.code)?.controlSite) controlSites++;
  }
  // A raster-only map has no features at all, and its blobs are what its windows hold.
  // Filled only when `map.features` is empty (see `analyse`), so nothing is counted twice.
  for (const blob of analysis.moveable ?? []) {
    if (insideCrop(positionOf(blob), crop)) features++;
  }
  for (const site of analysis.controlSites ?? []) {
    if (insideCrop(site, crop)) controlSites++;
  }

  let low = Infinity;
  let high = -Infinity;
  if (grid) {
    const probes = 12;
    for (let j = 0; j <= probes; j++) {
      for (let i = 0; i <= probes; i++) {
        const h = sampleGridAt(grid, crop.x + (i * crop.size) / probes, crop.y + (j * crop.size) / probes);
        if (h < low) low = h;
        if (h > high) high = h;
      }
    }
  }
  const reliefRange = grid ? high - low : 0;

  const cells = analysis.runnabilityGrid;
  const size = Math.max(map.width, map.height);
  const step = size / cells;
  let covered = 0;
  let counted = 0;
  let brown = 0;
  for (let j = Math.floor(crop.y / step); j <= Math.floor((crop.y + crop.size) / step); j++) {
    for (let i = Math.floor(crop.x / step); i <= Math.floor((crop.x + crop.size) / step); i++) {
      if (i < 0 || j < 0 || i >= cells || j >= cells) continue;
      counted++;
      if (analysis.runnability[j * cells + i]! < 1) covered++;
      brown += analysis.brown?.[j * cells + i] ?? 0;
    }
  }
  const cover = counted > 0 ? covered / counted : 0;
  const detail = counted > 0 ? brown / counted : 0;
  const outside = outsideShare(crop, drawn);

  // A window that cannot answer the question at all scores zero and is dropped, rather
  // than scoring badly and being picked when nothing better exists. A contours round on
  // flat ground is not a hard round, it is an unanswerable one.
  let score = 0;
  // The padding is the first of those floors, and it is about the card rather than about
  // the question: a strip of bare paper down one edge is a worse round than any of them.
  //
  // Asked only of a drawing the card fits inside. A map drawn smaller than the window that
  // wants it has no framing that avoids the paper, and refusing every window would be
  // refusing the map — where offering the least bad one is what the rest of the score is
  // for. That is the hand-written fixtures and, one day, a sprint map under a 300 m card.
  const fits = drawn.maxX - drawn.minX >= crop.size && drawn.maxY - drawn.minY >= crop.size;
  if (fits && outside > MAX_PADDING) {
    return { crop, reliefRange, features, controlSites, landforms, cover, outside, score: 0 };
  }
  const wantsRelief = requirement.needsRelief || requirement.relief !== undefined;
  // A relief round needs ground it can *move*, not only ground that goes up and down:
  // `proposeEdit` picks a warp from the landform candidates inside the window, and a
  // window with none has nothing to offer it. An even hillside is exactly that case.
  if (wantsRelief && landforms === 0) {
    return { crop, reliefRange, features, controlSites, landforms, cover, outside, score: 0 };
  }
  if (wantsRelief && (!grid || reliefRange < (requirement.relief?.minRange ?? 5))) {
    return { crop, reliefRange, features, controlSites, landforms, cover, outside, score: 0 };
  }
  if (requirement.minControlSites !== undefined && controlSites < requirement.minControlSites) {
    return { crop, reliefRange, features, controlSites, landforms, cover, outside, score: 0 };
  }
  const wantedFeatures = totalWanted(requirement);
  if (wantedFeatures > 0 && features < Math.ceil(wantedFeatures / 2)) {
    return { crop, reliefRange, features, controlSites, landforms, cover, outside, score: 0 };
  }

  // Past the floors it is a preference, and the parts are weighted by how much each one
  // costs the round when it is missing. Ground with nothing on it is the worst window
  // there is — two blank cards are a memory game about card position — so the feature
  // count leads.
  score += Math.min(2, features / Math.max(1, wantedFeatures));
  if (wantsRelief) {
    const wanted = requirement.relief;
    if (wanted) {
      // Inside the band is what was asked for; outside it is worse the further out it is.
      const middle = (wanted.minRange + wanted.maxRange) / 2;
      const half = Math.max(1, (wanted.maxRange - wanted.minRange) / 2);
      score += Math.max(0, 1 - Math.abs(reliefRange - middle) / (half * 2));
    } else {
      score += Math.min(1, reliefRange / 20);
    }
  }
  if (requirement.minControlSites) score += Math.min(1, controlSites / (requirement.minControlSites * 2));
  if (wantsRelief) score += Math.min(1, landforms / 3);
  // Not one flat green wash, and not a bare white field either.
  score += 1 - Math.abs(cover - 0.35) * 2;
  // A raster map's only word about relief. It cannot make a window answer the contours
  // drill — `needsRelief` is refused above, and brown ink is not a height field — but
  // between two windows a pexeso card is better on the one with contours in it. Zero on
  // every vector map, so no bundle already written moves.
  if (analysis.brown) score += Math.min(1, detail / DETAIL_TARGET);

  return { crop, reliefRange, features, controlSites, landforms, cover, outside, score };
}

/**
 * How much of a window is paper rather than map, by area.
 *
 * The drawn extent is a box and so is the window, so this is one rectangle overlap — the
 * surveyor's outline is not a box, but the padding this is here to catch is, and a
 * per-feature test would be reading the drawing to answer a question about the paper.
 */
function outsideShare(crop: Crop, drawn: Box): number {
  const wide = Math.max(0, Math.min(crop.x + crop.size, drawn.maxX) - Math.max(crop.x, drawn.minX));
  const tall = Math.max(0, Math.min(crop.y + crop.size, drawn.maxY) - Math.max(crop.y, drawn.minY));
  return 1 - (wide * tall) / (crop.size * crop.size);
}

const totalWanted = (requirement: WindowRequirement): number => {
  const wanted = requirement.minFeatures;
  if (!wanted) return 0;
  return (wanted.point ?? 0) + (wanted.line ?? 0) + (wanted.area ?? 0);
};

