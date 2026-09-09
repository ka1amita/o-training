import { defineDrill, type Score } from '@/drills/types.ts';
import { siblings } from '@/drills/shared/siblings.ts';
import type { RoundContext, WindowRequirement } from '@/lib/maps/provider.ts';
import type { Rng } from '@/lib/rng.ts';
import { difference, type Variant } from '@/lib/terrain/edits.ts';
import type { Crop, OMap } from '@/lib/terrain/omap.ts';
import Play from './Play.tsx';

/**
 * Map memory.
 *
 * One window on a map, shown briefly, then four candidates. The distractors are the same
 * map with **one feature moved**, so the question is what you actually retained rather
 * than the gist of it — which is the difference between remembering a leg and remembering
 * that there was a leg.
 *
 * Anything may change, unlike the contour drill, because everything on an ISOM map is
 * visible: a feature moves, or the ground under it warps. What must hold is that the
 * change happened **inside the window** — a boulder shifted off-screen leaves two
 * identical cards and a round with two right answers.
 */
export interface MapMemoryRound {
  readonly base: OMap;
  readonly variants: readonly Variant[];
  readonly correctIndex: number;
  /** The same window for the target and every candidate. */
  readonly crop: Crop;
  readonly exposureMs: number;
}

export interface MapMemoryAnswer {
  readonly index: number;
  readonly correct: boolean;
}

export const OPTIONS = 4;
export const CROP_SIZE = 150;

export interface MemoryParams {
  readonly exposureMs: number;
  readonly distance: number;
}

export function paramsFor(level: number): MemoryParams {
  const clamped = Math.min(10, Math.max(1, level));
  const between = (low: number, high: number) => low + ((high - low) * (clamped - 1)) / 9;
  return {
    // Two axes at once: less time to look, and less to notice.
    exposureMs: Math.round(between(6000, 1800)),
    distance: Math.round(between(55, 18)),
  };
}

/** Some of everything, in a 300 m map the drill then shows 150 m of. */
export function requirementFor(level: number): WindowRequirement {
  const clamped = Math.min(10, Math.max(1, level));
  const scale = (low: number, high: number) =>
    Math.round(low + ((high - low) * (clamped - 1)) / 9);
  return {
    size: 300,
    needsRelief: false,
    crop: CROP_SIZE,
    minFeatures: {
      landform: scale(5, 9),
      point: scale(10, 18),
      line: scale(2, 3),
      area: scale(4, 8),
    },
    rides: 2,
    // Fewer than the pexeso map on purpose. The question here is which *one* feature
    // moved, and a rock field of twenty near-identical crags is a needle in a haystack
    // rather than a memory of the ground.
    clusters: scale(1, 3),
  };
}

export const mapMemory = defineDrill<MapMemoryRound, MapMemoryAnswer>({
  id: 'map-memory',
  title: 'Map memory',
  blurb: 'A map extract, briefly. Then pick the one you saw.',
  engine: 'terrain',
  bounds: { min: 1, max: 10 },
  roundsPerSession: 10,

  generate(rng: Rng, level: number, ctx: RoundContext): MapMemoryRound {
    const params = paramsFor(level);
    const picked = ctx.maps.pick(rng, requirementFor(level));
    if (!picked) throw new Error('map memory: no map for this level');
    const { map: base, crop } = picked;

    return {
      // A landform is warped and everything else is moved: between them they are the
      // "one feature nudged" this drill has always asked for.
      ...siblings(rng, base, OPTIONS, { distance: params.distance, ops: ['warp', 'move'], crop }),
      crop,
      exposureMs: params.exposureMs,
    };
  },

  wellFormed(round: MapMemoryRound): string[] {
    const problems: string[] = [];
    if (round.variants.length !== OPTIONS) {
      problems.push(`${round.variants.length} options, expected ${OPTIONS}`);
    }
    if (!round.variants[round.correctIndex]) {
      problems.push(`correctIndex ${round.correctIndex} is not an option`);
      return problems;
    }

    round.variants.forEach((variant, index) => {
      if (index === round.correctIndex) return;
      if (!difference(variant, round.crop).visible) {
        problems.push(`option ${index} is identical to the answer inside the window`);
      }
    });

    const { x, y, size } = round.crop;
    if (x < 0 || y < 0 || x + size > round.base.width || y + size > round.base.width) {
      problems.push('the window runs off the map');
    }
    if (round.exposureMs <= 0) problems.push('exposureMs must be positive');

    return problems;
  },

  score(_round: MapMemoryRound, answers: readonly MapMemoryAnswer[]): Score {
    const first = answers[0];
    return { correct: first?.correct ? 1 : 0, total: 1, passed: first?.correct === true };
  },

  Play,
});
