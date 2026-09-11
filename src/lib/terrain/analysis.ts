import { downhillAt, sampleGridAt, type Grid } from './height.ts';
import { boundsOf, type Feature, type MapAnalysis, type OMap, type Vec } from './omap.ts';
import type { LandformKind } from './relief.ts';
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
export interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * The ground the surveyor drew, as a box.
 *
 * Exported because two stages need the same answer: the landform candidates are clipped
 * to it, and so are the windows (`scoreWindows` in `maps/import/analyse.ts`). A map is
 * stored square and padded to its longer side, and a window framed on that padding is a
 * card with a blank strip down one edge — which the padding rule in stage five refuses,
 * from this box and not from a second idea of where the map is.
 */
export function drawnExtent(map: OMap): Box {
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
    const form = classifyLandform(grid, candidate.centre, radius, amplitude);
    kept.push({
      centre: candidate.centre,
      radius,
      amplitude,
      // A name only where the ground was decisive, and only for a form the answer space
      // has a word for: `LandformKind` has no `saddle`, so a saddle stays an unnamed piece
      // of ground that a warp can still pick up. See `classifyLandform`.
      ...(nameable(form) ? { kind: form.form } : {}),
      // The axis is a measurement and travels whether or not the name did: it is what
      // `standsOut` measures a spur across, and an unnamed candidate that later gets a
      // word should not have to be re-measured.
      ...(form.elongation === undefined || form.rotation === undefined
        ? {}
        : { rotation: form.rotation, elongation: form.elongation }),
    });
  }
  return kept;
}

const nameable = (form: Classification): form is Classification & { form: LandformKind } =>
  form.form !== undefined && form.form !== 'saddle' && form.confidence >= KIND_CONFIDENCE;


// ---------------------------------------------------------------------------------------
// Which form a candidate is
// ---------------------------------------------------------------------------------------

/**
 * What a surveyed candidate turns out to be, including the one word the answer space lacks.
 *
 * `LandformKind` is the vocabulary the generator was built from and the vocabulary map
 * dohledavka can name. A saddle is a perfectly good control description word and is
 * neither, so it is classified here and dropped on the way out (`nameable`): adding it to
 * `LandformKind` means adding it to that drill's `CONTROL_NAMES` in the same change, and
 * one candidate in six on generated ground comes back a saddle, so the word is worth
 * having the day the answer space can carry it.
 */
export type SurveyedForm = LandformKind | 'saddle';

export interface Classification {
  /** Absent when nothing the ground says was decisive. */
  readonly form?: SurveyedForm;
  /**
   * The share of the sixteen rays that agreed, 0 to 1.
   *
   * One number over tests of different shapes, deliberately: it is always **how many of
   * the rays walked out from the candidate said what the form says they should**, so one
   * threshold applies to all of them and a form cannot pass on one kind of evidence while
   * being weak on another. A ray that decided nothing — the ground neither fell nor rose
   * an interval within reach — is a ray that did not agree.
   */
  readonly confidence: number;
  /** Radians, along the long axis, as `Landform.rotation` means it. */
  readonly rotation?: number;
  /** 1 is round. Absent when the region was too small to fit an axis to. */
  readonly elongation?: number;
}

/** Rays walked out from the candidate. Sixteen sees the two highs and two lows of a col. */
const PROFILE_DIRECTIONS = 16;

/**
 * How far a ray walks, against the candidate's own radius, and in how many steps.
 *
 * Three radii, because a ray that has decided nothing is a ray that votes against the
 * form, and on real ground two radii left three rays in ten undecided. It costs nothing on
 * shaped ground: the walk stops at the first crossing, so it only runs its full length
 * where the ground is flat.
 */
const PROFILE_REACH = 3;
const PROFILE_STEPS = 12;

/**
 * The height difference that decides a ray, in metres: ISOM's contour interval, which is
 * what this app draws at (`MapView`, and `standsOut` in map dohledavka asks for the same).
 *
 * It is the whole bar. A form the map does not draw a contour for is not a form a control
 * description can name, and a ray that has neither fallen nor climbed a full interval
 * within reach has not seen the edge of anything. Measured: gating on the candidate's own
 * amplitude as well changes 2 candidates in 3500 on generated ground, because this test
 * already refuses everything an amplitude bar would have. At half an interval it names
 * half as much again and hill precision against the drawn contours falls from 0.95 to
 * 0.90 — a generated map's metre of micro-relief is exactly what the half-interval bar
 * lets through.
 */
const CONTOUR_INTERVAL = 5;

/**
 * How much of the evidence has to agree before the candidate gets a name.
 *
 * Fourteen rays of sixteen. Measured on generated maps against the contours the map
 * actually draws (`analysis.test.ts` runs the table): at 13 of 16 hill precision falls
 * from 0.95 to 0.94 and depression from 0.97 to 0.96; at 15 of 16 the spurs collapse from
 * 21 to 14 and their precision from 0.57 to 0.43, because the two rays of slack are where
 * a spur runs out into ground that has not made up its mind. Two rays is also what one
 * bench cut across a hillside costs.
 */
const KIND_CONFIDENCE = 0.875;

/**
 * How many rays the majority side of an open form has to hold, of sixteen.
 *
 * An even split is not a form, it is a hillside: on a plane exactly half the rays fall and
 * half climb, whatever the slope, and a candidate there would be a spur or a re-entrant on
 * the strength of one ray. Ten of sixteen is a form standing clear of the slope it is on,
 * and it costs one spur and two re-entrants of the measured table.
 */
const PROFILE_MAJORITY = 10;

/**
 * How nearly the long axis has to lie along the fall, as |cos| of the angle between them.
 *
 * 0.71 is 45 degrees: past it the axis is more along the fall than across it, which is
 * the difference between a spur and a shoulder of the hill. An elongated form across the
 * fall is a ridge or a terrace, and the answer space has no word for either.
 */
const ALONG_FALL = 0.71;

/** How far out the region is looked at, against the candidate's own radius. */
const REGION_REACH = 1.5;

/** Samples across that reach. 24 gives ~450 inside the disc — a moment fit, not a map. */
const REGION_SAMPLES = 24;

/**
 * Where the region's edge is put, as a share of the amplitude.
 *
 * Half the height of the bump, which is what an eye reads as "the spur" rather than "the
 * spur and the hillside it dies into". Lower and the region grows until it is the window;
 * higher and it shrinks to the few samples nearest the top, where every form is round.
 */
const REGION_SHARE = 0.5;

/**
 * Which form a piece of ground is, read off the relief around it.
 *
 * The sign of the amplitude says up or down and nothing else: a hollow on a hillside and a
 * closed depression have the same sign and only one of them is a depression. What decides
 * is **sixteen rays walked outward**, each ending where the ground first falls or first
 * climbs a contour interval — which is the same question the contours answer, because a
 * line closes on the side the ground drops below it:
 *
 * - **hill / depression** — every ray falls (or every ray climbs). A closed high, a knoll:
 *   nothing around it within two radii stands an interval above it.
 * - **spur / re-entrant** — one contiguous arc of rays climbs and the rest fall. That arc
 *   is where the form runs back into the hillside it came off, which is exactly what stops
 *   a contour closing round it. Falling rays in the majority is ground standing above its
 *   flanks — a spur; climbing rays in the majority is ground cut into them — a re-entrant.
 *   Confirmed against the fall: the long axis of the region has to lie along the local
 *   fall (`ALONG_FALL`), or the form is a terrace across the slope and gets no name.
 * - **saddle** — two climbing arcs and two falling ones. Classified and then dropped; see
 *   `SurveyedForm`.
 *
 * **Where this departs from the plan.** The plan gated a spur on the region's `elongation`
 * being 1.6 or more. A curvature candidate sits at the *nose*, and the region around a
 * nose is not elongated: measured over a hundred generated maps, the region at a candidate
 * on a spur comes out at a median 2.1 against 1.5 on a hill, and adding the gate took spur
 * from 22 candidates to 10 without improving what they were. So the axis is used for the
 * direction it points in — where it is accurate, a median 8 degrees off the generator's
 * own — and not as a threshold.
 */
export function classifyLandform(
  grid: Grid,
  centre: Vec,
  radius: number,
  amplitude: number,
): Classification {
  const rays = profileOf(grid, centre, radius);
  const region = regionOf(grid, centre, radius, amplitude);
  const axes = region && { rotation: region.rotation, elongation: region.elongation };

  let falling = 0;
  let climbing = 0;
  for (const ray of rays) {
    if (ray === 'falls') falling++;
    if (ray === 'climbs') climbing++;
  }
  const decided = (falling + climbing) / PROFILE_DIRECTIONS;

  // Closed, in one direction or the other: a knoll or a pit.
  if (climbing === 0) {
    const confidence = falling / PROFILE_DIRECTIONS;
    return { ...(confidence >= KIND_CONFIDENCE ? { form: 'hill' as const } : {}), confidence, ...axes };
  }
  if (falling === 0) {
    const confidence = climbing / PROFILE_DIRECTIONS;
    return { ...(confidence >= KIND_CONFIDENCE ? { form: 'depression' as const } : {}), confidence, ...axes };
  }

  const arcs = arcsOf(rays);
  // Two ways up and two ways down: the col itself, the one form whose centre is neither a
  // high nor a low.
  if (arcs === 4) return { form: 'saddle', confidence: decided, ...axes };

  const majority = Math.max(falling, climbing);
  if (
    arcs === 2 && climbing >= 2 && falling >= 2 && majority >= PROFILE_MAJORITY
    && decided >= KIND_CONFIDENCE && region
  ) {
    const alignment = Math.abs(
      Math.cos(region.rotation) * region.fall.x + Math.sin(region.rotation) * region.fall.y,
    );
    if (alignment >= ALONG_FALL) {
      return { form: falling > climbing ? 'spur' : 'reentrant', confidence: decided, ...axes };
    }
  }
  return { confidence: 0, ...axes };
}

/**
 * Sixteen rays, each ending where the ground first leaves the band round the candidate.
 *
 * **Whichever comes first**, and the band is symmetric. A knoll on the shoulder of a hill
 * rises three metres toward the summit and then plunges twenty: read as "this side climbs"
 * it would be a spur, and the map draws a closed ring round it. The first full interval is
 * what the cartography agrees with — measured, it is the difference between naming 0.95 of
 * the hills right and 0.92 of them.
 */
function profileOf(grid: Grid, centre: Vec, radius: number): ('falls' | 'climbs' | 'flat')[] {
  const out: ('falls' | 'climbs' | 'flat')[] = [];
  const here = sampleGridAt(grid, centre.x, centre.y);
  for (let d = 0; d < PROFILE_DIRECTIONS; d++) {
    const angle = (d * 2 * Math.PI) / PROFILE_DIRECTIONS;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let state: 'falls' | 'climbs' | 'flat' = 'flat';
    for (let step = 1; step <= PROFILE_STEPS; step++) {
      const t = (radius * PROFILE_REACH * step) / PROFILE_STEPS;
      const difference = sampleGridAt(grid, centre.x + dx * t, centre.y + dy * t) - here;
      if (difference <= -CONTOUR_INTERVAL) {
        state = 'falls';
        break;
      }
      if (difference >= CONTOUR_INTERVAL) {
        state = 'climbs';
        break;
      }
    }
    out.push(state);
  }
  return out;
}

/** How many arcs of climbing ground the ring of rays is cut into, counted as boundaries. */
function arcsOf(rays: readonly ('falls' | 'climbs' | 'flat')[]): number {
  let changes = 0;
  for (let i = 0; i < rays.length; i++) {
    const here = rays[i] === 'climbs';
    const next = rays[(i + 1) % rays.length] === 'climbs';
    if (here !== next) changes++;
  }
  return changes;
}

/**
 * The region the candidate stands out over, as a principal-axis fit.
 *
 * Second moments of the excess over the surrounding level: the weights are how far each
 * sample stands clear, so the fit describes the shape of the bump rather than the shape of
 * the disc it was sampled in. `elongation` is the ratio of the axes' standard deviations,
 * which is 1 on a round hill whatever its size, and `rotation` is the long one — the same
 * convention `Landform.rotation` and `contributionOf` use, so a candidate and a generated
 * landform mean the same thing by it. Measured against the generator's own landforms, the
 * axis comes out a median 8 degrees off.
 *
 * `fall` is `downhillAt` averaged over the same region, as unit vectors: on a spur they
 * splay either side of the crest and average along it; on a round hill they cancel, which
 * is why the alignment test is only ever asked of a form the rays already call open.
 */
function regionOf(
  grid: Grid,
  centre: Vec,
  radius: number,
  amplitude: number,
): { rotation: number; elongation: number; fall: Vec } | null {
  const sign = amplitude >= 0 ? 1 : -1;
  const reach = radius * REGION_REACH;
  const step = (2 * reach) / REGION_SAMPLES;
  // The level the candidate stands out from: the mean of a ring at its own radius, which
  // is what its amplitude was measured against in `extentOf`.
  const level = sampleGridAt(grid, centre.x, centre.y) - amplitude;
  const floor = Math.abs(amplitude) * REGION_SHARE;
  const points: { x: number; y: number; weight: number }[] = [];
  let weight = 0;
  let sx = 0;
  let sy = 0;
  let fx = 0;
  let fy = 0;
  for (let j = 0; j <= REGION_SAMPLES; j++) {
    for (let i = 0; i <= REGION_SAMPLES; i++) {
      const x = centre.x - reach + i * step;
      const y = centre.y - reach + j * step;
      if (Math.hypot(x - centre.x, y - centre.y) > reach) continue;
      const excess = sign * (sampleGridAt(grid, x, y) - level);
      if (excess < floor) continue;
      points.push({ x, y, weight: excess });
      weight += excess;
      sx += excess * x;
      sy += excess * y;
      const fall = downhillAt(grid, x, y);
      fx += fall.x;
      fy += fall.y;
    }
  }
  // Fewer than a handful of samples is a fit to noise: three points lie on an ellipse
  // exactly, and its axes say nothing about the ground.
  if (points.length < 8 || weight <= 0) return null;

  const cx = sx / weight;
  const cy = sy / weight;
  let mxx = 0;
  let myy = 0;
  let mxy = 0;
  for (const p of points) {
    mxx += p.weight * (p.x - cx) * (p.x - cx);
    myy += p.weight * (p.y - cy) * (p.y - cy);
    mxy += p.weight * (p.x - cx) * (p.y - cy);
  }
  mxx /= weight;
  myy /= weight;
  mxy /= weight;

  const half = (mxx + myy) / 2;
  const spread = Math.sqrt(((mxx - myy) / 2) ** 2 + mxy * mxy);
  const length = Math.hypot(fx, fy);
  return {
    // Half the angle of the doubled-angle form: the direction of the larger eigenvalue.
    rotation: 0.5 * Math.atan2(2 * mxy, mxx - myy),
    elongation: Math.sqrt((half + spread) / Math.max(half - spread, 1e-9)),
    fall: length === 0 ? { x: 0, y: 0 } : { x: fx / length, y: fy / length },
  };
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

/**
 * Even-odd point in polygon, over every ring — holes cancel, which is what evenodd is.
 *
 * Exported because `enrich.ts` asks the same question for a different reason: a boulder
 * may not be added inside a lake or a building. One implementation, so the runnability
 * raster and the plausibility rules cannot disagree about where an area is.
 */
export function insidePolygon(p: Vec, feature: Feature): boolean {
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
