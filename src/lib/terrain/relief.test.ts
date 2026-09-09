import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { contoursOf } from './contours.ts';
import { heightGrid, type Grid } from './height.ts';
import { ContourRelief, GridRelief, warpDisplacement, type Warp } from './relief.ts';

/**
 * The two imported reliefs, held to the property the whole distractor design rests on:
 * **a warp is local**. Outside its support the ground and the lines drawn on it are not
 * merely close, they are identical; inside, nothing travels further than the warp was
 * asked to move it.
 *
 * Stated separately from `edits.test.ts`, which pins the same property for the analytic
 * relief. The analytic one gets it for free — it moves a bump with compact support — and
 * these two have to earn it through a resample and a vertex walk, which is where it could
 * quietly stop being true.
 */
const SIZE = 400;

const dem = (n: number, f: (x: number, y: number) => number, size = SIZE): Grid =>
  heightGrid({ heightAt: f }, size, n);

const ground = (x: number, y: number) =>
  0.04 * x + Math.sin(x / 47) * 6 + Math.cos(y / 61) * 5 + Math.sin((x + y) / 23) * 1.5;

const anyWarp = fc
  .record({
    cx: fc.integer({ min: 60, max: 340 }),
    cy: fc.integer({ min: 60, max: 340 }),
    radius: fc.integer({ min: 25, max: 90 }),
    angle: fc.integer({ min: 0, max: 359 }),
    distance: fc.integer({ min: 5, max: 70 }),
  })
  .map(({ cx, cy, radius, angle, distance }): Warp => ({
    centre: { x: cx, y: cy },
    radius,
    dx: Math.cos((angle * Math.PI) / 180) * distance,
    dy: Math.sin((angle * Math.PI) / 180) * distance,
  }));

const length = (w: Warp) => Math.hypot(w.dx, w.dy);

describe('warpDisplacement', () => {
  it('is zero at and beyond the radius, and never longer than the move asked for', () => {
    fc.assert(
      fc.property(anyWarp, fc.integer({ min: 0, max: 400 }), fc.integer({ min: 0, max: 400 }),
        (w, x, y) => {
          const d = warpDisplacement(w, x, y);
          const away = Math.hypot(x - w.centre.x, y - w.centre.y);
          if (away >= w.radius) expect(d).toEqual({ x: 0, y: 0 });
          expect(Math.hypot(d.x, d.y)).toBeLessThanOrEqual(length(w) + 1e-9);
        }),
      { numRuns: 300 },
    );
  });
});

describe('GridRelief', () => {
  const grid = dem(96, ground);
  const relief = new GridRelief(grid);

  it('reads the DEM back at its own resolution rather than interpolating it', () => {
    expect(relief.sampleGrid(96)).toBe(grid);
    expect(relief.heightAt(0, 0)).toBe(grid.values[0]);
  });

  it('leaves every sample outside the support exactly unchanged', () => {
    // Bit-identical, not merely close. A sample outside the support is displaced by
    // nothing, and `resampledThrough` copies it rather than re-interpolating it, which is
    // the difference between "the sibling differs only here" and "the sibling differs
    // everywhere by a last bit".
    //
    // Grid *samples*, and one step further out for interpolated heights: `heightAt`
    // between two nodes blends them, and a node just inside the support did move.
    fc.assert(
      fc.property(anyWarp, (w) => {
        const after = relief.warped(w);
        const step = SIZE / grid.n;
        for (let j = 0; j <= grid.n; j++) {
          for (let i = 0; i <= grid.n; i++) {
            const x = i * step;
            const y = j * step;
            const away = Math.hypot(x - w.centre.x, y - w.centre.y);
            if (away < w.radius) continue;
            expect(after.grid.values[j * (grid.n + 1) + i]).toBe(grid.values[j * (grid.n + 1) + i]);
            if (away >= w.radius + step * 1.5) {
              expect(after.heightAt(x + step / 3, y + step / 3))
                .toBe(relief.heightAt(x + step / 3, y + step / 3));
            }
          }
        }
      }),
      { numRuns: 15 },
    );
  });

  it('inside the support, every height came from within the distance asked for', () => {
    fc.assert(
      fc.property(anyWarp, (w) => {
        const after = relief.warped(w);
        for (let j = 0; j <= 24; j++) {
          for (let i = 0; i <= 24; i++) {
            const x = (i * SIZE) / 24;
            const y = (j * SIZE) / 24;
            const d = warpDisplacement(w, x, y);
            // The ground now here is the ground that was at p - d(p), and |d| is bounded
            // by the move: nothing on this map travelled further than it was pushed.
            expect(Math.hypot(d.x, d.y)).toBeLessThanOrEqual(length(w) + 1e-9);
            expect(after.heightAt(x, y)).toBeCloseTo(relief.heightAt(x - d.x, y - d.y), 5);
          }
        }
      }),
      { numRuns: 25 },
    );
  });

  it('moves the ground enough to be seen', () => {
    // The other half: locality is worthless if the sibling is also identical *inside*.
    const w: Warp = { centre: { x: 200, y: 200 }, radius: 70, dx: 45, dy: 0 };
    const after = relief.warped(w);
    let worst = 0;
    for (let j = 0; j <= 48; j++) {
      for (let i = 0; i <= 48; i++) {
        const x = (i * SIZE) / 48;
        const y = (j * SIZE) / 48;
        worst = Math.max(worst, Math.abs(after.heightAt(x, y) - relief.heightAt(x, y)));
      }
    }
    expect(worst).toBeGreaterThan(1);
  });

  it('traces its own contours, and no form lines', () => {
    // A form line is a cartographer's judgement. Derived from a DEM it says only "gentle
    // here", which is most of a forest.
    const lines = relief.contours(5);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((c) => c.form)).toBe(false);
    expect(lines.some((c) => c.index)).toBe(true);
    // Cached: two cards over one map trace once.
    expect(relief.contours(5)).toBe(lines);
  });
});

describe('ContourRelief', () => {
  const grid = dem(96, ground);
  const lines = contoursOf(grid, { interval: 5, resolution: 96 });
  const relief = new ContourRelief({ interval: 5, lines, grid });

  it('returns the lines it was given, at any interval asked for', () => {
    expect(relief.contours(5)).toBe(lines);
    expect(relief.contours(2.5)).toBe(lines);
  });

  it('leaves lines and heights outside the support exactly unchanged', () => {
    fc.assert(
      fc.property(anyWarp, (w) => {
        const after = relief.warped(w);
        after.lines.forEach((line, i) => {
          const before = lines[i]!;
          const anyInside = before.points.some(
            (p) => Math.hypot(p.x - w.centre.x, p.y - w.centre.y) < w.radius,
          );
          if (!anyInside) {
            // The same object, not a copy of it.
            expect(line).toBe(before);
            return;
          }
          line.points.forEach((p, k) => {
            const was = before.points[k]!;
            if (Math.hypot(was.x - w.centre.x, was.y - w.centre.y) >= w.radius) {
              expect(p).toEqual(was);
            }
          });
        });
      }),
      { numRuns: 25 },
    );
  });

  it('moves no contour vertex further than the warp was asked to move it', () => {
    fc.assert(
      fc.property(anyWarp, (w) => {
        const after = relief.warped(w);
        const limit = length(w) + 1e-9;
        after.lines.forEach((line, i) => {
          line.points.forEach((p, k) => {
            const was = lines[i]!.points[k]!;
            expect(Math.hypot(p.x - was.x, p.y - was.y)).toBeLessThanOrEqual(limit);
          });
        });
      }),
      { numRuns: 25 },
    );
  });

  it('warps the grid with the lines, so the contours still describe the ground', () => {
    const w: Warp = { centre: { x: 180, y: 220 }, radius: 80, dx: 0, dy: 50 };
    const after = relief.warped(w);
    for (let j = 0; j <= 32; j++) {
      for (let i = 0; i <= 32; i++) {
        const x = (i * SIZE) / 32;
        const y = (j * SIZE) / 32;
        const d = warpDisplacement(w, x, y);
        expect(after.heightAt(x, y)).toBeCloseTo(relief.heightAt(x - d.x, y - d.y), 5);
      }
    }
  });

  it('carries the slope tags with the lines they tag', () => {
    const closed = lines.find((c) => c.tags.length > 0);
    if (!closed) return;
    const tag = closed.tags[0]!;
    const w: Warp = { centre: { x: tag.x, y: tag.y }, radius: 60, dx: 20, dy: 10 };
    const after = relief.warped(w);
    const now = after.lines[lines.indexOf(closed)]!.tags[0]!;
    expect(now.x).toBeCloseTo(tag.x + 20, 6);
    expect(now.y).toBeCloseTo(tag.y + 10, 6);
    // The tick still points downhill: a near-translation leaves downhill where it was.
    expect({ dx: now.dx, dy: now.dy }).toEqual({ dx: tag.dx, dy: tag.dy });
  });
});
