import type { Contour } from '@/lib/terrain/contours.ts';
import type { Grid } from '@/lib/terrain/height.ts';
import type { Feature, Vec } from '@/lib/terrain/omap.ts';
import { ContourRelief, GridRelief, NoRelief, type Relief } from '@/lib/terrain/relief.ts';
import { assignLevels, type ContourLine } from './levels.ts';

/**
 * Stage three: give the map a height field, or say it has none.
 *
 * Best first, exactly as §1.4 of the design note orders them — a DEM if one was supplied,
 * else the contour lines with levels reconstructed from the drawing, else nothing. The
 * third outcome is a real one and not a failure to handle: a map with no relief still
 * serves two of the three terrain drills, and the provider is what declines it for the
 * third.
 */
export interface ReliefOptions {
  /** A DEM sampled over the map's own square extent, if one was supplied. */
  readonly dem?: Grid;
  /** Metres between ordinary contours. ISOM's standard is 5, and no file states it. */
  readonly interval?: number;
  /** Resolution of the grid rasterised from contour lines. */
  readonly resolution?: number;
}

export interface ReliefResult {
  readonly relief: Relief;
  /** What happened, for the pipeline to print. Always set, including on success. */
  readonly note: string;
}

/**
 * Samples a side for the grid reconstructed from contours.
 *
 * 128 over a 550 m map is four metres, which is about the interval's own resolution: the
 * lines are five metres apart vertically and tens of metres apart on the ground, and a
 * finer grid would be inventing detail that the drawing does not contain. `readGround`
 * samples at 96 and the shading at 148, so this is the same order as both.
 */
const DEFAULT_RESOLUTION = 128;

/** Codes that are contour lines, and what each one is. */
const CONTOUR_CODES: Readonly<Record<string, 'ordinary' | 'index' | 'form'>> = {
  '101': 'ordinary',
  '102': 'index',
  '103': 'form',
};

/** 101.1 — the tick on the low side, and the only mark that says which way is up. */
const SLOPE_CODE = '101.1';

/** Two ends this close mean a ring that closes rather than a line that stops. */
const CLOSING_TOLERANCE = 0.5;

export function attachRelief(
  features: readonly Feature[],
  size: number,
  options: ReliefOptions = {},
): ReliefResult {
  if (options.dem) {
    return { relief: new GridRelief(options.dem), note: `DEM, ${options.dem.n} samples a side` };
  }

  const lines: ContourLine[] = [];
  const slopeMarks: Vec[] = [];
  for (const feature of features) {
    if (feature.code === SLOPE_CODE) {
      const g = feature.geometry;
      if (g.kind === 'point') slopeMarks.push(g.at);
      else if (g.kind === 'polyline' && g.points[0]) slopeMarks.push(g.points[0]);
      continue;
    }
    const role = CONTOUR_CODES[feature.code];
    if (!role || feature.geometry.kind !== 'polyline') continue;
    const points = feature.geometry.points;
    if (points.length < 2) continue;
    const first = points[0]!;
    const last = points[points.length - 1]!;
    lines.push({
      points,
      closed: Math.hypot(first.x - last.x, first.y - last.y) <= CLOSING_TOLERANCE,
      index: role === 'index',
      form: role === 'form',
    });
  }

  if (lines.length === 0) {
    return { relief: new NoRelief(size), note: 'no contour lines and no DEM' };
  }

  const assigned = assignLevels(lines, {
    ...(options.interval === undefined ? {} : { interval: options.interval }),
    slopeMarks,
  });
  if (!assigned.ok) {
    return { relief: new NoRelief(size), note: `contour levels unresolved: ${assigned.reason}` };
  }

  const resolution = options.resolution ?? DEFAULT_RESOLUTION;
  const grid = rasteriseContours(assigned.contours, size, resolution, assigned.interval);
  return {
    relief: new ContourRelief({ interval: assigned.interval, lines: assigned.contours, grid }),
    note: `${assigned.contours.length} contours at ${assigned.interval} m, ` +
      `${(grid.max - grid.min).toFixed(1)} m of relief`,
  };
}

// ---------------------------------------------------------------------------------------
// A height field from lines
// ---------------------------------------------------------------------------------------

/** Sweeps of relaxation at each resolution. Enough to settle; it is an offline stage. */
const SWEEPS = 260;

/** The coarsest grid the solve starts on. */
const COARSEST = 8;

/**
 * A grid interpolated between contour lines.
 *
 * The lines are the boundary condition and everything between them is the smoothest
 * surface that fits — Laplace, solved by relaxation. That is the standard
 * DEM-from-contours method and it is chosen here for what it does **not** do: it invents
 * no detail. Between two lines it gives an even slope, over a summit a dome, and in a
 * flat-bottomed hollow a flat bottom. A map's contours say nothing finer than that, and a
 * reconstruction that pretended otherwise would put ground on the card that nobody
 * surveyed.
 *
 * Solved coarse to fine. Relaxation moves information one cell per sweep, so on a 128-grid
 * a summit twenty cells from its nearest contour needs hundreds of sweeps to hear about
 * it; starting at 8 and doubling, each level begins from an answer that is already nearly
 * right and only has to sharpen it. Same result, a fraction of the arithmetic.
 *
 * ## Summits, which Laplace cannot give
 *
 * A harmonic function has **no interior maximum**: that is the maximum principle, and it
 * says that the smoothest surface fitting a set of rings gives every hill a flat top at
 * the level of its innermost ring, and every hollow a flat floor. Mesas, not hills — and
 * worse than ugly, because `analyse` looks for local maxima to find ground worth warping
 * and a plateau has none. The forest sample came out with two landform candidates on
 * seventy metres of relief.
 *
 * So the innermost rings get a point of their own, `SUMMIT_RISE` of an interval above (or
 * below) the ring, at the point furthest inside it. Half an interval is what a ring says
 * about the ground it encloses — somewhere between this level and the next — and the
 * result is a dome rather than a guess at a peak that the surveyor did not record.
 */
/** How far above its innermost ring a summit is lifted, as a fraction of the interval. */
const SUMMIT_RISE = 0.6;

export function rasteriseContours(
  contours: readonly Contour[],
  size: number,
  n: number,
  interval: number,
): Grid {
  const summits = summitsOf(contours, interval);
  let values: Float32Array | null = null;
  let at = COARSEST;
  for (;;) {
    const resolution = Math.min(at, n);
    const seeded = values ? upsample(values, at / 2, resolution) : null;
    values = solve(contours, summits, size, resolution, seeded);
    if (resolution >= n) break;
    at *= 2;
  }

  const solved = values!;
  let min = Infinity;
  let max = -Infinity;
  for (const v of solved) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { n, size, values: solved, min, max };
}

interface Summit {
  readonly at: Vec;
  readonly level: number;
}

function solve(
  contours: readonly Contour[],
  summits: readonly Summit[],
  size: number,
  n: number,
  seeded: Float32Array | null,
): Float32Array {
  const width = n + 1;
  const values = new Float32Array(width * width);
  const fixed = new Uint8Array(width * width);
  const step = size / n;

  // Stamp the lines. A vertex lands on the nearest node, and a long segment is walked at
  // half a cell so a contour cannot slip between two nodes and leave the grid unconstrained
  // along its whole length.
  const sums = new Float64Array(width * width);
  const counts = new Uint16Array(width * width);
  for (const contour of contours) {
    for (let i = 0; i < contour.points.length - 1; i++) {
      const a = contour.points[i]!;
      const b = contour.points[i + 1]!;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil((length / step) * 2));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const x = Math.round((a.x + (b.x - a.x) * t) / step);
        const y = Math.round((a.y + (b.y - a.y) * t) / step);
        if (x < 0 || y < 0 || x > n || y > n) continue;
        const index = y * width + x;
        sums[index] = (sums[index] ?? 0) + contour.level;
        counts[index] = (counts[index] ?? 0) + 1;
      }
    }
  }
  for (const summit of summits) {
    const x = Math.round(summit.at.x / step);
    const y = Math.round(summit.at.y / step);
    if (x < 0 || y < 0 || x > n || y > n) continue;
    const index = y * width + x;
    // The summit overrides rather than averages: it is the one statement about ground the
    // lines do not cover, and letting a nearby ring vote it back down is the flat top.
    sums[index] = summit.level;
    counts[index] = 1;
  }

  for (let i = 0; i < values.length; i++) {
    if (counts[i]! === 0) continue;
    // Two lines through one cell average, which is what a four-metre grid does to a
    // re-entrant narrower than four metres. Better than whichever was stamped last.
    values[i] = sums[i]! / counts[i]!;
    fixed[i] = 1;
  }

  if (seeded) {
    for (let i = 0; i < values.length; i++) if (fixed[i] === 0) values[i] = seeded[i]!;
  } else {
    // Nothing known yet: start everything at the mean of the lines, so the first sweeps
    // are pulling the surface into shape rather than dragging it up from zero.
    let total = 0;
    let count = 0;
    for (let i = 0; i < values.length; i++) {
      if (fixed[i] === 1) {
        total += values[i]!;
        count++;
      }
    }
    const mean = count > 0 ? total / count : 0;
    for (let i = 0; i < values.length; i++) if (fixed[i] === 0) values[i] = mean;
  }

  // Gauss-Seidel, in place: each node becomes the average of its neighbours. The edges of
  // the grid mirror rather than wrap — a wrapped edge invents a cliff along two sides of
  // every map, which is the same mistake `Relief.tsx` avoids in its shading.
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const index = j * width + i;
        if (fixed[index] === 1) continue;
        const left = values[j * width + (i > 0 ? i - 1 : 1)]!;
        const right = values[j * width + (i < n ? i + 1 : n - 1)]!;
        const up = values[(j > 0 ? j - 1 : 1) * width + i]!;
        const down = values[(j < n ? j + 1 : n - 1) * width + i]!;
        values[index] = (left + right + up + down) / 4;
      }
    }
  }

  return values;
}

/**
 * The innermost closed rings, and a point inside each with the height the ring implies.
 *
 * A ring is innermost when no other contour has a vertex inside it — the whole nesting
 * test the design note asks for, done once here rather than as a tree, because only the
 * leaves of that tree are wanted. Whether it is a knoll or a hollow is already recorded
 * on the ring: its slope tags point downhill, so a ring that carries them encloses lower
 * ground.
 */
function summitsOf(contours: readonly Contour[], interval: number): Summit[] {
  const rings = contours.filter((c) => c.closed && !c.form && c.points.length >= 4);
  const summits: Summit[] = [];
  for (const ring of rings) {
    const holdsAnother = contours.some(
      (other) => other !== ring && other.points[0] && insideRing(other.points[0], ring.points),
    );
    if (holdsAnother) continue;
    const inside = deepestPoint(ring.points);
    if (!inside) continue;
    const rise = (ring.tags.length > 0 ? -1 : 1) * SUMMIT_RISE * interval;
    summits.push({ at: inside, level: ring.level + rise });
  }
  return summits;
}

/**
 * A point well inside a ring: the vertex-average when that lands inside, else the
 * midpoint of the widest chord that does. A crescent-shaped ring has neither, and gets no
 * summit rather than one placed outside itself.
 */
function deepestPoint(points: readonly Vec[]): Vec | undefined {
  const count = points.length - 1;
  let x = 0;
  let y = 0;
  for (let i = 0; i < count; i++) {
    x += points[i]!.x;
    y += points[i]!.y;
  }
  const centroid = { x: x / count, y: y / count };
  if (insideRing(centroid, points)) return centroid;
  for (let i = 0; i < count; i++) {
    const opposite = points[(i + Math.floor(count / 2)) % count]!;
    const middle = { x: (points[i]!.x + opposite.x) / 2, y: (points[i]!.y + opposite.y) / 2 };
    if (insideRing(middle, points)) return middle;
  }
  return undefined;
}

/** Even-odd point in ring. */
function insideRing(p: Vec, ring: readonly Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Bilinear resample of a solved grid onto the next resolution up. */
function upsample(values: Float32Array, from: number, to: number): Float32Array {
  const out = new Float32Array((to + 1) * (to + 1));
  const scale = from / to;
  for (let j = 0; j <= to; j++) {
    for (let i = 0; i <= to; i++) {
      const x = Math.min(from, i * scale);
      const y = Math.min(from, j * scale);
      const x0 = Math.min(from - 1, Math.floor(x));
      const y0 = Math.min(from - 1, Math.floor(y));
      const fx = x - x0;
      const fy = y - y0;
      const value = (a: number, b: number) => values[b * (from + 1) + a]!;
      const top = value(x0, y0) * (1 - fx) + value(x0 + 1, y0) * fx;
      const bottom = value(x0, y0 + 1) * (1 - fx) + value(x0 + 1, y0 + 1) * fx;
      out[j * (to + 1) + i] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// A DEM from a file
// ---------------------------------------------------------------------------------------

/**
 * An Esri ASCII grid (`.asc`), the format every mapping agency and every GIS can write.
 *
 * Read here rather than in the script because the script must stay a thin shell over
 * tested functions — and because a DEM that is silently misaligned with its map is a
 * height field that describes the wrong hillside, which is the one failure a person
 * cannot spot on a contact sheet.
 *
 * The grid is resampled onto the map's own square extent: `Relief.sampleGrid` hands back a
 * square `Grid` and every drill's window is square, so a DEM that covers more, less, or a
 * differently placed piece of ground has to be brought onto the map before it is one.
 */
export interface AsciiGrid {
  readonly ncols: number;
  readonly nrows: number;
  readonly xllcorner: number;
  readonly yllcorner: number;
  readonly cellsize: number;
  readonly nodata: number;
  readonly values: Float32Array;
}

export function parseAsciiGrid(text: string): AsciiGrid {
  const tokens = text.trim().split(/\s+/);
  const header: Record<string, number> = {};
  let at = 0;
  while (at + 1 < tokens.length && Number.isNaN(Number(tokens[at]))) {
    header[tokens[at]!.toLowerCase()] = Number(tokens[at + 1]);
    at += 2;
  }
  const need = (name: string): number => {
    const value = header[name];
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(`asc: no ${name} in the header`);
    }
    return value;
  };
  const ncols = need('ncols');
  const nrows = need('nrows');
  // xllcenter/yllcenter are the other spelling; half a cell out is half a cell out.
  const xllcorner = header['xllcorner'] ?? (header['xllcenter'] ?? 0) - (header['cellsize'] ?? 0) / 2;
  const yllcorner = header['yllcorner'] ?? (header['yllcenter'] ?? 0) - (header['cellsize'] ?? 0) / 2;
  const cellsize = need('cellsize');
  const nodata = header['nodata_value'] ?? -9999;

  const values = new Float32Array(ncols * nrows);
  if (tokens.length - at < values.length) {
    throw new Error(`asc: ${tokens.length - at} values for ${ncols}x${nrows}`);
  }
  for (let i = 0; i < values.length; i++) values[i] = Number(tokens[at + i]);
  return { ncols, nrows, xllcorner, yllcorner, cellsize, nodata, values };
}

/**
 * An ASCII grid onto the map's square extent.
 *
 * `origin` is where the map's (0, 0) sits in the DEM's own coordinates. An `.asc` counts
 * rows from the top and its y axis points **up**, while a map's points down, so the row
 * index is flipped here — get it wrong and every hill becomes the valley beside it, which
 * looks entirely plausible until someone who knows the forest sees it.
 */
export function gridFromAscii(
  asc: AsciiGrid,
  size: number,
  n: number,
  origin: Vec = { x: asc.xllcorner, y: asc.yllcorner + asc.nrows * asc.cellsize },
): Grid {
  const values = new Float32Array((n + 1) * (n + 1));
  const step = size / n;
  let min = Infinity;
  let max = -Infinity;
  let seen = 0;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const worldX = origin.x + i * step;
      const worldY = origin.y - j * step;
      const column = Math.round((worldX - asc.xllcorner) / asc.cellsize);
      const row = Math.round((asc.yllcorner + asc.nrows * asc.cellsize - worldY) / asc.cellsize);
      let height = 0;
      if (column >= 0 && column < asc.ncols && row >= 0 && row < asc.nrows) {
        const sample = asc.values[row * asc.ncols + column]!;
        if (sample !== asc.nodata) {
          height = sample;
          seen++;
        }
      }
      values[j * (n + 1) + i] = height;
      if (height < min) min = height;
      if (height > max) max = height;
    }
  }
  if (seen === 0) throw new Error('asc: the DEM does not cover the map at all');
  return { n, size, values, min, max };
}
