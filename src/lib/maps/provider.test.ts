import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { seeded, type Rng } from '@/lib/rng.ts';
import { hashJson } from '@/lib/rng.ts';
import { NoRelief } from '@/lib/terrain/relief.ts';
import type { Crop, OMap } from '@/lib/terrain/omap.ts';
import {
  GeneratedProvider, MixedProvider, type MapProvider, type WindowRequirement,
} from './provider.ts';

const anySeed = fc.integer({ min: 0, max: 0xffffffff });

const requirement: WindowRequirement = {
  size: 300,
  needsRelief: false,
  minFeatures: { landform: 4, point: 6, line: 1, area: 2 },
};

/**
 * A source that always says the same thing, or always says no.
 *
 * Standing in for a library, because what a mix has to be tested on is *whether* a part
 * answered and how much rng it took to do it — not what its map looked like. `draws` is
 * how many numbers it takes, so a test can tell a fall-through apart from a first hit by
 * where the stream ended up.
 */
function stub(id: string, answers: boolean, draws = 1): MapProvider & { calls: number } {
  const map: OMap = {
    id,
    width: 300,
    height: 300,
    scale: 15000,
    relief: new NoRelief(300),
    features: [],
  };
  return {
    id,
    calls: 0,
    pick(rng: Rng): { map: OMap; crop: Crop } | null {
      this.calls++;
      for (let i = 0; i < draws; i++) rng.next();
      return answers ? { map, crop: { x: 0, y: 0, size: 300 } } : null;
    },
  };
}

describe('MixedProvider', () => {
  it('is a function of the rng and nothing else', () => {
    fc.assert(
      fc.property(anySeed, (seed) => {
        const mix = () => new MixedProvider([
          { provider: new GeneratedProvider(), weight: 0.7 },
          { provider: stub('library:a', true), weight: 0.3 },
        ]);
        expect(hashJson(mix().pick(seeded(seed), requirement)!.crop))
          .toBe(hashJson(mix().pick(seeded(seed), requirement)!.crop));
      }),
      { numRuns: 60 },
    );
  });

  it('falls through when a source declines', () => {
    // The case the whole class exists for: a library that has no window for what was
    // asked — the contours drill on a raster-only map — must not become an error screen.
    const empty = stub('library:none', false);
    const mix = new MixedProvider([
      { provider: empty, weight: 1 },
      { provider: new GeneratedProvider(), weight: 0 },
    ]);
    for (let seed = 0; seed < 20; seed++) {
      expect(mix.pick(seeded(seed), requirement)!.map.id).toBe('generated');
    }
    expect(empty.calls).toBe(20);
  });

  it('declines only when every source has', () => {
    const mix = new MixedProvider([
      { provider: stub('a', false), weight: 1 },
      { provider: stub('b', false), weight: 1 },
    ]);
    expect(mix.pick(seeded(1), requirement)).toBeNull();
  });

  it('at 1 and 0 is the one source, draw for draw', () => {
    // Not merely "the same map": the same *rng stream*, so that a policy at 100% one
    // source produces the rounds that source produces rather than rounds shifted by the
    // draw that chose it. A choice with one outcome is not a choice.
    fc.assert(
      fc.property(anySeed, (seed) => {
        const alone = new GeneratedProvider();
        const mix = new MixedProvider([
          { provider: new GeneratedProvider(), weight: 1 },
          { provider: stub('library:a', true), weight: 0 },
        ]);
        const a = seeded(seed);
        const b = seeded(seed);
        expect(hashJson(mix.pick(a, requirement))).toBe(hashJson(alone.pick(b, requirement)));
        // Same number of draws taken, which is what "draw for draw" means.
        expect(a.next()).toBe(b.next());
      }),
      { numRuns: 40 },
    );
  });

  it('draws each source about as often as its weight', () => {
    const from = (seed: number) => {
      const mix = new MixedProvider([
        { provider: stub('a', true), weight: 0.7 },
        { provider: stub('b', true), weight: 0.3 },
      ]);
      return mix.pick(seeded(seed), requirement)!.map.id;
    };
    const ids = Array.from({ length: 600 }, (_, s) => from(s));
    const a = ids.filter((id) => id === 'a').length / ids.length;
    expect(a).toBeGreaterThan(0.62);
    expect(a).toBeLessThan(0.78);
  });

  it('names its parts and their shares, in the order it tries them', () => {
    // A round is a function of (seed, level, provider.id), so the id has to say everything
    // that changes a round: which sources, in what proportion, and in what order — the
    // order is the fall-through order and is therefore behaviour.
    const mix = new MixedProvider([
      { provider: new GeneratedProvider(), weight: 7 },
      { provider: stub('library:abc', true), weight: 3 },
    ]);
    expect(mix.id).toBe('mixed:0.7*generated+0.3*library:abc');
    // Relative, so the same mix written differently is the same id.
    expect(new MixedProvider([
      { provider: new GeneratedProvider(), weight: 0.7 },
      { provider: stub('library:abc', true), weight: 0.3 },
    ]).id).toBe(mix.id);
    expect(new MixedProvider([
      { provider: stub('library:abc', true), weight: 3 },
      { provider: new GeneratedProvider(), weight: 7 },
    ]).id).not.toBe(mix.id);
  });

  it('refuses to be a mix of nothing', () => {
    expect(() => new MixedProvider([])).toThrow();
  });
});
