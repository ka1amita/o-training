import type { FC } from 'react';
import type { Rng } from '@/lib/rng.ts';
import type { StaircaseBounds } from '@/lib/staircase.ts';

export type Engine = 'symbols' | 'terrain';

/** The outcome of one round. A round is one item for the sequence drills and a whole
 *  board for Pexeso, which is why this is a tally rather than a boolean. */
export interface Score {
  readonly correct: number;
  readonly total: number;
  /** Whether the round counts as a success for the staircase. */
  readonly passed: boolean;
}

export interface DrillMeta {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly engine: Engine;
  readonly bounds: StaircaseBounds;
  readonly roundsPerSession: number;
  /** Whether the drill offers a second player (split screen or peer-to-peer). */
  readonly multiplayer?: boolean;
}

export interface PlayProps<Round, Answer> {
  readonly round: Round;
  readonly level: number;
  /** Called once, when the round is over. */
  onDone(answers: Answer[]): void;
}

/**
 * The whole plug-in surface. `generate`, `wellFormed` and `score` are pure and are what
 * the suite tests; `Play` is the only part that touches the DOM and is checked by eye.
 *
 * The rule that makes this work: **an answer is derived from the round's structure and
 * never from what was rendered**. A `score()` that needed to read a canvas would be a
 * bug in the drill, not a gap in the tests.
 */
export interface Drill<Round, Answer> extends DrillMeta {
  /** Pure. The rng is a parameter; nothing here reaches for Math.random or Date.now. */
  generate(rng: Rng, level: number): Round;
  /** Pure. Returns the invariants this round violates — empty means well formed. */
  wellFormed(round: Round): string[];
  /** Pure. */
  score(round: Round, answers: readonly Answer[]): Score;
  readonly Play: FC<PlayProps<Round, Answer>>;
}

/**
 * The registry erases each drill's Round and Answer types, since a list of drills has no
 * single pair to name. `any` is contained to this alias and the registry table; every
 * drill module is fully typed inside itself.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDrill = Drill<any, any>;

/** Identity, but it pins Round and Answer at the definition site so a drill's own
 *  generate/score/Play are checked against each other. */
export function defineDrill<Round, Answer>(d: Drill<Round, Answer>): Drill<Round, Answer> {
  return d;
}
