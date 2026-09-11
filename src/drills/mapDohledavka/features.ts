import { drawnExtent, type Box } from '@/lib/terrain/analysis.ts';
import { sampleGridAt, type Grid } from '@/lib/terrain/height.ts';
import { POINT, styleFor } from '@/lib/terrain/isom.ts';
import {
  areasOf, boundsOf, linesOf, pointsOf, positionOf,
  type Crop, type Feature, type MapAnalysis, type OMap, type Vec,
} from '@/lib/terrain/omap.ts';
import type { LandformKind } from '@/lib/terrain/relief.ts';
import { semanticsOf, type Family, type IsomCode } from '@/lib/terrain/semantics.ts';

/**
 * What a control circle can be hung on, and where.
 *
 * A course is drawn over a map: the circle says "the feature at my centre", and a
 * description sheet says which feature. This drill takes the description sheet away and
 * asks the question the other way round — *which kind of thing* is circled on both cards —
 * so the vocabulary of kinds is the drill's answer space, and it has to be one a control
 * could really sit in.
 *
 * ## The list is the semantic table's, not this file's
 *
 * Which symbols a control may stand on is `Semantics.controlSite`, and it is the IOF
 * control descriptions rather than the sixteen things the generator draws. This file
 * answers the two questions the table deliberately does not:
 *
 *  - **What word** a description sheet would use — `WORDS` below, keyed by ISOM code like
 *    everything else that has to hold for an imported feature as well as a generated one.
 *    Several codes share a word on purpose: three densities of green are one *thicket*,
 *    and a footpath, a small path and a ride are one *path*, because they are one thing
 *    to a player squinting through a 3 mm circle. That is also what makes the uniqueness
 *    rule below safe — a look-alike can no longer be a second answer, because it is not a
 *    second word.
 *  - **Which part** of the symbol the circle goes on — `candidatesOf`. A point is the
 *    whole of itself; a line offers its bends, junctions, crossings and ends; an area
 *    offers its outline. Never the middle of a meadow: an area's interior marks nothing,
 *    which is why the wash of green under half the control circles on a real map is not an
 *    answer *and* not in the way.
 */
export type ControlKind =
  // Relief, as the ground shows it. `LandformKind` is hill, depression, spur, re-entrant.
  | LandformKind
  // Landforms drawn as symbols. Brown.
  | 'earthBank' | 'gully' | 'knoll' | 'pit' | 'brokenGround'
  // Rock. Black, and grey where it is ground rather than a thing.
  | 'cliff' | 'cave' | 'boulder' | 'boulderField'
  | 'stonyGround' | 'sandyGround' | 'rock' | 'trench'
  // Water. Blue.
  | 'pond' | 'waterhole' | 'stream' | 'ditch' | 'marsh' | 'well' | 'spring' | 'trough'
  // Vegetation. Green and yellow.
  | 'open' | 'thicket' | 'cultivated' | 'vegetationBoundary' | 'tree'
  // Made by people.
  | 'paved' | 'road' | 'path' | 'railway' | 'powerLine' | 'bridge' | 'wall' | 'fence'
  | 'crossingPoint' | 'building' | 'canopy' | 'ruin' | 'tower' | 'cairn' | 'fodderRack'
  | 'stairway'
  // The family words. A `controlSite` code `WORDS` does not name still has a name.
  | 'landform' | 'rockFeature' | 'waterFeature' | 'vegetationFeature' | 'manmade';

/**
 * The word a control description sheet would use, by ISOM 2017-2 code.
 *
 * Not one word per symbol: one word per *thing a player can tell apart through a circle*.
 * Where the standard splits a symbol into a runnability scale — the greens, the three
 * densities of stony ground, the ladder from a wide road down to a ride — the split is
 * about how fast you can run, not about what is there, and asking a player to read it off
 * a card is a colour-matching game rather than an orienteering one. So they share a word,
 * and sharing a word is exactly what stops them being two answers to one round: the
 * uniqueness rule below is by word.
 *
 * Merged for the same reason and worth naming, because each was once a bug waiting:
 * a **ride** and a **footpath** are both thin black lines (they used to be in `BLOCKING`
 * for it); **104–106** earth bank, earth wall and its ruin are drawn with one brown
 * stroke here; **201** and **202** are both cliffs and a description sheet calls both a
 * cliff; **415** and **416** are both a boundary between two kinds of ground.
 *
 * A code the table does not name falls to its family's word — see `wordFor`.
 */
const WORDS: Readonly<Record<IsomCode, ControlKind>> = {
  // Landform. 104 earth bank, 105 earth wall, 106 ruined earth wall; 107/108 the two
  // erosion gullies; 109/110 knoll and elongated knoll; 111 small depression; 112 pit;
  // 113/113.1/114 broken and very broken ground. 115 is the family word.
  '104': 'earthBank', '105': 'earthBank', '106': 'earthBank',
  '107': 'gully', '108': 'gully',
  '109': 'knoll', '110': 'knoll',
  '111': 'depression',
  '112': 'pit',
  '113': 'brokenGround', '113.1': 'brokenGround', '114': 'brokenGround',

  // Rock. 201 impassable cliff and 202 cliff; 203 rocky pit or cave; 204–206 boulders up
  // to the gigantic one that is drawn as an area; 207–209 clusters and fields; 210–212
  // stony ground; 213 sandy ground; 214 bare rock; 215 trench.
  '201': 'cliff', '202': 'cliff',
  '203': 'cave', '203.1': 'cave', '203.2': 'cave',
  '204': 'boulder', '205': 'boulder', '206': 'boulder',
  '207': 'boulderField', '208': 'boulderField', '208.1': 'boulderField', '209': 'boulderField',
  '210': 'stonyGround', '210.1': 'stonyGround', '211': 'stonyGround', '212': 'stonyGround',
  '213': 'sandyGround',
  '214': 'rock',
  '215': 'trench',

  // Water. 301/302 bodies of it; 303 water hole; 304/305 watercourses; 306 the minor or
  // seasonal channel a description calls a ditch; 307–310 the marshes; 311 well;
  // 312 spring; 313 water tank or trough.
  '301': 'pond', '302': 'pond',
  '303': 'waterhole',
  '304': 'stream', '305': 'stream',
  '306': 'ditch',
  '307': 'marsh', '308': 'marsh', '309': 'marsh', '310': 'marsh',
  '311': 'well', '312': 'spring', '313': 'trough',

  // Vegetation. 401–404 open and rough open, with or without scattered trees — one word,
  // because a light yellow and a lighter yellow through a circle is the question this
  // drill has always refused to ask. 406–411 and the sprint hedge are one *thicket*, and
  // they are answers **as edges**: an area's interior is never a site. 412–414 the
  // cultivated ones; 415/416 the two boundary lines; 417/418 trees; 419 the family word.
  '401': 'open', '402': 'open', '403': 'open', '404': 'open',
  '406': 'thicket', '407': 'thicket', '408': 'thicket', '409': 'thicket',
  '410': 'thicket', '410.4': 'thicket', '411': 'thicket',
  '412': 'cultivated', '413': 'cultivated', '414': 'cultivated',
  '415': 'vegetationBoundary', '416': 'vegetationBoundary',
  // 417 large tree, 418 bush, 419 prominent vegetation feature: one word because `isom.ts`
  // draws all three as a green ring and the last two differ only in radius. A word per
  // symbol here would be a pair of cards a player is asked to match on a millimetre.
  '417': 'tree', '418': 'tree', '419': 'tree',

  // Made by people. 502–504 the roads and the vehicle track; 505–508 the footpaths and
  // the ride; 513–515 the walls; 516–518 the fences. 528–531, the standard's prominent
  // and special man-made features, are the family word — which is what a description
  // sheet does with them too.
  '501': 'paved', '501.3': 'paved',
  '502': 'road', '503': 'road', '504': 'road',
  '505': 'path', '506': 'path', '507': 'path', '508': 'path',
  '509': 'railway',
  '510': 'powerLine', '511': 'powerLine',
  '512': 'bridge', '512.2': 'bridge',
  '513': 'wall', '513.2': 'wall', '514': 'wall', '515': 'wall',
  '516': 'fence', '517': 'fence', '518': 'fence',
  '519': 'crossingPoint',
  '521': 'building',
  '522': 'canopy',
  '523': 'ruin',
  '524': 'tower', '525': 'tower',
  '526': 'cairn',
  '527': 'fodderRack',
  '532': 'stairway',
};

/**
 * What a symbol is called when it is a control site and `WORDS` does not name it.
 *
 * A real map arrives with about 190 symbols and the table above names a hundred; the
 * standard's own answer for the rest is its "prominent" and "special" features, which a
 * description sheet names by family and a competitor finds by looking. So does this: the
 * player sees a black thing among the buildings, or a blue thing among the water, and
 * *that* is the word both cards have to agree on.
 *
 * Overprint has no `controlSite` row — a course printed over a map is not ground — so its
 * entry is never reached and is here for the type's sake.
 */
const FAMILY_WORDS: Readonly<Record<Family, ControlKind>> = {
  landform: 'landform',
  rock: 'rockFeature',
  water: 'waterFeature',
  vegetation: 'vegetationFeature',
  manmade: 'manmade',
  overprint: 'manmade',
};

/** The word for a code, or undefined if a control could not stand on it. */
export function wordFor(code: IsomCode): ControlKind | undefined {
  const semantics = semanticsOf(code);
  if (!semantics?.controlSite) return undefined;
  return WORDS[code] ?? FAMILY_WORDS[semantics.family];
}

/**
 * The words that say **what the ground is made of**, rather than naming a thing on it.
 *
 * A wash of green, of yellow, of stony grey: the runnability scale, which is a fact about
 * the ground under everything else rather than an object standing on it. This file always
 * said so of the greens — "a green under a circle reads as ground rather than as the thing
 * circled, which is just as well, since half the control circles on a real map have some"
 * — and the only change is that it is now said of all of them, and of their edges as well
 * as their middles.
 *
 * It buys the whole widening. Measured on the forest sample at level 5 before this rule
 * existed, the commonest reasons a candidate was not a site were `thicket <- open, path,
 * vegetationBoundary` and `path <- thicket`: on a surveyed map every circle has a
 * vegetation edge through it, so a flat ring rule let the ground cover shadow nearly every
 * drawn object and the cards came out **thinner** than before the vocabulary grew. It is
 * also what a description sheet does — a boulder in a clearing is described as a boulder,
 * never as a clearing — so the rule is: **ground cover shadows nothing but ground cover.**
 * A boulder, a path bend or a hilltop with a forest edge across the ring is still that
 * thing; a thicket corner with a boulder in the ring is the boulder, because the object is
 * the more particular of the two and shadows the cover in the other direction.
 *
 * Asked of the word *and* the geometry, with one exception: **415 and 416 are cover
 * whatever they are drawn as**, because a distinct vegetation boundary is the edge of a
 * cover area drawn a second time. The surveyor draws the green and then draws the line
 * along it; treating the line as an object and the area's own outline as cover would make
 * one edge shadow as two different things. Measured on the forest sample — 55 of its 538
 * features are one of these two lines — this was the single commonest reason a path bend
 * or a landform was not a site.
 */
const GROUND_COVER: ReadonlySet<ControlKind> = new Set<ControlKind>([
  'open', 'thicket', 'cultivated', 'brokenGround', 'boulderField',
  'stonyGround', 'sandyGround', 'rock', 'marsh', 'paved', 'vegetationBoundary',
]);

/** Whether this feature is the ground's own cover rather than a thing standing on it. */
const isCover = (feature: Feature, word: ControlKind | undefined): boolean =>
  word !== undefined &&
  GROUND_COVER.has(word) &&
  (feature.geometry.kind === 'polygon' || word === 'vegetationBoundary');

/**
 * Drawn like an answer, but never one.
 *
 * One code is left, and merging words took the rest: 520 is out of bounds, an olive wash
 * that classifies out of the ink as green and reads through a circle as vegetation. It
 * cannot be an answer — a rule printed over a map is not a thing on the ground — so it
 * blocks instead, at its **edge**, exactly as a green area does.
 *
 * The ride and rough open used to be here. They are answers now, under the words *path*
 * and *open land*, which is the same protection by better means: a thing that shares a
 * word with what it looks like cannot be a second answer to one round.
 */
const BLOCKING: readonly IsomCode[] = ['520'];

/** What the circle is on, in the words a control description would use. */
export const CONTROL_NAMES: Readonly<Record<ControlKind, string>> = {
  hill: 'hilltop',
  depression: 'depression',
  spur: 'spur',
  reentrant: 're-entrant',
  earthBank: 'earth bank',
  gully: 'gully',
  knoll: 'knoll',
  pit: 'pit',
  brokenGround: 'broken ground',
  cliff: 'cliff',
  cave: 'cave',
  boulder: 'boulder',
  boulderField: 'boulder field',
  stonyGround: 'stony ground',
  sandyGround: 'sandy ground',
  rock: 'bare rock',
  trench: 'trench',
  pond: 'pond',
  waterhole: 'water hole',
  stream: 'stream',
  ditch: 'ditch',
  marsh: 'marsh',
  well: 'well',
  spring: 'spring',
  trough: 'water trough',
  open: 'open land',
  thicket: 'thicket',
  cultivated: 'cultivated land',
  vegetationBoundary: 'vegetation boundary',
  tree: 'distinctive tree',
  paved: 'paved area',
  road: 'road',
  path: 'path',
  railway: 'railway',
  powerLine: 'power line',
  bridge: 'bridge',
  wall: 'wall',
  fence: 'fence',
  crossingPoint: 'crossing point',
  building: 'building',
  canopy: 'canopy',
  ruin: 'ruin',
  tower: 'tower',
  cairn: 'cairn',
  fodderRack: 'fodder rack',
  stairway: 'stairway',
  landform: 'landform feature',
  rockFeature: 'rock feature',
  waterFeature: 'water feature',
  vegetationFeature: 'vegetation feature',
  manmade: 'man-made feature',
};

/**
 * Which part of the object the circle is on.
 *
 * Not read while a round is played — the answer is the word — but it is what the
 * measurements in the design note count, and what a drill asking *what changed* between
 * two versions of a window would name the change by.
 */
export type SiteClass =
  /** The feature is the whole of itself. */
  | 'point'
  /** A form of the ground, from `analysis.landforms`. */
  | 'landform'
  /** On a line: a turn, a fork, a crossing with another line, a loose end. */
  | 'bend' | 'junction' | 'crossing' | 'end'
  /** On an area's outline: a corner of it, or the middle of one short side. */
  | 'corner' | 'side';

/**
 * Something on the map with a name, and the shape a ring is measured against.
 *
 * `shape` and `reach` are the object *itself* — the line, the outline, or one point
 * widened by what is drawn at it — and that is what the uniqueness rule measures. An
 * area's shape is its **outline** and not a disc over its middle, which is the whole of
 * "an area interior does not shadow": a ring in the middle of a meadow is not near
 * anything of the meadow's, because the nearest thing the meadow has is its edge.
 *
 * The look-alikes are nameable without being answerable, and carry no word.
 */
interface Named {
  readonly shape: readonly Vec[];
  readonly reach: number;
  /** The feature it came from. Two of these off one feature never shadow each other. */
  readonly source: string;
  /** The word a description would use, or null for a look-alike that has none. */
  readonly word: ControlKind | null;
  /** `Semantics.reliefBound`: a form of the ground rather than a thing standing on it. */
  readonly reliefBound: boolean;
  /** A piece of ground off `analysis.landforms`, rather than a symbol someone drew. */
  readonly form: boolean;
  /** An area of `GROUND_COVER`: what the ground is made of, not a thing standing on it. */
  readonly cover: boolean;
  /** The shape's bounds, so the ring test can reject most pairs without walking it. */
  readonly box: Box;
}

/** A place a control could go, and the object it would then be marking. */
export interface Site {
  readonly at: Vec;
  readonly kind: ControlKind;
  readonly where: SiteClass;
  /** The object itself: the point, the line, or the ring of the outline. */
  readonly shape: readonly Vec[];
  readonly reach: number;
  readonly source: string;
}

const distanceToSegment = (p: Vec, a: Vec, b: Vec): number => {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lengthSquared = vx * vx + vy * vy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((p.x - a.x) * vx + (p.y - a.y) * vy) / lengthSquared));
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
};

/** How far `p` is from the object itself, which is zero anywhere on it. */
export function clearanceFrom(
  object: { readonly shape: readonly Vec[]; readonly reach: number },
  p: Vec,
): number {
  const { shape } = object;
  let nearest = Math.hypot(p.x - shape[0]!.x, p.y - shape[0]!.y);
  for (let i = 1; i < shape.length; i++) {
    nearest = Math.min(nearest, distanceToSegment(p, shape[i - 1]!, shape[i]!));
  }
  return Math.max(0, nearest - object.reach);
}

const boxOf = (shape: readonly Vec[], reach: number): Box => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of shape) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX: minX - reach, minY: minY - reach, maxX: maxX + reach, maxY: maxY + reach };
};

/** The interval `MapView` draws at. Relief under one line draws nothing at all. */
const CONTOUR_INTERVAL = 5;

/** Samples per side for the height questions below. `readGround` uses the same. */
const GRID = 64;

/** How far a summit may be hunted from the landform's own centre, against its radius. */
const CLIMB_LIMIT = 0.8;

/**
 * A landform, as the map's own analysis states it.
 *
 * Read from `analysis.landforms` and never off the relief, for the reason `AGENTS.md`
 * gives: every map answers where its landforms are the same way, and a generated map's
 * candidates *are* the landforms it was built from. A candidate that does not say which
 * form it is has no name a control description could use, so it is not a site.
 */
type Form = MapAnalysis['landforms'][number];

/** Round unless the source said otherwise. A curvature candidate has no axis. */
const elongationOf = (f: Form): number => f.elongation ?? 1;

/**
 * The top of a rise, rather than the middle of the bump that mostly makes it.
 *
 * Landforms are summed, so a hill on the flank of the ridge has its real summit uphill of
 * its own centre — sometimes by more than the circle's radius. Centred on the feature list
 * rather than on the ground, the circle would sit beside the top, and the card would be
 * asking about a hilltop while pointing at a hillside.
 */
function summitOf(grid: Grid, f: Form): Vec {
  const sign = f.amplitude >= 0 ? 1 : -1;
  const step = grid.size / grid.n;
  let best: Vec = f.centre;
  let bestHeight = sign * sampleGridAt(grid, best.x, best.y);

  for (let i = 0; i < 12; i++) {
    let moved = false;
    for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]] as const) {
      const q = { x: best.x + dx, y: best.y + dy };
      if (Math.hypot(q.x - f.centre.x, q.y - f.centre.y) > f.radius * CLIMB_LIMIT) continue;
      const height = sign * sampleGridAt(grid, q.x, q.y);
      if (height > bestHeight) {
        bestHeight = height;
        best = q;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return best;
}

/**
 * Whether a landform draws something a player could name — asked of the height field that
 * gets contoured, not of the bump's own amplitude.
 *
 * A landform is one term in a sum. An 8 m hill on ground already falling 10 m over the
 * same distance has no summit, closes no contour and reads as a slope. The test is
 * therefore the one the contours will answer: the ground at the feature stands a full
 * interval above — or below — the ground its own radius away, tilt, neighbours and
 * micro-relief included.
 *
 * A spur is measured **across** itself only. Along its length it runs back into the
 * hillside it came from, and asking for a drop there would be asking it to be a hill.
 */
function standsOut(grid: Grid, f: Form, at: Vec): boolean {
  const sign = f.amplitude >= 0 ? 1 : -1;
  const here = sampleGridAt(grid, at.x, at.y);
  const across = (f.rotation ?? 0) + Math.PI / 2;
  const directions =
    elongationOf(f) > 1.2 ? [across, across + Math.PI] : [0, Math.PI / 2, Math.PI, -Math.PI / 2];

  return directions.every((angle) => {
    const q = { x: at.x + Math.cos(angle) * f.radius, y: at.y + Math.sin(angle) * f.radius };
    return sign * (here - sampleGridAt(grid, q.x, q.y)) >= CONTOUR_INTERVAL;
  });
}

/**
 * How far along its own axis a long form offers a circle, against its length.
 *
 * A hill is read at its top and a hollow at its bottom, so each of those is one place. A
 * spur or a re-entrant is not: it is a hundred metres of ground read along its length, and
 * a description sheet says spur about any of it. Offering only the middle made a whole
 * form's worth of ground depend on whether one road happened to pass within a ring of one
 * point — on the forest sample at level 10 that took every one of its nine usable forms
 * away, which is a fact about one road and not about the ground.
 */
const ALONG_FORM = 0.4;

/** The places on one form a circle could go. */
function alongForm(grid: Grid, f: Form): Vec[] {
  if (elongationOf(f) <= 1.2) return [summitOf(grid, f)];
  const angle = f.rotation ?? 0;
  const step = f.radius * ALONG_FORM;
  return [0, -1, 1].map((k) => ({
    x: f.centre.x + Math.cos(angle) * step * k,
    y: f.centre.y + Math.sin(angle) * step * k,
  }));
}

/** Radians of turn that make a vertex a bend rather than a wobble. */
const MIN_BEND = 0.2;
/** Two sites on one object closer than this are one place, offered twice. */
const MIN_BEND_SPACING = 45;

/** How near an end has to come to another line to be a junction with it. */
const JUNCTION_TOLERANCE = 8;

/**
 * A corner of an outline is measured over a **length of it**, not from vertex to vertex.
 *
 * `MIN_BEND` is a turn between two segments, which is the right question for a path traced
 * in twenty-metre steps and the wrong one for an outline: a generated area is drawn as
 * twenty-eight points round an ellipse, so every vertex turns by a fourteenth of a full
 * circle and *every* vertex would be a corner of a perfectly smooth curve. Measured over
 * twenty metres of outline instead, a corner is a corner at any sampling — and a building
 * whose sides are shorter than that still answers, because the chords across two of its
 * right angles are at right angles too.
 */
const CORNER_ARC = 20;
/** And a corner turns properly, where a bend in a path need only be visible. */
const CORNER_TURN = 0.6;

/**
 * A side of an area short enough for its middle to be a place rather than a length.
 *
 * The same thought as "never mid-straight" on a line: a circle halfway along two hundred
 * metres of forest edge marks the edge and not a point of it. A building's wall, a field's
 * short side and the neck of a clearing are all under this.
 */
const SHORT_SIDE = 90;
/** And long enough that its middle is not simply one of its two corners. */
const MIN_SIDE = 40;

const turnAt = (before: Vec, here: Vec, after: Vec): number => {
  const turn = Math.abs(
    Math.atan2(after.y - here.y, after.x - here.x) -
      Math.atan2(here.y - before.y, here.x - before.x),
  );
  return Math.min(turn, 2 * Math.PI - turn);
};

/**
 * The bends of a line.
 *
 * A control goes on a bend and never halfway along a straight — a circle there marks a
 * length of path rather than a place on it. The ends are not bends; they are their own
 * kind of site, and `endsOf` has the extra question to ask about them.
 */
function bendsOf(points: readonly Vec[]): Vec[] {
  const bends: Vec[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    const here = points[i]!;
    if (turnAt(points[i - 1]!, here, points[i + 1]!) < MIN_BEND) continue;
    const last = bends[bends.length - 1];
    if (last && Math.hypot(here.x - last.x, here.y - last.y) < MIN_BEND_SPACING) continue;
    bends.push(here);
  }
  return bends;
}

/** Whether `p` lies on one of `line`'s segments, within `tolerance`. */
function touches(p: Vec, line: readonly Vec[], tolerance: number): boolean {
  for (let i = 1; i < line.length; i++) {
    if (distanceToSegment(p, line[i - 1]!, line[i]!) <= tolerance) return true;
  }
  return false;
}

/** Where two segments cross, or null. Parallel and touching-at-a-shared-end both count
 *  as no crossing: a shared end is a junction, and that is a question already asked. */
function crossing(a1: Vec, a2: Vec, b1: Vec, b2: Vec): Vec | null {
  const rx = a2.x - a1.x;
  const ry = a2.y - a1.y;
  const sx = b2.x - b1.x;
  const sy = b2.y - b1.y;
  const denominator = rx * sy - ry * sx;
  if (denominator === 0) return null;
  const t = ((b1.x - a1.x) * sy - (b1.y - a1.y) * sx) / denominator;
  const u = ((b1.x - a1.x) * ry - (b1.y - a1.y) * rx) / denominator;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return { x: a1.x + rx * t, y: a1.y + ry * t };
}

const overlaps = (a: Box, b: Box, slack = 0): boolean =>
  a.maxX + slack >= b.minX && a.minX - slack <= b.maxX &&
  a.maxY + slack >= b.minY && a.minY - slack <= b.maxY;

/**
 * The ground the surveyor drew, remembered.
 *
 * `drawnExtent` walks every feature on the map, and a surveyed map has thousands where a
 * card has a hundred. A map is immutable once loaded, so the answer is too.
 */
const drawnExtents = new WeakMap<OMap, Box>();
function extentOf(map: OMap): Box {
  const known = drawnExtents.get(map);
  if (known) return known;
  const box = drawnExtent(map);
  drawnExtents.set(map, box);
  return box;
}

/**
 * How far the drawn symbol spreads from the point the feature is at, in metres.
 *
 * `MapView` draws these at fixed millimetres of paper through the style table, and a
 * cliff as a mark across the slope that is wider than the feature's own size — so a cliff
 * whose *centre* is outside a ring can still have half of itself inside one. The ring test
 * is about what a player sees, so it measures what is drawn, and it asks the same table
 * the renderer asks, for the geometry the feature actually has.
 */
function drawnReach(point: Feature, unit: number): number {
  const style = styleFor(point.code, { geometry: 'point' });
  const symbol =
    point.code === '202'
      ? POINT.cliffWidth * 3
      : style?.geometry === 'point' ? style.radius : POINT.boulderRadius;
  return Math.max(point.size ?? 0, symbol * unit);
}

/** A polygon ring, closed, because a ring's last side is a side like any other. */
function closedRing(ring: readonly Vec[]): readonly Vec[] {
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  return first.x === last.x && first.y === last.y ? ring : [...ring, first];
}

/**
 * Where a circle could go on an area: the corners of its outline, and the middle of a
 * short side.
 *
 * **Never the interior.** The middle of a meadow marks nothing a description sheet has a
 * word for — "clearing" says which clearing and not where in it — and hanging the circle
 * there is what made every area on a card a single site at a place no control would ever
 * be. The outline is the nameable part: a corner of the field, the north side of the
 * marsh, the neck of the clearing.
 */
function outlineSites(ring: readonly Vec[]): { at: Vec; where: SiteClass }[] {
  const closed = closedRing(ring);
  if (closed.length < 4) return [];
  const n = closed.length - 1;
  const out: { at: Vec; where: SiteClass }[] = [];
  // Spaced against its own kind of place, and not against the other: two corners a step
  // apart are one corner, and so are two middles, but a side's middle is a different
  // place from the turn at either end of it — `MIN_SIDE` is what keeps it far enough from
  // them to be worth offering.
  const spaced = (p: Vec, where: SiteClass): boolean =>
    out.every((s) => s.where !== where || Math.hypot(s.at.x - p.x, s.at.y - p.y) >= MIN_BEND_SPACING);

  /** The vertex `CORNER_ARC` metres away along the ring, in the given direction. */
  const along = (from: number, step: 1 | -1): Vec => {
    let i = from;
    let walked = 0;
    for (let taken = 0; taken < n; taken++) {
      const next = (i + step + n) % n;
      walked += Math.hypot(closed[next]!.x - closed[i]!.x, closed[next]!.y - closed[i]!.y);
      i = next;
      if (walked >= CORNER_ARC) break;
    }
    return closed[i]!;
  };

  // Corners first, so a short side's middle never displaces the turn it runs between.
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    const here = closed[i]!;
    if (turnAt(along(i, -1), here, along(i, 1)) < CORNER_TURN) continue;
    corners.push(i);
    if (spaced(here, 'corner')) out.push({ at: here, where: 'corner' });
  }

  // Then the middle of each side that runs between two corners and is short enough for a
  // middle to be a place. Measured along the outline and taken on it, so the site is on
  // the ring however much the side wanders.
  for (let k = 0; k < corners.length; k++) {
    const from = corners[k]!;
    const to = corners[(k + 1) % corners.length]!;
    let length = 0;
    const steps: number[] = [];
    for (let i = from; i !== to; i = (i + 1) % n) {
      const step = Math.hypot(closed[(i + 1) % n]!.x - closed[i]!.x, closed[(i + 1) % n]!.y - closed[i]!.y);
      steps.push(step);
      length += step;
    }
    if (length < MIN_SIDE || length > SHORT_SIDE) continue;
    let walked = 0;
    let i = from;
    for (const step of steps) {
      if (walked + step >= length / 2) {
        const t = (length / 2 - walked) / (step || 1);
        const a = closed[i]!;
        const b = closed[(i + 1) % n]!;
        const at = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        if (spaced(at, 'side')) out.push({ at, where: 'side' });
        break;
      }
      walked += step;
      i = (i + 1) % n;
    }
  }
  return out;
}

interface Candidates {
  readonly named: readonly Named[];
  readonly sites: readonly Site[];
}

/**
 * Everything in this window a player could name, and every place a control could go on it.
 *
 * Culled to the window plus one circle's reach, because that is everything a ring centred
 * inside the window can contain — and because a surveyed map is two kilometres of forest
 * where a card is three hundred metres of it, so the alternative is comparing every
 * feature on it with every other one, ten pairs of cards a round.
 *
 * The two lists are not the same list. **Everything nameable shadows**, whether or not it
 * offers a site: a straight path through a ring has no bend to hang a circle on and is
 * still a black line across the middle of it. That is the half of the rule that used to be
 * missing — a line with no bend was invisible to the ring test — and it is why a boulder
 * sitting on a path is no longer a site.
 */
function candidatesOf(map: OMap, crop: Crop, radius: number): Candidates {
  const grid = map.relief.sampleGrid(GRID);
  const unit = crop.size / 100;
  const named: Named[] = [];
  const sites: Site[] = [];
  const window_: Box = {
    minX: crop.x - radius, minY: crop.y - radius,
    maxX: crop.x + crop.size + radius, maxY: crop.y + crop.size + radius,
  };
  const near = (f: Feature): boolean => overlaps(boundsOf(f), window_);

  const name = (
    shape: readonly Vec[],
    reach: number,
    source: string,
    word: ControlKind | null,
    reliefBound: boolean,
    form = false,
    cover = false,
  ): void => {
    named.push({ shape, reach, source, word, reliefBound, form, cover, box: boxOf(shape, reach) });
  };

  pointsOf(map).filter(near).forEach((p, i) => {
    const word = wordFor(p.code);
    if (!word) return;
    const at = positionOf(p);
    const reach = drawnReach(p, unit);
    const source = `point:${i}`;
    const reliefBound = semanticsOf(p.code)?.reliefBound === true;
    name([at], reach, source, word, reliefBound);
    sites.push({ at, kind: word, where: 'point', shape: [at], reach, source });
  });

  (map.analysis?.landforms ?? []).forEach((f, i) => {
    // A candidate nobody named is a piece of ground that bends, and no control description
    // has a word for that. See `MapAnalysis.landforms`.
    if (!f.kind) return;
    const source = `landform:${i}`;
    // A landform the ground does not actually show is not a site. See `standsOut`: the
    // analysis says there is a hill here, and the contours are what the player has.
    for (const at of alongForm(grid, f)) {
      if (!standsOut(grid, f, at)) continue;
      name([at], 0, source, f.kind, true, true);
      sites.push({ at, kind: f.kind, where: 'landform', shape: [at], reach: 0, source });
    }
  });

  const lines = linesOf(map).filter(near).map((line, i) => ({
    feature: line,
    points: line.geometry.kind === 'polyline' ? line.geometry.points : [],
    source: `line:${i}`,
    index: i,
    box: boundsOf(line),
  })).filter((l) => l.points.length >= 2);

  for (const line of lines) {
    const word = wordFor(line.feature.code);
    const blocks = BLOCKING.includes(line.feature.code);
    if (!word && !blocks) continue;
    name(
      line.points, 0, line.source, word ?? null,
      semanticsOf(line.feature.code)?.reliefBound === true, false, isCover(line.feature, word),
    );
    if (!word) continue;

    // Junctions and crossings first, then the loose ends, then the bends: where two of
    // them land within a spacing of each other, the more distinctive place is the one a
    // description sheet would name.
    const found: { at: Vec; where: SiteClass }[] = [];
    const ends = [line.points[0]!, line.points[line.points.length - 1]!];

    for (const other of lines) {
      if (other === line || !overlaps(line.box, other.box, JUNCTION_TOLERANCE)) continue;
      // A fork: one line stops on another, whatever either of them is. Both count —
      // the word rule below decides whether the pair is readable as one thing.
      for (const end of ends) {
        if (touches(end, other.points, JUNCTION_TOLERANCE)) found.push({ at: end, where: 'junction' });
      }
      // A crossing is one place, so it is counted once per pair of lines and lands on the
      // one that runs the test. Which of the two that is never changes the outcome: a
      // crossing of two lines with different words has both of them in the ring and is no
      // site at all, and one of two lines with the same word says that word either way.
      if (other.index < line.index) continue;
      for (let i = 1; i < line.points.length; i++) {
        const a1 = line.points[i - 1]!;
        const a2 = line.points[i]!;
        for (let j = 1; j < other.points.length; j++) {
          const b1 = other.points[j - 1]!;
          const b2 = other.points[j]!;
          if (Math.min(a1.x, a2.x) > Math.max(b1.x, b2.x)) continue;
          if (Math.max(a1.x, a2.x) < Math.min(b1.x, b2.x)) continue;
          if (Math.min(a1.y, a2.y) > Math.max(b1.y, b2.y)) continue;
          if (Math.max(a1.y, a2.y) < Math.min(b1.y, b2.y)) continue;
          const at = crossing(a1, a2, b1, b2);
          if (at) found.push({ at, where: 'crossing' });
        }
      }
    }

    // An end that meets nothing is a place: the path simply stops. Not one on the edge of
    // the map or of the paper a square map is padded with, where half the circle would be
    // off the drawing and the "end" is the surveyor's sheet rather than the ground.
    const drawn = extentOf(map);
    for (const end of ends) {
      if (found.some((f) => f.where === 'junction' && f.at === end)) continue;
      if (end.x - radius < drawn.minX || end.x + radius > drawn.maxX) continue;
      if (end.y - radius < drawn.minY || end.y + radius > drawn.maxY) continue;
      if (end.x - radius < 0 || end.y - radius < 0) continue;
      if (end.x + radius > map.width || end.y + radius > map.height) continue;
      found.push({ at: end, where: 'end' });
    }

    for (const at of bendsOf(line.points)) found.push({ at, where: 'bend' });

    const taken: Vec[] = [];
    for (const { at, where } of found) {
      if (taken.some((p) => Math.hypot(p.x - at.x, p.y - at.y) < MIN_BEND_SPACING)) continue;
      taken.push(at);
      sites.push({ at, kind: word, where, shape: line.points, reach: 0, source: line.source });
    }
  }

  areasOf(map).filter(near).forEach((area, i) => {
    const word = wordFor(area.code);
    const blocks = BLOCKING.includes(area.code);
    if (!word && !blocks) return;
    if (area.geometry.kind !== 'polygon') return;
    const source = `area:${i}`;
    const reliefBound = semanticsOf(area.code)?.reliefBound === true;
    const cover = isCover(area, word);
    for (const ring of area.geometry.rings) {
      if (ring.length < 3) continue;
      const closed = closedRing(ring);
      // The **outline**, not a disc over the middle: an area's interior is not a shadow.
      name(closed, 0, source, word ?? null, reliefBound, false, cover);
      if (!word) continue;
      for (const { at, where } of outlineSites(ring)) {
        sites.push({ at, kind: word, where, shape: closed, reach: 0, source });
      }
    }
  });

  return { named, sites };
}

/**
 * The places on one map where a circle would mark one thing and one thing only.
 *
 * This is the drill's version of Dobble's "no two symbols overlap", and it is the whole of
 * what makes a round answerable. A ring with a boulder at its centre and a knoll just
 * inside it can be read either way; if the other card circles a knoll, that round has two
 * right answers, and neither the player nor the screen can tell which was meant. So a site
 * is only a site if nothing else with a **different word** is inside the ring.
 *
 * By word and not by code, which is the change that made the vocabulary safe to widen: a
 * footpath crossing a ride, two shades of green meeting, a boulder beside a large boulder
 * are each one word in the ring and therefore one answer. Three other exemptions, each of
 * them a claim about what the player sees rather than a loosening:
 *
 *  - **Same word, any number.** Two boulders in one ring still say boulder.
 *  - **Same object.** Two sites off one line — a bend and the junction it runs to — are
 *    one thing offered twice.
 *  - **A form of the ground does not shadow the symbol standing on it.** `placePoints`
 *    puts knolls on `ground.maxima`, and a surveyed knoll is drawn on a rise for the same
 *    reason a real one is: *that is what a knoll is*. The map draws a ring round it and a
 *    description sheet says knoll, so the drawn symbol is the answer and the hill under it
 *    is not a second one. It is asked of `Semantics.reliefBound`, which is exactly the
 *    claim — a boulder is **not** relief-bound, and a boulder on a hilltop is still two
 *    things in one ring. Measured over 80 generated windows at level 10, it is worth 126
 *    knoll sites where there were 62, 121 pits where there were 79, and a tenth more
 *    sites overall.
 *  - **Ground cover shadows nothing but ground cover**, which is the other half of the
 *    same thought and is set out at `GROUND_COVER`.
 *
 * It is also what sets the size of the circle. Measured on a level 10 card — 360 m of
 * ground, where five controls need nine words between the two cards — at the 3 mm across
 * drawn here a generated card offers a median of 8.5 words and two of them 11, and a
 * window of the forest sample 7 and 8; at 4 mm, 7 and 9 generated but only 3 and 4 real;
 * at ISOM's own 6 mm, 3 and 5 generated and 1 and 2 real. The surveyed map is what now
 * decides it: a real window at 4 mm is two circles where the level asks for five.
 */
export function sitesOf(map: OMap, crop: Crop, radius: number): Site[] {
  const { named, sites } = candidatesOf(map, crop, radius);
  const own = new Map<string, Named>();
  for (const n of named) if (!own.has(n.source)) own.set(n.source, n);

  return sites
    .filter(
      (c) =>
        c.at.x >= crop.x + radius &&
        c.at.y >= crop.y + radius &&
        c.at.x <= crop.x + crop.size - radius &&
        c.at.y <= crop.y + crop.size - radius,
    )
    .filter((c) => {
      // A drawn symbol that is a form of the ground, standing on the ground it is the
      // form of. Narrow on purpose, in both directions: the exemption is only ever from a
      // landform *candidate*, and only ever for a symbol someone drew — a spur candidate
      // still shadows a re-entrant candidate beside it, and the knoll still shadows the
      // hill, because the drawn symbol is the more particular of the two.
      const mine = own.get(c.source);
      const drawnForm = c.where !== 'landform' && mine?.reliefBound === true;
      // Ground cover shadows nothing but ground cover. See `GROUND_COVER`.
      const mineIsCover = mine?.cover === true;
      return named.every(
        (other) =>
          other.source === c.source ||
          other.word === c.kind ||
          other.box.minX > c.at.x + radius ||
          other.box.maxX < c.at.x - radius ||
          other.box.minY > c.at.y + radius ||
          other.box.maxY < c.at.y - radius ||
          (other.form && drawnForm) ||
          (other.cover && !mineIsCover) ||
          clearanceFrom(other, c.at) >= radius,
      );
    });
}

/** The sites, grouped by what they are. */
export function byKind(sites: readonly Site[]): Map<ControlKind, Site[]> {
  const groups = new Map<ControlKind, Site[]>();
  for (const site of sites) {
    const list = groups.get(site.kind);
    if (list) list.push(site);
    else groups.set(site.kind, [site]);
  }
  return groups;
}
