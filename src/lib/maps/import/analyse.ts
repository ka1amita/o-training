import { sampleGridAt, type Grid } from '@/lib/terrain/height.ts';
import {
  boundsOf, insideCrop, positionOf,
  type Crop, type Feature, type MapAnalysis, type OMap, type Vec,
} from '@/lib/terrain/omap.ts';
import { semanticsOf } from '@/lib/terrain/semantics.ts';
import { readGround } from '@/lib/terrain/terrain.ts';
import { requirementId, type WindowRequirement } from '../provider.ts';
import { rasterAnalysis } from './raster.ts';

/**
 * Stage four: what a map can answer about itself without being re-read.
 *
 * Everything here is computed **once, offline**, because the alternative is a phone
 * reading two kilometres of forest before the first round. `edits.ts` already prefers
 * `map.analysis.landforms` over reaching into `AnalyticRelief`, and pexeso's `controlFor`
 * already prefers it over the same — this is the stage that finally fills it, and with it
 * the two `instanceof AnalyticRelief` fallbacks stop being the only way an imported map
 * could have been handled.
 */

/**
 * How far apart two summits have to be to be two summits, in metres.
 *
 * `readGround` reports a grid maximum wherever a cell is above its eight neighbours, and a
 * broad hilltop sampled at four metres is dozens of them. A warp candidate is a *piece of
 * ground to move*, so clustering them is not tidying: it is the difference between moving
 * a hill and moving one sample of it.
 */
const LANDFORM_SEPARATION = 45;

/** Landform candidates kept, strongest first. More is a longer bundle, not a better map. */
const MAX_LANDFORMS = 64;

/** Where the extent of a landform is looked for, and how far out it may reach. */
const EXTENT_PROBES = 12;
const MIN_EXTENT = 20;
const MAX_EXTENT = 110;
const EXTENT_STEP = 12;

/**
 * How much further the ring has to fall for the bump to still be growing.
 *
 * The extent walks outward until it stops finding more: at that point the ground has
 * stopped belonging to this landform, which is what "compact support" means for a bump —
 * the same shape `height.ts` gives a generated landform, so a warp taken from here reaches
 * about as far as a generated one of the same amplitude.
 */
const EXTENT_GROWTH = 0.12;

export interface Analysis extends MapAnalysis {
  /** Ids of features that cannot be crossed. `Semantics.barrier`, resolved once. */
  readonly barriers: readonly string[];
  /** Coarse runnability, `RUNNABILITY_GRID` a side, 1 = white forest, 0 = impassable. */
  readonly runnability: readonly number[];
  readonly runnabilityGrid: number;
}

/** Samples a side for the runnability raster. Coarse on purpose: it is a route-choice
 *  input, and a cost surface finer than the features that make it is a false precision. */
export const RUNNABILITY_GRID = 48;

export function analyse(map: OMap): Analysis {
  const ground = map.relief.kind === 'none' ? null : readGround(map.relief);
  const size = Math.max(map.width, map.height);
  /**
   * The mask answers for a map that has no features to ask.
   *
   * Only then: a vectorised map's own symbols are a better answer to every one of these
   * questions than a blob filter is, and two answers to one question are two places for
   * it to be wrong — a boulder would be both a `Feature` and a blob, and a window would
   * count it twice.
   */
  const fromMask = map.raster && map.features.length === 0
    ? rasterAnalysis(map.raster, size, RUNNABILITY_GRID)
    : null;
  return {
    landforms: ground ? landformsOf(ground.grid, size, drawnExtent(map)) : [],
    barriers: map.features.filter((f) => semanticsOf(f.code)?.barrier).map((f) => f.id),
    runnability: fromMask ? fromMask.runnability : runnabilityOf(map, size),
    runnabilityGrid: RUNNABILITY_GRID,
    ...(fromMask
      ? {
          controlSites: fromMask.controlSites,
          moveable: fromMask.moveable,
          brown: fromMask.brown,
        }
      : {}),
  };
}

/** The box the surveyor actually drew in, which a padded map is larger than. */
interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function drawnExtent(map: OMap): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const feature of map.features) {
    const box = boundsOf(feature);
    if (box.minX < minX) minX = box.minX;
    if (box.minY < minY) minY = box.minY;
    if (box.maxX > maxX) maxX = box.maxX;
    if (box.maxY > maxY) maxY = box.maxY;
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: map.width, maxY: map.height };
  return { minX, minY, maxX, maxY };
}

/**
 * Pieces of ground worth moving, clustered, with an extent and an amplitude.
 *
 * This is the imported map's answer to "where is there a piece of ground a warp could pick
 * up", and it has to be the same *kind* of answer the generator gives from its landform
 * parameters, because `proposeEdit` treats the two identically.
 *
 * **Curvature, not extrema.** The design note says maxima and minima, and on the first
 * real map that gave two candidates over seventy metres of relief — because a surveyed
 * hillside has almost no local extrema at all. Its landforms are spurs and re-entrants,
 * which are places where the ground *bends*, not places where it stops rising. The
 * discrete Laplacian is exactly that bend: zero on a plane, however steep, and largest at
 * the nose of a spur and the head of a re-entrant. Knolls and hollows are the special case
 * where it is largest and the gradient is also zero, so nothing is lost by asking the more
 * general question.
 *
 * Candidates outside the ground the surveyor drew are dropped. A map is stored square and
 * padded to its longer side, and the reconstructed surface runs on smoothly into the
 * padding — where it invents a gentle hollow that no one surveyed and that no feature
 * stands on.
 */
function landformsOf(grid: Grid, size: number, drawn: Box): MapAnalysis['landforms'] {
  const { n, values } = grid;
  const step = size / n;
  const at = (i: number, j: number) => values[j * (n + 1) + i]!;
  const bend = (i: number, j: number) =>
    at(i - 1, j) + at(i + 1, j) + at(i, j - 1) + at(i, j + 1) - 4 * at(i, j);

  const found: { centre: Vec; strength: number; sign: number }[] = [];
  // Interior only, and two cells in: the Laplacian needs a neighbour on every side, and an
  // edge cell would report the whole border as shaped ground.
  for (let j = 2; j < n - 1; j++) {
    for (let i = 2; i < n - 1; i++) {
      const x = i * step;
      const y = j * step;
      if (x < drawn.minX || x > drawn.maxX || y < drawn.minY || y > drawn.maxY) continue;
      const here = Math.abs(bend(i, j));
      let strongest = true;
      for (let dj = -1; dj <= 1 && strongest; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          if (Math.abs(bend(i + di, j + dj)) > here) strongest = false;
        }
      }
      // A negative Laplacian is ground that curves *up* to here: a summit or a spur.
      if (strongest && here > 0) {
        found.push({ centre: { x, y }, strength: here, sign: bend(i, j) < 0 ? 1 : -1 });
      }
    }
  }

  // Most sharply shaped first, so that when two candidates on one spur collide it is the
  // nose that survives and the shoulder that is dropped.
  found.sort((a, b) => b.strength - a.strength || a.centre.x - b.centre.x || a.centre.y - b.centre.y);

  const kept: MapAnalysis['landforms'][number][] = [];
  for (const candidate of found) {
    if (kept.length >= MAX_LANDFORMS) break;
    const near = kept.some(
      (l) => Math.hypot(l.centre.x - candidate.centre.x, l.centre.y - candidate.centre.y)
        < LANDFORM_SEPARATION,
    );
    if (near) continue;
    const { radius, amplitude } = extentOf(grid, candidate.centre, candidate.sign);
    // A bump under a metre is inside the noise of a reconstructed surface, and warping it
    // would produce a distractor nobody can see.
    if (Math.abs(amplitude) < 1) continue;
    kept.push({ centre: candidate.centre, radius, amplitude });
  }
  return kept;
}

/**
 * How far a landform reaches, and how much of it there is.
 *
 * Measured as the **residual against the ground around it**: the height at the centre
 * minus the mean of a ring of probes at radius r. On a plane that is zero however steep
 * the plane is, which is the whole point — a regional fall of one in eight swamps a
 * three-metre knoll, and an estimate that compared the centre with the lowest probe would
 * report the hillside rather than the knoll. It was doing exactly that, and every landform
 * on the forest sample came out with the maximum extent and twenty metres of amplitude.
 *
 * Walking outward until the residual stops growing is then the extent: past the edge of a
 * bump, a wider ring adds only more of the plane and the residual flattens.
 */
function extentOf(grid: Grid, centre: Vec, sign: number): { radius: number; amplitude: number } {
  const here = sampleGridAt(grid, centre.x, centre.y);
  let radius = MIN_EXTENT;
  let amplitude = 0;
  let best = 0;
  for (let step = MIN_EXTENT; step <= MAX_EXTENT; step += EXTENT_STEP) {
    let total = 0;
    for (let probe = 0; probe < EXTENT_PROBES; probe++) {
      const angle = (probe * 2 * Math.PI) / EXTENT_PROBES;
      total += sampleGridAt(
        grid,
        centre.x + Math.cos(angle) * step,
        centre.y + Math.sin(angle) * step,
      );
    }
    const residual = here - total / EXTENT_PROBES;
    const grown = sign * residual;
    if (grown <= 0) break;
    if (step > MIN_EXTENT && grown <= best * (1 + EXTENT_GROWTH)) break;
    radius = step;
    amplitude = residual;
    best = grown;
  }
  return { radius, amplitude };
}

/**
 * A coarse runnability raster, from the area codes that cover each cell.
 *
 * White forest is 1 and everything is drawn over it, so a cell takes the **lowest**
 * runnability of any area covering it: green over white is green, and a route through it
 * costs what the green costs. Nothing reads this yet — it is what a route-choice drill
 * would cost a leg over, and it is here because it costs one pass over the features to
 * compute offline and a pass over 4000 of them to compute on a phone.
 */
function runnabilityOf(map: OMap, size: number): number[] {
  const cells = RUNNABILITY_GRID;
  const values = new Array<number>(cells * cells).fill(1);
  const step = size / cells;
  for (const feature of map.features) {
    if (feature.geometry.kind !== 'polygon') continue;
    const runnability = semanticsOf(feature.code)?.runnability;
    if (runnability === undefined || runnability >= 1) continue;
    const box = boundsOf(feature);
    const i0 = Math.max(0, Math.floor(box.minX / step));
    const i1 = Math.min(cells - 1, Math.floor(box.maxX / step));
    const j0 = Math.max(0, Math.floor(box.minY / step));
    const j1 = Math.min(cells - 1, Math.floor(box.maxY / step));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const centre = { x: (i + 0.5) * step, y: (j + 0.5) * step };
        if (!insidePolygon(centre, feature)) continue;
        const index = j * cells + i;
        if (runnability < values[index]!) values[index] = runnability;
      }
    }
  }
  return values;
}

/** Even-odd point in polygon, over every ring — holes cancel, which is what evenodd is. */
function insidePolygon(p: Vec, feature: Feature): boolean {
  if (feature.geometry.kind !== 'polygon') return false;
  let inside = false;
  for (const ring of feature.geometry.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!;
      const b = ring[j]!;
      if ((a.y > p.y) !== (b.y > p.y) &&
          p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
  }
  return inside;
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

  const scored: WindowScore[] = [];
  for (let y = 0; y + size <= map.height + 1e-6; y += stride) {
    for (let x = 0; x + size <= map.width + 1e-6; x += stride) {
      const crop: Crop = { x, y, size };
      const window_ = scoreWindow(map, analysis, requirement, crop, grid);
      if (window_.score > 0) scored.push(window_);
    }
  }
  scored.sort((a, b) => b.score - a.score || a.crop.y - b.crop.y || a.crop.x - b.crop.x);
  return scored.slice(0, keep);
}

function scoreWindow(
  map: OMap,
  analysis: Analysis,
  requirement: WindowRequirement,
  crop: Crop,
  grid: Grid | null,
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

  // A window that cannot answer the question at all scores zero and is dropped, rather
  // than scoring badly and being picked when nothing better exists. A contours round on
  // flat ground is not a hard round, it is an unanswerable one.
  let score = 0;
  const wantsRelief = requirement.needsRelief || requirement.relief !== undefined;
  // A relief round needs ground it can *move*, not only ground that goes up and down:
  // `proposeEdit` picks a warp from the landform candidates inside the window, and a
  // window with none has nothing to offer it. An even hillside is exactly that case.
  if (wantsRelief && landforms === 0) {
    return { crop, reliefRange, features, controlSites, landforms, cover, score: 0 };
  }
  if (wantsRelief && (!grid || reliefRange < (requirement.relief?.minRange ?? 5))) {
    return { crop, reliefRange, features, controlSites, landforms, cover, score: 0 };
  }
  if (requirement.minControlSites !== undefined && controlSites < requirement.minControlSites) {
    return { crop, reliefRange, features, controlSites, landforms, cover, score: 0 };
  }
  const wantedFeatures = totalWanted(requirement);
  if (wantedFeatures > 0 && features < Math.ceil(wantedFeatures / 2)) {
    return { crop, reliefRange, features, controlSites, landforms, cover, score: 0 };
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

  return { crop, reliefRange, features, controlSites, landforms, cover, score };
}

const totalWanted = (requirement: WindowRequirement): number => {
  const wanted = requirement.minFeatures;
  if (!wanted) return 0;
  return (wanted.point ?? 0) + (wanted.line ?? 0) + (wanted.area ?? 0);
};

