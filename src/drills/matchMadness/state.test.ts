import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { GeneratedProvider } from '@/lib/maps/provider.ts';
import { seeded } from '@/lib/rng.ts';
import { matchMadness as drill } from './drill.ts';
import {
  initialState, matchReduce, matchedNames, isTileMatched,
  type MatchEvent, type MatchState,
} from './state.ts';

const round = drill.generate(seeded(7), 1, { maps: new GeneratedProvider() });
const tap = (kind: 'symbol' | 'name', value: string): MatchEvent => ({ type: 'tap', kind, value });
const run = (events: MatchEvent[], from: MatchState = initialState) =>
  events.reduce((s, e) => matchReduce(round, s, e), from);

/** Taps the two tiles of pair `i`, symbol first. */
const pairTaps = (i: number): MatchEvent[] => [
  tap('symbol', round.pairs[i]!.symbolId),
  tap('name', round.pairs[i]!.name),
];

describe('match madness / selection', () => {
  it('a first tap selects', () => {
    const s = run([tap('symbol', round.pairs[0]!.symbolId)]);
    expect(s.selected).toEqual({ kind: 'symbol', value: round.pairs[0]!.symbolId });
    expect(s.answers).toHaveLength(0);
  });

  it('tapping again in the same column moves the selection, it does not match', () => {
    const s = run([tap('symbol', round.pairs[0]!.symbolId), tap('symbol', round.pairs[1]!.symbolId)]);
    expect(s.selected).toEqual({ kind: 'symbol', value: round.pairs[1]!.symbolId });
    expect(s.answers).toHaveLength(0);
  });

  it('matches a correct pair and clears the selection', () => {
    const s = run(pairTaps(0));
    expect(s.matched.has(round.pairs[0]!.symbolId)).toBe(true);
    expect(s.selected).toBeNull();
    expect(s.answers).toEqual([{ ...round.pairs[0], correct: true }]);
  });

  it('works name-first as well as symbol-first', () => {
    const s = run([tap('name', round.pairs[0]!.name), tap('symbol', round.pairs[0]!.symbolId)]);
    expect(s.matched.has(round.pairs[0]!.symbolId)).toBe(true);
  });

  it('records a wrong pair, keeps it unmatched, and flags it for the flash', () => {
    const s = run([tap('symbol', round.pairs[0]!.symbolId), tap('name', round.pairs[1]!.name)]);
    expect(s.matched.size).toBe(0);
    expect(s.selected).toBeNull();
    expect(s.wrong).toEqual({ symbolId: round.pairs[0]!.symbolId, name: round.pairs[1]!.name });
    expect(s.answers).toEqual([
      { symbolId: round.pairs[0]!.symbolId, name: round.pairs[1]!.name, correct: false },
    ]);
  });

  it('clears the flash on request, and does so without churning state otherwise', () => {
    const wrong = run([tap('symbol', round.pairs[0]!.symbolId), tap('name', round.pairs[1]!.name)]);
    expect(matchReduce(round, wrong, { type: 'clear-wrong' }).wrong).toBeNull();
    const clean = run(pairTaps(0));
    expect(matchReduce(round, clean, { type: 'clear-wrong' })).toBe(clean);
  });

  it('ignores a tap on a tile already paired off — either column', () => {
    const s = run(pairTaps(0));
    expect(matchReduce(round, s, tap('symbol', round.pairs[0]!.symbolId))).toBe(s);
    expect(matchReduce(round, s, tap('name', round.pairs[0]!.name))).toBe(s);
  });

  it('finishes when the last pair lands', () => {
    const all = round.pairs.flatMap((_, i) => pairTaps(i));
    const s = run(all);
    expect(s.done).toBe(true);
    expect(s.matched.size).toBe(round.pairs.length);
    expect(drill.score(round, s.answers).passed).toBe(true);
  });

  it('several taps in one batch still finish the round', () => {
    // The bug this reducer exists to prevent: two taps arriving before a re-render used
    // to both read the same stale state, so the round never completed.
    expect(run(round.pairs.flatMap((_, i) => pairTaps(i))).done).toBe(true);
  });

  it('accepts nothing after it is done', () => {
    const s = run(round.pairs.flatMap((_, i) => pairTaps(i)));
    const after = run([tap('symbol', round.pairs[0]!.symbolId), { type: 'timeout' }], s);
    expect(after).toBe(s);
    expect(after.answers).toHaveLength(round.pairs.length);
  });

  it('a timeout ends the round and keeps what was found', () => {
    const s = run([...pairTaps(0), { type: 'timeout' }]);
    expect(s.done).toBe(true);
    expect(drill.score(round, s.answers)).toEqual({
      correct: 1,
      total: round.pairs.length,
      passed: false,
    });
  });

  it('matchedNames tracks matched symbols', () => {
    const s = run(pairTaps(0));
    expect([...matchedNames(round, s)]).toEqual([round.pairs[0]!.name]);
    expect(isTileMatched(round, s, 'name', round.pairs[0]!.name)).toBe(true);
    expect(isTileMatched(round, s, 'name', round.pairs[1]!.name)).toBe(false);
  });
});

describe('match madness / selection invariants', () => {
  const anyTap = fc.oneof(
    ...round.pairs.flatMap((p) => [
      fc.constant(tap('symbol', p.symbolId)),
      fc.constant(tap('name', p.name)),
    ]),
    fc.constant<MatchEvent>({ type: 'clear-wrong' }),
  );

  it('never records more matches than there are pairs, however it is tapped at', () => {
    fc.assert(
      fc.property(fc.array(anyTap, { maxLength: 60 }), (events) => {
        const s = run(events);
        expect(s.matched.size).toBeLessThanOrEqual(round.pairs.length);
        // Every recorded match is a real one, and none is recorded twice.
        const correctIds = s.answers.filter((a) => a.correct).map((a) => a.symbolId);
        expect(new Set(correctIds).size).toBe(correctIds.length);
        expect(s.matched.size).toBe(correctIds.length);
      }),
    );
  });

  it('is done exactly when every pair is matched, or a timeout said so', () => {
    fc.assert(
      fc.property(fc.array(anyTap, { maxLength: 60 }), (events) => {
        const s = run(events);
        expect(s.done).toBe(s.matched.size === round.pairs.length);
      }),
    );
  });

  it('never holds a selection on a tile that is already matched', () => {
    fc.assert(
      fc.property(fc.array(anyTap, { maxLength: 60 }), (events) => {
        const s = run(events);
        if (s.selected) {
          expect(isTileMatched(round, s, s.selected.kind, s.selected.value)).toBe(false);
        }
      }),
    );
  });
});
