import { sampleGridAt, type Grid } from '@/lib/terrain/height.ts';
import { POINT, styleFor } from '@/lib/terrain/isom.ts';
import {
  areasOf, boundsOf, linesOf, pointsOf, positionOf,
  type Crop, type Feature, type MapAnalysis, type OMap, type Vec,
} from '@/lib/terrain/omap.ts';
import type { LandformKind } from '@/lib/terrain/relief.ts';
import type { IsomCode } from '@/lib/terrain/semantics.ts';

/**
 * What a control circle can be hung on, and where.
 *
 * A course is drawn over a map: the circle says "the feature at my centre", and a
 * description sheet says which feature. This drill takes the description sheet away and
 * asks the question the other way round — *which kind of thing* is circled on both cards —
 * so the vocabulary of kinds is the drill's answer space, and it has to be one a control
 * could really sit in.
 *
 * The vocabulary is keyed by **ISOM code**, like every other thing in the app that has to
 * hold for an imported feature as well as a generated one: an imported 206 and a generated
 * boulder are one answer, or the round could share a kind with itself and not know.
 *
 * Left out on purpose:
 *
 *  - **Vegetation screens.** Nobody sets a control on "green": the greens are a runnability
 *    scale, and three shades of one as three answers is a colour-matching game. Rough open
 *    goes with them — it is the same yellow as a clearing at half the screen, and telling
 *    401 from 403 through a control circle is not a question worth asking.
 *  - **Rides.** A ride is drawn dead straight, so it has no bend to hang a control on, and
 *    a circle halfway along a featureless corridor marks nothing.
 *
 * Two of those still get in the way. See `BLOCKING`.
 */
export type ControlKind =
  | 'boulder' | 'knoll' | 'pit' | 'tree' | 'crag'
  | LandformKind
  | 'path' | 'stream' | 'fence'
  | 'marsh' | 'open' | 'rock';

/**
 * The codes a circle can be hung on, and what a control description would call them.
 *
 * Areas that are ground cover rather than features — the greens — are simply absent, as
 * is any code the table does not name: an unknown symbol off a real map is not an answer,
 * because the player has no word for it either.
 */
const ANSWERS: Readonly<Record<IsomCode, ControlKind>> = {
  '206': 'boulder',
  '112': 'knoll',
  '116': 'pit',
  '418': 'tree',
  '203': 'crag',
  '505': 'path',
  '306': 'stream',
  '516': 'fence',
  '311': 'marsh',
  '401': 'open',
  '212': 'rock',
};

/**
 * Drawn like an answer, but never one.
 *
 * A ride is a black line through the forest and a path is a black line through the forest;
 * rough open is the yellow of a clearing at half the screen. A player who finds one of
 * these in the middle of a ring on each card has matched a pair the drill never offered,
 * and no amount of it being *wrong* makes the round fair. So they block a site the way a
 * real feature does, without ever being an answer.
 *
 * The greens are not here. Nothing in the vocabulary is a wash of green, so a green
 * under a circle reads as ground rather than as the thing circled — which is just as well,
 * since half the control circles on a real map have some.
 */
const BLOCKING: readonly IsomCode[] = ['508', '403'];

/** What the circle is on, in the words a control description would use. */
export const CONTROL_NAMES: Readonly<Record<ControlKind, string>> = {
  boulder: 'boulder',
  knoll: 'knoll',
  pit: 'pit',
  tree: 'distinctive tree',
  crag: 'crag',
  hill: 'hilltop',
  depression: 'depression',
  spur: 'spur',
  reentrant: 're-entrant',
  marsh: 'marsh',
  open: 'clearing',
  rock: 'bare rock',
  path: 'path',
  stream: 'stream',
  fence: 'fence',
};

/**
 * Something on the map with a name, and where a control marking it would sit.
 *
 * `at` is where the circle's centre would land. `shape` and `reach` are the object
 * *itself* — one point for anything but a line, widened by `reach` for anything with an
 * extent — and that is what a ring is measured against.
 *
 * The look-alikes are nameable without being answerable: being unanswerable is not the
 * same as being invisible.
 */
interface Nameable {
  readonly at: Vec;
  readonly shape: readonly Vec[];
  readonly reach: number;
  /** The feature it came from. Two of these off one feature never shadow each other. */
  readonly source: string;
}

interface Unanswerable extends Nameable {
  readonly answerable: false;
  /** The code, since a blocker has no name in the answer space. */
  readonly kind: IsomCode;
}

/** A place a control could go, and the object it would then be marking. */
export interface Site extends Nameable {
  readonly answerable: true;
  readonly kind: ControlKind;
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

/** Radians of turn that make a vertex a bend rather than a wobble. */
const MIN_BEND = 0.2;
/** Two bends closer than this are one bend, offered twice. */
const MIN_BEND_SPACING = 45;

/**
 * The bends of a line.
 *
 * Controls go on bends, junctions and ends, never halfway along a straight — a circle
 * there marks a length of path rather than a place on it. The ends are left out too: they
 * are on the map border, where the circle would run off the card.
 */
function bendsOf(points: readonly Vec[]): Vec[] {
  const bends: Vec[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    const before = points[i - 1]!;
    const here = points[i]!;
    const after = points[i + 1]!;
    const turn = Math.abs(
      Math.atan2(after.y - here.y, after.x - here.x) -
        Math.atan2(here.y - before.y, here.x - before.x),
    );
    if (Math.min(turn, 2 * Math.PI - turn) < MIN_BEND) continue;
    const last = bends[bends.length - 1];
    if (last && Math.hypot(here.x - last.x, here.y - last.y) < MIN_BEND_SPACING) continue;
    bends.push(here);
  }
  return bends;
}

/**
 * How far the drawn symbol spreads from the point the feature is at, in metres.
 *
 * `MapView` draws these at fixed millimetres of paper through the style table, and 203 as
 * a line across the slope that is wider than the feature's own size — so a crag whose
 * *centre* is outside a ring can still have half of itself inside one. The ring test is
 * about what a player sees, so it measures what is drawn, and it asks the same table the
 * renderer asks.
 */
function drawnReach(point: Feature, unit: number): number {
  const style = styleFor(point.code);
  const symbol =
    point.code === '203'
      ? POINT.cliffWidth * 3
      : style?.geometry === 'point' ? style.radius : POINT.boulderRadius;
  return Math.max(point.size ?? 0, symbol * unit);
}

/**
 * How far an area spreads from the point it is marked at.
 *
 * Measured off the outline the map actually carries rather than off the radii it was
 * generated from: an imported area has an outline and no radii, and for a generated one
 * the traced ring is what the eye sees anyway. It is the whole of the area another circle
 * has to keep out of.
 */
function areaReach(area: Feature, at: Vec): number {
  if (area.geometry.kind !== 'polygon') {
    const box = boundsOf(area);
    return Math.max(box.maxX - box.minX, box.maxY - box.minY) / 2;
  }
  let reach = 0;
  for (const ring of area.geometry.rings) {
    for (const p of ring) reach = Math.max(reach, Math.hypot(p.x - at.x, p.y - at.y));
  }
  return reach;
}

/**
 * Everything in this window a player could name, and where a control could go on it.
 *
 * Culled to the window plus one circle's reach, because that is everything a ring centred
 * inside the window can contain — and because a surveyed map is two kilometres of forest
 * where a card is three hundred metres of it, so the alternative is comparing every
 * feature on it with every other one, ten pairs of cards a round.
 */
function candidatesOf(map: OMap, crop: Crop, radius: number): (Site | Unanswerable)[] {
  const grid = map.relief.sampleGrid(GRID);
  const unit = crop.size / 100;
  const raw: (Site | Unanswerable)[] = [];
  const near = (f: Feature): boolean => {
    const box = boundsOf(f);
    return box.maxX >= crop.x - radius && box.minX <= crop.x + crop.size + radius &&
      box.maxY >= crop.y - radius && box.minY <= crop.y + crop.size + radius;
  };

  pointsOf(map).filter(near).forEach((p, i) => {
    const kind = ANSWERS[p.code];
    if (!kind) return;
    const at = positionOf(p);
    raw.push({
      kind,
      at,
      shape: [at],
      reach: drawnReach(p, unit),
      source: `point:${i}`,
      answerable: true,
    });
  });

  (map.analysis?.landforms ?? []).forEach((f, i) => {
    // A candidate nobody named is a piece of ground that bends, and no control description
    // has a word for that. See `MapAnalysis.landforms`.
    if (!f.kind) return;
    // A spur has no summit to stand on: it is read along its length, so the circle goes on
    // the middle of it. A hill or a hollow is read at its top or bottom.
    const at = elongationOf(f) > 1.2 ? f.centre : summitOf(grid, f);
    // A landform the ground does not actually show is not a site. See `standsOut`: the
    // analysis says there is a hill here, and the contours are what the player has.
    if (!standsOut(grid, f, at)) return;
    raw.push({ kind: f.kind, at, shape: [at], reach: 0, source: `landform:${i}`, answerable: true });
  });

  linesOf(map).filter(near).forEach((line, i) => {
    if (line.geometry.kind !== 'polyline') return;
    const shape = line.geometry.points;
    if (BLOCKING.includes(line.code)) {
      // `at` is never read for these; a ride is straight and has no bend to offer anyway.
      raw.push({
        kind: line.code, at: shape[0]!, shape, reach: 0, source: `line:${i}`, answerable: false,
      });
      return;
    }
    const kind = ANSWERS[line.code];
    if (!kind) return;
    for (const at of bendsOf(shape)) {
      raw.push({ kind, at, shape, reach: 0, source: `line:${i}`, answerable: true });
    }
  });

  areasOf(map).filter(near).forEach((area, i) => {
    const kind = ANSWERS[area.code];
    const blocks = BLOCKING.includes(area.code);
    if (!kind && !blocks) return;
    const at = positionOf(area);
    raw.push({
      ...(kind ? { answerable: true as const, kind } : { answerable: false as const, kind: area.code }),
      at,
      shape: [at],
      // An area is marked from its middle, and it is the whole of it that another circle
      // has to keep out of.
      reach: areaReach(area, at),
      source: `area:${i}`,
    });
  });

  return raw;
}

/**
 * The places on one map where a circle would mark one thing and one thing only.
 *
 * This is the drill's version of Dobble's "no two symbols overlap", and it is the whole of
 * what makes a round answerable. A ring with a boulder at its centre and a knoll just
 * inside it can be read either way; if the other card circles a knoll, that round has two
 * right answers, and neither the player nor the screen can tell which was meant. So a site
 * is only a site if nothing else nameable is inside the ring.
 *
 * Same-kind neighbours are allowed: two boulders in one ring still say boulder.
 *
 * It is also what sets the size of the circle. The generator keeps point features a symbol
 * apart and puts knolls on the tops of hills, so a wide ring has a second nameable thing
 * in it nearly everywhere and the sites run out before the round is built. Measured on a
 * level 10 card: 3 mm across leaves a median of seven kinds a card and nine between two of
 * them, which is what five controls need; 4 mm leaves four; ISOM's own 6 mm leaves one.
 */
export function sitesOf(map: OMap, crop: Crop, radius: number): Site[] {
  const raw = candidatesOf(map, crop, radius);
  return raw
    .filter((c) => c.answerable)
    .filter(
      (c) =>
        c.at.x >= crop.x + radius &&
        c.at.y >= crop.y + radius &&
        c.at.x <= crop.x + crop.size - radius &&
        c.at.y <= crop.y + crop.size - radius,
    )
    .filter((c) =>
      raw.every(
        (other) =>
          other.source === c.source ||
          other.kind === c.kind ||
          clearanceFrom(other, c.at) >= radius,
      ),
    );
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
