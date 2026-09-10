import type { FC } from 'react';
import type { RoundContext } from '@/lib/maps/provider.ts';
import type { Rng } from '@/lib/rng.ts';
import type { OMap } from '@/lib/terrain/omap.ts';
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
  /**
   * Pure. The rng is a parameter; nothing here reaches for Math.random or Date.now.
   *
   * `ctx` is where a terrain drill gets its ground: it asks a `MapProvider` for a window
   * that meets its requirement rather than calling the generator, so which source the
   * round runs on is decided outside the drill. The symbol drills ignore it.
   */
  generate(rng: Rng, level: number, ctx: RoundContext): Round;
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

/**
 * The ground a round is on, read off the round itself.
 *
 * A terrain round holds its map as `base` — one map and its variants, which is the contours
 * drill and map memory — or as `maps`, one per pair, which is pexeso, or on its `cards`,
 * one window each, which is map dohledavka. That is a convention rather than a field of
 * `Drill`, and this is where it is written down, because the session runner needs it to say
 * which source a round came from and a drill should not have to gain a method to be asked.
 *
 * Read from the **round**, never from what was drawn. Which is the one rule, applied to a
 * badge rather than to an answer, and for the same reason: the round is the truth.
 */
export function mapsOfRound(round: unknown): readonly OMap[] {
  if (typeof round !== 'object' || round === null) return [];
  const held = round as { base?: unknown; maps?: unknown; cards?: unknown };
  if (Array.isArray(held.maps)) return held.maps.filter(isMap);
  if (Array.isArray(held.cards)) {
    return held.cards
      .map((card) => (typeof card === 'object' && card !== null
        ? (card as { map?: unknown }).map
        : null))
      .filter(isMap);
  }
  return isMap(held.base) ? [held.base] : [];
}

const isMap = (value: unknown): value is OMap =>
  typeof value === 'object' && value !== null && 'relief' in value && 'features' in value;
