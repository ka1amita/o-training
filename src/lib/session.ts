import { deriveSeed } from './rng.ts';
import { advance, initial, type StaircaseBounds, type StaircaseState } from './staircase.ts';
import type { Score } from '@/drills/types.ts';
import type { PolicySource } from '@/lib/maps/policy.ts';

/**
 * A session as a pure reducer. Every event carries its own timestamp, so nothing in here
 * reads the clock and the tests need no fake timers — which is the difference between
 * testing the rules and testing setTimeout.
 */
export interface RoundRecord {
  readonly index: number;
  readonly level: number;
  readonly score: Score;
  readonly responseMs: number;
}

export interface SessionState {
  readonly drillId: string;
  readonly seed: number;
  /**
   * Which map source this session ran on.
   *
   * Carried through the session so the summary can record it: a level reached on real maps
   * and one reached on generated maps are not the same level — real ground is busier and
   * more varied, so "distance 18 m" is not one difficulty (the design note's risk 2). The
   * chart is still one curve; this is what will let it be split without asking players to
   * re-train first.
   */
  readonly policySource: PolicySource;
  readonly index: number;
  readonly total: number;
  readonly staircase: StaircaseState;
  readonly records: readonly RoundRecord[];
  readonly startedAt: number;
  /** When the current round became answerable — set after any exposure phase. */
  readonly roundStartedAt: number | null;
  readonly finishedAt: number | null;
  readonly streak: number;
  readonly bestStreak: number;
}

/**
 * `answered` records the attempt; `continue` moves on. Two events rather than one because
 * the round is looked at after it is answered: the correct answer is revealed and the
 * player confirms. Between the two the session is paused on a round it already knows the
 * score of — which is why nothing but `records` moves on `answered`, and why the response
 * time is measured at `answered` and the next round's clock starts at `continue`. A player
 * who studies the reveal for twenty seconds has not got slower.
 *
 * A drill that gives its own feedback (Match Madness, Pexeso) never pauses: `DrillPage`
 * dispatches `continue` in the same breath as `answered`, and those sessions behave
 * exactly as they did when there was one event.
 */
export type SessionEvent =
  | { readonly type: 'round-started'; readonly at: number }
  | { readonly type: 'answered'; readonly score: Score; readonly at: number }
  | { readonly type: 'continue'; readonly at: number }
  | { readonly type: 'finished'; readonly at: number };

export interface SessionInit {
  readonly drillId: string;
  readonly seed: number;
  readonly total: number;
  readonly bounds: StaircaseBounds;
  readonly level: number;
  readonly at: number;
  /** Optional, and defaults to `generated`: a caller that does not say is one that has no
   *  policy to say it with, which is what every caller was before there were policies. */
  readonly policySource?: PolicySource;
}

export function start(init: SessionInit): SessionState {
  return {
    drillId: init.drillId,
    seed: init.seed,
    policySource: init.policySource ?? 'generated',
    index: 0,
    total: init.total,
    staircase: initial(init.bounds, init.level),
    records: [],
    startedAt: init.at,
    roundStartedAt: init.at,
    finishedAt: init.total > 0 ? null : init.at,
    streak: 0,
    bestStreak: 0,
  };
}

export function reduce(
  state: SessionState,
  event: SessionEvent,
  bounds: StaircaseBounds,
): SessionState {
  if (state.finishedAt !== null) return state;

  switch (event.type) {
    case 'round-started':
      return { ...state, roundStartedAt: event.at };

    case 'answered': {
      // A late or duplicated answer past the last round changes nothing. Without this
      // a double-tap on the final round appends a record the session never planned.
      if (state.index >= state.total) return state;
      // Nor does a second answer to the round now being reviewed: the attempt is over and
      // its time is taken, and a stray tap must not overwrite it with a slower one.
      if (awaitingContinue(state)) return state;

      const startedAt = state.roundStartedAt ?? state.startedAt;
      // Clamped: a clock that steps backwards mid-round must not record a negative
      // response, which would silently drag a median below anything achievable.
      const responseMs = Math.max(0, event.at - startedAt);
      const record: RoundRecord = {
        index: state.index,
        level: state.staircase.level,
        score: event.score,
        responseMs,
      };
      // The record, and nothing else. The round counter, the level and the streak are on
      // screen while the answer is being looked at, and a header that moved under the
      // reveal would say the next round had started when it has not.
      return { ...state, records: [...state.records, record] };
    }

    case 'continue': {
      const record = state.records[state.records.length - 1];
      // Confirming a round that was never answered is a stray key on the way to the
      // first tap. Idempotent for the same reason: Enter on a focused button arrives
      // twice on some keyboards, and the second one must not skip a round.
      if (!record || !awaitingContinue(state)) return state;

      const index = state.index + 1;
      const streak = record.score.passed ? state.streak + 1 : 0;
      return {
        ...state,
        index,
        staircase: advance(state.staircase, record.score.passed, bounds),
        // The next round becomes answerable now — the reveal is not part of its time.
        roundStartedAt: event.at,
        streak,
        bestStreak: Math.max(state.bestStreak, streak),
        // The session ends itself on the last round rather than waiting to be told.
        finishedAt: index >= state.total ? event.at : null,
      };
    }

    case 'finished':
      return { ...state, finishedAt: event.at };
  }
}

/**
 * Whether the round in play has been answered and is waiting to be confirmed.
 *
 * Derived rather than stored: `records` grows on `answered` and `index` on `continue`, so
 * one being ahead of the other *is* the review phase, and a second field saying so is a
 * second thing to keep true.
 */
export function awaitingContinue(state: SessionState): boolean {
  return state.finishedAt === null && state.records.length > state.index;
}

/** The seed for the round now being played. */
export function currentSeed(state: SessionState): number {
  return deriveSeed(state.seed, state.index);
}

export interface SessionSummary {
  readonly drillId: string;
  readonly finishedAt: number;
  readonly rounds: number;
  readonly correct: number;
  readonly total: number;
  readonly accuracy: number;
  readonly medianResponseMs: number;
  readonly endLevel: number;
  readonly bestStreak: number;
  /**
   * Which source the rounds came from. **Optional**, and it stays optional: every summary
   * already on a device was written by a build that did not record one, and inventing
   * `generated` for those would be a stored record claiming something it never said.
   * Absent means "not recorded", which a chart that splits by source has to handle anyway.
   */
  readonly policySource?: PolicySource;
}

/**
 * Median rather than mean: one round where the phone was put down mid-session drags a
 * mean far enough to hide the trend this app exists to show.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const xs = [...values].sort((a, b) => a - b);
  const mid = xs.length >> 1;
  return xs.length % 2 === 1 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

export function summarise(state: SessionState): SessionSummary | null {
  if (state.finishedAt === null || state.records.length === 0) return null;
  const correct = state.records.reduce((a, r) => a + r.score.correct, 0);
  const total = state.records.reduce((a, r) => a + r.score.total, 0);
  return {
    drillId: state.drillId,
    finishedAt: state.finishedAt,
    rounds: state.records.length,
    correct,
    total,
    accuracy: total === 0 ? 0 : correct / total,
    medianResponseMs: median(state.records.map((r) => r.responseMs)),
    endLevel: state.staircase.level,
    bestStreak: state.bestStreak,
    policySource: state.policySource,
  };
}
