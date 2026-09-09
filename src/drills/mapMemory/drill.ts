import { defineDrill, type Score } from '@/drills/types.ts';
import { differsWithin, siblings } from '@/drills/shared/siblings.ts';
import type { Rng } from '@/lib/rng.ts';
import type { Crop } from '@/lib/terrain/omap.ts';
import {
  generateTerrain, type GeneratedMap, type TerrainParams,
} from '@/lib/terrain/terrain.ts';
import Play from './Play.tsx';

/**
 * Map memory.
 *
 * One window on a map, shown briefly, then four candidates. The distractors are the same
 * map with **one feature moved**, so the question is what you actually retained rather
 * than the gist of it — which is the difference between remembering a leg and remembering
 * that there was a leg.
 *
 * Any feature may move, unlike the contour drill, because everything on an ISOM map is
 * visible. What must hold is that the move happened **inside the window**: a boulder
 * shifted off-screen leaves two identical cards and a round with two right answers.
 */
export interface MapMemoryRound {
  readonly options: readonly GeneratedMap[];
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

function terrainFor(level: number): TerrainParams {
  const clamped = Math.min(10, Math.max(1, level));
  const scale = (low: number, high: number) =>
    Math.round(low + ((high - low) * (clamped - 1)) / 9);
  return {
    size: 300,
    landforms: scale(5, 9),
    points: scale(10, 18),
    lines: scale(2, 3),
    areas: scale(4, 8),
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

  generate(rng: Rng, level: number): MapMemoryRound {
    const params = paramsFor(level);
    const base = generateTerrain(rng, terrainFor(level));

    const crop: Crop = {
      x: rng.range(0, base.width - CROP_SIZE),
      y: rng.range(0, base.width - CROP_SIZE),
      size: CROP_SIZE,
    };

    return {
      ...siblings(rng, base, OPTIONS, { distance: params.distance, crop }),
      crop,
      exposureMs: params.exposureMs,
    };
  },

  wellFormed(round: MapMemoryRound): string[] {
    const problems: string[] = [];
    if (round.options.length !== OPTIONS) {
      problems.push(`${round.options.length} options, expected ${OPTIONS}`);
    }
    const answer = round.options[round.correctIndex];
    if (!answer) {
      problems.push(`correctIndex ${round.correctIndex} is not an option`);
      return problems;
    }

    round.options.forEach((option, index) => {
      if (index === round.correctIndex) return;
      if (!differsWithin(answer, option, round.crop)) {
        problems.push(`option ${index} is identical to the answer inside the window`);
      }
    });

    const { x, y, size } = round.crop;
    if (x < 0 || y < 0 || x + size > answer.width || y + size > answer.width) {
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
