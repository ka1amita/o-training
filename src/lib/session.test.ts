import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { start, reduce, summarise, median, currentSeed, type SessionState } from './session.ts';
import type { StaircaseBounds } from './staircase.ts';
import type { Score } from '@/drills/types.ts';

const B: StaircaseBounds = { min: 1, max: 10 };
const ok: Score = { correct: 1, total: 1, passed: true };
const bad: Score = { correct: 0, total: 1, passed: false };

const fresh = (total = 3, at = 1000): SessionState =>
  start({ drillId: 'test', seed: 42, total, bounds: B, level: 5, at });

const answer = (s: SessionState, score: Score, at: number) =>
  reduce(s, { type: 'answered', score, at }, B);

describe('session', () => {
  it('records response time from the round start, not the session start', () => {
    let s = fresh();
    s = reduce(s, { type: 'round-started', at: 1500 }, B);
    s = answer(s, ok, 2100);
    expect(s.records[0]!.responseMs).toBe(600);
  });

  it('measures each later round from the previous answer', () => {
    let s = fresh();
    s = answer(s, ok, 1400); // 400ms from session start
    s = answer(s, ok, 1900); // 500ms from the previous answer
    expect(s.records.map((r) => r.responseMs)).toEqual([400, 500]);
  });

  it('clamps a backwards clock rather than recording a negative response', () => {
    let s = fresh();
    s = answer(s, ok, 200); // earlier than startedAt
    expect(s.records[0]!.responseMs).toBe(0);
  });

  it('finishes itself on the last round', () => {
    let s = fresh(2);
    s = answer(s, ok, 1100);
    expect(s.finishedAt).toBeNull();
    s = answer(s, ok, 1200);
    expect(s.finishedAt).toBe(1200);
  });

  it('ignores answers after it has finished — a double tap adds no round', () => {
    let s = fresh(1);
    s = answer(s, ok, 1100);
    const after = answer(s, ok, 1150);
    expect(after).toBe(s);
    expect(after.records).toHaveLength(1);
  });

  it('tracks streak and best streak, resetting on a miss', () => {
    let s = fresh(6);
    for (const [score, at] of [[ok, 1100], [ok, 1200], [bad, 1300], [ok, 1400], [ok, 1500]] as const) {
      s = answer(s, score, at);
    }
    expect(s.streak).toBe(2);
    expect(s.bestStreak).toBe(2);
  });

  it('records the level the round was played at, not the level after it', () => {
    let s = fresh(6);
    s = answer(s, ok, 1100);
    s = answer(s, ok, 1200);
    s = answer(s, ok, 1300); // third correct advances 5 -> 6
    expect(s.records.map((r) => r.level)).toEqual([5, 5, 5]);
    expect(s.staircase.level).toBe(6);
  });

  it('derives a per-round seed that does not depend on rounds already played', () => {
    const a = fresh();
    const atRoundTwo = answer(answer(a, ok, 1100), ok, 1200);
    // Same index reached by replay must give the same seed.
    const replayed = { ...a, index: 2 };
    expect(currentSeed(atRoundTwo)).toBe(currentSeed(replayed));
    expect(currentSeed(a)).not.toBe(currentSeed(atRoundTwo));
  });

  it('never exceeds its planned round count, for any sequence of events', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.array(fc.boolean(), { maxLength: 60 }),
        (total, answers) => {
          let s = fresh(total);
          answers.forEach((c, i) => {
            s = answer(s, c ? ok : bad, 1000 + (i + 1) * 100);
          });
          expect(s.records.length).toBeLessThanOrEqual(total);
          expect(s.index).toBeLessThanOrEqual(total);
        },
      ),
    );
  });

  it('summarises only a finished session', () => {
    let s = fresh(2);
    s = answer(s, ok, 1400);
    expect(summarise(s)).toBeNull();
    s = answer(s, bad, 1600);
    const sum = summarise(s)!;
    expect(sum).toMatchObject({ rounds: 2, correct: 1, total: 2, accuracy: 0.5, endLevel: 4 });
    expect(sum.medianResponseMs).toBe(300); // median of 400 and 200
  });

  it('records which source the rounds ran on', () => {
    // A level reached on real maps is not the level reached on generated ones: real ground
    // is busier and more varied, so the same requested distance is not the same difficulty.
    // The chart is still one curve; this is what will let it be split later without asking
    // players to re-train first.
    let s = start({
      drillId: 'test', seed: 42, total: 1, bounds: B, level: 5, at: 1000, policySource: 'mixed',
    });
    s = answer(s, ok, 1300);
    expect(summarise(s)!.policySource).toBe('mixed');
  });

  it('defaults the source to generated when a caller does not say', () => {
    // Which every caller was before there were policies, and which the summaries already
    // on a device were written by — those carry no source at all, and `SessionSummary`
    // keeps the field optional so that stays readable rather than being invented.
    let s = fresh(1);
    expect(s.policySource).toBe('generated');
    s = answer(s, ok, 1300);
    expect(summarise(s)!.policySource).toBe('generated');
  });
});

describe('median', () => {
  it('handles empty, odd and even', () => {
    expect(median([])).toBe(0);
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('resists a single outlier where a mean would not', () => {
    const xs = [500, 520, 480, 510, 600000];
    expect(median(xs)).toBe(510);
  });
});
