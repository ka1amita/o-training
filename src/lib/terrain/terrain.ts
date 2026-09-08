import type { Rng } from '@/lib/rng.ts';
import {
  contributionOf, downhillAt, sampleGrid, sampleGridAt, slopeAt, type Grid,
} from './height.ts';

/**
 * Terrain is a **list of named features**, not a field of noise.
 *
 * Fractal noise would be less code and the wrong model. Three things follow from features
 * that would not follow from noise:
 *
 *  - "The same map with one feature nudged" is an operation — `perturb` moves one thing.
 *    Reseeding noise changes everything at once, which is a different map, not a sibling,
 *    and a distractor that differs everywhere teaches nothing about reading detail.
 *  - The map reads as a map, in the vocabulary an orienteer already has: knoll, marsh,
 *    re-entrant, path.
 *  - The invariants are checkable. "Features do not collide" and "the perturbation moved
 *    something by at least this much" are statements about a list.
 *
 * World units are metres and the terrain is square.
 */

export type LandformKind = 'hill' | 'depression' | 'spur' | 'reentrant';
export type PointKind = 'boulder' | 'knoll' | 'pit' | 'tree' | 'crag';
export type LineKind = 'path' | 'stream' | 'fence' | 'ride';
/**
 * Green is a **runnability scale**, so the three densities are three kinds and not one
 * "thicket" with a parameter: ISOM draws them as separate symbols (406 slow running,
 * 408 walk, 410 fight), and reading which is which is half of route choice.
 */
export type AreaKind = 'marsh' | 'open' | 'rough' | 'slow' | 'walk' | 'fight' | 'rock';

export interface Landform {
  readonly kind: LandformKind;
  readonly x: number;
  readonly y: number;
  /** Half-extent of the bump, in metres. */
  readonly radius: number;
  /** Signed height in metres; negative digs a hollow. */
  readonly amplitude: number;
  /** Radians. Only meaningful when elongated. */
  readonly rotation: number;
  /** 1 is round; above 1 stretches along the rotation axis, making a spur or re-entrant. */
  readonly elongation: number;
}

export interface PointFeature {
  readonly kind: PointKind;
  readonly x: number;
  readonly y: number;
  /** Drawn size in metres. */
  readonly size: number;
}

export interface Vec {
  readonly x: number;
  readonly y: number;
}

export interface LineFeature {
  readonly kind: LineKind;
  readonly points: readonly Vec[];
}

export interface AreaFeature {
  readonly kind: AreaKind;
  readonly x: number;
  readonly y: number;
  readonly rx: number;
  readonly ry: number;
  readonly rotation: number;
}

export interface Terrain {
  /** Side of the square, in metres. */
  readonly size: number;
  /**
   * Regional slope, in metres of fall per metre, as a gradient vector.
   *
   * Ground is never level. Without this the map is a few nested ovals floating in white,
   * where a real map carries contours across every part of it — and a plain at exactly
   * zero also gives a stream nowhere to drain to.
   */
  readonly tilt: Vec;
  /**
   * Seed for the micro-relief in `noise.ts`. **Carried through `perturb` unchanged**, so
   * siblings share their noise exactly and still differ only where a landform moved.
   */
  readonly noiseSeed: number;
  readonly landforms: readonly Landform[];
  readonly points: readonly PointFeature[];
  readonly lines: readonly LineFeature[];
  readonly areas: readonly AreaFeature[];
}

export interface TerrainParams {
  readonly size: number;
  readonly landforms: number;
  readonly points: number;
  readonly lines: number;
  readonly areas: number;
}

/** Point features closer than this read as one blob rather than two features. */
export const MIN_POINT_SEPARATION = 22;

/**
 * Feature sizes are **metres, not fractions of the map**, because a drill can look at any
 * window onto it. Sized as a fraction, a marsh drawn for a 420 m map covers most of a
 * 130 m pexeso crop and every card is one grey wash — which is exactly what happened.
 * A marsh is 25-70 m across wherever it is, and a hill is a hill.
 */
const LANDFORM_RADIUS: readonly [number, number] = [28, 85];
/**
 * Longest a spur or re-entrant may run, in metres.
 *
 * `radius` is the half-extent across the feature, and elongation multiplies it along the
 * feature — so a radius of 85 stretched 3.4 times is a ridge 290 m long, which on a 300 m
 * map is not a spur, it is the map. Capped here rather than by narrowing the radius band,
 * so a long spur is a *thin* one, the way a real one is.
 */
const MAX_LANDFORM_LENGTH = 155;
/**
 * Smaller than the ellipses these replaced, because `areaOutline` wanders up to a third
 * outside the radius: at the old band a single patch of open land covered most of a 110 m
 * pexeso card, which is the same mistake as sizing features as a fraction of the map.
 */
const AREA_RADIUS: readonly [number, number] = [9, 21];
const POINT_SIZE: readonly [number, number] = [3, 7];

const POINT_KINDS: readonly PointKind[] = ['boulder', 'knoll', 'pit', 'tree', 'crag'];
/**
 * Weighted by repetition rather than picked uniformly.
 *
 * On an ISOM map the ground is *white* — runnable forest — and everything else is the
 * exception. Drawing the four kinds uniformly filled a 110 m pexeso card edge to edge and
 * lost the white entirely, which is both wrong cartography and a harder card to read.
 * Bare rock is the rarest thing here for the same reason it is rare underfoot.
 */
const AREA_KINDS: readonly AreaKind[] = [
  'slow', 'slow', 'slow',
  'walk', 'walk',
  'fight',
  'marsh', 'marsh',
  'rough', 'rough',
  'open',
  'rock',
];

export function paramsFor(level: number, size = 420): TerrainParams {
  const clamped = Math.min(10, Math.max(1, level));
  const scale = (low: number, high: number) =>
    Math.round(low + ((high - low) * (clamped - 1)) / 9);
  return {
    size,
    landforms: scale(4, 9),
    points: scale(3, 9),
    lines: scale(1, 3),
    areas: scale(2, 5),
  };
}

/** Keeps a feature clear of the edge so a crop near the border still has context. */
const MARGIN = 0.12;

/** Fall across the whole map, in metres. See `Terrain.tilt`. */
const TILT_DROP: readonly [number, number] = [14, 32];

/**
 * Total relief the landforms contribute, in metres, before the tilt is added.
 *
 * Amplitudes used to be drawn per feature and summed to whatever they summed to, so one
 * map came out with three contour lines and the next with thirty. A map is drawn to be
 * legible: the surveyor picks the interval, and here the interval is fixed at the 5 m
 * ISOM uses, so the relief is what has to land in range.
 */
const LANDFORM_RELIEF: readonly [number, number] = [20, 40];

/**
 * Where each kind of ground sits in **this map's own** slope distribution.
 *
 * Absolute thresholds were tried first and are wrong, because the regional tilt alone
 * ranges from 0.05 to 0.11 m/m: a steeply tilted map has no ground under an absolute
 * "flat enough for marsh" bar, so every marsh fell through to the unconditioned fallback
 * and landed anywhere — which is the behaviour this whole phase exists to remove. A marsh
 * belongs in the flattest ground *there is here*, and a crag on the steepest.
 */
const MARSH_FLATTEST = 0.25;
const ROCK_STEEPEST = 0.85;
const CRAG_STEEPEST = 0.75;
const OPEN_MAX = 0.8;
const VEGETATION_MAX = 0.92;

/** A budget for every rejection sampler here. See `placePoints`. */
const ATTEMPT_FACTOR = 40;
/**
 * Areas get a larger one, because there are at most six of them and marsh asks for two
 * things at once — flat *and* low — which a tilted map can make genuinely rare.
 */
const AREA_ATTEMPTS = 160;

// ---------------------------------------------------------------------------------------
// Landforms
// ---------------------------------------------------------------------------------------

/**
 * Landforms are **composed on a ridge**, not scattered.
 *
 * Independently placed bumps are the single biggest reason a generated map does not read
 * as terrain: real ground is one connected surface, so hills sit on a spine and spurs and
 * re-entrants alternate down its flanks. Scattering them uniformly produces a field of
 * unrelated blobs, which is a picture of nothing.
 *
 * Spurs and re-entrants are placed in **pairs on the same flank**, because telling one
 * from the other is the discrimination the sport actually asks for, and a card that
 * contains only one of them cannot ask for it.
 */
function placeLandforms(rng: Rng, params: TerrainParams, tiltAngle: number): Landform[] {
  const { size } = params;
  const centre = size / 2;
  const lo = size * MARGIN;
  const hi = size * (1 - MARGIN);
  const clamp = (v: number) => Math.min(hi, Math.max(lo, v));

  /**
   * The ridge lies **across** the regional fall, so its spurs and re-entrants — which run
   * perpendicular to it — run *down* the slope, which is what spurs and re-entrants do.
   *
   * Drawn independently of the tilt, a re-entrant across the fall line is not a valley at
   * all but a closed basin, and two maps in five then had their stream stop dead in one.
   */
  const axis = tiltAngle + Math.PI / 2 + rng.range(-0.4, 0.4);
  const ax = Math.cos(axis);
  const ay = Math.sin(axis);
  // Perpendicular to the ridge: the direction a spur runs and a re-entrant cuts.
  const px = -ay;
  const py = ax;

  /**
   * The ridge is offset and its length varies, or every map is the same diagonal band of
   * ground through the middle with empty corners — recognisable as a template within about
   * six seeds, which is fewer than one session.
   */
  const span = size * rng.range(0.5, 0.85);
  const shiftAlong = rng.range(-size * 0.1, size * 0.1);
  const shiftAcross = rng.range(-size * 0.16, size * 0.16);
  const originX = centre + ax * shiftAlong + px * shiftAcross;
  const originY = centre + ay * shiftAlong + py * shiftAcross;

  const count = params.landforms;
  const hills = Math.max(1, Math.round(count * 0.35));
  const hollows = count >= 6 ? 1 : 0;
  const flanks = Math.max(0, count - hills - hollows);

  const forms: Landform[] = [];
  const radius = () => rng.range(LANDFORM_RADIUS[0], LANDFORM_RADIUS[1]);

  for (let i = 0; i < hills; i++) {
    const t = -span / 2 + (span * (i + 0.5)) / hills + rng.range(-span * 0.08, span * 0.08);
    forms.push({
      kind: 'hill',
      x: clamp(originX + ax * t),
      y: clamp(originY + ay * t),
      radius: radius(),
      amplitude: rng.range(8, 20),
      rotation: axis,
      elongation: 1,
    });
  }

  for (let k = 0; k < flanks; k++) {
    // Pairs share a flank; consecutive pairs swap sides, so the ridge has shape on both.
    const side = (k >> 1) % 2 === 0 ? 1 : -1;
    const spur = k % 2 === 0;
    const t = -span / 2 + (span * (k + 0.5)) / Math.max(1, flanks) + rng.range(-span * 0.06, span * 0.06);
    const elongation = rng.range(2, 3.4);
    const r = Math.min(radius(), MAX_LANDFORM_LENGTH / (2 * elongation));
    // A spur reaches *out* from the ridge, so its centre stands off by something like its
    // own length. Offsetting by the short radius instead left every flank feature sitting
    // on the axis, and at nine landforms they piled into a corduroy of nested ovals that
    // reads as texture rather than as ground.
    const reach = r * elongation;
    const offset = reach * rng.range(0.5, 0.9) * side;
    forms.push({
      kind: spur ? 'spur' : 'reentrant',
      x: clamp(originX + ax * t + px * offset),
      y: clamp(originY + ay * t + py * offset),
      radius: r,
      amplitude: (spur ? 1 : -1) * rng.range(6, 16),
      // Elongated away from the ridge, which is what makes it a spur rather than a lump.
      rotation: axis + Math.PI / 2 + rng.range(-0.35, 0.35),
      elongation,
    });
  }

  for (let i = 0; i < hollows; i++) {
    forms.push({
      kind: 'depression',
      x: rng.range(lo, hi),
      y: rng.range(lo, hi),
      radius: rng.range(LANDFORM_RADIUS[0], LANDFORM_RADIUS[0] * 1.6),
      amplitude: -rng.range(7, 14),
      rotation: rng.range(0, Math.PI),
      elongation: 1,
    });
  }

  return normaliseRelief(forms, params.size, rng.range(LANDFORM_RELIEF[0], LANDFORM_RELIEF[1]));
}

/** Scales every amplitude so the landforms together span `target` metres. */
function normaliseRelief(forms: readonly Landform[], size: number, target: number): Landform[] {
  const n = 24;
  const step = size / n;
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      let h = 0;
      for (const f of forms) h += contributionOf(f, i * step, j * step);
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  const span = max - min;
  // A map with no relief at all cannot be scaled into having some.
  if (!Number.isFinite(span) || span < 1e-6) return [...forms];
  const scale = target / span;
  return forms.map((f) => ({ ...f, amplitude: f.amplitude * scale }));
}

// ---------------------------------------------------------------------------------------
// Reading the ground
// ---------------------------------------------------------------------------------------

/** What the placement phases need to know about the field, sampled once. */
export interface Ground {
  readonly grid: Grid;
  /** Height below which a point is in the lowest fifth, and so on. */
  quantile(fraction: number): number;
  /** The same, over gradient magnitude. */
  slopeQuantile(fraction: number): number;
  readonly maxima: readonly Vec[];
  readonly minima: readonly Vec[];
}

const GROUND_RESOLUTION = 64;

export function readGround(terrain: Terrain): Ground {
  const grid = sampleGrid(terrain, GROUND_RESOLUTION);
  const { n, values } = grid;
  const step = terrain.size / n;

  const pick = (sorted: Float32Array) => (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))]!;
  const quantile = pick(Float32Array.from(values).sort());

  const slopes = new Float32Array((n - 1) * (n - 1));
  for (let j = 1; j < n; j++) {
    for (let i = 1; i < n; i++) {
      slopes[(j - 1) * (n - 1) + (i - 1)] = slopeAt(grid, i * step, j * step);
    }
  }
  const slopeQuantile = pick(slopes.sort());

  const maxima: Vec[] = [];
  const minima: Vec[] = [];
  const at = (i: number, j: number) => values[j * (n + 1) + i]!;
  // Interior only: an edge cell has no neighbours on one side and would report every
  // border sample as an extremum.
  for (let j = 2; j < n - 1; j++) {
    for (let i = 2; i < n - 1; i++) {
      const h = at(i, j);
      let high = true;
      let low = true;
      for (let dj = -1; dj <= 1 && (high || low); dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const other = at(i + di, j + dj);
          if (other >= h) high = false;
          if (other <= h) low = false;
        }
      }
      if (high) maxima.push({ x: i * step, y: j * step });
      if (low) minima.push({ x: i * step, y: j * step });
    }
  }

  return { grid, quantile, slopeQuantile, maxima, minima };
}

// ---------------------------------------------------------------------------------------
// Features that read the ground
// ---------------------------------------------------------------------------------------

/**
 * Rejection sampling against a predicate, with the same budget and the same surrender as
 * `placePoints`: a slightly sparser map is harmless, a hung generator is not.
 *
 * The fallback ignores the predicate rather than returning nothing, because a map with no
 * marsh at all is a worse map than one with a marsh on a gentle slope instead of a flat.
 */
function sampleWhere(
  rng: Rng,
  size: number,
  wanted: (p: Vec) => boolean,
  attempts = ATTEMPT_FACTOR,
): Vec {
  const lo = size * MARGIN;
  const hi = size * (1 - MARGIN);
  for (let i = 0; i < attempts; i++) {
    const p = { x: rng.range(lo, hi), y: rng.range(lo, hi) };
    if (wanted(p)) return p;
  }
  return { x: rng.range(lo, hi), y: rng.range(lo, hi) };
}

/**
 * Where each kind of ground belongs.
 *
 * This is the whole of "plausible combinations": a marsh is wet because water sits there,
 * so it is in a hollow and it is flat; bare rock is exposed because nothing holds soil on
 * it, so it is steep. Placed uniformly at random, a marsh halfway up a hillside is the
 * kind of wrongness an orienteer sees instantly without being able to name.
 */
export function suitsArea(kind: AreaKind, ground: Ground, p: Vec): boolean {
  const slope = slopeAt(ground.grid, p.x, p.y);
  const height = sampleGridAt(ground.grid, p.x, p.y);
  switch (kind) {
    case 'marsh':
      return slope < ground.slopeQuantile(MARSH_FLATTEST) && height < ground.quantile(0.45);
    case 'rock':
      return slope > ground.slopeQuantile(ROCK_STEEPEST);
    case 'open':
    case 'rough':
      return slope < ground.slopeQuantile(OPEN_MAX);
    default:
      // Vegetation grows anywhere the ground is not a crag.
      return slope < ground.slopeQuantile(VEGETATION_MAX);
  }
}

/**
 * Areas, with the sinks taken first.
 *
 * Where a traced stream stops inland it has run into a closed hollow, and on a real map
 * that is drawn: the water goes into a marsh. Leaving the sink bare is what makes a
 * stream look like it was cut off rather than like it arrived somewhere.
 */
/**
 * The same question for a point feature, asked the weaker way.
 *
 * Generation puts a knoll *on* a sampled local maximum, which is a stronger claim than
 * this. What is wanted here is the claim that survives a feature being moved a few tens
 * of metres: that the ground still agrees with the symbol. A knoll on a hummock that is
 * not quite the summit is a fine knoll; a knoll in a hollow is a contradiction.
 */
export function suitsPoint(kind: PointKind, ground: Ground, p: Vec): boolean {
  const REACH = 10;
  const here = sampleGridAt(ground.grid, p.x, p.y);
  const around =
    [[REACH, 0], [-REACH, 0], [0, REACH], [0, -REACH]]
      .reduce((sum, [dx, dy]) => sum + sampleGridAt(ground.grid, p.x + dx!, p.y + dy!), 0) / 4;
  switch (kind) {
    case 'knoll':
      return here > around;
    case 'pit':
      return here < around;
    case 'boulder':
    case 'crag':
      return slopeAt(ground.grid, p.x, p.y) > ground.slopeQuantile(CRAG_STEEPEST);
    case 'tree':
      return true;
  }
}

function placeAreas(
  rng: Rng,
  params: TerrainParams,
  ground: Ground,
  sinks: readonly Vec[],
): AreaFeature[] {
  const areas: AreaFeature[] = [];
  const shape = (kind: AreaKind, p: Vec): AreaFeature => ({
    kind,
    x: p.x,
    y: p.y,
    rx: rng.range(AREA_RADIUS[0], AREA_RADIUS[1]),
    ry: rng.range(AREA_RADIUS[0], AREA_RADIUS[1]),
    rotation: rng.range(0, Math.PI),
  });

  for (const sink of sinks.slice(0, params.areas)) areas.push(shape('marsh', sink));

  while (areas.length < params.areas) {
    const kind = rng.pick(AREA_KINDS);
    areas.push(
      shape(kind, sampleWhere(rng, params.size, (q) => suitsArea(kind, ground, q), AREA_ATTEMPTS)),
    );
  }
  return areas;
}

/**
 * Point features that mean something about the relief go where that relief is.
 *
 * A knoll is a small hill and a pit is a small hollow — drawn on a uniform slope they are
 * brown dots that contradict the contours they sit on. Boulders and crags want steep,
 * broken ground for the same reason bare rock does.
 */
function placePoints(rng: Rng, params: TerrainParams, count: number, ground: Ground): PointFeature[] {
  const placed: PointFeature[] = [];
  const lo = params.size * MARGIN;
  const hi = params.size * (1 - MARGIN);
  const inside = (p: Vec) => p.x >= lo && p.x <= hi && p.y >= lo && p.y <= hi;
  const clear = (p: Vec) =>
    !placed.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < MIN_POINT_SEPARATION);

  // Rejection sampling with a budget. A hard loop could not terminate at high counts in a
  // small area; giving up quietly leaves a slightly sparser map, which is harmless, and
  // the separation invariant still holds for everything that was placed.
  for (let attempts = 0; placed.length < count && attempts < count * ATTEMPT_FACTOR; attempts++) {
    const kind = rng.pick(POINT_KINDS);
    let p: Vec;
    if (kind === 'knoll' || kind === 'pit') {
      const peaks = kind === 'knoll' ? ground.maxima : ground.minima;
      const usable = peaks.filter(inside);
      if (usable.length === 0) continue;
      const anchor = rng.pick(usable);
      // Nudged off the exact sample so several knolls do not stack on one grid cell.
      p = { x: anchor.x + rng.range(-4, 4), y: anchor.y + rng.range(-4, 4) };
      if (!inside(p)) continue;
    } else if (kind === 'boulder' || kind === 'crag') {
      const steep = ground.slopeQuantile(CRAG_STEEPEST);
      p = sampleWhere(rng, params.size, (q) => slopeAt(ground.grid, q.x, q.y) > steep);
    } else {
      p = sampleWhere(rng, params.size, () => true, 1);
    }
    if (!clear(p)) continue;
    // Checked, not assumed. A grid maximum at 4.7 m spacing is not always a rise at the
    // 10 m the eye reads, and the nudge above can push a knoll off its own summit onto
    // the slope beside it. Asking the predicate is what makes the invariant hold rather
    // than hold usually.
    if (!suitsPoint(kind, ground, p)) continue;
    placed.push({ kind, x: p.x, y: p.y, size: rng.range(POINT_SIZE[0], POINT_SIZE[1]) });
  }
  return placed;
}

// ---------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------

/** A point on the border, and the point on the far side to aim at. */
function crossing(rng: Rng, size: number): readonly [Vec, Vec] {
  const edge = rng.int(4);
  const along = () => rng.range(size * 0.15, size * 0.85);
  const start: Vec =
    edge === 0 ? { x: along(), y: 0 }
    : edge === 1 ? { x: size, y: along() }
    : edge === 2 ? { x: along(), y: size }
    : { x: 0, y: along() };
  const end: Vec =
    edge === 0 ? { x: along(), y: size }
    : edge === 1 ? { x: 0, y: along() }
    : edge === 2 ? { x: along(), y: 0 }
    : { x: size, y: along() };
  return [start, end];
}

const inMap = (p: Vec, size: number): boolean =>
  p.x > 0 && p.y > 0 && p.x < size && p.y < size;

const STREAM_STEPS = 300;
/** A trickle across one corner is not worth drawing. */
const MIN_STREAM_LENGTH = 0.3;

/**
 * A watercourse, by steepest descent.
 *
 * A stream that ignores the height field is the most obviously wrong thing a generated
 * map can contain — water running over a hilltop is not a subtle mistake. Descent also
 * puts the stream *in* the valley, so the contours bend around it the way they do on a
 * surveyed map, without anything having to arrange that.
 *
 * Direction carries momentum, because raw steepest descent on a sampled grid zig-zags
 * between cells and draws a stream that looks like a saw blade.
 */
function traceStream(ground: Ground, start: Vec, size: number): Vec[] | null {
  const step = size / GROUND_RESOLUTION;
  const points: Vec[] = [start];
  let dx = 0;
  let dy = 0;

  for (let i = 0; i < STREAM_STEPS; i++) {
    const p = points[points.length - 1]!;
    const here = sampleGridAt(ground.grid, p.x, p.y);
    const down = downhillAt(ground.grid, p.x, p.y);
    if (down.x === 0 && down.y === 0) break;

    const blended = { x: dx * 0.45 + down.x * 0.55, y: dy * 0.45 + down.y * 0.55 };
    const blendedLength = Math.hypot(blended.x, blended.y) || 1;
    let ux = blended.x / blendedLength;
    let uy = blended.y / blendedLength;
    let next = { x: p.x + ux * step, y: p.y + uy * step };

    // Momentum smooths the zig-zag that raw grid descent draws, but on a tight bend it
    // overshoots and points uphill — and a stream that stops there is not a spring
    // running dry, it is an artefact of the smoothing. Fall back to the true steepest
    // line before believing it, or one in eight maps ends its water on a hillside.
    if (inMap(next, size) && sampleGridAt(ground.grid, next.x, next.y) >= here) {
      ux = down.x;
      uy = down.y;
      next = { x: p.x + ux * step, y: p.y + uy * step };
    }

    if (!inMap(next, size)) {
      points.push({
        x: Math.min(size, Math.max(0, next.x)),
        y: Math.min(size, Math.max(0, next.y)),
      });
      break;
    }
    // A closed hollow is where a stream really does stop; on a real map it becomes a
    // marsh or a sink, and drawing it further would be inventing water.
    if (sampleGridAt(ground.grid, next.x, next.y) >= here) break;

    dx = ux;
    dy = uy;
    points.push(next);
  }

  let run = 0;
  for (let i = 1; i < points.length; i++) {
    run += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  if (run < size * MIN_STREAM_LENGTH) return null;

  // One point every few steps: the trace is finer than any map would draw, and a path
  // with three hundred vertices is three hundred numbers in every card that shows it.
  const thinned = points.filter((_, i) => i % 4 === 0 || i === points.length - 1);
  return smooth(thinned);
}

/** Three-point average, twice. Enough to take the grid out without moving the line. */
function smooth(points: readonly Vec[]): Vec[] {
  let current = [...points];
  for (let pass = 0; pass < 2; pass++) {
    current = current.map((p, i) => {
      const before = current[i - 1];
      const after = current[i + 1];
      if (!before || !after) return p;
      return { x: (before.x + p.x * 2 + after.x) / 4, y: (before.y + p.y * 2 + after.y) / 4 };
    });
  }
  return current;
}

/** How much a path will detour to avoid climbing, against how much it wants to arrive. */
const PATH_CLIMB_WEIGHT = 1.4;
const PATH_STEPS = 90;

/**
 * A path, taking the gentle line.
 *
 * Paths exist because people walked them, and people contour. A straight line drawn
 * across a hillside is the one thing a real path never is.
 */
function tracePath(ground: Ground, start: Vec, end: Vec, size: number): Vec[] {
  const step = size / 26;
  const points: Vec[] = [start];

  for (let i = 0; i < PATH_STEPS; i++) {
    const p = points[points.length - 1]!;
    if (Math.hypot(end.x - p.x, end.y - p.y) < step * 1.5) break;
    const bearing = Math.atan2(end.y - p.y, end.x - p.x);
    const here = sampleGridAt(ground.grid, p.x, p.y);

    let best: Vec | null = null;
    let bestCost = Infinity;
    // Turns are capped well under a right angle: a path bends, it does not take corners,
    // and one hard corner is enough to make a whole card look drawn by a machine.
    for (const turn of [-0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6]) {
      const angle = bearing + turn;
      const q = { x: p.x + Math.cos(angle) * step, y: p.y + Math.sin(angle) * step };
      if (q.x < 0 || q.y < 0 || q.x > size || q.y > size) continue;
      const climb = Math.abs(sampleGridAt(ground.grid, q.x, q.y) - here) / step;
      const cost = climb * PATH_CLIMB_WEIGHT + Math.abs(turn) * 0.02;
      if (cost < bestCost) {
        bestCost = cost;
        best = q;
      }
    }
    if (!best) break;
    points.push(best);
  }

  points.push(end);
  return smooth(smooth(points));
}

/** A ride is cut, so it is straight; a fence follows a boundary, so it wanders. */
function makeStraightOrWandering(rng: Rng, params: TerrainParams, kind: LineKind): LineFeature {
  const [start, end] = crossing(rng, params.size);
  if (kind === 'ride') return { kind, points: [start, end] };

  const steps = 4;
  const points: Vec[] = [start];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const wander = params.size * 0.09;
    points.push({
      x: start.x + (end.x - start.x) * t + rng.range(-wander, wander),
      y: start.y + (end.y - start.y) * t + rng.range(-wander, wander),
    });
  }
  points.push(end);
  return { kind, points };
}

/**
 * Lines, in the order a landscape gets them: water first, then the path people wore
 * beside it, then whatever was built.
 */
interface Drainage {
  readonly lines: readonly LineFeature[];
  /** Where a stream stopped short of the border, and so needs somewhere to go. */
  readonly sinks: readonly Vec[];
}

function placeLines(rng: Rng, params: TerrainParams, ground: Ground): Drainage {
  const lines: LineFeature[] = [];
  const sinks: Vec[] = [];
  const { size } = params;

  // The contours drill asks for a map with nothing on it but the relief, and it means it.
  if (params.lines <= 0) return { lines, sinks };

  // Water starts where it gathers: high ground, but not the very top of it.
  const high = ground.quantile(0.6);
  const low = ground.quantile(0.92);
  let stream: Vec[] | null = null;
  for (let attempt = 0; attempt < 12 && !stream; attempt++) {
    const from = sampleWhere(rng, size, (p) => {
      const h = sampleGridAt(ground.grid, p.x, p.y);
      return h > high && h < low;
    });
    stream = traceStream(ground, from, size);
  }
  if (stream) {
    lines.push({ kind: 'stream', points: stream });
    const end = stream[stream.length - 1]!;
    const onEdge = end.x <= 0 || end.y <= 0 || end.x >= size || end.y >= size;
    if (!onEdge) sinks.push(end);
  }

  if (lines.length < params.lines) {
    const [start, end] = crossing(rng, size);
    lines.push({ kind: 'path', points: tracePath(ground, start, end, size) });
  }

  while (lines.length < params.lines) {
    lines.push(makeStraightOrWandering(rng, params, rng.pick(['fence', 'ride'] as const)));
  }

  return { lines: lines.slice(0, params.lines), sinks };
}

// ---------------------------------------------------------------------------------------

/**
 * The order is the point: the ground exists first, and everything else is placed by
 * reading it.
 *
 * Landforms are composed, then scaled so the relief is legible at a 5 m interval, then
 * sampled once into a `Ground`. Streams, marshes, crags and knolls are all decided from
 * that one sampling, which is what makes them agree with the contours drawn over them.
 */
export function generateTerrain(rng: Rng, params: TerrainParams): Terrain {
  const tiltAngle = rng.range(0, 2 * Math.PI);
  const gradient = rng.range(TILT_DROP[0], TILT_DROP[1]) / params.size;
  const tilt: Vec = { x: Math.cos(tiltAngle) * gradient, y: Math.sin(tiltAngle) * gradient };
  // The low bit is set because seed 0 is the documented "no micro-relief" case in
  // `noise.ts`, and a map that silently came out smooth would be a puzzling one-in-four-
  // billion bug report.
  const noiseSeed = rng.next() | 1;

  const landforms = placeLandforms(rng, params, tiltAngle);

  const bare: Terrain = {
    size: params.size,
    tilt,
    noiseSeed,
    landforms,
    points: [],
    lines: [],
    areas: [],
  };
  const ground = readGround(bare);

  // Water before ground cover: a marsh is put where the stream ends, so the two agree.
  const drainage = placeLines(rng, params, ground);

  return {
    ...bare,
    lines: drainage.lines,
    areas: placeAreas(rng, params, ground, drainage.sinks),
    points: placePoints(rng, params, params.points, ground),
  };
}

/** What a perturbation did, so a test can assert it did something. */
export interface Change {
  readonly what: 'landform' | 'point' | 'area';
  readonly index: number;
  /** How far the feature moved, in metres. */
  readonly distance: number;
}

export interface Perturbed {
  readonly terrain: Terrain;
  readonly change: Change;
}

/**
 * Moves exactly one feature, and says which.
 *
 * `target: 'landform'` is for drills read off the relief — moving a boulder changes the
 * map and not the contours, so a contour distractor perturbed anywhere else would be
 * identical to the answer.
 */
export function perturb(
  terrain: Terrain,
  rng: Rng,
  options: { readonly distance: number; readonly target?: 'landform' | 'any' },
): Perturbed {
  const { distance } = options;
  const target = options.target ?? 'any';

  const pools: Change['what'][] =
    target === 'landform'
      ? ['landform']
      : [
          ...(terrain.landforms.length > 0 ? (['landform'] as const) : []),
          ...(terrain.points.length > 0 ? (['point'] as const) : []),
          ...(terrain.areas.length > 0 ? (['area'] as const) : []),
        ];
  const what = rng.pick(pools);

  // A random direction at a fixed distance: the move is always exactly as large as asked,
  // so difficulty is the number that was requested rather than one that came out of a
  // uniform square and averaged smaller.
  const angle = rng.range(0, 2 * Math.PI);
  const dx = Math.cos(angle) * distance;
  const dy = Math.sin(angle) * distance;
  const clamp = (v: number) => Math.min(terrain.size, Math.max(0, v));

  if (what === 'landform') {
    const index = rng.int(terrain.landforms.length);
    const landforms = terrain.landforms.map((f, i) =>
      i === index ? { ...f, x: clamp(f.x + dx), y: clamp(f.y + dy) } : f,
    );
    return { terrain: { ...terrain, landforms }, change: { what, index, distance } };
  }
  if (what === 'point') {
    const index = rng.int(terrain.points.length);
    const points = terrain.points.map((f, i) =>
      i === index ? { ...f, x: clamp(f.x + dx), y: clamp(f.y + dy) } : f,
    );
    return { terrain: { ...terrain, points }, change: { what, index, distance } };
  }
  const index = rng.int(terrain.areas.length);
  const areas = terrain.areas.map((f, i) =>
    i === index ? { ...f, x: clamp(f.x + dx), y: clamp(f.y + dy) } : f,
  );
  return { terrain: { ...terrain, areas }, change: { what, index, distance } };
}
