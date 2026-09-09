import { contoursOf, type Contour } from './contours.ts';
import { contributionOf, heightGrid, type Grid } from './height.ts';
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
