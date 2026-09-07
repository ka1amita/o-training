import type { Landform, Terrain } from './terrain.ts';

/**
 * Height is the sum of the landforms, each a smooth bump with **compact support**: it is
 * exactly zero past its own radius.
 *
 * A Gaussian would be smoother and wrong for this app. With unbounded falloff, moving one
 * knoll changes the height everywhere by a little, so a "one feature nudged" distractor
 * differs from the answer across the whole map — the opposite of the drill. Compact
 * support keeps a local change local.
 */
function bump(distance: number): number {
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

export function heightAt(terrain: Terrain, x: number, y: number): number {
  let h = 0;
  for (const f of terrain.landforms) h += contributionOf(f, x, y);
  return h;
}

export interface Grid {
  /** Samples per side. The array holds (n + 1)^2 values, row-major from the top-left. */
  readonly n: number;
  readonly size: number;
  readonly values: Float32Array;
  readonly min: number;
  readonly max: number;
}

export function sampleGrid(terrain: Terrain, n: number): Grid {
  const values = new Float32Array((n + 1) * (n + 1));
  const step = terrain.size / n;
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const h = heightAt(terrain, i * step, j * step);
      values[j * (n + 1) + i] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  return { n, size: terrain.size, values, min, max };
}

/**
 * The largest height difference between two terrains over a sampled grid.
 *
 * This is what "the distractor is actually different" means for a drill read off the
 * relief, and it is why perturbation targets a landform there: moving a boulder leaves
 * this at zero.
 */
export function maxHeightDifference(a: Terrain, b: Terrain, n = 32): number {
  const step = a.size / n;
  let worst = 0;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const d = Math.abs(heightAt(a, i * step, j * step) - heightAt(b, i * step, j * step));
      if (d > worst) worst = d;
    }
  }
  return worst;
}
