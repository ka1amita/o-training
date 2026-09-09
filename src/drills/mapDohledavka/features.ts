import { sampleGrid, sampleGridAt, type Grid } from '@/lib/terrain/height.ts';
import { POINT } from '@/lib/terrain/isom.ts';
import { OUTLINE_SLACK } from '@/lib/terrain/shapes.ts';
import type {
  AreaKind, Landform, LandformKind, LineFeature, LineKind, PointFeature, PointKind, Terrain, Vec,
} from '@/lib/terrain/terrain.ts';

/**
 * What a control circle can be hung on, and where.
 *
 * A course is drawn over a map: the circle says "the feature at my centre", and a
 * description sheet says which feature. This drill takes the description sheet away and
 * asks the question the other way round — *which kind of thing* is circled on both cards —
 * so the vocabulary of kinds is the drill's answer space, and it has to be one a control
 * could really sit in.
 *
 * Left out on purpose:
 *
 *  - **Vegetation screens.** Nobody sets a control on "green": the greens are a runnability
 *    scale, and three shades of one as three answers is a colour-matching game. Rough open
 *    goes with them — it is the same yellow as a clearing at half the screen, and telling
 *    401 from 403 through a control circle is not a question worth asking.
 *  - **Rides.** `makeStraightOrWandering` draws a ride straight, so it has no bend to hang
 *    a control on, and a circle halfway along a featureless corridor marks nothing.
 *
 * Two of those still get in the way. See `LOOKALIKES`.
 */
export type ControlKind =
  | PointKind
  | LandformKind
  | Extract<LineKind, 'path' | 'stream' | 'fence'>
  | Extract<AreaKind, 'marsh' | 'open' | 'rock'>;

/** Areas a control can be set on. The rest of them are ground cover, not features. */
const AREA_KINDS: readonly AreaKind[] = ['marsh', 'open', 'rock'];

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
const LOOKALIKES: readonly (LineKind | AreaKind)[] = ['ride', 'rough'];

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
  readonly kind: Extract<LineKind, 'ride'> | Extract<AreaKind, 'rough'>;
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
 * The top of a rise, rather than the middle of the bump that mostly makes it.
 *
 * Landforms are summed, so a hill on the flank of the ridge has its real summit uphill of
 * its own centre — sometimes by more than the circle's radius. Centred on the feature list
 * rather than on the ground, the circle would sit beside the top, and the card would be
 * asking about a hilltop while pointing at a hillside.
 */
function summitOf(grid: Grid, f: Landform): Vec {
  const sign = f.amplitude >= 0 ? 1 : -1;
  const step = grid.size / grid.n;
  let best: Vec = { x: f.x, y: f.y };
  let bestHeight = sign * sampleGridAt(grid, best.x, best.y);

  for (let i = 0; i < 12; i++) {
    let moved = false;
    for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]] as const) {
      const q = { x: best.x + dx, y: best.y + dy };
      if (Math.hypot(q.x - f.x, q.y - f.y) > f.radius * CLIMB_LIMIT) continue;
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
function standsOut(grid: Grid, f: Landform, at: Vec): boolean {
  const sign = f.amplitude >= 0 ? 1 : -1;
  const here = sampleGridAt(grid, at.x, at.y);
  const across = f.rotation + Math.PI / 2;
  const directions =
    f.elongation > 1.2 ? [across, across + Math.PI] : [0, Math.PI / 2, Math.PI, -Math.PI / 2];

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
function bendsOf(line: LineFeature): Vec[] {
  const bends: Vec[] = [];
  for (let i = 1; i < line.points.length - 1; i++) {
    const before = line.points[i - 1]!;
    const here = line.points[i]!;
    const after = line.points[i + 1]!;
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
 * `MapView` draws these at fixed millimetres of paper, and a crag as a line across the
 * slope that is wider than the feature's own size — so a crag whose *centre* is outside a
 * ring can still have half of itself inside one. The ring test is about what a player
 * sees, so it measures what is drawn.
 */
function drawnReach(point: PointFeature, unit: number): number {
  const symbol =
    point.kind === 'boulder' ? POINT.boulderRadius
    : point.kind === 'knoll' ? POINT.knollRadius
    : point.kind === 'pit' ? POINT.pitRadius
    : point.kind === 'tree' ? POINT.treeRadius
    : POINT.cliffWidth * 3;
  return Math.max(point.size, symbol * unit);
}

/** Everything on this map a player could name, and where a control could go on it. */
function candidatesOf(terrain: Terrain): (Site | Unanswerable)[] {
  const grid = sampleGrid(terrain, GRID);
  const unit = terrain.size / 100;
  const raw: (Site | Unanswerable)[] = [];

  terrain.points.forEach((p, i) => {
    const at = { x: p.x, y: p.y };
    raw.push({
      kind: p.kind,
      at,
      shape: [at],
      reach: drawnReach(p, unit),
      source: `point:${i}`,
      answerable: true,
    });
  });

  terrain.landforms.forEach((f, i) => {
    // A spur has no summit to stand on: it is read along its length, so the circle goes on
    // the middle of it. A hill or a hollow is read at its top or bottom.
    const at = f.elongation > 1.2 ? { x: f.x, y: f.y } : summitOf(grid, f);
    // A landform the ground does not actually show is not a site. See `standsOut`: the
    // feature list says there is a hill here, and the contours are what the player has.
    if (!standsOut(grid, f, at)) return;
    raw.push({ kind: f.kind, at, shape: [at], reach: 0, source: `landform:${i}`, answerable: true });
  });

  terrain.lines.forEach((line, i) => {
    const shape = line.points;
    if (line.kind === 'ride') {
      // `at` is never read for these; a straight line has no bend to offer anyway.
      raw.push({ kind: line.kind, at: shape[0]!, shape, reach: 0, source: `line:${i}`, answerable: false });
      return;
    }
    for (const at of bendsOf(line)) {
      raw.push({ kind: line.kind, at, shape, reach: 0, source: `line:${i}`, answerable: true });
    }
  });

  terrain.areas.forEach((area, i) => {
    if (!AREA_KINDS.includes(area.kind) && !LOOKALIKES.includes(area.kind)) return;
    const at = { x: area.x, y: area.y };
    raw.push({
      ...(area.kind === 'rough'
        ? { answerable: false, kind: area.kind }
        : { answerable: true, kind: area.kind as Extract<AreaKind, ControlKind> }),
      at,
      shape: [at],
      // An area is marked from its middle, and it is the whole of it that another circle
      // has to keep out of.
      reach: Math.max(area.rx, area.ry) * OUTLINE_SLACK,
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
 * It is also what sets the size of the circle. The generator keeps point features 22 m
 * apart and puts knolls on the tops of hills, so a wide ring has a second nameable thing
 * in it nearly everywhere and the sites run out before the round is built. Measured on a
 * level 10 card: 3 mm across leaves a median of seven kinds a card and nine between two of
 * them, which is what five controls need; 4 mm leaves four; ISOM's own 6 mm leaves one.
 */
export function sitesOf(terrain: Terrain, radius: number): Site[] {
  const raw = candidatesOf(terrain);
  return raw
    .filter((c) => c.answerable)
    .filter(
      (c) =>
        c.at.x >= radius &&
        c.at.y >= radius &&
        c.at.x <= terrain.size - radius &&
        c.at.y <= terrain.size - radius,
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
