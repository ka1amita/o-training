import type { Grid } from './height.ts';
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
  // Segments are indexed by their start point, so following a line is a lookup rather
  // than a scan; a full scan per step is what makes a naive version quadratic and slow
  // enough to be felt on a phone.
  const bySource = new Map<string, [Vec, Vec][]>();
  for (const segment of segments) {
    const k = key(segment[0]);
    const list = bySource.get(k);
    if (list) list.push(segment);
    else bySource.set(k, [segment]);
  }

  const used = new Set<[Vec, Vec]>();
  const contours: Contour[] = [];

  const take = (from: Vec): [Vec, Vec] | undefined => {
    const list = bySource.get(key(from));
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
      const next = take(points[points.length - 1]!);
      if (!next) break;
      if (key(next[1]) === key(points[0]!)) {
        points.push(next[1]);
        closed = true;
        break;
      }
      points.push(next[1]);
    }
    contours.push({ level, points, closed });
  }

  return contours;
}

export interface ContourOptions {
  /** Vertical distance between lines, in metres. */
  readonly interval: number;
  /** Grid resolution used to trace them. */
  readonly resolution: number;
}

export function contoursOf(grid: Grid, options: ContourOptions): Contour[] {
  const { interval } = options;
  const out: Contour[] = [];
  const first = Math.ceil(grid.min / interval) * interval;
  for (let level = first; level < grid.max; level += interval) {
    // A level landing exactly on a plateau produces degenerate cells; nudging it off the
    // sample values costs nothing visually and avoids the whole class.
    out.push(...stitch(marchingSquares(grid, level + interval * 1e-3), level));
  }
  return out;
}
