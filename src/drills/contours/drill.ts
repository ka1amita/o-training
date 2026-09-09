import { defineDrill, type Score } from '@/drills/types.ts';
import { siblings } from '@/drills/shared/siblings.ts';
import type { Rng } from '@/lib/rng.ts';
import { difference, type Variant } from '@/lib/terrain/edits.ts';
import { wholeMap, type OMap } from '@/lib/terrain/omap.ts';
import { generateTerrain, paramsFor as terrainParams } from '@/lib/terrain/terrain.ts';
import Play from './Play.tsx';

/**
 * Contours to relief.
 *
 * A contour-only card, then four shaded reliefs: pick the ground the contours describe.
 * This is the reading an orienteer does continuously and can practise nowhere else
 * indoors — brown lines into three dimensions.
 *
 * The distractors are the same ground **warped**, and it has to be the ground: a boulder
 * somewhere else changes the map and not the relief, so any other edit would produce a
 * distractor identical to the answer.
 */
export interface ContoursRound {
  readonly base: OMap;
  /** The answer is the variant with no edits; the rest each carry one warp. */
  readonly variants: readonly Variant[];
  readonly correctIndex: number;
}

export interface ContoursAnswer {
  readonly index: number;
  readonly correct: boolean;
}

export const OPTIONS = 4;
/** Below this a moved landform is not visible in the shading. */
export const MIN_HEIGHT_DIFFERENCE = 1.5;

export function distanceFor(level: number): number {
  const clamped = Math.min(10, Math.max(1, level));
  // Nearer means harder: the two reliefs differ by less.
  return Math.round(70 - ((70 - 20) * (clamped - 1)) / 9);
}

export const contours = defineDrill<ContoursRound, ContoursAnswer>({
  id: 'contours',
  title: 'Contours to relief',
  blurb: 'Read the brown lines, then pick the ground they describe.',
  engine: 'terrain',
  bounds: { min: 1, max: 10 },
  roundsPerSession: 10,

  generate(rng: Rng, level: number): ContoursRound {
    // A calmer map than the pexeso one: this drill is about the shape of the ground, and
    // a busy map hides it under detail that carries no relief at all.
    const base = generateTerrain(rng, {
      ...terrainParams(level, 380),
      points: 0,
      lines: 0,
      areas: 0,
      rides: 0,
      clusters: 0,
    });
    return siblings(rng, base, OPTIONS, {
      distance: distanceFor(level),
      ops: ['warp'],
      minReliefDelta: MIN_HEIGHT_DIFFERENCE,
    });
  },

  wellFormed(round: ContoursRound): string[] {
    const problems: string[] = [];
    if (round.variants.length !== OPTIONS) {
      problems.push(`${round.variants.length} options, expected ${OPTIONS}`);
    }
    if (!round.variants[round.correctIndex]) {
      problems.push(`correctIndex ${round.correctIndex} is not an option`);
      return problems;
    }

    // The whole map is the window: this drill shows all of it.
    const window_ = wholeMap(round.base);
    round.variants.forEach((variant, index) => {
      if (index === round.correctIndex) return;
      // The invariant that makes the round answerable: every other relief has to be
      // visibly different ground, or the card describes two of them equally well. Read
      // off the edits, never off the shading they would produce.
      const delta = difference(variant, window_).reliefDelta;
      if (delta < MIN_HEIGHT_DIFFERENCE) {
        problems.push(`option ${index} differs from the answer by only ${delta.toFixed(2)} m`);
      }
    });

    return problems;
  },

  score(_round: ContoursRound, answers: readonly ContoursAnswer[]): Score {
    const first = answers[0];
    return {
      correct: first?.correct ? 1 : 0,
      total: 1,
      passed: first?.correct === true,
    };
  },

  Play,
});
