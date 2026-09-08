import { defineDrill, type Score } from '@/drills/types.ts';
import { siblings } from '@/drills/shared/siblings.ts';
import type { Rng } from '@/lib/rng.ts';
import { maxHeightDifference } from '@/lib/terrain/height.ts';
import { generateTerrain, paramsFor as terrainParams, type Terrain } from '@/lib/terrain/terrain.ts';
import Play from './Play.tsx';

/**
 * Contours to relief.
 *
 * A contour-only card, then four shaded reliefs: pick the ground the contours describe.
 * This is the reading an orienteer does continuously and can practise nowhere else
 * indoors — brown lines into three dimensions.
 *
 * The distractors are the same terrain with **one landform moved**, and it has to be a
 * landform: a boulder somewhere else changes the map and not the relief, so any other
 * target would produce a distractor identical to the answer.
 */
export interface ContoursRound {
  readonly options: readonly Terrain[];
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
      target: 'landform',
      minHeightDifference: MIN_HEIGHT_DIFFERENCE,
    });
  },

  wellFormed(round: ContoursRound): string[] {
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
      // The invariant that makes the round answerable: every other relief has to be
      // visibly different ground, or the card describes two of them equally well.
      const difference = maxHeightDifference(answer, option);
      if (difference < MIN_HEIGHT_DIFFERENCE) {
        problems.push(`option ${index} differs from the answer by only ${difference.toFixed(2)} m`);
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
