import type { Rng } from '@/lib/rng.ts';

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
export type AreaKind = 'marsh' | 'open' | 'thicket' | 'rock';

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
const AREA_RADIUS: readonly [number, number] = [10, 26];
const POINT_SIZE: readonly [number, number] = [3, 7];

const LANDFORM_KINDS: readonly LandformKind[] = ['hill', 'depression', 'spur', 'reentrant'];
const POINT_KINDS: readonly PointKind[] = ['boulder', 'knoll', 'pit', 'tree', 'crag'];
const LINE_KINDS: readonly LineKind[] = ['path', 'stream', 'fence', 'ride'];
/**
 * Weighted by repetition rather than picked uniformly.
 *
 * On an ISOM map the ground is *white* — runnable forest — and everything else is the
 * exception. Drawing the four kinds uniformly filled a 110 m pexeso card edge to edge and
 * lost the white entirely, which is both wrong cartography and a harder card to read.
 * Bare rock is the rarest thing here for the same reason it is rare underfoot.
 */
const AREA_KINDS: readonly AreaKind[] = [
  'thicket', 'thicket', 'thicket',
  'marsh', 'marsh',
  'open', 'open',
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

function placePoints(rng: Rng, params: TerrainParams, count: number): PointFeature[] {
  const placed: PointFeature[] = [];
  const lo = params.size * MARGIN;
  const hi = params.size * (1 - MARGIN);

  // Rejection sampling with a budget. A hard loop could not terminate at high counts in a
  // small area; giving up quietly leaves a slightly sparser map, which is harmless, and
  // the separation invariant still holds for everything that was placed.
  for (let attempts = 0; placed.length < count && attempts < count * 40; attempts++) {
    const x = rng.range(lo, hi);
    const y = rng.range(lo, hi);
    if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < MIN_POINT_SEPARATION)) continue;
    placed.push({ kind: rng.pick(POINT_KINDS), x, y, size: rng.range(POINT_SIZE[0], POINT_SIZE[1]) });
  }
  return placed;
}

function makeLine(rng: Rng, params: TerrainParams): LineFeature {
  // A line crosses the map rather than sitting in the middle of it: a path that stops
  // nowhere is the one thing that never appears on a real map.
  const edge = rng.int(4);
  const along = () => rng.range(params.size * 0.15, params.size * 0.85);
  const start: Vec =
    edge === 0 ? { x: along(), y: 0 }
    : edge === 1 ? { x: params.size, y: along() }
    : edge === 2 ? { x: along(), y: params.size }
    : { x: 0, y: along() };
  const end: Vec =
    edge === 0 ? { x: along(), y: params.size }
    : edge === 1 ? { x: 0, y: along() }
    : edge === 2 ? { x: along(), y: 0 }
    : { x: params.size, y: along() };

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
  return { kind: rng.pick(LINE_KINDS), points };
}

export function generateTerrain(rng: Rng, params: TerrainParams): Terrain {
  const lo = params.size * MARGIN;
  const hi = params.size * (1 - MARGIN);

  const landforms: Landform[] = Array.from({ length: params.landforms }, () => {
    const kind = rng.pick(LANDFORM_KINDS);
    const elongated = kind === 'spur' || kind === 'reentrant';
    const down = kind === 'depression' || kind === 'reentrant';
    return {
      kind,
      x: rng.range(lo, hi),
      y: rng.range(lo, hi),
      radius: rng.range(LANDFORM_RADIUS[0], LANDFORM_RADIUS[1]),
      amplitude: (down ? -1 : 1) * rng.range(6, 20),
      rotation: rng.range(0, Math.PI),
      elongation: elongated ? rng.range(2, 3.4) : 1,
    };
  });

  const areas: AreaFeature[] = Array.from({ length: params.areas }, () => ({
    kind: rng.pick(AREA_KINDS),
    x: rng.range(lo, hi),
    y: rng.range(lo, hi),
    rx: rng.range(AREA_RADIUS[0], AREA_RADIUS[1]),
    ry: rng.range(AREA_RADIUS[0], AREA_RADIUS[1]),
    rotation: rng.range(0, Math.PI),
  }));

  return {
    size: params.size,
    landforms,
    areas,
    lines: Array.from({ length: params.lines }, () => makeLine(rng, params)),
    points: placePoints(rng, params, params.points),
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
