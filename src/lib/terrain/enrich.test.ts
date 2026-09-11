import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadBundle, type MapBundle } from '@/lib/maps/bundle.ts';
import { hashJson, seeded } from '@/lib/rng.ts';
import { applyEdits, difference, plausibilityOf, suitsAt, type Edit } from './edits.ts';
import {
  ADDABLE, budgetFor, drawnSizeOf, footprintOf, MIN_SALIENCE, proposeEnrichment, scaledBy,
} from './enrich.ts';
import MapView from './MapView.tsx';
import {
  areasOf, insideCrop, pointsOf, positionOf,
  type Crop, type Feature, type OMap,
} from './omap.ts';
import { NoRelief } from './relief.ts';
import { semanticsOf } from './semantics.ts';
import { generateTerrain, MIN_POINT_SEPARATION, paramsFor, separationOf } from './terrain.ts';

/**
 * Enrichment, as properties over both kinds of map it has to work on.
 *
 * The generated map is the easy case and the surveyed one is the case this exists for:
 * Mapper's forest sample carries 32 point features in 554 m of forest, twelve of them one
 * vegetation symbol, so a three-hundred-metre window offers four or five distinct point
 * codes where a level asks for more. The measurement at the bottom is the number that
 * says whether any of this was worth doing.
 */
const bundleJson = JSON.parse(
  readFileSync(new URL('../../../public/maps/forest-sample.json', import.meta.url), 'utf8'),
) as MapBundle;
const forest = loadBundle(bundleJson);
const window300 = forest.windows!['s300.k3']!;

const generated = (seed: number): OMap =>
  generateTerrain(seeded(seed), paramsFor(5, 300));

const anySeed = fc.integer({ min: 0, max: 0xffff });

/** Every point symbol on the map, the picture's blobs included. They all take room. */
const standingOn = (map: OMap): readonly Feature[] =>
  [...pointsOf(map), ...(map.analysis?.moveable ?? [])];

const added = (edits: readonly Edit[]): Feature[] =>
  edits.flatMap((e) => (e.op === 'add' ? [e.feature] : []));

describe('the vocabulary enrichment may invent', () => {
  it('is point symbols a control description can name, and nothing built by people', () => {
    expect(ADDABLE.length).toBeGreaterThan(12);
    for (const code of ADDABLE) {
      const semantics = semanticsOf(code)!;
      expect(semantics.geometry, code).toBe('point');
      expect(semantics.controlSite, code).toBe(true);
      // A tower is there because somebody built it: the ground has no opinion, so `suits`
      // cannot judge one and this must not invent one.
      expect(semantics.family, code).not.toBe('manmade');
      expect(semantics.family, code).not.toBe('overprint');
    }
    // The special-feature symbols mean whatever the legend says. Placing one writes a
    // legend entry the map does not have.
    for (const special of ['115', '313', '419']) expect(ADDABLE).not.toContain(special);
    // The pair every beginner confuses is in there, which is the point of swapping at all.
    expect(ADDABLE).toContain('204');
    expect(ADDABLE).toContain('109');
  });

  it('sizes a symbol from the standard, at the map the symbol is on', () => {
    // 0.4 mm of boulder is 6 m of ground at 1:15000 and 4 m at the 1:10000 the forest
    // sample was drawn at — the band the generator draws its own boulders in, arrived at
    // from ISOM rather than copied from the generator.
    expect(drawnSizeOf('204', 15000)).toBeCloseTo(6);
    expect(drawnSizeOf('204', 10000)).toBeCloseTo(4);
  });
});

describe('proposeEnrichment', () => {
  it('is pure: the same map, window and rng state give the same edits', () => {
    fc.assert(
      fc.property(anySeed, (seed) => {
        const crop = window300[seed % window300.length]!;
        const once = proposeEnrichment(forest, crop, seeded(seed), budgetFor(7));
        const again = proposeEnrichment(forest, crop, seeded(seed), budgetFor(7));
        expect(hashJson(again)).toBe(hashJson(once));
      }),
      { numRuns: 30 },
    );
  });

  it('draws no numbers at all for an empty budget', () => {
    // What makes the adjusted source at intensity 0 the real source draw for draw, the
    // same way a mix at 100% one part is that part draw for draw.
    const a = seeded(4);
    const b = seeded(4);
    expect(proposeEnrichment(forest, window300[0]!, a, scaledBy(budgetFor(10), 0))).toEqual([]);
    expect(a.next()).toBe(b.next());
  });

  it('never spends more than the budget', () => {
    for (const level of [1, 5, 10]) {
      const budget = budgetFor(level);
      for (let seed = 0; seed < 20; seed++) {
        const edits = proposeEnrichment(
          forest, window300[seed % window300.length]!, seeded(seed), budget,
        );
        const count = (op: Edit['op']) => edits.filter((e) => e.op === op).length;
        expect(count('add'), `level ${level} seed ${seed}`).toBeLessThanOrEqual(budget.adds);
        expect(count('remove')).toBeLessThanOrEqual(budget.removes);
        expect(count('swap')).toBeLessThanOrEqual(budget.swaps);
        expect(count('move')).toBeLessThanOrEqual(budget.moves);
        expect(count('warp')).toBe(0);
      }
    }
  });

  it('gives every edit an identity of its own, and never touches one twice', () => {
    for (let seed = 0; seed < 30; seed++) {
      const edits = proposeEnrichment(
        forest, window300[seed % window300.length]!, seeded(seed), budgetFor(10),
      );
      const names = edits.map((e) => (e.op === 'add' ? e.feature.id : e.op === 'warp' ? 'w' : e.feature));
      expect(new Set(names).size, `seed ${seed}`).toBe(names.length);
      // `add:<n>`, stable and never a feature the map already had.
      const ids = new Set(forest.features.map((f) => f.id));
      for (const feature of added(edits)) {
        expect(feature.id).toMatch(/^add:\d+$/);
        expect(ids.has(feature.id)).toBe(false);
      }
    }
  });

  it('adds nothing the window cannot show, and nothing nobody could see', () => {
    fc.assert(
      fc.property(anySeed, fc.integer({ min: 1, max: 10 }), (seed, level) => {
        const crop = window300[seed % window300.length]!;
        const edits = proposeEnrichment(forest, crop, seeded(seed), budgetFor(level));
        for (const edit of edits) {
          const report = difference({ base: forest, edits: [edit] }, crop);
          expect(report.visible, JSON.stringify(edit)).toBe(true);
          expect(report.salience).toBeGreaterThanOrEqual(MIN_SALIENCE);
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe('what an added symbol has to be true of', () => {
  const cases: { name: string; map: OMap; crop: Crop }[] = [
    { name: 'the forest sample', map: forest, crop: window300[0]! },
    { name: 'a generated map', map: generated(3), crop: { x: 0, y: 0, size: 300 } },
  ];

  for (const { name, map, crop } of cases) {
    it(`stands on ground that suits it — ${name}`, () => {
      const where = plausibilityOf(map);
      for (let seed = 0; seed < 25; seed++) {
        const edits = proposeEnrichment(map, crop, seeded(seed), budgetFor(10));
        for (const feature of added(edits)) {
          expect(suitsAt(feature.code, where, positionOf(feature)), `${feature.code} seed ${seed}`)
            .toBe(true);
        }
      }
    });

    it(`keeps print's distance from every other symbol — ${name}`, () => {
      for (let seed = 0; seed < 25; seed++) {
        const edits = proposeEnrichment(map, crop, seeded(seed), budgetFor(10));
        const after = applyEdits(map, edits);
        const points = standingOn(after);
        for (const feature of added(edits)) {
          for (const other of points) {
            if (other.id === feature.id) continue;
            const gap = Math.hypot(
              positionOf(other).x - positionOf(feature).x,
              positionOf(other).y - positionOf(feature).y,
            );
            // `separationOf`, because a cliff takes more room than a boulder — and never
            // under the floor that constant advertises.
            expect(gap, `${feature.id} to ${other.id}, seed ${seed}`)
              .toBeGreaterThanOrEqual(Math.min(separationOf(feature, other), gap + 1) - 1e-9);
            expect(gap).toBeGreaterThanOrEqual(MIN_POINT_SEPARATION - 1e-9);
          }
        }
      }
    });

    it(`lands inside the window, drawn whole — ${name}`, () => {
      for (let seed = 0; seed < 25; seed++) {
        const edits = proposeEnrichment(map, crop, seeded(seed), budgetFor(10));
        for (const feature of added(edits)) {
          const at = positionOf(feature);
          expect(insideCrop(at, crop), `seed ${seed}`).toBe(true);
          const size = feature.size!;
          expect(at.x - size).toBeGreaterThanOrEqual(Math.max(0, crop.x) - 1e-9);
          expect(at.x + size).toBeLessThanOrEqual(Math.min(map.width, crop.x + crop.size) + 1e-9);
        }
      }
    });

    it(`carries the size its own symbol is drawn at — ${name}`, () => {
      for (let seed = 0; seed < 10; seed++) {
        for (const feature of added(proposeEnrichment(map, crop, seeded(seed), budgetFor(10)))) {
          expect(feature.size).toBeCloseTo(drawnSizeOf(feature.code, map.scale));
        }
      }
    });
  }

  it('never puts a boulder in a lake, in a building or on a paved yard', () => {
    // The half of plausibility a height field cannot see. The forest sample has fifty
    // buildings and no water at all, so the water half is a map built for it.
    const lake: Feature = {
      id: 'lake',
      code: '301',
      geometry: {
        kind: 'polygon',
        rings: [[{ x: 40, y: 40 }, { x: 260, y: 40 }, { x: 260, y: 260 }, { x: 40, y: 260 }]],
      },
    };
    const base = generated(11);
    const flooded: OMap = { ...base, features: [...base.features, lake] };
    const crop: Crop = { x: 0, y: 0, size: 300 };
    let dry = 0;
    for (let seed = 0; seed < 30; seed++) {
      for (const feature of added(proposeEnrichment(flooded, crop, seeded(seed), budgetFor(10)))) {
        const at = positionOf(feature);
        const inside = at.x > 40 && at.x < 260 && at.y > 40 && at.y < 260;
        if (inside) expect(semanticsOf(feature.code)?.family, `${feature.code} in the lake`).toBe('water');
        else dry++;
      }
    }
    expect(dry).toBeGreaterThan(0);

    for (let seed = 0; seed < 30; seed++) {
      const window_ = window300[seed % window300.length]!;
      for (const feature of added(proposeEnrichment(forest, window_, seeded(seed), budgetFor(10)))) {
        const at = positionOf(feature);
        for (const area of areasOf(forest)) {
          const semantics = semanticsOf(area.code);
          // Nothing may stand in what cannot be entered — the sample's fifty buildings
          // and eight out-of-bounds areas.
          if (semantics?.runnability !== 0) continue;
          expect(insidePolygonHere(at, area), `${feature.id} inside ${area.code}`).toBe(false);
        }
      }
    }
  });
});

/** The even-odd test `analysis.ts` owns, restated here so the assertion reads locally. */
function insidePolygonHere(p: { x: number; y: number }, feature: Feature): boolean {
  if (feature.geometry.kind !== 'polygon') return false;
  let inside = false;
  for (const ring of feature.geometry.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!;
      const b = ring[j]!;
      if ((a.y > p.y) !== (b.y > p.y)
        && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

describe('what a swap and a move have to be true of', () => {
  it('a swapped symbol is one the ground under it agrees with', () => {
    const where = plausibilityOf(forest);
    for (let seed = 0; seed < 40; seed++) {
      const crop = window300[seed % window300.length]!;
      const edits = proposeEnrichment(forest, crop, seeded(seed), budgetFor(10));
      for (const edit of edits) {
        if (edit.op !== 'swap') continue;
        const was = forest.features.find((f) => f.id === edit.feature)!;
        expect(ADDABLE, `${was.code} was swapped`).toContain(was.code);
        expect(ADDABLE).toContain(edit.code);
        expect(edit.code).not.toBe(was.code);
        expect(suitsAt(edit.code, where, positionOf(was)), `${was.code} -> ${edit.code}`).toBe(true);
      }
    }
  });

  it('a moved feature still suits the ground it landed on, and is still in the window', () => {
    const where = plausibilityOf(forest);
    for (let seed = 0; seed < 40; seed++) {
      const crop = window300[seed % window300.length]!;
      const edits = proposeEnrichment(forest, crop, seeded(seed), budgetFor(10));
      const after = applyEdits(forest, edits);
      for (const edit of edits) {
        if (edit.op !== 'move') continue;
        const now = after.features.find((f) => f.id === edit.feature)!;
        const at = positionOf(now);
        // An area has no `shape` when it was imported, so its position after a move is a
        // centroid recomputed from translated vertices — the last bit of it is float
        // noise, and a window edge is exactly where that shows.
        const eased = { x: crop.x - 1e-6, y: crop.y - 1e-6, size: crop.size + 2e-6 };
        expect(insideCrop(at, eased), `${edit.feature} seed ${seed}`).toBe(true);
        expect(suitsAt(now.code, where, at), `${now.code} seed ${seed}`).toBe(true);
      }
    }
  });

  it('a removed feature is one the window holds whole', () => {
    for (let seed = 0; seed < 40; seed++) {
      const crop = window300[seed % window300.length]!;
      for (const edit of proposeEnrichment(forest, crop, seeded(seed), budgetFor(10))) {
        if (edit.op !== 'remove') continue;
        const was = forest.features.find((f) => f.id === edit.feature)!;
        // Never a line: a path runs off the window and out the other side, and removing
        // one inside a card leaves it stopping in mid-air on every other card of the map.
        expect(was.geometry.kind, `${was.code}`).not.toBe('polyline');
        expect(insideCrop(positionOf(was), crop)).toBe(true);
      }
    }
  });
});

describe('applyEdits materialises an add and a swap all the way through', () => {
  const crop = window300[0]!;
  const edits = proposeEnrichment(forest, crop, seeded(12), budgetFor(10));

  it('puts the added feature where every reader of a map looks', () => {
    const after = applyEdits(forest, edits);
    for (const feature of added(edits)) {
      // `features`, so `pointsOf` sees it — and `pointsOf` is what the renderer culls,
      // what pexeso stands a control on, and what map dohledavka reads sites off.
      expect(after.features).toContainEqual(feature);
      expect(pointsOf(after).map((f) => f.id)).toContain(feature.id);
    }
    expect(after.features.length)
      .toBe(forest.features.length + added(edits).length - edits.filter((e) => e.op === 'remove').length);
  });

  it('draws it: the symbol reaches the page', () => {
    // Rendering is checked by eye — `AGENTS.md` — and this is the one thing eyes cannot
    // do reliably: notice that a whole class of symbol silently drew nothing.
    const before = renderToStaticMarkup(createElement(MapView, { map: forest, crop }));
    const after = renderToStaticMarkup(
      createElement(MapView, { map: applyEdits(forest, edits), crop }),
    );
    expect(after).not.toBe(before);
    const marks = (svg: string) => svg.split('<circle').length + svg.split('<path').length;
    expect(marks(after)).toBeGreaterThan(0);
    for (const feature of added(edits)) {
      const at = positionOf(feature);
      // The coordinates the symbol is drawn at appear in the document; the old one has
      // nothing at that place.
      expect(after).toContain(at.x.toString().slice(0, 8));
    }
  });

  it('a swap changes the code and drops the generator word for what it was', () => {
    const base = generated(5);
    const point = pointsOf(base).find((f) => ADDABLE.includes(f.code))!;
    const swapped = applyEdits(base, [{ op: 'swap', feature: point.id, code: '109' }]);
    const now = swapped.features.find((f) => f.id === point.id)!;
    expect(now.code).toBe('109');
    expect(now.kind).toBeUndefined();
    expect(positionOf(now)).toEqual(positionOf(point));
  });

  it('reports the change: `difference` reads an add through its own drawn size', () => {
    // It did not, and the symbols it silently scored below the floor were the faint ones
    // — which made "add the kinds the window lacks" quietly mean "add the loud ones".
    const at = { x: crop.x + 60, y: crop.y + 60 };
    const size = drawnSizeOf('418', forest.scale);
    const report = difference({
      base: forest,
      edits: [{ op: 'add', feature: { id: 'add:0', code: '418', geometry: { kind: 'point', at }, size } }],
    }, crop);
    expect(report.salience).toBeGreaterThanOrEqual(MIN_SALIENCE);
    expect(report.visible).toBe(true);
  });
});

describe('footprintOf', () => {
  it('says where an edit happened and how much room to allow it', () => {
    // What the discrepancy drill hit-tests a tap against. Read off the edit and the base
    // map, never off the two drawings.
    const crop = window300[2]!;
    const edits = proposeEnrichment(forest, crop, seeded(21), budgetFor(10));
    expect(edits.length).toBeGreaterThan(0);
    for (const edit of edits) {
      const spot = footprintOf(forest, edit)!;
      expect(spot).not.toBeNull();
      expect(spot.radius).toBeGreaterThan(0);
      // Inside the window, because that is where every edit here was required to be.
      expect(insideCrop(spot.at, crop), JSON.stringify(edit)).toBe(true);
    }
  });

  it('has nothing to say about an edit naming a feature the map does not hold', () => {
    expect(footprintOf(forest, { op: 'remove', feature: 'nonesuch' })).toBeNull();
  });
});

describe('a map with no ground to read', () => {
  it('a flat map with no picture is asked nothing, and still gets its symbols', () => {
    // `plausibilityOf` returns null: a grid of zeros has no steepest quarter, and asking
    // it would refuse every symbol that has an opinion. Nothing is implausible there.
    const flat: OMap = {
      id: 'flat', width: 300, height: 300, scale: 15000,
      relief: new NoRelief(300), features: [],
    };
    const edits = proposeEnrichment(flat, { x: 0, y: 0, size: 300 }, seeded(1), budgetFor(10));
    expect(added(edits).length).toBe(budgetFor(10).adds);
    // Nothing to remove, swap or move on a map with no features, and it says so by
    // proposing none rather than by throwing.
    expect(edits.every((e) => e.op === 'add')).toBe(true);
  });
});

/**
 * The measurement the whole package is for.
 *
 * Distinct point codes in a 300 m window of the forest sample, before and after, over
 * twenty windows a level. Printed rather than only asserted, because the numbers are what
 * the design note quotes and a number nobody can read is a number nobody re-measures.
 */
describe('what enrichment buys, on the forest sample', () => {
  it('turns four or five distinct point codes in a window into nine or more', () => {
    const kinds = (map: OMap, crop: Crop) =>
      new Set(pointsOf(map).filter((f) => insideCrop(positionOf(f), crop)).map((f) => f.code)).size;

    const report: string[] = [];
    for (const level of [1, 5, 10]) {
      const budget = budgetFor(level);
      const counts = { add: 0, remove: 0, swap: 0, move: 0 };
      let before = 0;
      let after = 0;
      const seeds = 20;
      for (let seed = 0; seed < seeds; seed++) {
        const crop = window300[seed % window300.length]!;
        const edits = proposeEnrichment(forest, crop, seeded(seed * 7 + level), budget);
        for (const edit of edits) {
          if (edit.op !== 'warp') counts[edit.op]++;
        }
        before += kinds(forest, crop);
        after += kinds(applyEdits(forest, edits), crop);
      }
      const mean = (n: number) => (n / seeds).toFixed(2);
      report.push(
        `level ${level}: adds ${mean(counts.add)} removes ${mean(counts.remove)} `
        + `swaps ${mean(counts.swap)} moves ${mean(counts.move)} — `
        + `distinct point codes per 300 m window ${mean(before)} → ${mean(after)}`,
      );
      // Every slot the budget offered was spent: a level that asks for six adds and finds
      // four is a window this cannot enrich, and the numbers below would say so.
      expect(counts.add / seeds, `level ${level}`).toBe(budget.adds);
      expect(counts.remove / seeds).toBe(budget.removes);
      expect(counts.swap / seeds).toBe(budget.swaps);
      expect(counts.move / seeds).toBe(budget.moves);
      expect(after / seeds).toBeGreaterThan(before / seeds);
    }
    console.log(report.join('\n'));
    expect(report).toHaveLength(3);
  });
});
