import { sampleGridAt, type Grid } from './height.ts';
import { boundsOf, type Feature, type MapAnalysis, type OMap, type Vec } from './omap.ts';
import { semanticsOf } from './semantics.ts';

/**
 * What a map can answer about itself without being re-read.
 *
 * This began in the import pipeline, where it runs **once, offline**, because the
 * alternative was a phone reading two kilometres of forest before the first round. It
 * lives here now because the generated map needs the same answers from the same code: a
 * warp picks its ground out of `analysis.landforms` whatever drew the map, and for as long
 * as the generator carried no analysis the only way to warp its ground was an
 * `instanceof AnalyticRelief` in `edits.ts` — a source-specific branch in the one place
 * this whole refactor exists to keep source-neutral.
 *
 * `maps/import/analyse.ts` re-exports every name here unchanged. The window scoring stays
 * there: it reads a `WindowRequirement`, and nothing under `terrain/` may depend on the
 * provider that defines one.
 */

/**
 * How far apart two summits have to be to be two summits, in metres.
 *
 * A broad hilltop sampled at four metres is dozens of grid maxima. A warp candidate is a
 * *piece of ground to move*, so clustering them is not tidying: it is the difference
 * between moving a hill and moving one sample of it.
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

/**
 * Samples a side the ground is read at.
 *
 * The 64 `readGround` uses, and deliberately the same number: candidates found on a
 * coarser grid than the one the generator placed its features from would be pieces of
 * ground nothing else in the app agrees exist.
 */
const ANALYSIS_RESOLUTION = 64;

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

/** What a source may hand the analysis rather than make it read the ground for. */
export interface AnalysisOptions {
  /**
   * Landform candidates the source already knows, in place of reading them off curvature.
   *
   * A surveyed map has to be asked where its landforms are. A generated one was *built*
   * from them, and asking curvature to find them again on ground that also carries a metre
   * of micro-relief answers worse — see `candidatesOf` in `terrain.ts`, which is the only
   * caller that passes this.
   */
  readonly landforms?: MapAnalysis['landforms'];
}

export function analyse(map: OMap, options: AnalysisOptions = {}): Analysis {
  const size = Math.max(map.width, map.height);
  return {
    // Read off the ground only when nobody handed them over: sampling a grid to find what
    // the caller already knows is the cost this runs on a phone once per generated map.
    landforms: options.landforms ?? landformCandidates(map, size),
    barriers: map.features.filter((f) => semanticsOf(f.code)?.barrier).map((f) => f.id),
    runnability: runnabilityOf(map, size),
    runnabilityGrid: RUNNABILITY_GRID,
  };
}

function landformCandidates(map: OMap, size: number): MapAnalysis['landforms'] {
  if (map.relief.kind === 'none') return [];
  return landformsOf(map.relief.sampleGrid(ANALYSIS_RESOLUTION), size, drawnExtent(map));
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
