import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { contours as contoursDrill } from '@/drills/contours/drill.ts';
import { mapDohledavka } from '@/drills/mapDohledavka/drill.ts';
import { mapMemory } from '@/drills/mapMemory/drill.ts';
import { pexeso, requirementFor as pexesoRequirement } from '@/drills/pexeso/drill.ts';
import { hashJson, seeded } from '@/lib/rng.ts';
import { applyEdits } from '@/lib/terrain/edits.ts';
import { proposeEnrichment } from '@/lib/terrain/enrich.ts';
import MapView from '@/lib/terrain/MapView.tsx';
import { insideCrop, pointsOf, positionOf, type Crop, type OMap } from '@/lib/terrain/omap.ts';
import { loadBundle, type MapBundle } from './bundle.ts';
import { FIXTURE_METRES_PER_PIXEL, syntheticMap } from './import/__fixtures__/paint.ts';
import { importImage } from './import/pipeline.ts';
import { libraryRequirements } from './library.ts';
import {
  AdjustedProvider, LibraryProvider, requirementId, type WindowRequirement,
} from './provider.ts';

/**
 * The adjusted source, end to end on the map it exists for.
 *
 * `public/maps/forest-sample.json` is Mapper's own forest sample: 538 features, 32 of them
 * point features, so a three-hundred-metre window of it is thin ground for a drill that
 * wants kinds. What is tested here is not that enrichment works — `terrain/enrich.test.ts`
 * has the properties — but that a **round** made on an adjusted window is a round: well
 * formed at every level, for every terrain drill, over enough seeds to mean it.
 */
const bundleJson = JSON.parse(
  readFileSync(new URL('../../../public/maps/forest-sample.json', import.meta.url), 'utf8'),
) as MapBundle;
const forest = loadBundle(bundleJson);
const library = new LibraryProvider([forest]);

const SEEDS = 24;
const LEVELS = [1, 5, 10];

describe('AdjustedProvider', () => {
  const adjusted = new AdjustedProvider(library, 1);

  it('names the maps it holds and how hard it adjusts them', () => {
    // A round is a function of `(seed, level, provider.id)`, so the id has to say
    // everything that changes a round — and the intensity changes every one of them.
    expect(adjusted.id).toBe(`adjusted:1:library:${forest.id}`);
    expect(new AdjustedProvider([forest], 0.5).id).toBe(`adjusted:0.5:library:${forest.id}`);
    expect(new AdjustedProvider([forest], 0).id).toBe(`adjusted:0:library:${forest.id}`);
    // Clamped, and the same mix of maps in either order is one library, as ever.
    expect(new AdjustedProvider([forest], 9).id).toBe(adjusted.id);
  });

  it('is pure: the same rng state gives the same map and window', () => {
    const requirement = pexesoRequirement(7);
    for (let seed = 0; seed < 12; seed++) {
      expect(hashJson(adjusted.pick(seeded(seed), requirement)))
        .toBe(hashJson(adjusted.pick(seeded(seed), requirement)));
    }
  });

  it('hands back a map whose id names the edits that made it', () => {
    const picked = adjusted.pick(seeded(3), pexesoRequirement(10))!;
    expect(picked.map.id).toMatch(new RegExp(`^adjusted:${forest.id}:[0-9a-f]{8}$`));
    expect(picked.map.adjusted).toBe(true);
    // Provenance is unchanged: adjusting a map does not change where it came from.
    expect(picked.map.meta).toEqual(forest.meta);
    // Two windows of one bundle, adjusted differently, are two maps and say so.
    const other = adjusted.pick(seeded(4), pexesoRequirement(10))!;
    expect(other.map.id).not.toBe(picked.map.id);
  });

  it('has more on it than the window it came from', () => {
    let richer = 0;
    for (let seed = 0; seed < SEEDS; seed++) {
      const plain = library.pick(seeded(seed), pexesoRequirement(10))!;
      const busy = adjusted.pick(seeded(seed), pexesoRequirement(10))!;
      if (pointsOf(busy.map).length > pointsOf(plain.map).length) richer++;
      // The same window: enrichment chooses nothing about where the card is.
      expect(busy.crop).toEqual(plain.crop);
    }
    expect(richer).toBe(SEEDS);
  });

  it('declines exactly when the library does, so the generator still catches it', () => {
    const impossible: WindowRequirement = { size: 5000, needsRelief: true };
    expect(adjusted.pick(seeded(1), impossible)).toBeNull();
    expect(new AdjustedProvider([], 1).pick(seeded(1), libraryRequirements()[0]!)).toBeNull();
  });

  it('at intensity 0 is the library, draw for draw', () => {
    // The same rule `MixedProvider` keeps at 100% one source: a knob turned all the way
    // down must not still consume a number, or every round after it is a different round.
    const quiet = new AdjustedProvider(library, 0);
    const requirement = pexesoRequirement(10);
    for (let seed = 0; seed < 12; seed++) {
      const a = seeded(seed);
      const b = seeded(seed);
      const one = quiet.pick(a, requirement)!;
      const two = library.pick(b, requirement)!;
      expect(hashJson(one)).toBe(hashJson(two));
      expect(one.map.adjusted).toBeUndefined();
      expect(a.next()).toBe(b.next());
    }
  });

  it('reads the level off the requirement, and has an answer when there is none', () => {
    const count = (level: number | undefined) => {
      const requirement = { ...pexesoRequirement(5), ...(level === undefined ? {} : { level }) };
      if (level === undefined) delete (requirement as { level?: number }).level;
      let added = 0;
      for (let seed = 0; seed < SEEDS; seed++) {
        const plain = library.pick(seeded(seed), requirement)!;
        const busy = adjusted.pick(seeded(seed), requirement)!;
        added += pointsOf(busy.map).length - pointsOf(plain.map).length;
      }
      return added / SEEDS;
    };
    const low = count(1);
    const high = count(10);
    expect(high).toBeGreaterThan(low);
    // A requirement that names no level is adjusted at the middle of the ladder rather
    // than not at all — `mapDohledavka` states none yet, and it still gets a busier card.
    const unstated = count(undefined);
    expect(unstated).toBeGreaterThan(low);
    expect(unstated).toBeLessThan(high);
  });
});

describe('every terrain drill, on an adjusted map', () => {
  const ctx = { maps: new AdjustedProvider(library, 1) };

  it('pexeso builds a board out of it', () => {
    for (const level of LEVELS) {
      for (let seed = 0; seed < SEEDS; seed++) {
        const round = pexeso.generate(seeded(seed), level, ctx);
        expect(pexeso.wellFormed(round), `level ${level} seed ${seed}`).toEqual([]);
      }
    }
  });

  it('map memory builds a round out of it', () => {
    for (const level of LEVELS) {
      for (let seed = 0; seed < SEEDS; seed++) {
        const round = mapMemory.generate(seeded(seed), level, ctx);
        expect(mapMemory.wellFormed(round), `level ${level} seed ${seed}`).toEqual([]);
      }
    }
  });

  it('the contours drill builds a round out of it', () => {
    // The drill with the most to go wrong: it needs relief, it warps ground that was
    // reconstructed rather than surveyed, and enrichment has just put symbols on it.
    for (const level of LEVELS) {
      for (let seed = 0; seed < SEEDS; seed++) {
        const round = contoursDrill.generate(seeded(seed), level, ctx);
        expect(contoursDrill.wellFormed(round), `level ${level} seed ${seed}`).toEqual([]);
      }
    }
  });

  it('mapova dohledavka deals its cards out of it', () => {
    // It asks the provider for two windows a round and states no level, so it is the
    // drill that exercises the unstated-level answer.
    for (const level of LEVELS) {
      for (let seed = 0; seed < SEEDS; seed++) {
        const round = mapDohledavka.generate(seeded(seed), level, ctx);
        expect(mapDohledavka.wellFormed(round), `level ${level} seed ${seed}`).toEqual([]);
      }
    }
  });

  it('is deterministic, so a round is a function of seed, level and provider', () => {
    expect(mapMemory.generate(seeded(9), 5, ctx)).toEqual(mapMemory.generate(seeded(9), 5, ctx));
  });
});

/**
 * A picture, adjusted.
 *
 * The raster tier has no features at all, so the question is whether an `add` can mean
 * anything on one. It can and it does: the symbol is **drawn over the image**, exactly as
 * a moved blob's symbol is, and it is data on the map rather than pixels — the picture is
 * untouched, `features` gains one entry, and the renderer draws it. Plausibility comes
 * from the colour mask, which is the backend a map with no height field offers, and the
 * spacing rule reads `analysis.moveable`, since a boulder the picture already draws still
 * takes up room.
 */
describe('a map made of pixels, adjusted', () => {
  const picture = loadBundle(JSON.parse(JSON.stringify(importImage({
    name: 'synthetic',
    requirements: libraryRequirements(),
    raster: {
      image: syntheticMap(),
      georeference: { metresPerPixel: FIXTURE_METRES_PER_PIXEL, originX: 0, originY: 0 },
      reference: 'synthetic.png',
      keepEdges: true,
    },
  }).bundle)) as MapBundle);
  const adjusted = new AdjustedProvider([picture], 1);

  it('draws the added symbol over the image rather than skipping it', () => {
    const requirement = pexesoRequirement(10);
    let seen = 0;
    for (let seed = 0; seed < 12; seed++) {
      const picked = adjusted.pick(seeded(seed), requirement);
      if (!picked) continue;
      seen++;
      expect(picked.map.features.length).toBeGreaterThan(0);
      const svg = renderToStaticMarkup(
        createElement(MapView, { map: picked.map, crop: picked.crop }),
      );
      // The picture is still under it, and the symbol is on top of it.
      expect(svg).toContain('<image');
      expect(svg.split('<circle').length - 1 + svg.split('<path').length - 1).toBeGreaterThan(0);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('leaves the picture alone: an add is a symbol, not a repaint', () => {
    // A *move* on a picture is a cut and paste and does leave a patch — that is what
    // `moveBlob` is for. An add leaves none: the ink under it is the forest it stands in.
    const crop = picture.windows![requirementId(pexesoRequirement(10))]![0]!;
    const edits = proposeEnrichment(picture, crop, seeded(2), { adds: 6, removes: 0, swaps: 0, moves: 0 });
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.every((e) => e.op === 'add')).toBe(true);
    const after = applyEdits(picture, edits);
    expect(after.raster!.patches ?? []).toEqual(picture.raster!.patches ?? []);
    expect(after.raster!.warps ?? []).toEqual(picture.raster!.warps ?? []);
    // The image itself is never rewritten, by any provider, ever.
    expect(adjusted.pick(seeded(2), pexesoRequirement(10))!.map.raster!.image)
      .toBe(picture.raster!.image);
  });

  it('pexeso and map memory still build rounds on it', () => {
    const ctx = { maps: adjusted };
    for (const level of LEVELS) {
      for (let seed = 0; seed < 8; seed++) {
        expect(pexeso.wellFormed(pexeso.generate(seeded(seed), level, ctx)), `pexeso ${level}`).toEqual([]);
        expect(mapMemory.wellFormed(mapMemory.generate(seeded(seed), level, ctx)), `memory ${level}`).toEqual([]);
      }
    }
  });
});

/** The numbers the design note quotes, re-measured rather than restated. */
describe('what an adjusted window is worth', () => {
  it('reports the symbols added per level on the forest sample', () => {
    const adjusted = new AdjustedProvider(library, 1);
    const lines: string[] = [];
    // Counted **inside the window the provider handed back**, which is the ground a card
    // is cut from — the sheet is 554 m and a pexeso window is 300 m of it.
    const inWindow = (picked: { map: OMap; crop: Crop }) =>
      pointsOf(picked.map).filter((f) => insideCrop(positionOf(f), picked.crop));

    for (const level of LEVELS) {
      const requirement = pexesoRequirement(level);
      let plainPoints = 0;
      let busyPoints = 0;
      let plainKinds = 0;
      let busyKinds = 0;
      for (let seed = 0; seed < SEEDS; seed++) {
        const plain = inWindow(library.pick(seeded(seed), requirement)!);
        const busy = inWindow(adjusted.pick(seeded(seed), requirement)!);
        plainPoints += plain.length;
        busyPoints += busy.length;
        plainKinds += new Set(plain.map((f) => f.code)).size;
        busyKinds += new Set(busy.map((f) => f.code)).size;
      }
      const mean = (n: number) => (n / SEEDS).toFixed(2);
      lines.push(
        `level ${level}: point features per 300 m window ${mean(plainPoints)}`
        + ` → ${mean(busyPoints)}, distinct point codes ${mean(plainKinds)}`
        + ` → ${mean(busyKinds)}`,
      );
      expect(busyPoints).toBeGreaterThan(plainPoints);
      expect(busyKinds).toBeGreaterThan(plainKinds);
    }
    console.log(lines.join('\n'));
  });
});

/** `OMap.adjusted` is the only thing that says so, and it survives the round trip. */
describe('an adjusted map, as a map', () => {
  it('keeps everything else the bundle had', () => {
    const picked = new AdjustedProvider(library, 1).pick(seeded(6), pexesoRequirement(10))!;
    const map: OMap = picked.map;
    expect(map.width).toBe(forest.width);
    expect(map.scale).toBe(forest.scale);
    expect(map.relief).toBe(forest.relief);
    expect(map.windows).toBe(forest.windows);
    expect(map.analysis).toBe(forest.analysis);
  });
});
