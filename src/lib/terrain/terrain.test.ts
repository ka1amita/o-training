import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { hashJson, seeded } from '@/lib/rng.ts';
import {
  generateTerrain, paramsFor, perturb, MIN_POINT_SEPARATION, type Terrain,
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

  it('gives every line two ends on the boundary', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const t = make(seed, level);
        const onEdge = (v: { x: number; y: number }) =>
          v.x === 0 || v.y === 0 || v.x === t.size || v.y === t.size;
        for (const line of t.lines) {
          expect(onEdge(line.points[0]!)).toBe(true);
          expect(onEdge(line.points[line.points.length - 1]!)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('golden: fixed seeds at fixed levels', () => {
    const terrains = [1, 2, 3].flatMap((s) => [1, 5, 9].map((l) => make(s, l)));
    expect(hashJson(terrains)).toMatchInlineSnapshot(`"1e3fb96f"`);
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

  it('flat ground has no contours', () => {
    const flat: Terrain = { size: 200, landforms: [], points: [], lines: [], areas: [] };
    expect(contoursOf(sampleGrid(flat, 20), { interval: 5, resolution: 20 })).toEqual([]);
  });
});
