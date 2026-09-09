import type { Contour, SlopeTag } from '@/lib/terrain/contours.ts';
import type { Vec } from '@/lib/terrain/omap.ts';

/**
 * Levels for contour lines that carry none, §1.4 of the design note.
 *
 * An `.xmap` has no heights in it at all: a contour is a line object with symbol 101 and
 * nothing else. Everything that reads the ground needs a height field, so either a DEM is
 * supplied or the levels have to be reconstructed from the drawing — which is what this
 * does, and what it **refuses** to do when the drawing does not say enough.
 *
 * ## What the drawing does say
 *
 * 1. Neighbouring contours differ by exactly one interval. Which one is higher is not in
 *    the drawing.
 * 2. Along any transect the levels are monotone: crossing three contours in a row is
 *    +1, +1 or −1, −1, never +1, −1. This is the constraint that ties a whole hillside
 *    together from purely local observations.
 * 3. A closed contour encloses a knoll unless a slope line (101.1, 104 in ISOM 2000) says
 *    it is a depression. This is the only thing in the drawing that says which way is up,
 *    and without at least one of them this stage gives up.
 * 4. Every fifth line is an index contour (102). That fixes the phase — where the
 *    multiples of five fall — but not the direction.
 *
 * The absolute datum is not recoverable at all without spot heights, so the lowest line
 * is called zero. Nothing in the app reads absolute height; the contours drill compares
 * two reliefs and the shading is fixed rather than normalised.
 *
 * ## Giving up is a result
 *
 * Every stage below can fail, and a failure returns `{ ok: false, reason }` rather than a
 * best guess. A map whose relief is wrong is worse than one with no relief: the contours
 * drill would hand out cards whose answer is a hillside that is not there, and nothing
 * downstream could tell. `relief: 'none'` costs that map one drill of three.
 */
export interface ContourLine {
  readonly points: readonly Vec[];
  readonly closed: boolean;
  /** 102: every fifth line, drawn heavier. */
  readonly index: boolean;
  /** 103: a half-interval line, which sits between two ordinary ones. */
  readonly form: boolean;
}

export interface LevelOptions {
  /** Metres between ordinary contours. ISOM's standard is 5; nothing in the file says. */
  readonly interval?: number;
  /** Where slope lines (101.1) were drawn — the marks that say "this ring is a hollow". */
  readonly slopeMarks?: readonly Vec[];
  /** How far apart two contours may be and still be neighbours, in metres. */
  readonly maxGap?: number;
}

export type LevelResult =
  | { readonly ok: true; readonly interval: number; readonly contours: readonly Contour[] }
  | { readonly ok: false; readonly reason: string };

const DEFAULT_INTERVAL = 5;
const DEFAULT_MAX_GAP = 90;

/** Vertices are sampled this far apart when looking for a contour's neighbours. */
const SAMPLE_SPACING = 10;

/** An observation pair needs this many votes before it counts as an edge. */
const MIN_VOTES = 3;

/** Fraction of the lines that must end up in one connected component. */
const MIN_COMPONENT = 0.9;

/** Fraction of index contours that must agree on where the multiples of five fall. */
const MIN_INDEX_AGREEMENT = 0.8;

/**
 * Contradicting observations tolerated, as a fraction of the edges.
 *
 * Not zero: a contour clipped by the map edge, or squeezed against a cliff, gives an
 * observation that cannot be reconciled with its neighbours and should be dropped rather
 * than reasoned from. Past this the graph is telling us it does not hold together, and
 * the answer is no relief rather than a plausible-looking wrong one.
 */
const MAX_CONTRADICTION = 0.15;

/** How near a slope mark has to be to a ring to be about that ring, in metres. */
const SLOPE_MARK_REACH = 8;

/**
 * How wide a break two pieces of one contour may have and still be one contour, in metres.
 *
 * A surveyed contour is drawn in pieces: broken where a knoll symbol takes over, where a
 * road crosses, where the mapper stopped and started. Left as separate lines they are
 * neighbours of each other at **the same level**, and the graph then insists they differ
 * by one — which was 18 of the 45 disagreements on the forest sample and dragged whole
 * hillsides a level out with them.
 */
const JOIN_GAP = 30;

/** ...and how nearly the two ends must be heading the same way to be joined. */
const JOIN_ALIGNMENT = 0.3;

/**
 * How far off the perpendicular a neighbour may sit, as the cosine of the angle.
 *
 * The observation is a **transect**, not "the nearest line on that side", and the
 * difference decides whether a spur reads as a spur. Two pieces of the *same* level, one
 * either side of a crest, are often nearer to each other in a straight line than either is
 * to the contour one interval up the crest between them — so an ungated search pairs them
 * and the graph then insists they differ by one, which walks a whole hillside out of
 * position. Looking only up and down the slope finds the contour that is actually next.
 */
const TRANSECT_CONE = 0.82;

export function assignLevels(lines: readonly ContourLine[], options: LevelOptions = {}): LevelResult {
  const interval = options.interval ?? DEFAULT_INTERVAL;
  const maxGap = options.maxGap ?? DEFAULT_MAX_GAP;
  const main = stitchPieces(lines.filter((l) => !l.form && l.points.length >= 2));
  if (main.length < 4) return { ok: false, reason: `only ${main.length} contour lines` };

  const index = new SegmentIndex(main, maxGap);
  const observations = observe(main, index, maxGap);
  if (observations.size === 0) return { ok: false, reason: 'no two contours are neighbours' };

  // 1. Which contours face the same way. `s(a) = e · s(b)`, a parity relation, so a
  //    union-find that carries parity solves it in one pass.
  //
  //    **Strongest evidence first.** The order matters: whichever edge of a contradicting
  //    cycle is processed last is the one blamed, and taking the best-attested edges first
  //    means the blame lands on the observation with the fewest votes behind it — which,
  //    on a real map, is a line clipped by the map edge or squeezed against a cliff.
  const seen = [...observations.values()]
    .filter((e) => e.votes >= MIN_VOTES)
    .sort((a, b) => b.votes - a.votes || a.a - b.a || a.b - b.b);
  if (seen.length === 0) return { ok: false, reason: 'no neighbour survived the vote' };

  const parity = new ParityUnion(main.length);
  const edges: Edge[] = [];
  let contradictions = 0;
  for (const edge of seen) {
    const agrees = edge.agree >= edge.disagree;
    if (parity.union(edge.a, edge.b, agrees ? 0 : 1)) edges.push(edge);
    else contradictions++;
  }
  // One bad observation in a dozen is a line clipped by the map edge, not a misreading.
  // Past that the graph is telling us it does not hold together.
  if (contradictions > Math.max(1, seen.length * MAX_CONTRADICTION)) {
    return { ok: false, reason: `${contradictions} of ${seen.length} neighbours contradict` };
  }

  // 2. One component, or give up. Two components have no relation to each other at all —
  //    nothing in the drawing says whether one hill is above or below the next.
  const counts = new Map<number, number>();
  for (let i = 0; i < main.length; i++) {
    const root = parity.find(i).root;
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  let biggest = -1;
  let biggestCount = 0;
  for (const [root, count] of counts) {
    if (count > biggestCount) {
      biggest = root;
      biggestCount = count;
    }
  }
  if (biggestCount < main.length * MIN_COMPONENT) {
    return {
      ok: false,
      reason: `contours fall into ${counts.size} groups, the largest holding ` +
        `${biggestCount} of ${main.length}`,
    };
  }
  const inComponent = main.map((_, i) => parity.find(i).root === biggest);

  // `s[i]` is +1 when the left normal of line i points uphill, up to one global flip.
  const s = main.map((_, i) => (parity.find(i).parity === 0 ? 1 : -1));

  // 3. Levels, by walking the graph. `k(b) − k(a) = σ · s(a)`, where σ is the side of a
  //    that b was seen on: the transect constraint, one edge at a time.
  //    Along the **best-attested edges first**: a maximum spanning tree over the vote
  //    counts. Every edge is checked afterwards, but which ones the levels are *derived*
  //    from should be the ones with a hundred observations behind them rather than the
  //    ones with three, and without a tree that is decided by traversal order.
  const tree = new ParityUnion(main.length);
  const neighbours: { to: number; step: number }[][] = main.map(() => []);
  for (const edge of edges) {
    if (!inComponent[edge.a] || !inComponent[edge.b]) continue;
    if (tree.find(edge.a).root === tree.find(edge.b).root) continue;
    tree.union(edge.a, edge.b, 0);
    neighbours[edge.a]!.push({ to: edge.b, step: edge.sigma >= 0 ? 1 : -1 });
    neighbours[edge.b]!.push({ to: edge.a, step: edge.reverse >= 0 ? 1 : -1 });
  }

  const k: (number | undefined)[] = main.map(() => undefined);
  const start = inComponent.indexOf(true);
  k[start] = 0;
  const queue = [start];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const { to, step } of neighbours[at]!) {
      if (k[to] !== undefined) continue;
      k[to] = k[at]! + step * s[at]!;
      queue.push(to);
    }
  }

  //    Now check every edge, including the ones the tree did not use. Two kinds of
  //    disagreement, and only one of them is a problem:
  //
  //    - **the same level twice.** A surveyed contour is drawn in pieces, and two pieces
  //      of one line are neighbours of each other at no height difference at all. The
  //      graph model has no way to say that, so it says ±1 and is overruled here. Benign,
  //      and on the forest sample it is every disagreement there is.
  //    - **two intervals or more.** That is a hillside read out of position, and no
  //      amount of it is acceptable: the contours drill would hand out cards whose answer
  //      is ground that is not there.
  let brokenPairs = 0;
  let levelClashes = 0;
  for (const edge of edges) {
    if (k[edge.a] === undefined || k[edge.b] === undefined) continue;
    const apart = Math.abs(k[edge.a]! - k[edge.b]!);
    if (apart === 1) continue;
    if (apart === 0) brokenPairs++;
    else levelClashes++;
  }
  const assigned = k.filter((v) => v !== undefined).length;
  if (assigned < main.length * MIN_COMPONENT) {
    return { ok: false, reason: `only ${assigned} of ${main.length} contours could be reached` };
  }
  if (levelClashes > Math.max(1, edges.length * MAX_CONTRADICTION)) {
    return { ok: false, reason: `${levelClashes} level assignments disagree` };
  }

  // 4. Which way is up. A closed ring encloses higher ground unless a slope line says
  //    otherwise, and that is the only statement of direction the drawing makes.
  const marks = options.slopeMarks ?? [];
  let upVotes = 0;
  let downVotes = 0;
  main.forEach((line, i) => {
    if (!line.closed || k[i] === undefined) return;
    const inward = inwardSign(line.points);
    if (inward === 0) return;
    const hollow = marks.some((m) => nearRing(m, line.points, SLOPE_MARK_REACH));
    // Interior uphill for a knoll: s must equal the inward side. Interior downhill for a
    // hollow: s must be the other way.
    const wanted = hollow ? -inward : inward;
    if (s[i] === wanted) upVotes++;
    else downVotes++;
  });
  if (upVotes + downVotes === 0) {
    return { ok: false, reason: 'no closed contour to say which way is up' };
  }
  const flip = downVotes > upVotes ? -1 : 1;

  // 5. Where the multiples of five fall. Index contours are every fifth line, so their
  //    levels must share a residue; if they do not, the reading of the graph is wrong
  //    somewhere and this is where it shows.
  const residues = new Map<number, number>();
  main.forEach((line, i) => {
    if (!line.index || k[i] === undefined) return;
    const residue = ((k[i]! * flip) % 5 + 5) % 5;
    residues.set(residue, (residues.get(residue) ?? 0) + 1);
  });
  let shift = 0;
  if (residues.size > 0) {
    let best = 0;
    let bestCount = 0;
    let total = 0;
    for (const [residue, count] of residues) {
      total += count;
      if (count > bestCount) {
        best = residue;
        bestCount = count;
      }
    }
    if (bestCount < total * MIN_INDEX_AGREEMENT) {
      return {
        ok: false,
        reason: `index contours disagree on the interval: ${bestCount} of ${total} agree`,
      };
    }
    shift = -best;
  }

  const levels = main.map((_, i) => (k[i] === undefined ? undefined : k[i]! * flip + shift));
  const lowest = Math.min(...levels.filter((v): v is number => v !== undefined));

  const contours: Contour[] = [];
  main.forEach((line, i) => {
    if (levels[i] === undefined) return;
    // Slope tags on the rings that enclose *lower* ground, pointing inward — which is
    // what a slope line is and what the renderer already draws. Without them a knoll and
    // a hollow are the same picture, so a reconstructed map has to state it even when the
    // source did not draw one, and by this point the direction is known.
    const inward = line.closed ? inwardSign(line.points) : 0;
    const interiorUp = inward !== 0 && s[i]! * flip === inward;
    contours.push({
      level: (levels[i]! - lowest) * interval,
      points: line.points,
      closed: line.closed,
      index: line.index,
      form: false,
      tags: line.closed && !interiorUp && inward !== 0 ? tagsPointingIn(line.points, inward) : [],
    });
  });

  // 6. Form lines last: each sits half an interval above or below the nearest ordinary
  //    contour, on whichever side of it the drawing put it.
  for (const line of lines) {
    if (!line.form || line.points.length < 2) continue;
    const near = nearestOf(line.points, index, maxGap);
    if (!near || levels[near.line] === undefined) continue;
    const half = (near.sigma >= 0 ? 1 : -1) * s[near.line]! * flip * 0.5;
    contours.push({
      level: (levels[near.line]! - lowest + half) * interval,
      points: line.points,
      closed: line.closed,
      index: false,
      form: true,
      tags: [],
    });
  }

  return { ok: true, interval, contours };
}


/**
 * Pieces of one contour, joined back into one line.
 *
 * Greedy and nearest-first, over open lines only: a closed ring is already whole. Two
 * pieces join when an end of one is within `JOIN_GAP` of an end of the other, the two are
 * heading the same way there, **and the straight bridge between them crosses no other
 * contour**. That last test is what lets the gap be as wide as it is: two pieces with a
 * contour between them are on opposite sides of it and cannot be one line, whatever their
 * ends look like, and without it a thirty-metre reach at the map edge welds two levels
 * into one line that then claims to be at two heights.
 *
 * Ordinary contours and index contours are never joined to each other: an index line is
 * every fifth line, so a piece of one continuing into a piece of the other would be a
 * drawing error rather than a break.
 */
export function stitchPieces(lines: readonly ContourLine[]): ContourLine[] {
  const closed = lines.filter((l) => l.closed);
  const open = lines.filter((l) => !l.closed).map((l) => ({ ...l, points: [...l.points] }));

  for (;;) {
    // Every line as it currently stands, for the bridge test: joining changes the set, so
    // a bridge is judged against the pieces there are now, not the ones there were.
    const world = [...closed, ...open];
    let best: { a: number; b: number; flipA: boolean; flipB: boolean; distance: number } | null = null;
    for (let a = 0; a < open.length; a++) {
      for (let b = a + 1; b < open.length; b++) {
        if (open[a]!.index !== open[b]!.index) continue;
        for (const flipA of [false, true]) {
          for (const flipB of [false, true]) {
            const found = joinable(open[a]!.points, open[b]!.points, flipA, flipB);
            if (found === null) continue;
            if (!bridgeIsClear(
              open[a]!.points, open[b]!.points, flipA, flipB,
              world, closed.length + a, closed.length + b,
            )) continue;
            if (best && found >= best.distance) continue;
            best = { a, b, flipA, flipB, distance: found };
          }
        }
      }
    }
    if (!best) break;
    const first = best.flipA ? [...open[best.a]!.points].reverse() : open[best.a]!.points;
    const second = best.flipB ? [...open[best.b]!.points].reverse() : open[best.b]!.points;
    open[best.a] = { ...open[best.a]!, points: [...first, ...second] };
    open.splice(best.b, 1);
  }

  return [...closed, ...open];
}

/** The gap between the end of `a` and the start of `b`, or null if they do not continue. */
function joinable(
  a: readonly Vec[],
  b: readonly Vec[],
  flipA: boolean,
  flipB: boolean,
): number | null {
  const endA = flipA ? a[0]! : a[a.length - 1]!;
  const priorA = flipA ? a[1]! : a[a.length - 2]!;
  const startB = flipB ? b[b.length - 1]! : b[0]!;
  const nextB = flipB ? b[b.length - 2]! : b[1]!;
  if (!priorA || !nextB) return null;
  const distance = Math.hypot(endA.x - startB.x, endA.y - startB.y);
  if (distance > JOIN_GAP) return null;
  const outgoing = unitBetween(priorA, endA);
  const incoming = unitBetween(startB, nextB);
  if (outgoing.x * incoming.x + outgoing.y * incoming.y < JOIN_ALIGNMENT) return null;
  return distance;
}

/** Whether the straight bridge between two ends crosses any contour but their own. */
function bridgeIsClear(
  a: readonly Vec[],
  b: readonly Vec[],
  flipA: boolean,
  flipB: boolean,
  lines: readonly ContourLine[],
  skipA: number,
  skipB: number,
): boolean {
  const endA = flipA ? a[0]! : a[a.length - 1]!;
  const startB = flipB ? b[b.length - 1]! : b[0]!;
  for (let i = 0; i < lines.length; i++) {
    if (i === skipA || i === skipB) continue;
    const points = lines[i]!.points;
    for (let k = 0; k < points.length - 1; k++) {
      if (crosses(endA, startB, points[k]!, points[k + 1]!)) return false;
    }
  }
  return true;
}

/** Proper segment intersection. Touching endpoints do not count: contours meet at gaps. */
function crosses(p1: Vec, p2: Vec, q1: Vec, q2: Vec): boolean {
  const side = (a: Vec, b: Vec, c: Vec) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = side(p1, p2, q1);
  const d2 = side(p1, p2, q2);
  const d3 = side(q1, q2, p1);
  const d4 = side(q1, q2, p2);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function unitBetween(a: Vec, b: Vec): Vec {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
}

// ---------------------------------------------------------------------------------------
// Observing which contours are neighbours
// ---------------------------------------------------------------------------------------

interface Edge {
  readonly a: number;
  readonly b: number;
  votes: number;
  /** Observations where the two lines' normals point the same way. */
  agree: number;
  disagree: number;
  /** Which side of `a` that `b` was seen on, summed over observations. */
  sigma: number;
  /** And which side of `b` that `a` was on. */
  reverse: number;
}

function observe(
  lines: readonly ContourLine[],
  index: SegmentIndex,
  maxGap: number,
): Map<string, Edge> {
  const edges = new Map<string, Edge>();
  lines.forEach((line, i) => {
    for (const sample of samplesOf(line.points, SAMPLE_SPACING)) {
      // Both sides of the line at once: what is uphill and what is downhill from here.
      for (const side of [1, -1] as const) {
        const hit = index.nearestOnSide(sample.at, sample.normal, side, i, maxGap);
        if (!hit) continue;
        const a = Math.min(i, hit.line);
        const b = Math.max(i, hit.line);
        const key = `${a}-${b}`;
        const edge = edges.get(key) ?? { a, b, votes: 0, agree: 0, disagree: 0, sigma: 0, reverse: 0 };
        edge.votes++;
        const t = sample.normal.x * hit.normal.x + sample.normal.y * hit.normal.y >= 0 ? 1 : -1;
        if (t === 1) edge.agree++;
        else edge.disagree++;
        // Both sides of the same observation. Seen from i, the other line is on side
        // `side`; seen from the other line, i is on `-side · t`, because t says whether
        // the two lines' normals point the same way. Recorded in the pair's own order.
        const sigmaHere = side;
        const sigmaThere = -side * t;
        if (i === a) {
          edge.sigma += sigmaHere;
          edge.reverse += sigmaThere;
        } else {
          edge.sigma += sigmaThere;
          edge.reverse += sigmaHere;
        }
        edges.set(key, edge);
      }
    }
  });
  return edges;
}

interface Sample {
  readonly at: Vec;
  /** Unit left normal of the line here. The sign convention every `s` is stated in. */
  readonly normal: Vec;
}

function samplesOf(points: readonly Vec[], spacing: number): Sample[] {
  const out: Sample[] = [];
  let carried = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length === 0) continue;
    const ux = (b.x - a.x) / length;
    const uy = (b.y - a.y) / length;
    for (let t = carried; t < length; t += spacing) {
      out.push({ at: { x: a.x + ux * t, y: a.y + uy * t }, normal: { x: -uy, y: ux } });
    }
    carried = ((carried - length) % spacing + spacing) % spacing;
  }
  return out;
}

/** Twice the signed area, and from it whether the left normal points into the ring. */
function inwardSign(points: readonly Vec[]): number {
  const count = points.length - (points.length > 1 &&
    points[0]!.x === points[points.length - 1]!.x &&
    points[0]!.y === points[points.length - 1]!.y ? 1 : 0);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % count]!;
    total += a.x * b.y - b.x * a.y;
  }
  if (total === 0) return 0;
  // Checked against the unit square wound (0,0) (10,0) (10,10) (0,10): its shoelace sum
  // is positive and the left normal of its first segment, (0, 1), points into it. y being
  // down does not change the algebra, only what "clockwise" looks like on screen.
  return total > 0 ? 1 : -1;
}

/**
 * Ticks on the low side of a closed ring, from the ring's own orientation.
 *
 * Not `slopeTagsFor`: that probes a height field to decide which way is down, and here
 * the answer is already known from the graph — probing the surface reconstructed *from
 * these lines* would be asking the lines a question they were just used to answer.
 */
function tagsPointingIn(points: readonly Vec[], inward: number): SlopeTag[] {
  const count = points.length - 1;
  if (count < 3) return [];
  const wanted = Math.min(3, Math.max(1, Math.floor(count / 8)));
  return Array.from({ length: wanted }, (_, k) => {
    const i = Math.floor((k * count) / wanted);
    const before = points[(i - 1 + count) % count]!;
    const after = points[(i + 1) % count]!;
    const length = Math.hypot(after.x - before.x, after.y - before.y) || 1;
    const nx = (-(after.y - before.y) / length) * inward;
    const ny = ((after.x - before.x) / length) * inward;
    return { x: points[i]!.x, y: points[i]!.y, dx: nx, dy: ny };
  });
}

function nearRing(p: Vec, points: readonly Vec[], reach: number): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    if (distanceToSegment(p, points[i]!, points[i + 1]!).distance <= reach) return true;
  }
  return false;
}

interface Nearest {
  readonly line: number;
  readonly normal: Vec;
  readonly sigma: number;
}

/** The main contour nearest to a form line, and which side of it the form line lies on. */
function nearestOf(
  points: readonly Vec[],
  index: SegmentIndex,
  maxGap: number,
): Nearest | undefined {
  for (const sample of samplesOf(points, SAMPLE_SPACING)) {
    const hit = index.nearest(sample.at, maxGap, -1);
    if (!hit) continue;
    // Which side of the found contour this point is on, in that contour's own convention.
    const away = { x: sample.at.x - hit.at.x, y: sample.at.y - hit.at.y };
    const sigma = away.x * hit.normal.x + away.y * hit.normal.y;
    if (sigma === 0) continue;
    return { line: hit.line, normal: hit.normal, sigma };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------
// A grid of segments, so "what is near here" is not a scan of the whole map
// ---------------------------------------------------------------------------------------

interface Hit {
  readonly line: number;
  readonly at: Vec;
  readonly normal: Vec;
  readonly distance: number;
}

/**
 * Every contour segment, bucketed by cell.
 *
 * Without it, finding each sample's neighbours is every sample against every segment:
 * seven thousand by seven thousand on the forest sample, which is a minute of arithmetic
 * for an answer that only ever involves segments within one cell of the sample.
 */
class SegmentIndex {
  readonly #cell: number;
  readonly #buckets = new Map<string, { line: number; a: Vec; b: Vec }[]>();

  constructor(lines: readonly ContourLine[], cell: number) {
    this.#cell = cell;
    lines.forEach((line, i) => {
      for (let k = 0; k < line.points.length - 1; k++) {
        const a = line.points[k]!;
        const b = line.points[k + 1]!;
        const segment = { line: i, a, b };
        // A segment can be longer than a cell, so it is filed under every cell its
        // bounding box touches rather than under its midpoint's.
        const x0 = Math.floor(Math.min(a.x, b.x) / cell);
        const x1 = Math.floor(Math.max(a.x, b.x) / cell);
        const y0 = Math.floor(Math.min(a.y, b.y) / cell);
        const y1 = Math.floor(Math.max(a.y, b.y) / cell);
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const key = `${x},${y}`;
            const bucket = this.#buckets.get(key);
            if (bucket) bucket.push(segment);
            else this.#buckets.set(key, [segment]);
          }
        }
      }
    });
  }

  #around(p: Vec): { line: number; a: Vec; b: Vec }[] {
    const cx = Math.floor(p.x / this.#cell);
    const cy = Math.floor(p.y / this.#cell);
    const out: { line: number; a: Vec; b: Vec }[] = [];
    for (let y = cy - 1; y <= cy + 1; y++) {
      for (let x = cx - 1; x <= cx + 1; x++) {
        const bucket = this.#buckets.get(`${x},${y}`);
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }

  nearest(p: Vec, maxGap: number, exclude: number): Hit | undefined {
    let best: Hit | undefined;
    for (const segment of this.#around(p)) {
      if (segment.line === exclude) continue;
      const found = distanceToSegment(p, segment.a, segment.b);
      if (found.distance > maxGap) continue;
      if (best && found.distance >= best.distance) continue;
      best = {
        line: segment.line,
        at: found.at,
        normal: unitNormal(segment.a, segment.b),
        distance: found.distance,
      };
    }
    return best;
  }

  /** The nearest other contour on one side of a line, `side` being the sign along `normal`. */
  nearestOnSide(p: Vec, normal: Vec, side: number, exclude: number, maxGap: number): Hit | undefined {
    let best: Hit | undefined;
    for (const segment of this.#around(p)) {
      if (segment.line === exclude) continue;
      const found = distanceToSegment(p, segment.a, segment.b);
      if (found.distance > maxGap || found.distance === 0) continue;
      const along = (found.at.x - p.x) * normal.x + (found.at.y - p.y) * normal.y;
      if (Math.sign(along) !== side) continue;
      if (Math.abs(along) < TRANSECT_CONE * found.distance) continue;
      if (best && found.distance >= best.distance) continue;
      best = {
        line: segment.line,
        at: found.at,
        normal: unitNormal(segment.a, segment.b),
        distance: found.distance,
      };
    }
    return best;
  }
}

function unitNormal(a: Vec, b: Vec): Vec {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
}

export function distanceToSegment(p: Vec, a: Vec, b: Vec): { at: Vec; distance: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0
    ? 0
    : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  const at = { x: a.x + t * dx, y: a.y + t * dy };
  return { at, distance: Math.hypot(p.x - at.x, p.y - at.y) };
}

// ---------------------------------------------------------------------------------------
// Union-find that carries a parity
// ---------------------------------------------------------------------------------------

/**
 * "These two face the same way" and "these two face opposite ways", solved together.
 *
 * Ordinary union-find answers "are these connected"; the relation here is `s(a) = ±s(b)`,
 * which is connectivity plus one bit. Carrying the parity to the root turns a whole
 * hillside of local observations into one consistent orientation, and makes a
 * contradiction — a cycle whose parities do not close — something the algorithm notices
 * rather than something it averages away.
 */
class ParityUnion {
  readonly #parent: number[];
  readonly #parity: number[];

  constructor(size: number) {
    this.#parent = Array.from({ length: size }, (_, i) => i);
    this.#parity = new Array<number>(size).fill(0);
  }

  find(i: number): { root: number; parity: number } {
    if (this.#parent[i] === i) return { root: i, parity: 0 };
    const up = this.find(this.#parent[i]!);
    this.#parent[i] = up.root;
    this.#parity[i] = (this.#parity[i]! + up.parity) % 2;
    return { root: up.root, parity: this.#parity[i]! };
  }

  /** Returns false when the claim contradicts what is already known. */
  union(a: number, b: number, parity: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra.root === rb.root) return (ra.parity + rb.parity) % 2 === parity % 2;
    this.#parent[rb.root] = ra.root;
    this.#parity[rb.root] = (ra.parity + rb.parity + parity) % 2;
    return true;
  }
}
