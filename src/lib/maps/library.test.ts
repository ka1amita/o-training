import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  GeneratedProvider, LibraryProvider, requirementId, type WindowRequirement,
} from './provider.ts';
import { libraryRequirements, loadLibrary } from './library.ts';
import { loadBundle, type MapBundle } from './bundle.ts';
import { memoryStore } from '@/lib/store.ts';
import { seeded } from '@/lib/rng.ts';
import MapView from '@/lib/terrain/MapView.tsx';
import { contours as contoursDrill } from '@/drills/contours/drill.ts';
import { mapMemory } from '@/drills/mapMemory/drill.ts';
import { pexeso } from '@/drills/pexeso/drill.ts';

/**
 * The first real map, end to end.
 *
 * `public/maps/forest-sample.json` is Mapper's own `examples/src/forest sample.xmap`
 * through `scripts/import-map.mjs`. It is a **dev fixture**: GPL, and committed as the
 * derived bundle rather than as the drawing, at 378 kB. Regenerate it with
 *
 *     node scripts/import-map.mjs 'forest sample.xmap' --name forest-sample \
 *       --licence GPL-3.0-or-later --attribution 'OpenOrienteering Mapper'
 *
 * The tests here are the ones a contact sheet cannot make: that the three drills each get
 * a round out of it, and that what draws is a plausible number of elements rather than a
 * blank square.
 */
const bundleJson = JSON.parse(
  readFileSync(new URL('../../../public/maps/forest-sample.json', import.meta.url), 'utf8'),
) as MapBundle;

const forest = loadBundle(bundleJson);
const library = new LibraryProvider([forest]);

describe('the forest sample bundle', () => {
  it('is a map with ground, features and an analysis', () => {
    expect(forest.meta?.name).toBe('forest-sample');
    expect(forest.meta?.licence).toBe('GPL-3.0-or-later');
    expect(forest.scale).toBe(10000);
    expect(forest.features.length).toBeGreaterThan(400);
    expect(forest.relief.kind).toBe('contours');
    expect(forest.analysis!.landforms.length).toBeGreaterThan(10);
  });

  it('draws its own contour lines rather than retracing them', () => {
    // The point of `ContourRelief`: real contours are cartography — smoothed, cut at a
    // knoll, thickened every fifth line — and a map that retraced them from a height field
    // reconstructed out of those same lines would look generated.
    const lines = forest.relief.contours(5);
    expect(lines.length).toBeGreaterThan(20);
    expect(lines.some((c) => c.index)).toBe(true);
    expect(forest.relief.contours(2.5)).toBe(lines);
  });

  it('carries a window list for every requirement any drill can state', () => {
    for (const requirement of libraryRequirements()) {
      const list = forest.windows?.[requirementId(requirement)];
      expect(list, requirementId(requirement)).toBeDefined();
      expect(list!.length, requirementId(requirement)).toBeGreaterThan(0);
    }
  });

  it('keeps every window on the map', () => {
    for (const list of Object.values(forest.windows ?? {})) {
      for (const crop of list) {
        expect(crop.x).toBeGreaterThanOrEqual(0);
        expect(crop.y).toBeGreaterThanOrEqual(0);
        expect(crop.x + crop.size).toBeLessThanOrEqual(forest.width + 1e-6);
        expect(crop.y + crop.size).toBeLessThanOrEqual(forest.height + 1e-6);
      }
    }
  });
});

describe('bundles stay out of the precache', () => {
  it('the service worker glob does not list json', () => {
    // A cold offline launch has to fetch the whole precache before it can show anything,
    // and one map with a height field is bigger than the entire app. Bundles are fetched
    // on demand and kept in IndexedDB instead. Asserted here rather than trusted, because
    // adding `json` to that list is a one-word change with a several-hundred-kilobyte
    // consequence that nothing else would notice.
    const config = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8');
    const glob = /globPatterns:\s*\[([^\]]*)\]/.exec(config);
    expect(glob).not.toBeNull();
    expect(glob![1]).not.toMatch(/json/);
  });
});

describe('LibraryProvider', () => {
  it('is pure: the same rng state gives the same map and window', () => {
    const requirement = libraryRequirements()[0]!;
    expect(library.pick(seeded(7), requirement)).toEqual(library.pick(seeded(7), requirement));
  });

  it('names itself by the bundles it holds, not by the order they came in', () => {
    expect(library.id).toBe(`library:${forest.id}`);
    expect(new LibraryProvider([]).id).toBe('library:');
  });

  it('declines rather than offering the wrong ground', () => {
    // The whole difference from the generator, which never declines: a real map is
    // selected from, and a provider that always says yes hands the contours drill a flat
    // map and calls it a hard round.
    const impossible: WindowRequirement = { size: 5000, needsRelief: true };
    expect(library.pick(seeded(1), impossible)).toBeNull();
    expect(new LibraryProvider([]).pick(seeded(1), libraryRequirements()[0]!)).toBeNull();
  });

  it('declines a map with no relief when relief is what was asked for', () => {
    const flat = loadBundle({
      ...bundleJson,
      relief: { kind: 'none' },
      windows: { ...bundleJson.windows },
    });
    const only = new LibraryProvider([flat]);
    const relief = libraryRequirements().find((r) => r.needsRelief)!;
    expect(only.pick(seeded(3), relief)).toBeNull();
  });

  it('draws the sub-window a drill asked for inside the window it was given', () => {
    const memory = libraryRequirements().find((r) => r.crop !== undefined)!;
    for (let seed = 0; seed < 40; seed++) {
      const picked = library.pick(seeded(seed), memory)!;
      expect(picked).not.toBeNull();
      expect(picked.crop.size).toBe(memory.crop);
      expect(picked.crop.x).toBeGreaterThanOrEqual(0);
      expect(picked.crop.x + picked.crop.size).toBeLessThanOrEqual(forest.width + 1e-6);
    }
  });
});

describe('the drills, on a real map', () => {
  const ctx = { maps: library };

  it('pexeso builds a board out of it', () => {
    for (const level of [1, 5, 10]) {
      const round = pexeso.generate(seeded(level), level, ctx);
      expect(pexeso.wellFormed(round), `level ${level}`).toEqual([]);
    }
  });

  it('map memory builds a round out of it', () => {
    for (const level of [1, 5, 10]) {
      const round = mapMemory.generate(seeded(level), level, ctx);
      expect(mapMemory.wellFormed(round), `level ${level}`).toEqual([]);
    }
  });

  it('the contours drill builds a round out of it', () => {
    // The drill with the most to go wrong on an imported map: it needs relief, it needs
    // ground it can warp, and its distractors have to differ by a metre and a half of
    // height that was reconstructed rather than surveyed.
    for (const level of [1, 5, 10]) {
      const round = contoursDrill.generate(seeded(level), level, ctx);
      expect(contoursDrill.wellFormed(round), `level ${level}`).toEqual([]);
    }
  });

  it('is deterministic, so a round is a function of seed, level and provider', () => {
    expect(mapMemory.generate(seeded(9), 5, ctx)).toEqual(mapMemory.generate(seeded(9), 5, ctx));
  });

  it('and the generator still answers everything, which is why it is the fallback', () => {
    const generated = { maps: new GeneratedProvider() };
    expect(contoursDrill.wellFormed(contoursDrill.generate(seeded(2), 5, generated))).toEqual([]);
  });
});

describe('the forest sample, drawn', () => {
  /**
   * Rendering is checked by eye — `AGENTS.md` — and this is not a substitute for that.
   * It is the one thing eyes on a contact sheet cannot do reliably: notice that a whole
   * class of symbol silently drew nothing. A real map arrives with codes the style table
   * does not know, and the fallback that draws them plainly is invisible when it fails.
   */
  const render = (props: Parameters<typeof MapView>[0]) =>
    renderToStaticMarkup(createElement(MapView, props));

  it('draws areas, lines, points and contours from one real map', () => {
    const svg = render({ map: forest });
    const count = (tag: string) => svg.split(`<${tag}`).length - 1;
    // Areas and contours are paths; a boulder is a circle; a fence tick is a line.
    expect(count('path')).toBeGreaterThan(200);
    expect(count('circle')).toBeGreaterThan(0);
    expect(svg).toContain('viewBox="0 0');
    // Every colour class the map uses should reach the page.
    for (const colour of ['#00a03c', '#d15c00', '#000000']) expect(svg).toContain(colour);
  });

  it('culls to the window, so a small crop is a small document', () => {
    const whole = render({ map: forest }).length;
    const crop = forest.windows!['s300.c150']![0]!;
    const small = render({ map: forest, crop }).length;
    expect(small).toBeLessThan(whole / 2);
    expect(small).toBeGreaterThan(500);
  });

  it('draws the contour card as contours and nothing else', () => {
    const svg = render({ map: forest, contoursOnly: true });
    expect(svg).toContain('#d15c00');
    expect(svg).not.toContain('#00a03c');
  });
});

describe('loadLibrary', () => {
  const url = 'https://example.test/maps/forest.json';
  const fetcher = (async (input: RequestInfo | URL) => {
    if (String(input) !== url) return new Response('no', { status: 404 });
    return new Response(JSON.stringify(bundleJson), { status: 200 });
  }) as typeof fetch;

  it('fetches, decodes and caches under its own prefix', async () => {
    const kv = memoryStore({ 'drill:pexeso': { level: 3, sessions: [] } });
    const maps = await loadLibrary([url], fetcher, kv);
    expect(maps).toHaveLength(1);
    expect(maps[0]!.id).toBe(forest.id);
    // `map:`, beside `drill:` and never instead of it: clearing progress must not throw
    // away a map the player would have to download again in a forest.
    expect(await kv.keys()).toEqual(['drill:pexeso', `map:${url}`]);
  });

  it('reads the cache the second time', async () => {
    let calls = 0;
    const counting = (async (input: RequestInfo | URL) => {
      calls++;
      return fetcher(input);
    }) as typeof fetch;
    const kv = memoryStore();
    await loadLibrary([url], counting, kv);
    await loadLibrary([url], counting, kv);
    expect(calls).toBe(1);
  });

  it('skips a bundle it cannot get rather than failing the session', async () => {
    const maps = await loadLibrary(['https://example.test/gone.json', url], fetcher);
    expect(maps).toHaveLength(1);
  });

  it('never caches a bundle it could not decode', async () => {
    const broken = (async () => new Response('{"format":99}', { status: 200 })) as typeof fetch;
    const kv = memoryStore();
    expect(await loadLibrary([url], broken, kv)).toEqual([]);
    expect(await kv.keys()).toEqual([]);
  });
});
