import { deriveSeed } from './rng.ts';
import { advance, initial, type StaircaseBounds, type StaircaseState } from './staircase.ts';
import type { Score } from '@/drills/types.ts';

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

export type SessionEvent =
  | { readonly type: 'round-started'; readonly at: number }
  | { readonly type: 'answered'; readonly score: Score; readonly at: number }
  | { readonly type: 'finished'; readonly at: number };

export interface SessionInit {
  readonly drillId: string;
  readonly seed: number;
  readonly total: number;
  readonly bounds: StaircaseBounds;
  readonly level: number;
  readonly at: number;
}

export function start(init: SessionInit): SessionState {
  return {
    drillId: init.drillId,
    seed: init.seed,
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
      const index = state.index + 1;
      const streak = event.score.passed ? state.streak + 1 : 0;
      return {
        ...state,
        index,
        staircase: advance(state.staircase, event.score.passed, bounds),
        records: [...state.records, record],
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
  };
}
