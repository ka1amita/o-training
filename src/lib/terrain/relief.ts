import { contoursOf, type Contour, type SlopeTag } from './contours.ts';
import { bump, contributionOf, heightGrid, sampleGridAt, type Grid } from './height.ts';
import { microRelief } from './noise.ts';
import type { Vec } from './omap.ts';

/**
 * The ground, however the source describes it.
 *
 * Every drill that reads relief reads it through this, so that a DEM sampled from LiDAR,
 * a set of surveyed contour lines and the generator's own sum of bumps are one thing to
 * the app. `AnalyticRelief` below is the generator's; `GridRelief` and `ContourRelief`
 * arrive with the import pipeline (`docs/real-maps-architecture.md` §2).
 *
 * The interface carries no extent: `sampleGrid` returns a `Grid` that knows its own size,
 * which is the only place callers needed one.
 */
export interface Relief {
  readonly kind: 'analytic' | 'grid' | 'contours' | 'none';
  heightAt(x: number, y: number): number;
  sampleGrid(n: number): Grid;
  /** Cartographic contour lines if the source drew them; otherwise traced from the grid. */
  contours(interval: number): readonly Contour[];
  /** The one relief edit that exists on every representation. */
  warped(w: Warp): Relief;
}

/**
 * A compact-support displacement: the ground inside `radius` of `centre` slides by
 * (dx, dy), fading to zero at the edge with the same bump the landforms use.
 *
 * It is the one edit that means the same thing to an analytic field, a DEM, a set of
 * contour lines and a raster — a DEM has no landform to index, so "move the third bump"
 * is not an operation that generalises, and this is.
 */
export interface Warp {
  readonly centre: Vec;
  readonly radius: number;
  readonly dx: number;
  readonly dy: number;
  /**
   * Whether the features standing on the moved ground move with it.
   *
   * §3.1 of the design note says a warp carries them, and it does: a boulder drawn on a
   * knoll belongs on the knoll wherever the knoll goes. `proposeEdit` asks for it on every
   * warp it makes; the flag stays because `Relief.warped` is also called by code that
   * moves ground with nothing on it, and because a caller that wants the old,
   * ground-only displacement should have to say so.
   *
   * It was off through steps 0-3 of the refactor, whose goldens existed to prove nothing
   * had changed, and turning it on re-pinned the two goldens over rounds that carry edits.
   */
  readonly carries?: boolean;
}

/**
 * The warp's displacement field, in **one** function.
 *
 * Three things displace through a warp — a DEM's samples, a contour's vertices, and the
 * features standing on the ground (`Warp.carries`) — and they have to agree exactly, or a
 * boulder drifts off the knoll it is drawn on by whatever the two definitions differ by.
 * So there is one definition, and it is this: the requested (dx, dy) scaled by the same
 * compact bump `height.ts` gives a landform, which is zero at and beyond the radius.
 */
export function warpDisplacement(w: Warp, x: number, y: number): Vec {
  const falloff = bump(Math.hypot(x - w.centre.x, y - w.centre.y) / w.radius);
  return falloff === 0 ? ZERO : { x: w.dx * falloff, y: w.dy * falloff };
}

const ZERO: Vec = { x: 0, y: 0 };

export type LandformKind = 'hill' | 'depression' | 'spur' | 'reentrant';

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

export interface AnalyticParams {
  /** Side of the square, in metres. */
  readonly size: number;
  /**
   * Regional slope, in metres of fall per metre, as a gradient vector.
   *
   * Ground is never level. Without this the map is a few nested ovals floating in white,
   * where a real map carries contours across every part of it — and a plain at exactly
   * zero also gives a stream nowhere to drain to.
   */
  readonly tilt: Vec;
  /**
   * Seed for the micro-relief in `noise.ts`. **Carried through a warp unchanged**, so
   * siblings share their noise exactly and still differ only where a landform moved.
   */
  readonly noiseSeed: number;
  readonly landforms: readonly Landform[];
}

/** Grid resolution the traced contours are read off. */
const CONTOUR_RESOLUTION = 96;

/**
 * The generator's relief: a regional tilt, plus the landforms, plus a metre of
 * micro-relief.
 *
 * The slope is not decoration. Without it the ground between features is exactly flat at
 * exactly zero, so the map is a few nested ovals floating in white — and real ground is
 * never level, so real maps carry contours everywhere. It also guarantees drainage: every
 * point has somewhere downhill to send a stream, which is what stops the descent in
 * `generateTerrain` from stalling in a plain.
 *
 * Tilt and `noiseSeed` both survive a warp untouched, so siblings differ only where the
 * moved landform reaches.
 */
export class AnalyticRelief implements Relief {
  readonly kind = 'analytic' as const;
  readonly size: number;
  readonly tilt: Vec;
  readonly noiseSeed: number;
  readonly landforms: readonly Landform[];

  /** Tracing is the same lines for every window onto this ground, so it is done once.
   *  Private, and therefore invisible to a structural comparison of two reliefs. */
  readonly #traced = new Map<number, readonly Contour[]>();

  constructor(params: AnalyticParams) {
    this.size = params.size;
    this.tilt = params.tilt;
    this.noiseSeed = params.noiseSeed;
    this.landforms = params.landforms;
  }

  heightAt(x: number, y: number): number {
    const half = this.size / 2;
    let h = this.tilt.x * (x - half) + this.tilt.y * (y - half);
    h += microRelief(this.noiseSeed, x, y);
    for (const f of this.landforms) h += contributionOf(f, x, y);
    return h;
  }

  sampleGrid(n: number): Grid {
    return heightGrid(this, this.size, n);
  }

  contours(interval: number): readonly Contour[] {
    const cached = this.#traced.get(interval);
    if (cached) return cached;
    const traced = contoursOf(this.sampleGrid(CONTOUR_RESOLUTION), {
      interval,
      resolution: CONTOUR_RESOLUTION,
      formLines: true,
    });
    this.#traced.set(interval, traced);
    return traced;
  }

  /**
   * Warping an analytic field is **moving the landform under the warp's centre**.
   *
   * The general form is `heightAt(p − d(p))`, and resampling through it would be the
   * honest thing to do on a grid. Here it would also be lossy for nothing: this field is
   * a sum of bumps with compact support, so displacing one of them *is* the displacement
   * field, exactly, and the sibling still differs from its base only where that bump
   * reaches. Nearest centre rather than an index, because a DEM has no index to give.
   */
  warped(w: Warp): AnalyticRelief {
    if (this.landforms.length === 0) return this;
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < this.landforms.length; i++) {
      const f = this.landforms[i]!;
      const d = Math.hypot(f.x - w.centre.x, f.y - w.centre.y);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    const clamp = (v: number) => Math.min(this.size, Math.max(0, v));
    return new AnalyticRelief({
      size: this.size,
      tilt: this.tilt,
      noiseSeed: this.noiseSeed,
      landforms: this.landforms.map((f, i) =>
        i === nearest ? { ...f, x: clamp(f.x + w.dx), y: clamp(f.y + w.dy) } : f,
      ),
    });
  }
}

/**
 * No relief at all.
 *
 * A raster-only map still has to be an `OMap`, and a drill that reads the ground has to
 * be able to ask and be told no rather than to find `undefined`.
 */
export class NoRelief implements Relief {
  readonly kind = 'none' as const;
  readonly size: number;

  constructor(size: number) {
    this.size = size;
  }

  heightAt(): number {
    return 0;
  }

  sampleGrid(n: number): Grid {
    return { n, size: this.size, values: new Float32Array((n + 1) * (n + 1)), min: 0, max: 0 };
  }

  contours(): readonly Contour[] {
    return [];
  }

  warped(): NoRelief {
    return this;
  }
}

/**
 * Resample a grid through a warp's **inverse** displacement.
 *
 * The height now at `p` is the height that was at `p − d(p)`, which is what moving the
 * ground forward by `d` means when the thing being moved is a field of samples rather
 * than a parameter. A DEM has no landform to index — that is the whole reason `Warp`
 * exists — so this is the general form `AnalyticRelief.warped` gets to short-circuit.
 *
 * Samples with zero displacement are **copied, not re-interpolated**. `sampleGridAt` at
 * an exact node is the node's value to within a float, and "to within a float" is not
 * "exactly unchanged": the property the whole distractor design rests on is that a
 * sibling is bit-identical outside the support, and a re-interpolated copy would fail it
 * on the last bit and only sometimes.
 */
function resampledThrough(grid: Grid, w: Warp): Grid {
  const { n, size, values } = grid;
  const step = size / n;
  const out = new Float32Array(values.length);
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = i * step;
      const y = j * step;
      const d = warpDisplacement(w, x, y);
      const h = d.x === 0 && d.y === 0
        ? values[j * (n + 1) + i]!
        : sampleGridAt(grid, x - d.x, y - d.y);
      out[j * (n + 1) + i] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  return { n, size, values: out, min, max };
}

/**
 * Longest side, in samples, a DEM is traced at.
 *
 * A metre-resolution DEM over a kilometre of forest is a 1000-square grid, and marching
 * squares over it emits a contour vertex every metre — hundreds of thousands of points
 * for lines that print at 0.14 mm. The cap is what keeps a bundle openable on a phone;
 * the DEM itself keeps its own resolution for `heightAt`, which is what the drills read.
 */
const DEM_TRACE_RESOLUTION = 192;

/**
 * A DEM: the ground as a field of heights, and the only source that ever gives true ones.
 *
 * `heightAt` is a bilinear sample, which is what `sampleGridAt` already was, so everything
 * that reads the ground — `readGround`, `suits`, `Relief.tsx` — works unchanged.
 */
export class GridRelief implements Relief {
  readonly kind = 'grid' as const;
  readonly grid: Grid;

  /** Traced once, as `AnalyticRelief` caches: two cards over one map trace once. */
  readonly #traced = new Map<number, readonly Contour[]>();

  constructor(grid: Grid) {
    this.grid = grid;
  }

  heightAt(x: number, y: number): number {
    return sampleGridAt(this.grid, x, y);
  }

  sampleGrid(n: number): Grid {
    // The DEM at its own resolution is the DEM, not an interpolation of it.
    return n === this.grid.n ? this.grid : heightGrid(this, this.grid.size, n);
  }

  /**
   * Traced, because a DEM drew no lines.
   *
   * **No form lines.** A form line is a cartographer's judgement that there is something
   * here the interval missed; derived from a height field it is only "the ground is gentle
   * here", which on a LiDAR DEM is most of the forest. The generator can afford them
   * because it knows it put a feature there.
   */
  contours(interval: number): readonly Contour[] {
    const cached = this.#traced.get(interval);
    if (cached) return cached;
    const resolution = Math.min(this.grid.n, DEM_TRACE_RESOLUTION);
    const traced = contoursOf(this.sampleGrid(resolution), { interval, resolution });
    this.#traced.set(interval, traced);
    return traced;
  }

  warped(w: Warp): GridRelief {
    return new GridRelief(resampledThrough(this.grid, w));
  }
}

export interface ContourParams {
  /** Vertical distance between ordinary lines, in metres. */
  readonly interval: number;
  /** The lines the surveyor drew, with the levels the pipeline assigned them. */
  readonly lines: readonly Contour[];
  /** The height field rasterised from those lines, for everything that reads the ground. */
  readonly grid: Grid;
}

/**
 * The map's own contour lines, plus a grid rasterised from them.
 *
 * `contours()` returns **the drawn lines** and never retraces. Real contours are
 * cartography: smoothed, cut where a knoll symbol takes over, thickened every fifth line,
 * generalised by a person who was standing there. Retracing them from a height field
 * reconstructed *from those same lines* would throw all of that away and make a surveyed
 * map look generated — which is the one thing a library of real maps is for.
 *
 * The grid is the other half: `readGround`, `suits` and the shading need heights, and a
 * polyline has none. It is reconstructed at import (`maps/import/relief.ts`) and is an
 * interpolation, so it is honest about detail it does not have — never finer than the
 * interval the lines were drawn at.
 */
export class ContourRelief implements Relief {
  readonly kind = 'contours' as const;
  readonly interval: number;
  readonly lines: readonly Contour[];
  readonly grid: Grid;

  constructor(params: ContourParams) {
    this.interval = params.interval;
    this.lines = params.lines;
    this.grid = params.grid;
  }

  heightAt(x: number, y: number): number {
    return sampleGridAt(this.grid, x, y);
  }

  sampleGrid(n: number): Grid {
    return n === this.grid.n ? this.grid : heightGrid(this, this.grid.size, n);
  }

  /** The drawn lines, whatever interval is asked for: they are the map, not a rendering
   *  choice. A caller wanting a different interval wants a different map. */
  contours(_interval?: number): readonly Contour[] {
    return this.lines;
  }

  /**
   * The lines' vertices move forward through the displacement; the grid is resampled
   * through its inverse. Both are the same field applied to the same ground, so the
   * contours still describe the height they sit on.
   *
   * Deliberately **not** "displace the lines and rasterise them again". That round trip
   * is lossy everywhere, including outside the support, which would leave a sibling
   * differing over the whole map — the exact thing compact support exists to prevent.
   */
  warped(w: Warp): ContourRelief {
    return new ContourRelief({
      interval: this.interval,
      lines: this.lines.map((line) => displaced(line, w)),
      grid: resampledThrough(this.grid, w),
    });
  }
}

/** A contour with every vertex inside the support slid forward, or the same object. */
function displaced(line: Contour, w: Warp): Contour {
  let touched = false;
  const move = (p: Vec): Vec => {
    const d = warpDisplacement(w, p.x, p.y);
    if (d.x === 0 && d.y === 0) return p;
    touched = true;
    return { x: p.x + d.x, y: p.y + d.y };
  };
  const points = line.points.map(move);
  const tags = line.tags.map((tag): SlopeTag => {
    const d = warpDisplacement(w, tag.x, tag.y);
    if (d.x === 0 && d.y === 0) return tag;
    touched = true;
    // The tick keeps its direction: it points downhill, and a near-translation of the
    // ground it sits on leaves downhill where it was.
    return { ...tag, x: tag.x + d.x, y: tag.y + d.y };
  });
  // Identity, not a copy, for a line the warp never reached — so "unchanged outside the
  // support" is a fact about the object and not only about its numbers.
  return touched ? { ...line, points, tags } : line;
}
