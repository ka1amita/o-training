import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { seeded } from '@/lib/rng.ts';
import { dohledavka as drill } from './drill.ts';
import { dobbleReduce, initialState, type DobbleEvent, type DobbleState } from './state.ts';

const round = drill.generate(seeded(3), 5);
const other = round.cards[0].symbols.map((s) => s.symbolId).filter((id) => id !== round.shared);
const tap = (symbolId: string): DobbleEvent => ({ type: 'tap', symbolId });
const run = (events: DobbleEvent[], from: DobbleState = initialState) =>
  events.reduce((s, e) => dobbleReduce(round, s, e), from);

describe('dohledavka / taps', () => {
  it('finding the shared symbol ends the round and passes', () => {
    const s = run([tap(round.shared)]);
    expect(s.done).toBe(true);
    expect(drill.score(round, s.answers).passed).toBe(true);
  });

  it('a wrong tap is recorded and flagged, and the round goes on', () => {
    const s = run([tap(other[0]!)]);
    expect(s.done).toBe(false);
    expect(s.wrong).toBe(other[0]);
    expect(s.answers).toEqual([{ symbolId: other[0], correct: false }]);
  });

  it('finding it after a miss counts, but does not pass', () => {
    const s = run([tap(other[0]!), tap(round.shared)]);
    expect(s.done).toBe(true);
    expect(drill.score(round, s.answers)).toEqual({ correct: 1, total: 1, passed: false });
  });

  it('stabbing at the same wrong symbol is one mistake, not many', () => {
    // A player jabbing at a card should not be scored worse than one who thought about it
    // once and was wrong.
    const s = run([tap(other[0]!), tap(other[0]!), tap(other[0]!)]);
    expect(s.answers).toHaveLength(1);
  });

  it('distinct wrong symbols each count', () => {
    const s = run([tap(other[0]!), tap(other[1]!)]);
    expect(s.answers).toHaveLength(2);
  });

  it('clears the flash on request', () => {
    const wrong = run([tap(other[0]!)]);
    expect(dobbleReduce(round, wrong, { type: 'clear-wrong' }).wrong).toBeNull();
    expect(dobbleReduce(round, initialState, { type: 'clear-wrong' })).toBe(initialState);
  });

  it('accepts nothing after it is done', () => {
    const s = run([tap(round.shared)]);
    expect(run([tap(other[0]!), { type: 'timeout' }], s)).toBe(s);
  });

  it('a timeout ends it with whatever was found', () => {
    const s = run([tap(other[0]!), { type: 'timeout' }]);
    expect(s.done).toBe(true);
    expect(drill.score(round, s.answers)).toEqual({ correct: 0, total: 1, passed: false });
  });

  it('is done exactly when the shared symbol was tapped, or time ran out', () => {
    const anyTap = fc.oneof(
      ...round.cards.flatMap((c) => c.symbols.map((s) => fc.constant(tap(s.symbolId)))),
      fc.constant<DobbleEvent>({ type: 'clear-wrong' }),
    );
    fc.assert(
      fc.property(fc.array(anyTap, { maxLength: 40 }), (events) => {
        const s = run(events);
        expect(s.done).toBe(s.answers.some((a) => a.correct));
        // No symbol is ever answered twice, so the mistake count is honest.
        const ids = s.answers.map((a) => a.symbolId);
        expect(new Set(ids).size).toBe(ids.length);
      }),
    );
  });
});
