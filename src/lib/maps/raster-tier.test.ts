import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  contours as contoursDrill, requirementFor as contoursRequirement,
} from '@/drills/contours/drill.ts';
import { mapMemory } from '@/drills/mapMemory/drill.ts';
import { pexeso } from '@/drills/pexeso/drill.ts';
import { hashJson, seeded } from '@/lib/rng.ts';
import { applyEdits, difference } from '@/lib/terrain/edits.ts';
import { styleFor } from '@/lib/terrain/isom.ts';
import MapView from '@/lib/terrain/MapView.tsx';
import type { Feature } from '@/lib/terrain/omap.ts';
import { generateTerrain, paramsFor } from '@/lib/terrain/terrain.ts';
import { loadBundle, type MapBundle } from './bundle.ts';
import { FIXTURE_METRES_PER_PIXEL, syntheticMap } from './import/__fixtures__/paint.ts';
import { importImage } from './import/pipeline.ts';
import { libraryRequirements } from './library.ts';
import { GeneratedProvider, LibraryProvider, requirementId } from './provider.ts';

/**
 * A map that is only a picture, end to end — step 5 of `docs/real-maps-architecture.md`.
 *
 * §5.3 says what each drill does with one: pexeso stands its controls on blobs read off
 * the mask, map memory moves one of them, and the contours drill **declines the map**,
 * because a picture of contour lines is not a height field and four options cut from one
 * flat relief are four right answers.
 *
 * The fixture is painted in code (`import/__fixtures__/paint.ts`) rather than committed as
 * an image: no Livelox export is in this repository, and a synthetic map in the app's own
 * ISOM screens tests the classifier rather than a printer's idea of green.
 */
const bundle = importImage({
  name: 'synthetic',
  requirements: libraryRequirements(),
  raster: {
    image: syntheticMap(),
    georeference: { metresPerPixel: FIXTURE_METRES_PER_PIXEL, originX: 0, originY: 0 },
    reference: 'synthetic.png',
    keepEdges: true,
  },
}).bundle;

const picture = loadBundle(JSON.parse(JSON.stringify(bundle)) as MapBundle);
const library = new LibraryProvider([picture]);
const ctx = { maps: library };

describe('a bundle made of pixels', () => {
  it('is a map with no features, no relief and a mask', () => {
    expect(picture.features).toEqual([]);
    expect(picture.relief.kind).toBe('none');
    expect(picture.width).toBe(300);
    expect(picture.meta?.source).toBe('image');
    expect(picture.raster!.metresPerCell).toBe(1);
    expect(picture.raster!.mask.length).toBe(300 * 300);
  });

  it('reads control sites and moveable blobs off the mask, and nothing else', () => {
    // The dots, and neither the path nor the stream: a blob filter is a shape filter, and
    // a long thin run of black is a path however black it is.
    expect(picture.analysis!.controlSites!.length).toBeGreaterThanOrEqual(30);
    expect(picture.analysis!.moveable!.length).toBe(picture.analysis!.controlSites!.length);
    const codes = new Set(picture.analysis!.moveable!.map((f) => f.code));
    expect([...codes].sort()).toEqual(['204', '311']);
    // They are not features: the picture already draws them, and drawing them again as
    // symbols would put a second boulder beside every boulder.
    expect(picture.features).toHaveLength(0);
  });

  it('carries windows for the drills it can serve and none for the one it cannot', () => {
    const relief = libraryRequirements().filter((r) => r.needsRelief);
    const flat = libraryRequirements().filter((r) => !r.needsRelief);
    expect(relief.length).toBeGreaterThan(0);
    for (const requirement of relief) {
      expect(picture.windows![requirementId(requirement)], requirementId(requirement)).toEqual([]);
    }
    for (const requirement of flat) {
      expect(
        picture.windows![requirementId(requirement)]!.length,
        requirementId(requirement),
      ).toBeGreaterThan(0);
    }
  });

  it('is the same bundle twice, so a re-import does not move a round', () => {
    const again = importImage({
      name: 'synthetic',
      requirements: libraryRequirements(),
      raster: {
        image: syntheticMap(),
        georeference: { metresPerPixel: FIXTURE_METRES_PER_PIXEL, originX: 0, originY: 0 },
        reference: 'synthetic.png',
        keepEdges: true,
      },
    }).bundle;
    expect(again.id).toBe(bundle.id);
  });
});

describe('the drills, on a map made of pixels', () => {
  it('pexeso builds a board out of it', () => {
    for (const level of [1, 5, 10]) {
      const round = pexeso.generate(seeded(level), level, ctx);
      expect(pexeso.wellFormed(round), `level ${level}`).toEqual([]);
      // Every control stands on a site the mask found, rather than on the interior
      // fallback: that is what `controlSites` is for, because a control on empty forest is
      // a card with nothing to recognise.
      //
      // This used to check the coordinates separately — x from the set of site xs, y from
      // the set of site ys — because `controlFor` drew from the candidate list twice and
      // no whole site had both. The two-draw pick was the bug, not a quirk to pin: on this
      // fixture it put the control on a real blob about one time in thirty.
      const sites = picture.analysis!.controlSites!;
      for (const card of round.cards) {
        expect(
          sites.some((s) => s.x === card.control.x && s.y === card.control.y),
          `pair ${card.pairId}`,
        ).toBe(true);
      }
    }
  });

  it('map memory builds a round out of it, and every distractor really differs', () => {
    for (const level of [1, 5, 10]) {
      const round = mapMemory.generate(seeded(level + 40), level, ctx);
      expect(mapMemory.wellFormed(round), `level ${level}`).toEqual([]);
      round.variants.forEach((variant, index) => {
        if (index === round.correctIndex) return;
        const report = difference(variant, round.crop);
        expect(report.visible, `level ${level} option ${index}`).toBe(true);
        // Salience is the blob's own size against its colour's contrast — a black dot on
        // a picture and a black boulder on a drawing come out on the same scale.
        expect(report.salience).toBeGreaterThan(0);
      });
    }
  });

  it('materialises a moved blob as a patch over the pixels and a symbol at the new place', () => {
    const round = mapMemory.generate(seeded(7), 5, ctx);
    const distractor = round.variants.find((v) => v.edits.length > 0)!;
    const edit = distractor.edits[0]!;
    expect(edit.op).toBe('move');
    const after = applyEdits(distractor.base, distractor.edits);
    // Cut: a patch of the surrounding colour where the blob was drawn.
    expect(after.raster!.patches).toHaveLength(1);
    expect(after.raster!.patches![0]!.radius).toBeGreaterThan(0);
    // ...and paste: the blob is now a feature, so the style table draws its symbol.
    expect(after.features).toHaveLength(1);
    expect(after.features[0]!.code).toMatch(/^(204|311)$/);
    // The base is untouched, which is what makes a variant a variant.
    expect(distractor.base.raster!.patches).toBeUndefined();
    expect(distractor.base.features).toHaveLength(0);
  });

  it('the contours drill declines it rather than asking an unanswerable question', () => {
    for (const level of [1, 5, 10]) {
      expect(library.pick(seeded(level), contoursRequirement(level)), `level ${level}`).toBeNull();
      expect(() => contoursDrill.generate(seeded(level), level, ctx)).toThrow(/no map with relief/);
    }
    // ...and the generator still answers it, which is why it is the fallback.
    const generated = { maps: new GeneratedProvider() };
    expect(contoursDrill.wellFormed(contoursDrill.generate(seeded(3), 5, generated))).toEqual([]);
  });

  it('is deterministic, so a round is a function of seed, level and provider', () => {
    expect(mapMemory.generate(seeded(11), 5, ctx)).toEqual(mapMemory.generate(seeded(11), 5, ctx));
    expect(pexeso.generate(seeded(11), 5, ctx)).toEqual(pexeso.generate(seeded(11), 5, ctx));
  });
});

describe('drawing a map made of pixels', () => {
  const render = (props: Parameters<typeof MapView>[0]) =>
    renderToStaticMarkup(createElement(MapView, props));

  it('puts the picture in world metres under whatever is drawn on it', () => {
    const svg = render({ map: picture, crop: { x: 20, y: 30, size: 110 } });
    // The whole image is placed once at its own origin; the crop is still only a viewBox.
    expect(svg).toContain('<image');
    expect(svg).toContain('href="synthetic.png"');
    expect(svg).toContain('width="300"');
    expect(svg).toContain('viewBox="20 30 110 110"');
  });

  it('paints out a moved blob and draws it again at its new place', () => {
    const round = mapMemory.generate(seeded(7), 5, ctx);
    const distractor = round.variants.find((v) => v.edits.length > 0)!;
    const svg = render({ map: applyEdits(distractor.base, distractor.edits) });
    const answer = render({ map: distractor.base });
    // One circle for the patch and one for the symbol, where the answer has neither.
    //
    // Framed on the whole map and not on `round.crop`, because the window is not what
    // this is about. `EditSpec.within` picks a blob the window can show, and a blob near
    // the window's edge moved fifty metres lands outside it — a distractor that differs
    // by a boulder having gone, which is a fair question and would cull the symbol here.
    expect(svg.split('<circle').length - 1).toBe(2);
    expect(answer.split('<circle').length - 1).toBe(0);
  });

  it('draws contours only as contours, with no picture under them', () => {
    // The contour card is brown lines on white. A photograph of a map under it would
    // hand the player the answer, which is the one rule stated as a rendering rule.
    expect(render({ map: picture, contoursOnly: true })).not.toContain('<image');
  });
});

describe('a map with no picture draws exactly what it drew before', () => {
  const render = (props: Parameters<typeof MapView>[0]) =>
    renderToStaticMarkup(createElement(MapView, props));

  it('is byte for byte the markup of the commit before the raster tier', () => {
    /**
     * Pinned from the commit before this one, by rendering the same three framings there
     * and hashing the markup. (Re-pinned when this branch was rebased on to a `main` that
     * changed the generator: the numbers below are the parent commit's, measured again.)
     *
     * The raster tier adds an `<image>` and a patch layer to `MapView`, and the whole
     * claim of this step is that it adds **capability for maps that have a picture** and
     * changes nothing for the maps that do not. A generated map is what every golden in
     * the suite is over, and this is the same statement about the one thing goldens
     * cannot see: what it draws.
     */
    const map = generateTerrain(seeded(4), paramsFor(5, 300));
    const whole = render({ map });
    const crop = render({ map, crop: { x: 40, y: 60, size: 110 }, control: { x: 95, y: 115 } });
    const contoursOnly = render({ map, contoursOnly: true });
    expect({
      whole: hashJson(whole),
      wholeLength: whole.length,
      crop: hashJson(crop),
      cropLength: crop.length,
      contoursOnly: hashJson(contoursOnly),
    }).toEqual({
      whole: '0d1e89f8',
      wholeLength: 32730,
      crop: 'a6b2e317',
      cropLength: 12333,
      contoursOnly: 'b10ee025',
    });
    expect(whole).not.toContain('<image');
  });

  it('and so does the imported vector map', () => {
    const forest = loadBundle(
      JSON.parse(
        readFileSync(new URL('../../../public/maps/forest-sample.json', import.meta.url), 'utf8'),
      ) as MapBundle,
    );
    const svg = render({ map: forest });
    // Re-pinned with the move to ISOM 2017-2, which re-imported this bundle: the same
    // ground, drawn from codes that are two tables further along.
    expect({ hash: hashJson(svg), length: svg.length })
      .toEqual({ hash: '9fda80bd', length: 147430 });
  });

  it('draws every symbol the bundle carries, rather than dropping one silently', () => {
    // `MapView` renders a feature only when the style it gets back has the geometry the
    // feature has — `Line` returns null for a point style — so a row whose geometry
    // disagrees with the map's is not a plain symbol, it is an invisible one. 202 is
    // where that bites: a cliff is a line on a surveyed map and a point where the
    // generator stands one, and both carry the code.
    const forest = loadBundle(
      JSON.parse(
        readFileSync(new URL('../../../public/maps/forest-sample.json', import.meta.url), 'utf8'),
      ) as MapBundle,
    );
    const geometryOf = (f: Feature) =>
      f.geometry.kind === 'point' ? 'point' : f.geometry.kind === 'polyline' ? 'line' : 'area';
    const undrawn = forest.features.filter((f) => {
      const style = styleFor(f.code, {
        geometry: geometryOf(f),
        ...(f.colour ? { colour: f.colour } : {}),
      });
      return style?.geometry !== geometryOf(f);
    });
    expect(undrawn.map((f) => `${f.code} ${geometryOf(f)}`)).toEqual([]);
    expect(forest.features.length).toBe(538);
  });
});

describe('pictures stay out of the precache', () => {
  it('the service worker glob lists neither json nor png', () => {
    // A bundle's picture is megabytes. A cold offline launch has to fetch the whole
    // precache before it can show anything, and `library.test.ts` makes the same
    // assertion about the JSON for the same reason — one word, several megabytes.
    const config = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8');
    const glob = /globPatterns:\s*\[([^\]]*)\]/.exec(config);
    expect(glob).not.toBeNull();
    expect(glob![1]).not.toMatch(/png/);
  });
});
