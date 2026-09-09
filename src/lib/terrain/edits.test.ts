import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { seeded } from '@/lib/rng.ts';
import { applyEdits, difference, proposeEdit, type Edit } from './edits.ts';
import { maxHeightDifference } from './height.ts';
import { linesOf, pointsOf, positionOf, wholeMap, type OMap, type Vec } from './omap.ts';
import { AnalyticRelief } from './relief.ts';
import { generateTerrain, paramsFor, type GeneratedMap } from './terrain.ts';

const anySeed = fc.integer({ min: 0, max: 0xffffffff });
const anyLevel = fc.integer({ min: 1, max: 10 });
const make = (seed: number, level = 5): GeneratedMap =>
  generateTerrain(seeded(seed), paramsFor(level));

const ANY: readonly Edit['op'][] = ['warp', 'move'];

const landformsOf = (map: OMap): Vec[] =>
  map.relief instanceof AnalyticRelief
    ? map.relief.landforms.map((f) => ({ x: f.x, y: f.y }))
    : [];

/** Every position an edit could move: the ground's landforms and the map's features. */
const places = (map: OMap): Vec[] => [...landformsOf(map), ...map.features.map(positionOf)];

const movedCount = (was: readonly Vec[], now: readonly Vec[]): number => {
  let moved = 0;
  was.forEach((p, i) => {
    const q = now[i]!;
    if (p.x !== q.x || p.y !== q.y) moved++;
  });
  return moved;
};

describe('edits / proposeEdit', () => {
  it('moves exactly one thing, by the distance asked for, and carries what stood on it', () => {
    fc.assert(
      fc.property(anySeed, fc.integer({ min: 5, max: 60 }), (seed, distance) => {
        const before = make(seed);
        const edit = proposeEdit(before, seeded(seed + 1), { distance, ops: ANY });
        const after = applyEdits(before, [edit]);

        const d = edit.op === 'warp' ? edit.warp : edit.op === 'move' ? edit : null;
        expect(Math.hypot(d!.dx, d!.dy)).toBeCloseTo(distance, 6);

        if (edit.op !== 'warp') {
          expect(movedCount(places(before), places(after))).toBe(1);
          return;
        }
        // A warp moves one piece of ground — and, since it carries, whatever was standing
        // on that ground. So "exactly one thing moved" becomes "exactly one landform
        // moved, and nothing moved that was not inside the support".
        expect(movedCount(landformsOf(before), landformsOf(after))).toBe(1);
        const { centre, radius } = edit.warp;
        before.features.forEach((was, i) => {
          const now = after.features[i]!;
          const at = positionOf(was);
          if (Math.hypot(at.x - centre.x, at.y - centre.y) < radius) return;
          expect(positionOf(now)).toEqual(at);
        });
      }),
      { numRuns: 200 },
    );
  });

  it('leaves everything else identical', () => {
    // A move, specifically: a warp is allowed to take the features standing on it with
    // it, and the test above is the one that pins which of them may go.
    const before = make(31);
    const after = applyEdits(before, [
      proposeEdit(before, seeded(2), { distance: 30, ops: ['move'] }),
    ]);
    expect(linesOf(after)).toEqual(linesOf(before));
    expect(after.width).toBe(before.width);
    expect(after.features).toHaveLength(before.features.length);
  });

  it('keeps the moved thing on the map', () => {
    fc.assert(
      fc.property(anySeed, fc.integer({ min: 5, max: 200 }), (seed, distance) => {
        const before = make(seed);
        const after = applyEdits(before, [
          proposeEdit(before, seeded(seed), { distance, ops: ANY }),
        ]);
        for (const p of places(after)) {
          expect(p.x >= 0 && p.x <= after.width && p.y >= 0 && p.y <= after.width).toBe(true);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('warping is what changes the relief', () => {
    // Moving a boulder leaves the contours identical, which would make a contour
    // distractor indistinguishable from the answer. This is why the drill asks for warps.
    fc.assert(
      fc.property(anySeed, (seed) => {
        const base = make(seed);
        const edit = proposeEdit(base, seeded(seed + 7), { distance: 40, ops: ['warp'] });
        expect(edit.op).toBe('warp');
        const after = applyEdits(base, [edit]);
        expect(maxHeightDifference(base.relief, after.relief)).toBeGreaterThan(0.5);
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
        const after = applyEdits(base, [
          proposeEdit(base, seeded(seed + 1), { distance: 30, ops: ANY }),
        ]);
        const relief = after.relief as AnalyticRelief;
        expect(relief.noiseSeed).toBe(base.relief.noiseSeed);
        expect(relief.tilt).toEqual(base.relief.tilt);
      }),
      { numRuns: 100 },
    );
  });

  it('a bigger move changes the relief more', () => {
    const base = make(77);
    const small = applyEdits(base, [proposeEdit(base, seeded(3), { distance: 10, ops: ['warp'] })]);
    const large = applyEdits(base, [proposeEdit(base, seeded(3), { distance: 60, ops: ['warp'] })]);
    expect(maxHeightDifference(base.relief, large.relief))
      .toBeGreaterThan(maxHeightDifference(base.relief, small.relief));
  });
});

describe('edits / applyEdits', () => {
  it('is pure: the base is untouched', () => {
    const base = make(5);
    const before = places(base).map((p) => ({ ...p }));
    applyEdits(base, [{ op: 'move', feature: base.features[0]!.id, dx: 20, dy: -10 }]);
    expect(places(base)).toEqual(before);
  });

  it('a move changes exactly that feature', () => {
    fc.assert(
      fc.property(anySeed, fc.integer({ min: 0, max: 40 }), (seed, which) => {
        const base = make(seed);
        const target = base.features[which % base.features.length]!;
        const after = applyEdits(base, [{ op: 'move', feature: target.id, dx: 12, dy: -7 }]);

        for (const before of base.features) {
          const now = after.features.find((f) => f.id === before.id)!;
          if (before.id === target.id) {
            const from = positionOf(before);
            const to = positionOf(now);
            expect(to.x - from.x).toBeCloseTo(12, 6);
            expect(to.y - from.y).toBeCloseTo(-7, 6);
          } else {
            expect(now).toEqual(before);
          }
        }
      }),
      { numRuns: 80 },
    );
  });

  it('a warp leaves every point outside its support at exactly the same height', () => {
    // The property the whole distractor design rests on: a local change stays local, so a
    // sibling differs from its base only where the ground moved.
    fc.assert(
      fc.property(anySeed, (seed) => {
        const base = make(seed);
        const form = base.relief.landforms[0]!;
        const warp = {
          centre: { x: form.x, y: form.y },
          radius: form.radius * form.elongation,
          dx: 25,
          dy: 15,
        };
        const after = applyEdits(base, [{ op: 'warp', warp }]);
        const reach = warp.radius + Math.hypot(warp.dx, warp.dy);
        for (let j = 0; j <= 24; j++) {
          for (let i = 0; i <= 24; i++) {
            const x = (i * base.width) / 24;
            const y = (j * base.width) / 24;
            if (Math.hypot(x - warp.centre.x, y - warp.centre.y) <= reach) continue;
            expect(after.relief.heightAt(x, y)).toBe(base.relief.heightAt(x, y));
          }
        }
      }),
      { numRuns: 40 },
    );
  });

  it('a carrying warp moves the features inside its support and no others', () => {
    // What `carries` is for, and why the generator leaves it off: see `Warp.carries`.
    const base = make(9);
    const form = base.relief.landforms[0]!;
    const warp = {
      centre: { x: form.x, y: form.y },
      radius: form.radius * form.elongation,
      dx: 18,
      dy: -6,
      carries: true,
    };
    const after = applyEdits(base, [{ op: 'warp', warp }]);

    let carried = 0;
    for (const before of base.features) {
      const now = after.features.find((f) => f.id === before.id)!;
      const at = positionOf(before);
      const inside = Math.hypot(at.x - warp.centre.x, at.y - warp.centre.y) < warp.radius;
      if (inside) {
        if (!positionsEqual(positionOf(now), at)) carried++;
      } else {
        expect(now).toEqual(before);
      }
    }
    expect(carried).toBeGreaterThan(0);
  });
});

const positionsEqual = (a: Vec, b: Vec) => a.x === b.x && a.y === b.y;

describe('edits / difference', () => {
  const base = make(13);
  const corner = { x: 0, y: 0, size: 40 };

  it('does not see an edit outside the window', () => {
    // The failure map memory is most exposed to: a feature moved off-screen leaves two
    // identical cards, and the round then has two right answers.
    const far = pointsOf(base).find((f) => {
      const at = positionOf(f);
      return at.x > 150 && at.y > 150;
    })!;
    const report = difference({ base, edits: [{ op: 'move', feature: far.id, dx: 10, dy: 10 }] }, corner);
    expect(report.visible).toBe(false);
    expect(report.footprint).toBe(0);
  });

  it('sees an edit inside the window, and says which family it touched', () => {
    const near = pointsOf(base)[0]!;
    const at = positionOf(near);
    const around = { x: at.x - 50, y: at.y - 50, size: 100 };
    const report = difference({ base, edits: [{ op: 'move', feature: near.id, dx: 5, dy: 5 }] }, around);
    expect(report.visible).toBe(true);
    expect(report.families).toHaveLength(1);
    expect(report.salience).toBeGreaterThan(0);
  });

  it('gives a warp inside the window a footprint and a relief delta', () => {
    const form = base.relief.landforms[0]!;
    const warp = {
      centre: { x: form.x, y: form.y },
      radius: form.radius * form.elongation,
      dx: 30,
      dy: 0,
    };
    const report = difference({ base, edits: [{ op: 'warp', warp }] }, wholeMap(base));
    expect(report.visible).toBe(true);
    expect(report.footprint).toBeGreaterThan(0);
    expect(report.reliefDelta).toBeGreaterThan(0);
    expect(report.families).toEqual(['landform']);
  });

  it('reports no relief delta for an edit that does not touch the ground', () => {
    const feature = pointsOf(base)[0]!;
    const report = difference(
      { base, edits: [{ op: 'move', feature: feature.id, dx: 9, dy: 0 }] },
      wholeMap(base),
    );
    expect(report.reliefDelta).toBe(0);
  });
});
