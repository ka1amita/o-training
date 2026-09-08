import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { hashJson, seeded } from '@/lib/rng.ts';
import {
  generateTerrain, paramsFor, perturb, readGround, suitsArea, suitsPoint,
  MIN_POINT_SEPARATION, type Terrain,
} from './terrain.ts';
import { contributionOf, heightAt, maxHeightDifference, sampleGrid } from './height.ts';
import { contoursOf, marchingSquares, stitch } from './contours.ts';

const anySeed = fc.integer({ min: 0, max: 0xffffffff });
const anyLevel = fc.integer({ min: 1, max: 10 });
const make = (seed: number, level = 5): Terrain =>
  generateTerrain(seeded(seed), paramsFor(level));

describe('terrain / generate', () => {
  it('is deterministic', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        expect(make(seed, level)).toEqual(make(seed, level));
      }),
    );
  });

  it('keeps every feature inside the map', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const t = make(seed, level);
        const inside = (v: number) => v >= 0 && v <= t.size;
        for (const f of [...t.landforms, ...t.points, ...t.areas]) {
          expect(inside(f.x) && inside(f.y)).toBe(true);
        }
        for (const line of t.lines) {
          for (const p of line.points) expect(inside(p.x) && inside(p.y)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('never puts two point features on top of each other', () => {
    // Two boulders 3 m apart print as one blob, and a drill about noticing detail cannot
    // be built on a map that cannot be read.
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const { points } = make(seed, level);
        for (let i = 0; i < points.length; i++) {
          for (let j = i + 1; j < points.length; j++) {
            const gap = Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y);
            expect(gap).toBeGreaterThanOrEqual(MIN_POINT_SEPARATION);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('gets busier with the level', () => {
    const count = (t: Terrain) =>
      t.landforms.length + t.points.length + t.lines.length + t.areas.length;
    expect(count(make(1, 1))).toBeLessThan(count(make(1, 10)));
  });

  it('gives every made line two ends on the boundary', () => {
    // A path, a fence or a ride that stops nowhere is the one thing that never appears on
    // a real map. Water is the exception and is asserted separately: a stream begins at a
    // source, which is somewhere in the middle of the ground, not at the edge of the page.
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const t = make(seed, level);
        const onEdge = (v: { x: number; y: number }) =>
          v.x === 0 || v.y === 0 || v.x === t.size || v.y === t.size;
        for (const line of t.lines) {
          if (line.kind === 'stream') continue;
          expect(onEdge(line.points[0]!)).toBe(true);
          expect(onEdge(line.points[line.points.length - 1]!)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('scales the relief into a legible band for a 5 m interval', () => {
    // The whole reason amplitudes are normalised: a map that came out with three contour
    // lines and the next with thirty are both unreadable, in opposite directions.
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const t = make(seed, level);
        const grid = sampleGrid(t, 48);
        const relief = grid.max - grid.min;
        expect(relief).toBeGreaterThan(15);
        expect(relief).toBeLessThan(90);
      }),
      { numRuns: 100 },
    );
  });

  it('runs every stream downhill', () => {
    // Water over a hilltop is the least subtle mistake a generated map can make.
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const t = make(seed, level);
        for (const line of t.lines) {
          if (line.kind !== 'stream') continue;
          const heights = line.points.map((p) => heightAt(t, p.x, p.y));
          // Smoothing moves a vertex a little off the traced line, so this is descent
          // over the whole watercourse rather than between every adjacent pair.
          expect(heights[heights.length - 1]!).toBeLessThan(heights[0]!);
          for (let i = 4; i < heights.length; i++) {
            expect(heights[i]!).toBeLessThanOrEqual(heights[i - 4]! + 0.5);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('puts every area on ground that suits it', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const t = make(seed, level);
        const ground = readGround(t);
        // The marsh drawn where a stream sinks is the one exception, and it is placed
        // *because* the water stops there rather than because the slope suits it.
        const sinks = t.lines
          .filter((l) => l.kind === 'stream')
          .map((l) => l.points[l.points.length - 1]!);
        const isSink = (a: { x: number; y: number }) =>
          sinks.some((e) => Math.hypot(e.x - a.x, e.y - a.y) < 1);
        for (const area of t.areas) {
          if (isSink(area)) continue;
          expect(suitsArea(area.kind, ground, area), `${area.kind} at ${area.x},${area.y}`)
            .toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('puts every knoll on a rise and every pit in a hollow', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const t = make(seed, level);
        const ground = readGround(t);
        for (const f of t.points) {
          if (f.kind !== 'knoll' && f.kind !== 'pit') continue;
          expect(suitsPoint(f.kind, ground, f), `${f.kind} at ${f.x},${f.y}`).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('golden: fixed seeds at fixed levels', () => {
    const terrains = [1, 2, 3].flatMap((s) => [1, 5, 9].map((l) => make(s, l)));
    expect(hashJson(terrains)).toMatchInlineSnapshot(`"863f6f87"`);
  });
});

describe('terrain / height', () => {
  it('a landform contributes nothing beyond its own radius', () => {
    // The property the whole distractor design rests on: a local change stays local.
    const t = make(11);
    for (const f of t.landforms) {
      const far = f.radius * f.elongation * 1.2;
      expect(Math.abs(contributionOf(f, f.x + far, f.y))).toBe(0);
      expect(Math.abs(contributionOf(f, f.x, f.y + far))).toBe(0);
    }
  });

  it('a hill peaks at its centre and a depression bottoms out there', () => {
    const t = make(23);
    for (const f of t.landforms) {
      const centre = contributionOf(f, f.x, f.y);
      const off = contributionOf(f, f.x + f.radius * 0.5, f.y);
      expect(Math.abs(centre)).toBeGreaterThanOrEqual(Math.abs(off));
      expect(Math.sign(centre)).toBe(Math.sign(f.amplitude));
    }
  });

  it('sampleGrid reports the range it actually sampled', () => {
    const grid = sampleGrid(make(5), 24);
    let min = Infinity;
    let max = -Infinity;
    for (const v of grid.values) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(grid.min).toBeCloseTo(min, 5);
    expect(grid.max).toBeCloseTo(max, 5);
  });

  it('the grid agrees with heightAt', () => {
    const t = make(9);
    const n = 16;
    const grid = sampleGrid(t, n);
    const step = t.size / n;
    for (const [i, j] of [[0, 0], [5, 7], [n, n], [3, n]] as const) {
      expect(grid.values[j * (n + 1) + i]).toBeCloseTo(heightAt(t, i * step, j * step), 4);
    }
  });
});

describe('terrain / perturb', () => {
  it('moves exactly one feature, by the distance asked for', () => {
    fc.assert(
      fc.property(anySeed, fc.integer({ min: 5, max: 60 }), (seed, distance) => {
        const before = make(seed);
        const { terrain: after, change } = perturb(before, seeded(seed + 1), { distance });

        const lists = ['landforms', 'points', 'areas'] as const;
        let moved = 0;
        for (const list of lists) {
          before[list].forEach((f, i) => {
            const g = after[list][i]!;
            if (f.x !== g.x || f.y !== g.y) moved++;
          });
        }
        expect(moved).toBe(1);
        expect(change.distance).toBe(distance);
      }),
      { numRuns: 200 },
    );
  });

  it('leaves everything else identical', () => {
    const before = make(31);
    const { terrain: after } = perturb(before, seeded(2), { distance: 30 });
    expect(after.lines).toEqual(before.lines);
    expect(after.size).toBe(before.size);
    expect(after.landforms).toHaveLength(before.landforms.length);
    expect(after.points).toHaveLength(before.points.length);
  });

  it('keeps the moved feature on the map', () => {
    fc.assert(
      fc.property(anySeed, fc.integer({ min: 5, max: 200 }), (seed, distance) => {
        const t = perturb(make(seed), seeded(seed), { distance }).terrain;
        for (const f of [...t.landforms, ...t.points, ...t.areas]) {
          expect(f.x >= 0 && f.x <= t.size && f.y >= 0 && f.y <= t.size).toBe(true);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('targeting a landform is what changes the relief', () => {
    // Moving a boulder leaves the contours identical, which would make a contour
    // distractor indistinguishable from the answer. This is why the option exists.
    fc.assert(
      fc.property(anySeed, (seed) => {
        const base = make(seed);
        const moved = perturb(base, seeded(seed + 7), { distance: 40, target: 'landform' });
        expect(moved.change.what).toBe('landform');
        expect(maxHeightDifference(base, moved.terrain)).toBeGreaterThan(0.5);
      }),
      { numRuns: 100 },
    );
  });

  it('carries the tilt and the micro-relief seed through unchanged', () => {
    // Siblings must share both, or they differ everywhere and compact support — the whole
    // reason a landform's falloff is bounded — stops meaning anything.
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const base = make(seed, level);
        const moved = perturb(base, seeded(seed + 1), { distance: 30 }).terrain;
        expect(moved.noiseSeed).toBe(base.noiseSeed);
        expect(moved.tilt).toEqual(base.tilt);
      }),
      { numRuns: 100 },
    );
  });

  it('a bigger move changes the relief more', () => {
    const base = make(77);
    const small = perturb(base, seeded(3), { distance: 10, target: 'landform' }).terrain;
    const large = perturb(base, seeded(3), { distance: 60, target: 'landform' }).terrain;
    expect(maxHeightDifference(base, large)).toBeGreaterThan(maxHeightDifference(base, small));
  });
});

describe('terrain / contours', () => {
  const grid = sampleGrid(make(13), 64);

  it('traces closed rings around a single hill', () => {
    const lone: Terrain = {
      size: 400,
      // No tilt and no micro-relief: this is a test of the tracer's geometry, and it
      // wants a field whose contours are exactly rings.
      tilt: { x: 0, y: 0 },
      noiseSeed: 0,
      landforms: [{ kind: 'hill', x: 200, y: 200, radius: 120, amplitude: 20, rotation: 0, elongation: 1 }],
      points: [], lines: [], areas: [],
    };
    const contours = contoursOf(sampleGrid(lone, 80), { interval: 5, resolution: 80 });
    expect(contours.length).toBeGreaterThan(0);
    for (const c of contours) {
      expect(c.closed, `level ${c.level}`).toBe(true);
      // Every point on a ring sits at roughly the radius where that height occurs.
      const radii = c.points.map((p) => Math.hypot(p.x - 200, p.y - 200));
      expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(12);
    }
  });

  it('nests rings: a higher level lies inside a lower one', () => {
    const lone: Terrain = {
      size: 400,
      tilt: { x: 0, y: 0 },
      noiseSeed: 0,
      landforms: [{ kind: 'hill', x: 200, y: 200, radius: 150, amplitude: 24, rotation: 0, elongation: 1 }],
      points: [], lines: [], areas: [],
    };
    const contours = contoursOf(sampleGrid(lone, 80), { interval: 5, resolution: 80 });
    const meanRadius = (level: number) => {
      const c = contours.find((x) => x.level === level)!;
      return c.points.reduce((a, p) => a + Math.hypot(p.x - 200, p.y - 200), 0) / c.points.length;
    };
    const levels = [...new Set(contours.map((c) => c.level))].sort((a, b) => a - b);
    for (let i = 1; i < levels.length; i++) {
      expect(meanRadius(levels[i]!)).toBeLessThan(meanRadius(levels[i - 1]!));
    }
  });

  it('every segment endpoint sits on a cell edge', () => {
    const step = grid.size / grid.n;
    for (const [a, b] of marchingSquares(grid, 3)) {
      for (const p of [a, b]) {
        const onVertical = Math.abs(p.x / step - Math.round(p.x / step)) < 1e-9;
        const onHorizontal = Math.abs(p.y / step - Math.round(p.y / step)) < 1e-9;
        expect(onVertical || onHorizontal).toBe(true);
      }
    }
  });

  it('stitching uses every segment exactly once', () => {
    const segments = marchingSquares(grid, 2);
    const contours = stitch(segments, 2);
    // Each contour of k points consumed k-1 segments, closed ones included.
    const consumed = contours.reduce((a, c) => a + c.points.length - 1, 0);
    expect(consumed).toBe(segments.length);
  });

  it('produces far fewer polylines than segments', () => {
    const segments = marchingSquares(grid, 2);
    const contours = stitch(segments, 2);
    expect(segments.length).toBeGreaterThan(20);
    expect(contours.length).toBeLessThan(segments.length / 4);
  });

  it('puts every contour level inside the sampled range', () => {
    for (const c of contoursOf(grid, { interval: 5, resolution: 64 })) {
      expect(c.level).toBeGreaterThanOrEqual(Math.floor(grid.min));
      expect(c.level).toBeLessThanOrEqual(Math.ceil(grid.max));
    }
  });

  it('stitches an open contour into one path, whichever end it is met from', () => {
    // The regression this exists for: following segments only forwards recovers a closed
    // ring from any starting point but shreds an open line, because the outer loop meets
    // segments in cell order and usually enters a contour in its middle. A pure slope has
    // exactly one contour per level and every one of them is open, so a count of paths is
    // a count of failures.
    const slope: Terrain = {
      size: 300,
      tilt: { x: 0.05, y: 0.02 },
      noiseSeed: 0,
      landforms: [], points: [], lines: [], areas: [],
    };
    const contours = contoursOf(sampleGrid(slope, 64), { interval: 5, resolution: 64 });
    expect(contours.length).toBeGreaterThan(1);
    const perLevel = new Map<number, number>();
    for (const c of contours) {
      expect(c.closed).toBe(false);
      perLevel.set(c.level, (perLevel.get(c.level) ?? 0) + 1);
    }
    for (const [level, count] of perLevel) expect(count, `level ${level}`).toBe(1);
  });

  it('marks every fifth line as an index contour and no others', () => {
    const contours = contoursOf(sampleGrid(make(21), 64), { interval: 5, resolution: 64 });
    for (const c of contours) {
      expect(c.index, `level ${c.level}`).toBe(Math.round(c.level / 5) % 5 === 0);
    }
  });

  it('tags a hollow and leaves a knoll alone', () => {
    // Without this the two are the same picture, and the relief drill asks a question its
    // own card cannot answer.
    const lone = (amplitude: number): Terrain => ({
      size: 400,
      tilt: { x: 0, y: 0 },
      noiseSeed: 0,
      landforms: [{ kind: 'hill', x: 200, y: 200, radius: 120, amplitude, rotation: 0, elongation: 1 }],
      points: [], lines: [], areas: [],
    });
    const options = { interval: 5, resolution: 80 };
    const knoll = contoursOf(sampleGrid(lone(20), 80), options);
    const hollow = contoursOf(sampleGrid(lone(-20), 80), options);

    expect(knoll.length).toBeGreaterThan(0);
    expect(hollow.length).toBeGreaterThan(0);
    expect(knoll.every((c) => c.tags.length === 0)).toBe(true);
    expect(hollow.every((c) => c.tags.length > 0)).toBe(true);
    // And every tag points into the hollow, which is where the ground falls away. The
    // step is a fraction of the ring's own radius: a fixed one overshoots the centre of
    // the innermost ring, which is a third of a metre across.
    for (const c of hollow) {
      for (const tag of c.tags) {
        const radius = Math.hypot(tag.x - 200, tag.y - 200);
        const moved = Math.hypot(tag.x + tag.dx * radius * 0.5 - 200, tag.y + tag.dy * radius * 0.5 - 200);
        expect(moved).toBeLessThan(radius);
      }
    }
  });

  it('flat ground has no contours', () => {
    const flat: Terrain = {
      size: 200, tilt: { x: 0, y: 0 }, noiseSeed: 0,
      landforms: [], points: [], lines: [], areas: [],
    };
    expect(contoursOf(sampleGrid(flat, 20), { interval: 5, resolution: 20 })).toEqual([]);
  });
});
