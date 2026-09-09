import type { Landform, Relief } from './relief.ts';

/**
 * Height is the sum of the landforms, each a smooth bump with **compact support**: it is
 * exactly zero past its own radius.
 *
 * A Gaussian would be smoother and wrong for this app. With unbounded falloff, moving one
 * knoll changes the height everywhere by a little, so a "one feature nudged" distractor
 * differs from the answer across the whole map — the opposite of the drill. Compact
 * support keeps a local change local.
 */
export function bump(distance: number): number {
  if (distance >= 1) return 0;
  const t = 1 - distance * distance;
  return t * t;
}

export function contributionOf(f: Landform, x: number, y: number): number {
  // Into the feature's own frame: rotate, then squash along one axis so a spur is an
  // elongated ridge rather than a round hill.
  const cos = Math.cos(-f.rotation);
  const sin = Math.sin(-f.rotation);
  const dx = x - f.x;
  const dy = y - f.y;
  const lx = (dx * cos - dy * sin) / f.elongation;
  const ly = dx * sin + dy * cos;
  return f.amplitude * bump(Math.hypot(lx, ly) / f.radius);
}

export interface Grid {
  /** Samples per side. The array holds (n + 1)^2 values, row-major from the top-left. */
  readonly n: number;
  readonly size: number;
  readonly values: Float32Array;
  readonly min: number;
  readonly max: number;
}

/**
 * The loop every `Relief` samples itself with, given only `heightAt` and an extent.
 *
 * It lives here rather than on the interface so a source that has no analytic height
 * function — a DEM, which *is* a grid — can hand its own array over instead of being made
 * to answer a million point queries to rebuild what it already had.
 */
export function heightGrid(
  source: { heightAt(x: number, y: number): number },
  size: number,
  n: number,
): Grid {
  const values = new Float32Array((n + 1) * (n + 1));
  const step = size / n;
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const h = source.heightAt(i * step, j * step);
      values[j * (n + 1) + i] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  return { n, size, values, min, max };
}

/** `(n + 1)^2` samples of a relief over its own extent. */
export const sampleGrid = (relief: Relief, n: number): Grid => relief.sampleGrid(n);

/** Bilinear sample of a traced grid, in metres. Outside the grid it clamps to the edge. */
export function sampleGridAt(grid: Grid, x: number, y: number): number {
  const { n, size, values } = grid;
  const step = size / n;
  const gx = Math.min(n, Math.max(0, x / step));
  const gy = Math.min(n, Math.max(0, y / step));
  const i = Math.min(n - 1, Math.floor(gx));
  const j = Math.min(n - 1, Math.floor(gy));
  const fx = gx - i;
  const fy = gy - j;
  const at = (a: number, b: number) => values[b * (n + 1) + a]!;
  const top = at(i, j) * (1 - fx) + at(i + 1, j) * fx;
  const bottom = at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Gradient magnitude in metres per metre, by central differences on the grid. */
export function slopeAt(grid: Grid, x: number, y: number): number {
  const step = grid.size / grid.n;
  const dx = (sampleGridAt(grid, x + step, y) - sampleGridAt(grid, x - step, y)) / (2 * step);
  const dy = (sampleGridAt(grid, x, y + step) - sampleGridAt(grid, x, y - step)) / (2 * step);
  return Math.hypot(dx, dy);
}

/** Downhill unit vector. Zero-length on a perfect flat, which callers must tolerate. */
export function downhillAt(grid: Grid, x: number, y: number): { x: number; y: number } {
  const step = grid.size / grid.n;
  const dx = (sampleGridAt(grid, x + step, y) - sampleGridAt(grid, x - step, y)) / (2 * step);
  const dy = (sampleGridAt(grid, x, y + step) - sampleGridAt(grid, x, y - step)) / (2 * step);
  const length = Math.hypot(dx, dy);
  return length === 0 ? { x: 0, y: 0 } : { x: -dx / length, y: -dy / length };
}

/**
 * The largest height difference between two reliefs over a sampled grid.
 *
 * This is what "the distractor is actually different" means for a drill read off the
 * relief, and it is why a relief drill's edit has to be a warp: moving a boulder leaves
 * this at zero.
 */
export function maxHeightDifference(a: Relief, b: Relief, n = 32): number {
  const left = a.sampleGrid(n).values;
  const right = b.sampleGrid(n).values;
  let worst = 0;
  for (let i = 0; i < left.length; i++) {
    const d = Math.abs(left[i]! - right[i]!);
    if (d > worst) worst = d;
  }
  return worst;
}
