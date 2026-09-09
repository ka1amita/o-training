import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { contoursOf } from '@/lib/terrain/contours.ts';
import { heightGrid, sampleGridAt } from '@/lib/terrain/height.ts';
import type { Feature, OMap } from '@/lib/terrain/omap.ts';
import { NoRelief } from '@/lib/terrain/relief.ts';
import { requirementId, type WindowRequirement } from '../provider.ts';
import { analyse, bestWindows, scoreWindows } from './analyse.ts';
import { ALIASES, canonicalCode, resolveSemantics } from './codes.ts';
import { cropTo, importXmap } from './pipeline.ts';
import { gridFromAscii, parseAsciiGrid, rasteriseContours } from './relief.ts';
import { parseXmap } from './xmap.ts';

const tiny = readFileSync(new URL('./__fixtures__/tiny.xmap', import.meta.url), 'utf8');

const requirements: WindowRequirement[] = [
  { size: 20, needsRelief: false, minFeatures: { point: 1 } },
];

describe('codes / aliases', () => {
  it('moves the ISOM 2000 codes that the standard renumbered', () => {
    expect(canonicalCode('104', 'ISOM2000')).toBe('101.1');
    expect(canonicalCode('524', 'ISOM2000')).toBe('516');
  });

  it('moves the two the generator took for itself out of the way', () => {
    // 508 is a narrow ride here and a less distinct small path in the standard; 516 is a
    // fence here and a power line there. The generator's codes cannot move — every golden
    // is over features carrying them — so the imported ones do.
    expect(canonicalCode('508', 'ISOM2000')).toBe('507');
    expect(canonicalCode('516', 'ISOM2000')).toBe('511');
    expect(canonicalCode('522', 'ISOM2000')).toBe('516');
  });

  it('passes a symbol set it has not checked straight through', () => {
    // Giving up rather than guessing, again: a guessed alias turns a power line into a
    // fence, and an unaliased code still draws in its own colour.
    expect(canonicalCode('104', 'ISOM2017')).toBe('104');
    expect(canonicalCode('104', '')).toBe('104');
    expect(Object.keys(ALIASES)).toEqual(['ISOM2000']);
  });

  it('keeps an unknown code, with the colour its own map drew it in', () => {
    const resolved = resolveSemantics(parseXmap(tiny));
    const unknown = resolved.features.find((f) => f.code === '777')!;
    expect(unknown.colour).toBe('black');
    expect(resolved.unresolved.map((u) => u.code)).toEqual(['777']);
    expect(resolved.unresolved[0]!.name).toBe('Something we do not know');
    // ...and a known one does not carry a colour: the table owns that, and storing it
    // twice is two places for it to disagree.
    expect(resolved.features.find((f) => f.code === '101')!.colour).toBeUndefined();
  });

  it('numbers features by position, so a re-import gives the same ids', () => {
    const once = resolveSemantics(parseXmap(tiny)).features.map((f) => f.id);
    const again = resolveSemantics(parseXmap(tiny)).features.map((f) => f.id);
    expect(once).toEqual(again);
    expect(once[0]).toBe('feature-0');
  });
});

describe('relief / a grid from contour lines', () => {
  const SIZE = 300;
  const hill = (x: number, y: number) => {
    const d = Math.hypot(x - 150, y - 150) / 110;
    return 0.05 * x + (d >= 1 ? 0 : 30 * (1 - d * d) * (1 - d * d));
  };
  const lines = contoursOf(heightGrid({ heightAt: hill }, SIZE, 96), { interval: 5, resolution: 96 });

  it('passes through the lines it was given', () => {
    // The check that says the interpolation is an interpolation: on the lines themselves
    // the surface is the level that was drawn there, not near it.
    const grid = rasteriseContours(lines, SIZE, 128, 5);
    let worst = 0;
    for (const contour of lines) {
      for (const p of contour.points) {
        worst = Math.max(worst, Math.abs(sampleGridAt(grid, p.x, p.y) - contour.level));
      }
    }
    expect(worst).toBeLessThan(2.5);
  });

  it('gives a hill a summit rather than a plateau', () => {
    // The maximum principle: the smoothest surface fitting a set of rings has no interior
    // maximum at all, so every hill comes out a mesa — and `analyse` finds nothing to warp
    // on a map full of them.
    const grid = rasteriseContours(lines, SIZE, 128, 5);
    const summit = sampleGridAt(grid, 150, 150);
    const innermost = Math.max(...lines.map((c) => c.level));
    expect(summit).toBeGreaterThan(innermost);
    expect(summit).toBeLessThan(innermost + 5);
  });

  it('is monotone between two lines', () => {
    const grid = rasteriseContours(lines, SIZE, 128, 5);
    // Straight down the slope away from the summit the ground falls, and keeps falling:
    // no terraces between the lines and no invented ledges. Within a metre, because the
    // lifted summit is a dome stitched onto a harmonic surface and the join is not exactly
    // smooth — a fifth of the interval, and nothing a card can show.
    let previous = Infinity;
    // From outside the lifted summit: its dome peaks at the grid node nearest the ring's
    // centroid, which is a few metres off the exact centre, so the first step out of the
    // middle can still be rising.
    for (let x = 170; x < 290; x += 6) {
      const here = sampleGridAt(grid, x, 150);
      expect(here).toBeLessThanOrEqual(previous + 1);
      previous = here;
    }
    expect(sampleGridAt(grid, 286, 150)).toBeLessThan(sampleGridAt(grid, 150, 150) - 20);
  });
});

describe('relief / an Esri ASCII grid', () => {
  const asc = [
    'ncols 3', 'nrows 2', 'xllcorner 100', 'yllcorner 200', 'cellsize 10',
    'NODATA_value -9999',
    '1 2 3',
    '4 5 -9999',
  ].join('\n');

  it('reads the header and the rows', () => {
    const grid = parseAsciiGrid(asc);
    expect(grid.ncols).toBe(3);
    expect(grid.nrows).toBe(2);
    expect(grid.cellsize).toBe(10);
    expect([...grid.values]).toEqual([1, 2, 3, 4, 5, -9999]);
  });

  it('flips the row order, because an .asc counts y upward and a map counts it down', () => {
    // The mistake that makes every hill the valley beside it, and looks entirely plausible
    // until someone who knows the forest sees it. Row 0 of the file is the *north* row, so
    // it is the map's y = 0.
    const grid = gridFromAscii(parseAsciiGrid(asc), 20, 2);
    expect(sampleGridAt(grid, 0, 0)).toBeCloseTo(1, 6);
    expect(sampleGridAt(grid, 20, 0)).toBeCloseTo(3, 6);
    expect(sampleGridAt(grid, 0, 10)).toBeCloseTo(4, 6);
  });

  it('refuses a DEM that does not cover the map', () => {
    expect(() => gridFromAscii(parseAsciiGrid(asc), 20, 2, { x: 100000, y: 100000 }))
      .toThrow(/does not cover/);
  });

  it('refuses a header it cannot read', () => {
    expect(() => parseAsciiGrid('ncols 3\n1 2 3')).toThrow(/nrows/);
  });
});

describe('analyse', () => {
  const feature = (id: string, code: string, x: number, y: number): Feature => ({
    id, code, geometry: { kind: 'point', at: { x, y } },
  });
  const flat: OMap = {
    id: 'flat',
    width: 100,
    height: 100,
    scale: 10000,
    relief: new NoRelief(100),
    features: [
      feature('a', '206', 10, 10),
      feature('b', '112', 50, 50),
      { id: 'c', code: '516', geometry: { kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 90, y: 90 }] } },
      {
        id: 'd',
        code: '410',
        geometry: {
          kind: 'polygon',
          rings: [[{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }]],
        },
      },
    ],
  };

  it('finds the barriers by code, not by name', () => {
    expect(analyse(flat).barriers).toEqual(['c']);
  });

  it('gives an area runnability to the cells it covers', () => {
    const analysis = analyse(flat);
    const cells = analysis.runnabilityGrid;
    const step = 100 / cells;
    const at = (x: number, y: number) =>
      analysis.runnability[Math.floor(y / step) * cells + Math.floor(x / step)]!;
    expect(at(20, 20)).toBeCloseTo(0.25, 6);
    expect(at(80, 80)).toBe(1);
  });

  it('finds no landforms on ground that has none', () => {
    expect(analyse(flat).landforms).toEqual([]);
  });
});

describe('scoreWindows', () => {
  const map: OMap = {
    id: 'm',
    width: 200,
    height: 200,
    scale: 10000,
    relief: new NoRelief(200),
    // Everything in one corner: the windows that hold it should win, and the empty ones
    // should not be offered at all.
    features: Array.from({ length: 12 }, (_, i): Feature => ({
      id: `p${i}`,
      code: '206',
      geometry: { kind: 'point', at: { x: 10 + (i % 4) * 8, y: 10 + Math.floor(i / 4) * 8 } },
    })),
  };
  const requirement: WindowRequirement = {
    size: 60,
    needsRelief: false,
    minFeatures: { point: 6 },
  };

  it('prefers the ground that holds something', () => {
    const windows = bestWindows(map, analyse(map), requirement);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0]!.crop.x).toBeLessThan(30);
    expect(windows[0]!.crop.y).toBeLessThan(30);
    expect(windows[0]!.features).toBeGreaterThanOrEqual(6);
  });

  it('offers nothing at all when nothing satisfies the requirement', () => {
    // A window that cannot answer the question is not a hard round, it is an unanswerable
    // one — so it scores zero and is dropped rather than being the best of a bad set.
    const relief: WindowRequirement = { size: 60, needsRelief: true };
    expect(bestWindows(map, analyse(map), relief)).toEqual([]);
  });

  it('is deterministic, so re-importing a map does not move its windows', () => {
    const once = bestWindows(map, analyse(map), requirement).map((w) => w.crop);
    const again = bestWindows(map, analyse(map), requirement).map((w) => w.crop);
    expect(once).toEqual(again);
  });

  it('keys the lists by what was asked for, not by who asked', () => {
    const analysis = analyse(map);
    const lists = scoreWindows(map, analysis, [requirement, { ...requirement, needsRelief: false }]);
    // The same requirement twice is one list, because two drills wanting the same ground
    // should share it.
    expect(Object.keys(lists)).toEqual([requirementId(requirement)]);
    expect(requirementId(requirement)).toBe('s60');
  });
});

describe('importXmap / end to end on the hand-written map', () => {
  const report = importXmap(tiny, { name: 'tiny', requirements });

  it('runs every stage and says what each one did', () => {
    expect(report.notes[0]).toMatch(/parsed: 7 objects/);
    expect(report.notes.join('\n')).toMatch(/semantics: /);
    expect(report.notes.join('\n')).toMatch(/relief: /);
    expect(report.notes.join('\n')).toMatch(/analysis: /);
    expect(report.notes.join('\n')).toMatch(/windows: /);
  });

  it('gives up on relief rather than guessing at it', () => {
    // Three contour fragments say nothing about which way is up.
    expect(report.map.relief.kind).toBe('none');
    expect(report.notes.join('\n')).toMatch(/contour levels unresolved|no contour lines/);
    expect(report.bundle.relief.kind).toBe('none');
  });

  it('squares the map up and records where it came from', () => {
    expect(report.map.width).toBe(report.map.height);
    expect(report.map.width).toBeCloseTo(55, 6);
    expect(report.map.meta?.name).toBe('tiny');
    expect(report.map.meta?.scale).toBe(10000);
    expect(report.map.meta?.source).toBe('xmap');
  });

  it('names the bundle by its content, and the same map twice the same way', () => {
    expect(report.bundle.id).toMatch(/^[0-9a-f]{64}$/);
    expect(importXmap(tiny, { name: 'tiny', requirements }).bundle.id).toBe(report.bundle.id);
    expect(importXmap(tiny, { name: 'other', requirements }).bundle.id).not.toBe(report.bundle.id);
  });
});

describe('cropTo', () => {
  const features = resolveSemantics(parseXmap(tiny)).features;

  it('keeps whole features and moves the origin', () => {
    const kept = cropTo(features, { x: 0, y: 0, size: 12 });
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(features.length);
    const moved = cropTo(features, { x: 5, y: 5, size: 40 });
    const point = moved.find((f) => f.code === '112')!;
    expect(point.geometry).toEqual({ kind: 'point', at: { x: 0, y: 2 } });
  });

  it('keeps the ids, because an id names a feature and not a position in a list', () => {
    const kept = cropTo(features, { x: 0, y: 20, size: 40 });
    for (const feature of kept) {
      expect(features.some((f) => f.id === feature.id)).toBe(true);
    }
  });
});
