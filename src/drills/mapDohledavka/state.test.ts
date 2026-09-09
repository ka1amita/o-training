import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { GeneratedProvider, type RoundContext } from '@/lib/maps/provider.ts';
import { seeded } from '@/lib/rng.ts';
import { mapDohledavka as drill } from './drill.ts';
import type { ControlKind } from './features.ts';
import {
  initialState, mapDobbleReduce, type MapDobbleEvent, type MapDobbleState,
} from './state.ts';

const maps: RoundContext = { maps: new GeneratedProvider() };
const round = drill.generate(seeded(3), 6, maps);
const decoy = round.cards[0].controls.find((c) => c.kind !== round.shared)!.kind;
const otherDecoy = round.cards[1].controls.find((c) => c.kind !== round.shared)!.kind;

const tap = (kind: ControlKind): MapDobbleEvent => ({ type: 'tap', kind });
const run = (events: MapDobbleEvent[], from: MapDobbleState = initialState) =>
  events.reduce((s, e) => mapDobbleReduce(round, s, e), from);

describe('map dohledavka / tapping', () => {
  it('the shared kind ends the round', () => {
    const s = run([tap(round.shared)]);
    expect(s.done).toBe(true);
    expect(s.answers).toEqual([{ kind: round.shared, correct: true }]);
  });

  it('is claimed from either card, because a kind is a kind', () => {
    // The shared kind is circled once on each card, in two different places. Which circle
    // was tapped is not a fact the round holds, and does not need to be.
    const onA = round.cards[0].controls.find((c) => c.kind === round.shared)!;
    const onB = round.cards[1].controls.find((c) => c.kind === round.shared)!;
    expect([onA.x, onA.y]).not.toEqual([onB.x, onB.y]);
    expect(run([tap(onA.kind)])).toEqual(run([tap(onB.kind)]));
  });

  it('a wrong kind is recorded and flashed, and the round goes on', () => {
    const s = run([tap(decoy)]);
    expect(s.done).toBe(false);
    expect(s.wrong).toBe(decoy);
    expect(s.answers).toEqual([{ kind: decoy, correct: false }]);
  });

  it('stabbing at the same wrong circle is one mistake, not five', () => {
    const s = run([tap(decoy), tap(decoy), tap(decoy)]);
    expect(s.answers).toHaveLength(1);
  });

  it('the flash clears without touching the answers', () => {
    const s = run([tap(decoy), { type: 'clear-wrong' }]);
    expect(s.wrong).toBeNull();
    expect(s.answers).toHaveLength(1);
  });

  it('clearing a flash that is not there changes nothing', () => {
    expect(mapDobbleReduce(round, initialState, { type: 'clear-wrong' })).toBe(initialState);
  });

  it('accepts nothing once it is done', () => {
    const s = run([tap(round.shared)]);
    expect(mapDobbleReduce(round, s, tap(decoy))).toBe(s);
  });

  it('scores a round found after two wrong kinds', () => {
    const s = run([tap(decoy), tap(otherDecoy), tap(round.shared)]);
    expect(drill.score(round, s.answers)).toEqual({ correct: 1, total: 1, passed: false });
  });

  it('records each distinct kind at most once, whatever the taps', () => {
    const kinds = round.cards.flatMap((c) => c.controls.map((x) => x.kind));
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...kinds).map(tap), { maxLength: 30 }), (events) => {
        const s = run(events);
        const seen = s.answers.map((a) => a.kind);
        expect(new Set(seen).size).toBe(seen.length);
        // The round ends on the shared kind and never before it.
        expect(s.done).toBe(seen.includes(round.shared));
        expect(s.answers.filter((a) => a.correct)).toHaveLength(s.done ? 1 : 0);
      }),
    );
  });
});
