import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { hashJson, seeded } from '@/lib/rng.ts';
import {
  generateTerrain, paramsFor, readGround, separationOf, MIN_POINT_SEPARATION,
  type GeneratedMap,
} from './terrain.ts';
import { suits } from './semantics.ts';
import { contributionOf, sampleGrid } from './height.ts';
import { areasOf, linesOf, pointsOf, positionOf, type Feature } from './omap.ts';
import { AnalyticRelief } from './relief.ts';
import { goldenMap } from './golden.ts';
import { CODE_OF } from './semantics.ts';
import { contoursOf, marchingSquares, stitch } from './contours.ts';
import { analyse, RUNNABILITY_GRID, type Analysis } from './analysis.ts';

const anySeed = fc.integer({ min: 0, max: 0xffffffff });
const anyLevel = fc.integer({ min: 1, max: 10 });
const make = (seed: number, level = 5): GeneratedMap =>
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
        const inside = (v: number) => v >= 0 && v <= t.width;
        for (const f of t.relief.landforms) expect(inside(f.x) && inside(f.y)).toBe(true);
        for (const f of [...pointsOf(t), ...areasOf(t)]) {
          const at = positionOf(f);
          expect(inside(at.x) && inside(at.y)).toBe(true);
        }
        for (const line of linesOf(t)) {
          for (const p of line.geometry.kind === 'polyline' ? line.geometry.points : []) {
            expect(inside(p.x) && inside(p.y)).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('never puts two point features on top of each other', () => {
    // Two boulders 3 m apart print as one blob, and a drill about noticing detail cannot
    // be built on a map that cannot be read. The bar is per pair, because a crag is a line
    // twice as long as a boulder is wide and a field of them needs the room.
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        // A level 10 map carries a hundred-odd points, so this is thousands of pairs per
        // run and some 400 000 over the property. Asserting on each one spent three of the
        // test's four seconds inside `expect` rather than on the generator, which put it
        // close enough to the 5 s timeout to trip over it on a loaded runner. The loop
        // measures every pair the same way and keeps the tightest; the assertion is made
        // once, on that one. A pair that clears the bar by the least clears it for all.
        const points = pointsOf(make(seed, level));
        let worst: readonly [Feature, Feature] | null = null;
        let margin = Infinity;
        for (let i = 0; i < points.length; i++) {
          for (let j = i + 1; j < points.length; j++) {
            const a = points[i]!;
            const b = points[j]!;
            const at = positionOf(a);
            const to = positionOf(b);
            const gap = Math.hypot(at.x - to.x, at.y - to.y);
            // Both bars at once, because either can be the one a pair undercuts.
            const slack = Math.min(gap - separationOf(a, b), gap - MIN_POINT_SEPARATION);
            if (slack < margin) {
              margin = slack;
              worst = [a, b];
            }
          }
        }
        if (!worst) return;
        const [a, b] = worst;
        const at = positionOf(a);
        const to = positionOf(b);
        const gap = Math.hypot(at.x - to.x, at.y - to.y);
        expect(gap, `${a.kind} and ${b.kind}`).toBeGreaterThanOrEqual(separationOf(a, b));
        expect(gap).toBeGreaterThanOrEqual(MIN_POINT_SEPARATION);
      }),
      { numRuns: 200 },
    );
  });

  it('advertises a floor no pair of symbols can undercut', () => {
    // `MIN_POINT_SEPARATION` is a constant others may reason with; `separationOf` is what
    // placement enforces. If the two drift apart the constant becomes a lie.
    const kinds = ['boulder', 'knoll', 'pit', 'tree', 'crag'] as const;
    for (const a of kinds) {
      for (const b of kinds) {
        const gap = separationOf({ code: CODE_OF[a], size: 3 }, { code: CODE_OF[b], size: 3 });
        expect(gap, `${a} and ${b}`).toBeGreaterThanOrEqual(MIN_POINT_SEPARATION);
      }
    }
  });

  it('gets busier with the level', () => {
    const count = (t: GeneratedMap) => t.relief.landforms.length + t.features.length;
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
          v.x === 0 || v.y === 0 || v.x === t.width || v.y === t.width;
        for (const line of linesOf(t)) {
          if (line.kind === 'stream' || line.geometry.kind !== 'polyline') continue;
          const { points } = line.geometry;
          expect(onEdge(points[0]!)).toBe(true);
          expect(onEdge(points[points.length - 1]!)).toBe(true);
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
        const grid = sampleGrid(t.relief, 48);
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
        for (const line of linesOf(t)) {
          if (line.kind !== 'stream' || line.geometry.kind !== 'polyline') continue;
          const heights = line.geometry.points.map((p) => t.relief.heightAt(p.x, p.y));
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
        const ground = readGround(t.relief);
        // The marsh drawn where a stream sinks is the one exception, and it is placed
        // *because* the water stops there rather than because the slope suits it.
        const sinks = linesOf(t)
          .filter((l) => l.kind === 'stream' && l.geometry.kind === 'polyline')
          .map((l) => {
            const points = l.geometry.kind === 'polyline' ? l.geometry.points : [];
            return points[points.length - 1]!;
          });
        const isSink = (a: { x: number; y: number }) =>
          sinks.some((e) => Math.hypot(e.x - a.x, e.y - a.y) < 1);
        for (const area of areasOf(t)) {
          const at = positionOf(area);
          if (isSink(at)) continue;
          expect(suits(area.code, ground, at), `${area.kind} at ${at.x},${at.y}`).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('draws no marsh where the rejection sampler ran out of tries', () => {
    // `seed 248, level 9`, the case the property above flaked on at about one run in
    // eight. Flat-and-low ground is 2.2% of that map — the flat parts are its tops and the
    // low parts are its steep flanks — so 160 draws miss it 2.8% of the time, and the
    // unconditioned draw `sampleWhere` used to end with put a marsh on ground falling at
    // 46%. Pinned by seed, because a property that finds this once in eight runs is a
    // property that says nothing on the other seven.
    const t = make(248, 9);
    const ground = readGround(t.relief);
    const marshes = areasOf(t).filter((a) => a.kind === 'marsh');
    expect(marshes.length).toBeGreaterThan(0);
    for (const marsh of marshes) {
      expect(suits(marsh.code, ground, positionOf(marsh))).toBe(true);
    }
    // And the redraw kept the count the requirement asked for rather than dropping a slot.
    expect(areasOf(t)).toHaveLength(paramsFor(9).areas);
  });

  it('puts every knoll on a rise and every pit in a hollow', () => {
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const t = make(seed, level);
        const ground = readGround(t.relief);
        for (const f of pointsOf(t)) {
          if (f.kind !== 'knoll' && f.kind !== 'pit') continue;
          const at = positionOf(f);
          expect(suits(f.code, ground, at), `${f.kind} at ${at.x},${at.y}`).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('golden: fixed seeds at fixed levels', () => {
    const terrains = [1, 2, 3].flatMap((s) => [1, 5, 9].map((l) => make(s, l)));
    // Re-pinned once, on purpose: the codes are ISOM 2017-2 now, so every feature in the
    // hash carries a different **string** — boulder 206 → 204, knoll 112 → 109, and so
    // on. Nothing the generator decided moved with them, and that is measurable: hash the
    // same projection with every `code` field removed and it is `049b8e41` before this
    // commit and `049b8e41` after.
    expect(hashJson(terrains.map(goldenMap))).toMatchInlineSnapshot(`"a1744b3b"`);
  });
});

describe('terrain / analysis', () => {
  it('answers about itself the way an imported map does', () => {
    // What deleted the two `instanceof AnalyticRelief` fallbacks: every map, whatever
    // drew it, says where its landforms are through `analysis` and nowhere else.
    fc.assert(
      fc.property(anySeed, anyLevel, (seed, level) => {
        const map = make(seed, level);
        expect(map.analysis).toBeDefined();
        expect(map.analysis!.landforms).toHaveLength(map.relief.landforms.length);
      }),
      { numRuns: 40 },
    );
  });

  it('offers the landforms it was built from, not the ones curvature would find', () => {
    // `AnalyticRelief.warped` moves the landform **nearest the warp's centre, whole**, so
    // a candidate that is not a landform centre declares one support and moves another —
    // and `Warp.carries` then picks up features that never stood on the ground that moved.
    // Measured on this generator: curvature candidates sit a median 49 m from the landform
    // they would actually move. See `candidatesOf`.
    const map = make(7, 8);
    const candidates = map.analysis!.landforms;
    map.relief.landforms.forEach((f, i) => {
      expect(candidates[i]!.centre).toEqual({ x: f.x, y: f.y });
      expect(candidates[i]!.radius).toBe(f.radius * f.elongation);
      expect(candidates[i]!.amplitude).toBe(f.amplitude);
    });
  });

  it('carries the whole analysis an imported map carries, not only the landforms', () => {
    // `OMap.analysis` promises only the landforms, because that is all any drill reads
    // today. What is actually there is the pipeline's own `Analysis`, barriers and
    // runnability raster included, so a route-choice drill would find the same fields
    // whichever source drew the map.
    const analysis = make(12, 6).analysis as Analysis;
    expect(analysis.runnabilityGrid).toBe(RUNNABILITY_GRID);
    expect(analysis.runnability).toHaveLength(RUNNABILITY_GRID * RUNNABILITY_GRID);
    expect(analysis.barriers).toEqual(analyse(make(12, 6)).barriers);
  });
});

describe('terrain / height', () => {
  it('a landform contributes nothing beyond its own radius', () => {
    // The property the whole distractor design rests on: a local change stays local.
    const t = make(11);
    for (const f of t.relief.landforms) {
      const far = f.radius * f.elongation * 1.2;
      expect(Math.abs(contributionOf(f, f.x + far, f.y))).toBe(0);
      expect(Math.abs(contributionOf(f, f.x, f.y + far))).toBe(0);
    }
  });

  it('a hill peaks at its centre and a depression bottoms out there', () => {
    const t = make(23);
    for (const f of t.relief.landforms) {
      const centre = contributionOf(f, f.x, f.y);
      const off = contributionOf(f, f.x + f.radius * 0.5, f.y);
      expect(Math.abs(centre)).toBeGreaterThanOrEqual(Math.abs(off));
      expect(Math.sign(centre)).toBe(Math.sign(f.amplitude));
    }
  });

  it('sampleGrid reports the range it actually sampled', () => {
    const grid = sampleGrid(make(5).relief, 24);
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
    const grid = sampleGrid(t.relief, n);
    const step = t.width / n;
    for (const [i, j] of [[0, 0], [5, 7], [n, n], [3, n]] as const) {
      expect(grid.values[j * (n + 1) + i]).toBeCloseTo(t.relief.heightAt(i * step, j * step), 4);
    }
  });
});

describe('terrain / contours', () => {
  const grid = sampleGrid(make(13).relief, 64);

  it('traces closed rings around a single hill', () => {
    const lone = new AnalyticRelief({
      size: 400,
      // No tilt and no micro-relief: this is a test of the tracer's geometry, and it
      // wants a field whose contours are exactly rings.
      tilt: { x: 0, y: 0 },
      noiseSeed: 0,
      landforms: [{ kind: 'hill', x: 200, y: 200, radius: 120, amplitude: 20, rotation: 0, elongation: 1 }],
    });
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
    const lone = new AnalyticRelief({
      size: 400,
      tilt: { x: 0, y: 0 },
      noiseSeed: 0,
      landforms: [{ kind: 'hill', x: 200, y: 200, radius: 150, amplitude: 24, rotation: 0, elongation: 1 }],
    });
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
    const slope = new AnalyticRelief({
      size: 300,
      tilt: { x: 0.05, y: 0.02 },
      noiseSeed: 0,
      landforms: [],
    });
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
    const contours = contoursOf(sampleGrid(make(21).relief, 64), { interval: 5, resolution: 64 });
    for (const c of contours) {
      expect(c.index, `level ${c.level}`).toBe(Math.round(c.level / 5) % 5 === 0);
    }
  });

  it('tags a hollow and leaves a knoll alone', () => {
    // Without this the two are the same picture, and the relief drill asks a question its
    // own card cannot answer.
    const lone = (amplitude: number) => new AnalyticRelief({
      size: 400,
      tilt: { x: 0, y: 0 },
      noiseSeed: 0,
      landforms: [{ kind: 'hill', x: 200, y: 200, radius: 120, amplitude, rotation: 0, elongation: 1 }],
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
    const flat = new AnalyticRelief({
      size: 200, tilt: { x: 0, y: 0 }, noiseSeed: 0, landforms: [],
    });
    expect(contoursOf(sampleGrid(flat, 20), { interval: 5, resolution: 20 })).toEqual([]);
  });
});
