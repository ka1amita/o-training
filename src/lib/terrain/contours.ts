import { sampleGridAt, type Grid } from './height.ts';
import { CONTOUR } from './isom.ts';
import type { Vec } from './terrain.ts';

/**
 * Contours by marching squares.
 *
 * Segments are emitted per cell and then stitched into polylines, because a contour drawn
 * as a thousand disconnected segments cannot be dashed, thickened for an index contour,
 * or drawn with joins that meet — and it is the *shape* of a contour that this drill is
 * about reading.
 */
export interface Contour {
  readonly level: number;
  readonly points: readonly Vec[];
  readonly closed: boolean;
  /** 102: every fifth line is drawn heavier, so height can be counted at a glance. */
  readonly index: boolean;
  /** 103: a half-interval line, drawn dashed. */
  readonly form: boolean;
  /**
   * 101.1 slope lines, on the downhill side.
   *
   * Only closed depressions carry them, and they are not decoration: without a tag, a
   * knoll and a hollow are *the same picture*. The contours drill asks which ground a
   * card describes and, until this existed, handed out cards that could not say.
   */
  readonly tags: readonly SlopeTag[];
}

/** A tick at `x, y` pointing downhill along `dx, dy` (unit length). */
export interface SlopeTag {
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
}

/**
 * Which edges the line crosses, per corner-above-level mask.
 *
 * Corner bits: 1 = top-left, 2 = top-right, 4 = bottom-right, 8 = bottom-left.
 * Edges: 0 = top (TL-TR), 1 = right (TR-BR), 2 = bottom (BL-BR), 3 = left (TL-BL).
 *
 * **Direction is the point of this table, not the pairing.** Which two edges a line
 * crosses follows from the mask alone; each pair here is ordered so that higher ground
 * lies to the *left* of travel, which is what makes neighbouring cells emit segments that
 * continue each other head-to-tail, so stitching is a lookup rather than a search. A
 * table with the right pairs and arbitrary directions produces the correct picture and
 * cannot be stitched at all — which is how this was first written.
 *
 * Complementary masks are mirror images: 1 is [3,0] and 14 is [0,3], and so on down.
 */
const CASES: readonly (readonly [number, number][])[] = [
  [],           // 0000  nothing above
  [[3, 0]],     // 0001  TL
  [[0, 1]],     // 0010  TR
  [[3, 1]],     // 0011  TL TR
  [[1, 2]],     // 0100  BR
  [],           // 0101  TL BR    saddle, resolved below
  [[0, 2]],     // 0110  TR BR
  [[3, 2]],     // 0111  TL TR BR
  [[2, 3]],     // 1000  BL
  [[2, 0]],     // 1001  TL BL
  [],           // 1010  TR BL    saddle, resolved below
  [[2, 1]],     // 1011  TL TR BL
  [[1, 3]],     // 1100  BR BL
  [[1, 0]],     // 1101  TL BR BL
  [[0, 3]],     // 1110  TR BR BL
  [],           // 1111  everything above
];

/** Where along an edge the level falls, linearly. */
const cut = (a: number, b: number, level: number): number =>
  a === b ? 0.5 : (level - a) / (b - a);

export function marchingSquares(grid: Grid, level: number): [Vec, Vec][] {
  const { n, values, size } = grid;
  const step = size / n;
  const at = (i: number, j: number) => values[j * (n + 1) + i]!;
  const segments: [Vec, Vec][] = [];

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const tl = at(i, j);
      const tr = at(i + 1, j);
      const br = at(i + 1, j + 1);
      const bl = at(i, j + 1);

      let mask = 0;
      if (tl > level) mask |= 1;
      if (tr > level) mask |= 2;
      if (br > level) mask |= 4;
      if (bl > level) mask |= 8;

      let pairs = CASES[mask]!;
      if (pairs.length === 0) continue;

      // A saddle has two readings and picking wrong joins the wrong corners, which draws
      // contours that cross. The cell's mean decides which pair the high ground connects,
      // and the directions follow the same left-hand rule as the rest of the table.
      if (mask === 5 || mask === 10) {
        const high = (tl + tr + br + bl) / 4 > level;
        if (mask === 5) {
          // TL and BR are above. If the middle is too they are one region and the two
          // low corners are the islands; otherwise TL and BR are islands themselves.
          pairs = high ? [[1, 0], [3, 2]] : [[3, 0], [1, 2]];
        } else {
          pairs = high ? [[0, 3], [2, 1]] : [[0, 1], [2, 3]];
        }
      }

      const x0 = i * step;
      const y0 = j * step;
      const point = (edge: number): Vec => {
        switch (edge) {
          case 0: return { x: x0 + cut(tl, tr, level) * step, y: y0 };
          case 1: return { x: x0 + step, y: y0 + cut(tr, br, level) * step };
          case 2: return { x: x0 + cut(bl, br, level) * step, y: y0 + step };
          default: return { x: x0, y: y0 + cut(tl, bl, level) * step };
        }
      };

      for (const [from, to] of pairs) segments.push([point(from), point(to)]);
    }
  }
  return segments;
}

/** Endpoints are compared at this precision when stitching. */
const KEY_PRECISION = 1e6;
const key = (p: Vec) =>
  `${Math.round(p.x * KEY_PRECISION)},${Math.round(p.y * KEY_PRECISION)}`;

export function stitch(segments: readonly [Vec, Vec][], level: number): Contour[] {
  // Segments are indexed by their endpoints, so following a line is a lookup rather
  // than a scan; a full scan per step is what makes a naive version quadratic and slow
  // enough to be felt on a phone.
  //
  // **Both ends are indexed, and a chain is walked in both directions.** Following only
  // forwards recovers a closed loop from any starting segment, but shreds an open one:
  // the outer loop meets segments in row-major cell order, so a contour that runs off the
  // map is usually entered somewhere in its middle, and everything upstream is then met
  // later as orphan pieces. On a 300 m map that turned one contour into 161 paths — each
  // with its own caps, its own dash phase, and its own cost.
  const bySource = new Map<string, [Vec, Vec][]>();
  const byTarget = new Map<string, [Vec, Vec][]>();
  for (const segment of segments) {
    const from = key(segment[0]);
    const to = key(segment[1]);
    (bySource.get(from) ?? bySource.set(from, []).get(from)!).push(segment);
    (byTarget.get(to) ?? byTarget.set(to, []).get(to)!).push(segment);
  }

  const used = new Set<[Vec, Vec]>();
  const contours: Contour[] = [];

  const take = (index: Map<string, [Vec, Vec][]>, at: Vec): [Vec, Vec] | undefined => {
    const list = index.get(key(at));
    if (!list) return undefined;
    const found = list.find((s) => !used.has(s));
    if (found) used.add(found);
    return found;
  };

  for (const segment of segments) {
    if (used.has(segment)) continue;
    used.add(segment);

    const points: Vec[] = [segment[0], segment[1]];
    let closed = false;
    // Bounded by the segment count: a cycle re-entering its own start closes, and
    // anything else runs out of unused segments.
    for (let guard = 0; guard <= segments.length; guard++) {
      const next = take(bySource, points[points.length - 1]!);
      if (!next) break;
      if (key(next[1]) === key(points[0]!)) {
        points.push(next[1]);
        closed = true;
        break;
      }
      points.push(next[1]);
    }

    if (!closed) {
      // Walk upstream. Collected then reversed rather than unshifted, which would make
      // extending a long contour quadratic in its own length.
      const head: Vec[] = [];
      for (let guard = 0; guard <= segments.length; guard++) {
        const previous = take(byTarget, head[head.length - 1] ?? points[0]!);
        if (!previous) break;
        head.push(previous[0]);
      }
      head.reverse();
      points.unshift(...head);
    }

    contours.push({ level, points, closed, index: false, form: false, tags: [] });
  }

  return contours;
}

/**
 * Twice the enclosed area, signed. Positive means the interior lies left of travel.
 *
 * `count` is the number of *distinct* vertices: a closed contour repeats its first point
 * at the end, and treating that copy as a vertex of its own makes the wrap-around at
 * index 0 look one point behind where it is.
 */
function signedArea(points: readonly Vec[], count: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % count]!;
    total += a.x * b.y - b.x * a.y;
  }
  return total;
}

/** How many ticks a loop of this size gets. Two on a big hollow, one on a small one. */
const tagCount = (perimeter: number, size: number): number =>
  perimeter > size * 0.9 ? 3 : perimeter > size * 0.35 ? 2 : 1;

/**
 * Slope tags for a closed contour, or none if it encloses high ground.
 *
 * The inward direction comes from the polygon's own orientation and the verdict from
 * sampling the field there — deliberately **not** from the direction convention in
 * `CASES`. Reading the height at a point inside the loop is a fact; the table's handedness
 * is an invariant that a future edit could break silently, and this is one of the two
 * things that make a relief card answerable.
 */
export function slopeTagsFor(contour: Contour, grid: Grid): SlopeTag[] {
  if (!contour.closed || contour.points.length < 4) return [];

  const points = contour.points;
  // The closing point is a copy of the first. Counting it as a vertex gives vertex 0 a
  // "previous" point equal to itself, so its normal comes from a one-sided difference —
  // a small error on a long ring and a 45-degree one on the four-segment ring at the very
  // bottom of a hollow, which was the one contour that never got its tags.
  const count = points.length - 1;
  const leftIsInside = signedArea(points, count) > 0;

  let perimeter = 0;
  for (let i = 1; i < points.length; i++) {
    perimeter += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }

  // The probe has to be short against the loop it is probing. A fixed grid step steps
  // clean over the innermost ring of a hollow — four segments round a single cell — and
  // out the far side, where the ground is higher, so the tightest and most obviously
  // hollow contour on the map was the one left untagged.
  const step = Math.min(grid.size / grid.n, perimeter / 12);

  const normalAt = (i: number) => {
    const before = points[(i - 1 + count) % count]!;
    const after = points[(i + 1) % count]!;
    const tx = after.x - before.x;
    const ty = after.y - before.y;
    const length = Math.hypot(tx, ty) || 1;
    const nx = -ty / length;
    const ny = tx / length;
    return leftIsInside ? { x: nx, y: ny } : { x: -nx, y: -ny };
  };

  // A vote rather than a single probe: one vertex can sit beside a neighbouring feature
  // whose ground runs the other way, and a lone bad sample would tag a knoll.
  //
  // Each probe is compared with **its own vertex**, not with `contour.level`. The line was
  // traced at the level nudged off the sample values, so the innermost ring of a hollow
  // lies entirely within that nudge of the stored level and every probe read as higher
  // than it — the contour most obviously a hollow was the one that failed the vote.
  let inside = 0;
  const votes = Math.min(count, 8);
  for (let v = 0; v < votes; v++) {
    const i = Math.floor((v * count) / votes);
    const p = points[i]!;
    const n = normalAt(i);
    const here = sampleGridAt(grid, p.x, p.y);
    if (sampleGridAt(grid, p.x + n.x * step, p.y + n.y * step) < here) inside++;
  }
  if (inside <= votes / 2) return [];

  const tags = tagCount(perimeter, grid.size);
  return Array.from({ length: tags }, (_, k) => {
    const i = Math.floor((k * count) / tags);
    const p = points[i]!;
    const n = normalAt(i);
    return { x: p.x, y: p.y, dx: n.x, dy: n.y };
  });
}

export interface ContourOptions {
  /** Vertical distance between lines, in metres. */
  readonly interval: number;
  /** Grid resolution used to trace them. */
  readonly resolution: number;
  /** 103: add half-interval lines where the ground is too gentle for an ordinary one. */
  readonly formLines?: boolean;
}

/**
 * Steepest ground a form line may cross, in metres per metre.
 *
 * A form line says "there is shape here the interval missed". Drawn on a slope that
 * already carries contours it says nothing and doubles the ink, which is the difference
 * between detail and clutter.
 */
const FORM_LINE_MAX_SLOPE = 0.1;

/**
 * Longest a form line may run, as a fraction of the map.
 *
 * Gentle ground is *everywhere* on a gently tilted map, so a slope test alone kept every
 * half-interval line and drew one down the whole card between each pair of contours —
 * which does not say "there is a feature here", it says the interval should have been
 * 2.5 m. A form line describes one small thing, so it is short, or it is a closed loop
 * around that thing.
 */
const FORM_LINE_MAX_LENGTH = 0.4;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
}

export function contoursOf(grid: Grid, options: ContourOptions): Contour[] {
  const { interval } = options;
  const out: Contour[] = [];
  const step = grid.size / grid.n;

  const trace = (level: number, form: boolean) => {
    // A level landing exactly on a plateau produces degenerate cells; nudging it off the
    // sample values costs nothing visually and avoids the whole class.
    const traced = stitch(marchingSquares(grid, level + interval * 1e-3), level);
    for (const contour of traced) {
      const index = !form && Math.round(level / interval) % CONTOUR.indexEvery === 0;
      const tags = form ? [] : slopeTagsFor(contour, grid);
      out.push({ ...contour, index, form, tags });
    }
  };

  const first = Math.ceil(grid.min / interval) * interval;
  for (let level = first; level < grid.max; level += interval) trace(level, false);

  if (options.formLines) {
    const kept: Contour[] = [];
    const before = out.length;
    for (let level = first - interval / 2; level < grid.max; level += interval) {
      if (level <= grid.min) continue;
      trace(level, true);
    }
    // Keep only the gentle, local ones. Slope is sampled along the line itself, so a form
    // line that starts in a hollow and runs up a bank is judged by where most of it lies.
    for (let i = before; i < out.length; i++) {
      const contour = out[i]!;
      let length = 0;
      for (let k = 1; k < contour.points.length; k++) {
        const a = contour.points[k - 1]!;
        const b = contour.points[k]!;
        length += Math.hypot(b.x - a.x, b.y - a.y);
      }
      if (!contour.closed && length > grid.size * FORM_LINE_MAX_LENGTH) continue;
      const slopes = contour.points.map((p) => {
        const dx = (sampleGridAt(grid, p.x + step, p.y) - sampleGridAt(grid, p.x - step, p.y));
        const dy = (sampleGridAt(grid, p.x, p.y + step) - sampleGridAt(grid, p.x, p.y - step));
        return Math.hypot(dx, dy) / (2 * step);
      });
      if (median(slopes) <= FORM_LINE_MAX_SLOPE) kept.push(contour);
    }
    out.length = before;
    out.push(...kept);
  }

  return out;
}
