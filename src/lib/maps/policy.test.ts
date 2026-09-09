import { describe, it, expect } from 'vitest';
import { memoryStore, clearAll, POLICY_KEY } from '@/lib/store.ts';
import { seeded, hashJson } from '@/lib/rng.ts';
import { NoRelief } from '@/lib/terrain/relief.ts';
import type { OMap } from '@/lib/terrain/omap.ts';
import {
  bundlesFor, DEFAULT_POLICY, loadPolicy, parsePolicy, providerFor, savePolicy, sourceBadge,
  sourceOf, type MapPolicy,
} from './policy.ts';
import { GeneratedProvider, type WindowRequirement } from './provider.ts';
import { mapsOfRound } from '@/drills/types.ts';
import { contours } from '@/drills/contours/drill.ts';
import { mapMemory } from '@/drills/mapMemory/drill.ts';
import { pexeso } from '@/drills/pexeso/drill.ts';
import { dohledavka } from '@/drills/dohledavka/drill.ts';

const requirement: WindowRequirement = { size: 300, needsRelief: false };

/** A bundle, as far as a policy is concerned: something with a `meta` and an id. */
const imported: OMap = {
  id: 'abc123',
  width: 600,
  height: 600,
  scale: 10000,
  relief: new NoRelief(600),
  features: [],
  meta: { name: 'forest-sample', scale: 10000, source: 'xmap' },
  windows: { 's300': [{ x: 0, y: 0, size: 300 }] },
};

describe('MapPolicy', () => {
  it('defaults to generated, which is what makes this step a switch and not a change', () => {
    expect(DEFAULT_POLICY.source).toBe('generated');
    expect(providerFor(DEFAULT_POLICY, [imported]).id).toBe('generated');
  });

  it('asks the network for nothing while the source is generated', () => {
    expect(bundlesFor(DEFAULT_POLICY)).toEqual([]);
    expect(bundlesFor({ source: 'real', library: ['a.json'] })).toEqual(['a.json']);
  });

  it('reads a malformed record as no policy rather than a half-applied one', async () => {
    // The same rule as `loadProgress`: storage gets cleared and written by older builds,
    // and a policy half-read is a provider whose id lies about the rounds it makes.
    const junk = [
      null, 42, 'nonsense', {}, { source: 'imaginary', library: [] },
      { source: 'real' }, { source: 'real', library: 'a.json' },
      { source: 'mixed', library: [], realShare: 4 },
      { source: 'mixed', library: [], realShare: 'half' },
      { source: 'real', library: [1, 2] },
    ];
    for (const stored of junk) {
      expect(parsePolicy(stored), JSON.stringify(stored)).toEqual(DEFAULT_POLICY);
      expect(await loadPolicy(memoryStore({ [POLICY_KEY]: stored }))).toEqual(DEFAULT_POLICY);
    }
  });

  it('round-trips a policy', async () => {
    const kv = memoryStore();
    const policy: MapPolicy = { source: 'mixed', realShare: 0.4, library: ['forest.json'] };
    await savePolicy(kv, policy);
    expect(await loadPolicy(kv)).toEqual(policy);
  });

  it('is erased along with progress', async () => {
    // "Erase all progress" should not quietly keep a choice this device made. The cached
    // bundles stay: they are a download, not a record.
    const kv = memoryStore({ 'map:forest.json': { format: 1 } });
    await savePolicy(kv, { source: 'real', library: ['forest.json'] });
    await clearAll(kv);
    expect(await loadPolicy(kv)).toEqual(DEFAULT_POLICY);
    expect(await kv.keys()).toEqual(['map:forest.json']);
  });
});

describe('providerFor', () => {
  it('a mix names both sources and their shares', () => {
    const mixed = providerFor({ source: 'mixed', realShare: 0.3, library: [] }, [imported]);
    expect(mixed.id).toBe('mixed:0.7*generated+0.3*library:abc123');
  });

  it('real maps still keep the generator behind them', () => {
    // A library that cannot answer the contours drill must not become an error screen, so
    // the generator is in the fall-through order at weight zero — never drawn, always there.
    const real = providerFor({ source: 'real', library: [] }, [imported]);
    expect(real.id).toBe('mixed:1*library:abc123+0*generated');
    // Nothing in this library has a window for a relief round, so the generator serves it.
    const picked = real.pick(seeded(4), { size: 380, needsRelief: true });
    expect(picked!.map.id).toBe('generated');
  });

  it('with nothing loaded, says so rather than claiming a library', () => {
    // Two peers comparing ids would otherwise agree on a mix that one of them cannot make.
    const nothing = providerFor({ source: 'real', library: ['forest.json'] }, []);
    expect(nothing.id).toBe('generated');
    expect(hashJson(nothing.pick(seeded(9), requirement)))
      .toBe(hashJson(new GeneratedProvider().pick(seeded(9), requirement)));
  });

  it('clamps a share that arrived out of range', () => {
    expect(providerFor({ source: 'mixed', realShare: 9, library: [] }, [imported]).id)
      .toBe('mixed:0*generated+1*library:abc123');
  });
});

describe('the badge a round wears', () => {
  const ctx = { maps: new GeneratedProvider() };

  it('finds the ground under every terrain drill', () => {
    // `mapsOfRound` reads a convention rather than a field — `base` for the two
    // four-option drills, `maps` for pexeso — so the thing that could break it silently is
    // a drill renaming what it holds. This is the test that would notice.
    for (const drill of [contours, mapMemory, pexeso]) {
      const round = drill.generate(seeded(3), 5, ctx);
      expect(mapsOfRound(round).length, drill.id).toBeGreaterThan(0);
      expect(sourceBadge(mapsOfRound(round)), drill.id).toBe('gen');
    }
  });

  it('says nothing for a drill that holds no map', () => {
    expect(mapsOfRound(dohledavka.generate(seeded(3), 5, ctx))).toEqual([]);
    expect(sourceBadge([])).toBeNull();
  });

  it('says mix when a round is genuinely on both', () => {
    // Pexeso draws a map per pair, so under a mixed policy two of six pairs can be real.
    // Calling that round `real` because its first pair was would be a badge saying
    // something the round does not.
    const generated = new GeneratedProvider().pick(seeded(2), requirement).map;
    expect(sourceBadge([generated, imported])).toBe('mix');
    expect(sourceBadge([imported, imported])).toBe('real');
  });
});

describe('sourceOf', () => {
  it('reads the map, not the screen', () => {
    const { meta: _from, ...anonymous } = imported;
    expect(sourceOf(imported)).toBe('real');
    expect(sourceOf(new GeneratedProvider().pick(seeded(1), requirement).map)).toBe('gen');
    // A bundle with no `meta` is still not the generator: its id is a content hash.
    expect(sourceOf(anonymous)).toBe('real');
  });
});
