import type { Rng } from '@/lib/rng.ts';
import { analyse } from './analysis.ts';
import { contributionOf, downhillAt, sampleGridAt, slopeAt, type Grid } from './height.ts';
import { ISOM_SCALE } from './isom.ts';
import type { Feature, MapAnalysis, OMap, Vec } from './omap.ts';
import { AnalyticRelief, type Landform, type Relief } from './relief.ts';
import { CODE_OF, CRAG_STEEPEST, suits, type IsomCode } from './semantics.ts';
import { areaOutline } from './shapes.ts';

export type { Vec } from './omap.ts';

/**
 * A generated map is a **list of named features**, not a field of noise.
 *
 * Fractal noise would be less code and the wrong model. Three things follow from features
 * that would not follow from noise:
 *
 *  - "The same map with one feature nudged" is an operation — an `Edit` moves one thing.
 *    Reseeding noise changes everything at once, which is a different map, not a sibling,
 *    and a distractor that differs everywhere teaches nothing about reading detail.
 *  - The map reads as a map, in the vocabulary an orienteer already has: knoll, marsh,
 *    re-entrant, path.
 *  - The invariants are checkable. "Features do not collide" and "the edit moved
 *    something by at least this much" are statements about a list.
 *
 * World units are metres and the terrain is square.
 */

export type PointKind = 'boulder' | 'knoll' | 'pit' | 'tree' | 'crag';
export type LineKind = 'path' | 'stream' | 'fence' | 'ride';
/**
 * Green is a **runnability scale**, so the three densities are three kinds and not one
 * "thicket" with a parameter: ISOM draws them as separate symbols (406 slow running,
 * 408 walk, 410 fight), and reading which is which is half of route choice.
 */
export type AreaKind = 'marsh' | 'open' | 'rough' | 'slow' | 'walk' | 'fight' | 'rock';

/**
 * What the generator thinks in, before the map exists.
 *
 * Three shapes rather than one `Feature`, because placement asks different questions of
 * each: an area is a centre and two radii until `areaOutline` is asked for its edge, a
 * line is a traced path, a point is a spot with a drawn size. `toFeatures` is where they
 * become the one list an `OMap` carries.
 */
interface PointFeature {
  readonly kind: PointKind;
  readonly code: IsomCode;
  readonly x: number;
  readonly y: number;
  /** Drawn size in metres. */
  readonly size: number;
}

interface LineFeature {
  readonly kind: LineKind;
  readonly code: IsomCode;
  readonly points: readonly Vec[];
}

interface AreaFeature {
  readonly kind: AreaKind;
  readonly code: IsomCode;
  readonly x: number;
  readonly y: number;
  readonly rx: number;
  readonly ry: number;
  readonly rotation: number;
}

/** What `generateTerrain` returns: an `OMap` whose relief is the analytic one, so a
 *  caller that wants the landform parameters can still have them. */
export interface GeneratedMap extends OMap {
  readonly relief: AnalyticRelief;
}

export interface TerrainParams {
  readonly size: number;
  readonly landforms: number;
  /** Scattered point features. Clusters are counted separately. */
  readonly points: number;
  readonly lines: number;
  readonly areas: number;
  /**
   * Families of parallel rides cutting the forest into compartments — 0, 1 or 2.
   *
   * Not a difficulty knob. A managed forest *has* a grid, and a map of one without it
   * reads as heath: the rides are the strongest structural signature of the terrain this
   * app is for. The contours drill sets it to 0 along with everything else.
   */
  readonly rides: number;
  /** Rock and boulder fields. Real point features come in patches, not evenly spread. */
  readonly clusters: number;
}

/**
 * The closest two point features can ever be, whatever their kinds. See `separationOf`.
 *
 * The 22 m this used to be was twice what print legibility asks for, and it was the main
 * reason a generated map looked empty beside a surveyed one: a real map puts boulders 10 m
 * apart and dozens of them in a field.
 */
export const MIN_POINT_SEPARATION = 11;   // = DOT_EXTENT * 2 + SYMBOL_GAP, and tested

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
/**
 * Green runs bigger than anything else, and only green.
 *
 * A stand of plantation is a management unit, so on a surveyed map the greens are the
 * largest things after the contours. A clearing is not: 401 open land is a field or a
 * felled block with edges, and giving yellow the same sprawl put a solid wash of it across
 * a whole 110 m card — the same failure as sizing features as a fraction of the map, from
 * the other direction.
 */
const VEGETATION_RADIUS: readonly [number, number] = [14, 34];
const GREEN: readonly AreaKind[] = ['slow', 'walk', 'fight'];
const isGreen = (kind: AreaKind): boolean => GREEN.includes(kind);
const radiusFor = (kind: AreaKind): readonly [number, number] =>
  isGreen(kind) ? VEGETATION_RADIUS : AREA_RADIUS;

/**
 * Drawn size in metres, by kind.
 *
 * A crag is a **line**, not a dot: ISOM 202 draws it at whatever length the rock runs, and
 * one 0.8 mm long at 1:15000 is 12 m of ground. The dots are all one ISOM size and ignore
 * this — it is here so that `separationOf` knows how much room each symbol takes.
 */
const POINT_SIZE: Readonly<Record<PointKind, readonly [number, number]>> = {
  boulder: [3, 6],
  knoll: [3, 6],
  pit: [3, 6],
  tree: [3, 6],
  crag: [9, 22],
};

const sizeFor = (rng: Rng, kind: PointKind): number =>
  rng.range(POINT_SIZE[kind][0], POINT_SIZE[kind][1]);

/** Clear paper between two symbols: 0.35 mm at 1:15000. */
const SYMBOL_GAP = 5;

/**
 * Half the ground a symbol covers, in metres.
 *
 * Asked of the **code**, not of the generator's `kind`, so that it answers for a feature
 * off an imported map as readily as for one this file placed: 203 is drawn as a line
 * across the slope and takes the room its own length asks for, and every other point
 * symbol is a dot.
 *
 * Floored at the dot radius even for a crag, so `MIN_POINT_SEPARATION` is a floor no pair
 * can undercut whatever `size` it was handed. Generation never draws a crag that short,
 * but a constant others reason with should not depend on that.
 */
const DOT_EXTENT = 3;
/** What `separationOf` needs of a feature: which symbol it is, and how big it was drawn. */
interface Drawn {
  readonly code: IsomCode;
  readonly size?: number;
}
const extentOf = (f: Drawn): number =>
  f.code === CODE_OF.crag ? Math.max((f.size ?? 0) / 2, DOT_EXTENT) : DOT_EXTENT;

/**
 * How far apart two point features have to be to still read as two.
 *
 * One constant could not do this. Derived for a boulder — a 0.4 mm dot, so about 10 m
 * between centres — it left a field of crags overlapping into a single black smear,
 * because a crag is a line twice as long as a boulder is wide. The bar is the room the
 * two symbols actually take.
 */
export const separationOf = (a: Drawn, b: Drawn): number =>
  extentOf(a) + extentOf(b) + SYMBOL_GAP;


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
  'slow', 'slow', 'slow', 'slow',
  'walk', 'walk', 'walk',
  'fight',
  'marsh', 'marsh',
  'rough',
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
    points: scale(10, 26),
    lines: scale(1, 3),
    areas: scale(5, 11),
    rides: 2,
    clusters: scale(2, 5),
  };
}

/** Keeps a feature clear of the edge so a crop near the border still has context. */
const MARGIN = 0.12;

/** Fall across the whole map, in metres. See `AnalyticParams.tilt`. */
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

export function readGround(relief: Relief): Ground {
  const grid = relief.sampleGrid(GROUND_RESOLUTION);
  const { n, values } = grid;
  const step = grid.size / n;

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

/** Somewhere inside the margin, asking the ground nothing. */
function anywhere(rng: Rng, size: number): Vec {
  const lo = size * MARGIN;
  const hi = size * (1 - MARGIN);
  return { x: rng.range(lo, hi), y: rng.range(lo, hi) };
}

/**
 * Rejection sampling against a predicate, with the same budget and the same surrender as
 * `placePoints`: a slightly sparser map is harmless, a hung generator is not.
 *
 * **It returns null rather than an unconditioned point.** It used to end with one last
 * draw that ignored the predicate, on the reasoning that a map with no marsh is worse than
 * a marsh on a gentle slope instead of a flat — but an unconditioned draw is not a gentle
 * slope, it is anywhere, and it put a marsh on ground falling at 46% about one map in
 * fifteen hundred. That is the wrongness `AGENTS.md` says an orienteer sees instantly, and
 * it is the same unchecked-last-draw the `siblings` fallback had. A caller that really
 * would rather have a point than nothing says so, in one word, at the call site.
 */
function sampleWhere(
  rng: Rng,
  size: number,
  wanted: (p: Vec) => boolean,
  attempts = ATTEMPT_FACTOR,
): Vec | null {
  const lo = size * MARGIN;
  const hi = size * (1 - MARGIN);
  for (let i = 0; i < attempts; i++) {
    const p = { x: rng.range(lo, hi), y: rng.range(lo, hi) };
    if (wanted(p)) return p;
  }
  return null;
}

/**
 * Where each kind of ground belongs — asked of the semantic table, by code.
 *
 * The rules themselves live in `semantics.ts` as data, so that a marsh imported from a
 * real map and a marsh this file placed answer the same question the same way.
 */
function suitsArea(kind: AreaKind, ground: Ground, p: Vec): boolean {
  return suits(CODE_OF[kind], ground, p);
}

/**
 * The same question for a point feature, asked the weaker way.
 *
 * Generation puts a knoll *on* a sampled local maximum, which is a stronger claim than
 * this. What is wanted here is the claim that survives a feature being moved a few tens
 * of metres: that the ground still agrees with the symbol. A knoll on a hummock that is
 * not quite the summit is a fine knoll; a knoll in a hollow is a contradiction.
 */
function suitsPoint(kind: PointKind, ground: Ground, p: Vec): boolean {
  return suits(CODE_OF[kind], ground, p);
}

/**
 * Areas, with the sinks taken first.
 *
 * Where a traced stream stops inland it has run into a closed hollow, and on a real map
 * that is drawn: the water goes into a marsh. Leaving the sink bare is what makes a
 * stream look like it was cut off rather than like it arrived somewhere.
 */
function placeAreas(
  rng: Rng,
  params: TerrainParams,
  ground: Ground,
  sinks: readonly Vec[],
  /** The ride bearing, which vegetation tends to run with — plantation is planted in blocks. */
  grain: number,
): AreaFeature[] {
  const areas: AreaFeature[] = [];
  const shape = (kind: AreaKind, p: Vec): AreaFeature => {
    const [low, high] = radiusFor(kind);
    return {
      kind,
      code: CODE_OF[kind],
      x: p.x,
      y: p.y,
      rx: rng.range(low, high),
      ry: rng.range(low, high),
      rotation: rng.range(0, Math.PI),
    };
  };

  for (const sink of sinks.slice(0, params.areas)) areas.push(shape('marsh', sink));

  // A kind the ground refuses is **redrawn, not forced**. The flat-and-low ground a marsh
  // needs is genuinely rare on a steeply tilted map — 2% of one, measured — and 160 draws
  // miss it about one map in thirty when it is that rare. Forcing it there is a marsh on a
  // hillside; drawing another kind for the slot keeps the count the requirement asked for
  // and puts nothing anywhere it contradicts. The outer budget is the same one
  // `placePoints` has: a slightly sparser map is harmless, a hung generator is not.
  const budget = params.areas * ATTEMPT_FACTOR;
  for (let attempt = 0; areas.length < params.areas && attempt < budget; attempt++) {
    const kind = rng.pick(AREA_KINDS);
    const head = sampleWhere(rng, params.size, (q) => suitsArea(kind, ground, q), AREA_ATTEMPTS);
    // The kind the ground refused is **redrawn, not forced**, so a head that never came
    // starts no chain either: the outer budget draws another kind for the slot.
    if (!head) continue;
    areas.push(shape(kind, head));

    /**
     * Vegetation sprawls in **chains**, not in single blobs.
     *
     * Green on a surveyed map is one connected, sinuous region running a couple of hundred
     * metres — it follows a wet line or a stand of plantation. Drawn as one lopsided
     * ellipse per patch, however irregular its outline, every green on the map was a
     * separate island of about the same size, which is a texture no forest has.
     *
     * Overlapping lobes need no new type: an `Edit` still moves one of them, and one lobe
     * of a chain sliding out is a change the eye catches as readily as a whole patch.
     */
    if (!isGreen(kind) || areas.length >= params.areas) continue;
    // Vegetation runs with the grain of the plantation, which is the grain of the rides.
    let bearing = grain + rng.range(-0.5, 0.5);
    let previous = head;
    const lobes = 1 + rng.int(4);
    for (let i = 0; i < lobes && areas.length < params.areas; i++) {
      // Just over one radius along: far enough to extend the region, near enough that the
      // outlines still overlap into one shape rather than a row of beads.
      const step = rng.range(VEGETATION_RADIUS[0], VEGETATION_RADIUS[1]) * 1.15;
      // The chain wanders, or a green is a straight sausage.
      bearing += rng.range(-0.45, 0.45);
      const next = {
        x: previous.x + Math.cos(bearing) * step,
        y: previous.y + Math.sin(bearing) * step,
      };
      if (next.x < params.size * MARGIN || next.x > params.size * (1 - MARGIN)) break;
      if (next.y < params.size * MARGIN || next.y > params.size * (1 - MARGIN)) break;
      if (!suitsArea(kind, ground, next)) break;
      areas.push(shape(kind, next));
      previous = next;
    }
  }
  return areas;
}

/**
 * Rock and boulder fields.
 *
 * Point features on a real map are **clustered, not spread**. A rocky slope carries thirty
 * crags in a band and the next hillside carries none; scattering them uniformly with a
 * minimum separation produces the most artificial distribution there is, because it is
 * more even than random — every feature the same distance from every other, over the whole
 * map. That evenness, more than the count, is what read as generated.
 *
 * A field is elongated **along the contour**, because that is how a slope breaks: crags
 * form a band across the fall line, not a smear down it.
 */
const CLUSTER_KINDS: readonly PointKind[] = ['boulder', 'boulder', 'crag', 'crag', 'knoll'];
/** A field of boulders that is not a rock face, and so is not tied to a slope. */
const BOULDER_FIELD_KINDS: readonly PointKind[] = ['boulder', 'boulder', 'boulder', 'knoll', 'pit'];
const CLUSTER_COUNT: readonly [number, number] = [5, 22];
const CLUSTER_LONG: readonly [number, number] = [34, 88];
const CLUSTER_SHORT: readonly [number, number] = [11, 27];

function placeClusters(
  rng: Rng,
  params: TerrainParams,
  ground: Ground,
  placed: PointFeature[],
): void {
  const { size } = params;
  const lo = size * MARGIN;
  const hi = size * (1 - MARGIN);
  const steep = ground.slopeQuantile(CRAG_STEEPEST);

  for (let c = 0; c < params.clusters; c++) {
    // Half the fields are rock on a slope break and half are boulders on whatever ground
    // they were left on. Putting every field on the steepest ground stacked them all on
    // the one ridge and left the rest of the map bare — the map had detail, in one place.
    const onSlope = rng.int(2) === 0;
    const kinds = onSlope ? CLUSTER_KINDS : BOULDER_FIELD_KINDS;
    const centre = onSlope
      ? sampleWhere(rng, size, (q) => slopeAt(ground.grid, q.x, q.y) > steep)
      : anywhere(rng, size);
    // A rock field with no rock face to stand on is **not drawn somewhere else** — the
    // same rule `placeAreas` follows one function along. Steep ground is a quarter of
    // every map, so forty draws miss it about once in a hundred thousand.
    if (!centre) continue;
    const down = downhillAt(ground.grid, centre.x, centre.y);
    const along =
      down.x === 0 && down.y === 0
        ? rng.range(0, Math.PI)
        : Math.atan2(down.y, down.x) + Math.PI / 2;
    const cos = Math.cos(along);
    const sin = Math.sin(along);
    const long = rng.range(CLUSTER_LONG[0], CLUSTER_LONG[1]);
    const short = rng.range(CLUSTER_SHORT[0], CLUSTER_SHORT[1]);
    const wanted = rng.int(CLUSTER_COUNT[1] - CLUSTER_COUNT[0] + 1) + CLUSTER_COUNT[0];

    let made = 0;
    for (let attempt = 0; made < wanted && attempt < wanted * ATTEMPT_FACTOR; attempt++) {
      // Uniform over the ellipse, not over its bounding box: a box leaves the corners
      // populated and the field ends up rectangular.
      const angle = rng.range(0, 2 * Math.PI);
      const radius = Math.sqrt(rng.float());
      const lx = Math.cos(angle) * radius * long;
      const ly = Math.sin(angle) * radius * short;
      const p = {
        x: centre.x + lx * cos - ly * sin,
        y: centre.y + lx * sin + ly * cos,
      };
      if (p.x < lo || p.x > hi || p.y < lo || p.y > hi) continue;
      const kind = rng.pick(kinds);
      // A field of knolls has to sit on knolls like any other, so the same check applies.
      if (!suitsPoint(kind, ground, p)) continue;
      const feature = { kind, code: CODE_OF[kind], x: p.x, y: p.y, size: sizeFor(rng, kind) };
      if (placed.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < separationOf(q, feature))) continue;
      placed.push(feature);
      made++;
    }
  }
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
  // Fields first: they are the shape of the ground, and the scatter fills in around them
  // rather than the other way round.
  placeClusters(rng, params, ground, placed);
  const lo = params.size * MARGIN;
  const hi = params.size * (1 - MARGIN);
  const inside = (p: Vec) => p.x >= lo && p.x <= hi && p.y >= lo && p.y <= hi;
  const clear = (f: PointFeature) =>
    !placed.some((q) => Math.hypot(q.x - f.x, q.y - f.y) < separationOf(q, f));

  // Rejection sampling with a budget. A hard loop could not terminate at high counts in a
  // small area; giving up quietly leaves a slightly sparser map, which is harmless, and
  // the separation invariant still holds for everything that was placed.
  const target = placed.length + count;
  for (let attempts = 0; placed.length < target && attempts < count * ATTEMPT_FACTOR; attempts++) {
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
    } else if (kind === 'crag') {
      const steep = ground.slopeQuantile(CRAG_STEEPEST);
      // `anywhere` when the steep ground is not found: the `suitsPoint` check below is
      // what makes this safe, and it is why this fallback is not the one `sampleWhere`
      // stopped taking on its own.
      p = sampleWhere(rng, params.size, (q) => slopeAt(ground.grid, q.x, q.y) > steep)
        ?? anywhere(rng, params.size);
    } else {
      p = anywhere(rng, params.size);
    }
    const feature = { kind, code: CODE_OF[kind], x: p.x, y: p.y, size: sizeFor(rng, kind) };
    if (!clear(feature)) continue;
    // Checked, not assumed. A grid maximum at 4.7 m spacing is not always a rise at the
    // 10 m the eye reads, and the nudge above can push a knoll off its own summit onto
    // the slope beside it. Asking the predicate is what makes the invariant hold rather
    // than hold usually.
    if (!suitsPoint(kind, ground, p)) continue;
    placed.push(feature);
  }
  return placed;
}

// ---------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------

/**
 * Where a straight line through `origin` in direction `d` leaves the square, or null if
 * it misses. Liang-Barsky over the four edges.
 */
function clipToSquare(origin: Vec, d: Vec, size: number): readonly [Vec, Vec] | null {
  let near = -Infinity;
  let far = Infinity;
  const slab = (position: number, direction: number): boolean => {
    if (Math.abs(direction) < 1e-9) return position >= 0 && position <= size;
    const a = (0 - position) / direction;
    const b = (size - position) / direction;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    return true;
  };
  if (!slab(origin.x, d.x) || !slab(origin.y, d.y)) return null;
  if (near >= far) return null;

  // Snapped, not just clamped. A ride ends *on* the border, and the invariant that says so
  // is an equality: `origin + d * t` lands a few ulps either side of it, which reads as a
  // line stopping just short of the edge or running just past it.
  const snap = (v: number) => (Math.abs(v) < 1e-6 ? 0 : Math.abs(v - size) < 1e-6 ? size : v);
  const at = (t: number): Vec => ({
    x: snap(Math.min(size, Math.max(0, origin.x + d.x * t))),
    y: snap(Math.min(size, Math.max(0, origin.y + d.y * t))),
  });
  return [at(near), at(far)];
}

/**
 * The compartment grid: families of dead-straight parallel rides.
 *
 * A managed forest is *divided*, and the division is the first thing you see on a map of
 * one — long straight rides at a fixed bearing, a hundred-odd metres apart, cutting the
 * ground into blocks. Everything else on the map sits inside those blocks. Without them
 * the drills were drawing open heath with a few wandering tracks on it.
 *
 * Rides are straight because they were cut, not walked. `tracePath` is for the paths that
 * were walked, and those bend.
 */
const RIDE_SPACING: readonly [number, number] = [80, 170];

function placeRides(rng: Rng, params: TerrainParams): LineFeature[] {
  const { size } = params;
  const lines: LineFeature[] = [];
  // The second family is roughly square to the first, which is how a forest is laid out,
  // with enough slack that the blocks are not graph paper.
  const first = rng.range(0, Math.PI);

  for (let family = 0; family < params.rides; family++) {
    const bearing = family === 0 ? first : first + Math.PI / 2 + rng.range(-0.25, 0.25);
    const d = { x: Math.cos(bearing), y: Math.sin(bearing) };
    const normal = { x: -d.y, y: d.x };
    const spacing = rng.range(RIDE_SPACING[0], RIDE_SPACING[1]);
    // The square's corners span this much along the normal, so stepping across that range
    // covers the map whatever the bearing.
    const reach = size * (Math.abs(normal.x) + Math.abs(normal.y)) / 2;
    const phase = rng.range(0, spacing);

    for (let offset = -reach + phase; offset <= reach; offset += spacing) {
      const origin = {
        x: size / 2 + normal.x * offset,
        y: size / 2 + normal.y * offset,
      };
      const ends = clipToSquare(origin, d, size);
      if (!ends) continue;
      lines.push({ kind: 'ride', code: CODE_OF.ride, points: [ends[0], ends[1]] });
    }
  }
  return lines;
}

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
  if (kind === 'ride') return { kind, code: CODE_OF[kind], points: [start, end] };

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
  return { kind, code: CODE_OF[kind], points };
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
  if (params.lines <= 0 && params.rides <= 0) return { lines, sinks };

  lines.push(...placeRides(rng, params));
  const rideCount = lines.length;
  if (params.lines <= 0) return { lines, sinks };

  // Water starts where it gathers: high ground, but not the very top of it.
  const high = ground.quantile(0.6);
  const low = ground.quantile(0.92);
  let stream: Vec[] | null = null;
  for (let attempt = 0; attempt < 12 && !stream; attempt++) {
    // A start the band did not contain is still a legal start: `traceStream` rejects a
    // watercourse that comes out too short, and twelve attempts is the budget for that.
    const from = sampleWhere(rng, size, (p) => {
      const h = sampleGridAt(ground.grid, p.x, p.y);
      return h > high && h < low;
    }) ?? anywhere(rng, size);
    stream = traceStream(ground, from, size);
  }
  if (stream) {
    lines.push({ kind: 'stream', code: CODE_OF.stream, points: stream });
    const end = stream[stream.length - 1]!;
    const onEdge = end.x <= 0 || end.y <= 0 || end.x >= size || end.y >= size;
    if (!onEdge) sinks.push(end);
  }

  // `params.lines` counts the lines that were *walked or built*, on top of the grid.
  const [start, end] = crossing(rng, size);
  lines.push({ kind: 'path', code: CODE_OF.path, points: tracePath(ground, start, end, size) });

  while (lines.length < rideCount + params.lines) {
    const [from, to] = crossing(rng, size);
    lines.push(
      rng.int(3) === 0
        ? makeStraightOrWandering(rng, params, 'fence')
        : { kind: 'path', code: CODE_OF.path, points: tracePath(ground, from, to, size) },
    );
  }

  return { lines, sinks };
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
export function generateTerrain(rng: Rng, params: TerrainParams): GeneratedMap {
  const tiltAngle = rng.range(0, 2 * Math.PI);
  const gradient = rng.range(TILT_DROP[0], TILT_DROP[1]) / params.size;
  const tilt: Vec = { x: Math.cos(tiltAngle) * gradient, y: Math.sin(tiltAngle) * gradient };
  // The low bit is set because seed 0 is the documented "no micro-relief" case in
  // `noise.ts`, and a map that silently came out smooth would be a puzzling one-in-four-
  // billion bug report.
  const noiseSeed = rng.next() | 1;

  const landforms = placeLandforms(rng, params, tiltAngle);
  const relief = new AnalyticRelief({ size: params.size, tilt, noiseSeed, landforms });
  const ground = readGround(relief);

  // Water before ground cover: a marsh is put where the stream ends, so the two agree.
  const drainage = placeLines(rng, params, ground);
  const grain = drainage.lines.length > 0
    ? Math.atan2(
        drainage.lines[0]!.points[1]!.y - drainage.lines[0]!.points[0]!.y,
        drainage.lines[0]!.points[1]!.x - drainage.lines[0]!.points[0]!.x,
      )
    : rng.range(0, Math.PI);
  const areas = placeAreas(rng, params, ground, drainage.sinks, grain);
  const points = placePoints(rng, params, params.points, ground);

  const map: GeneratedMap = {
    id: 'generated',
    width: params.size,
    height: params.size,
    scale: ISOM_SCALE,
    relief,
    features: toFeatures(drainage.lines, areas, points),
  };
  // Analysed by the same function an imported map is, so that a warp and a pexeso control
  // are chosen the same way whatever drew the ground — see `analysis.ts` and `edits.ts`.
  return { ...map, analysis: analyse(map, { landforms: candidatesOf(landforms) }) };
}

/**
 * The generator's landforms, as the analysis's candidates.
 *
 * `analyse` reads candidates off the **curvature** of the ground, because a surveyed
 * hillside has to be asked where its landforms are. This map does not: it was built from a
 * list of them, and asking curvature to find them again answers worse in two ways. It
 * finds the micro-relief — a metre of noise at a sixty-metre wavelength bends the surface
 * harder than a twelve-metre hill two hundred metres across, so the candidates come out at
 * four metres of amplitude where the landforms are at twelve. And it disagrees with
 * `AnalyticRelief.warped`, which moves **the landform nearest the warp's centre, whole**:
 * a warp centred on a curvature peak between two knolls declares one support and moves
 * another, so `Warp.carries` picks up features that are not standing on the ground that
 * moved. That is the very tell carrying exists to remove.
 *
 * The radius is the half-extent along the long axis, which is what `warpCandidates` read
 * off the relief before this existed — a circle around an ellipse, and the same circle.
 */
function candidatesOf(landforms: readonly Landform[]): MapAnalysis['landforms'] {
  return landforms.map((f) => ({
    centre: { x: f.x, y: f.y },
    radius: f.radius * f.elongation,
    amplitude: f.amplitude,
  }));
}

/**
 * The three builders, become the one list.
 *
 * An area keeps its parameters in `shape` beside the outline traced from them, because
 * `areaOutline` seeds its wander from those parameters and from nothing else: an area
 * that is moved has to come out the same shape, or a map-memory distractor differs by
 * more than the level asked for. Ids are positional and stable within the map; an edit
 * names one.
 */
function toFeatures(
  lines: readonly LineFeature[],
  areas: readonly AreaFeature[],
  points: readonly PointFeature[],
): Feature[] {
  return [
    ...lines.map((l, i): Feature => ({
      id: `line-${i}`,
      code: l.code,
      kind: l.kind,
      geometry: { kind: 'polyline', points: l.points },
    })),
    ...areas.map((a, i): Feature => {
      const shape = { kind: a.kind, x: a.x, y: a.y, rx: a.rx, ry: a.ry, rotation: a.rotation };
      return {
        id: `area-${i}`,
        code: a.code,
        kind: a.kind,
        geometry: { kind: 'polygon', rings: [areaOutline(shape)] },
        shape,
      };
    }),
    ...points.map((f, i): Feature => ({
      id: `point-${i}`,
      code: f.code,
      kind: f.kind,
      geometry: { kind: 'point', at: { x: f.x, y: f.y } },
      size: f.size,
    })),
  ];
}
