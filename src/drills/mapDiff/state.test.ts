import { describe, it, expect } from 'vitest';
import { GeneratedProvider, type RoundContext } from '@/lib/maps/provider.ts';
import { seeded } from '@/lib/rng.ts';
import type { Vec } from '@/lib/terrain/omap.ts';
import { mapDiff, type MapDiffRound } from './drill.ts';
import {
  foundIn, initialState, mapDiffReduce, targetAt, type MapDiffEvent, type MapDiffState,
} from './state.ts';

/**
 * The tap rules, asked without a DOM — which is the whole reason they are here and not in
 * the component. Two taps before a re-render both read `state` out of a closure, and Match
 * Madness is the drill that learnt it the hard way.
 */
const ctx: RoundContext = { maps: new GeneratedProvider() };
const round: MapDiffRound = mapDiff.generate(seeded(21), 10, ctx);

const play = (...events: MapDiffEvent[]): MapDiffState =>
  events.reduce((state, event) => mapDiffReduce(round, state, event), initialState);

/** The centre of a target, which is as square on it as a tap can be. */
const on = (index: number): MapDiffEvent => ({ type: 'tap', at: round.targets[index]!.at });

/** Somewhere on the card that is not inside any target. */
const nowhere = (): Vec => {
  const { crop } = round;
  const rng = seeded(5);
  for (let attempt = 0; attempt < 500; attempt++) {
    const at = {
      x: crop.x + rng.range(0, crop.size),
      y: crop.y + rng.range(0, crop.size),
    };
    if (targetAt(round, at) === null) return at;
  }
  throw new Error('every point of this card is a target');
};

describe('map vs reality / the tap rules', () => {
  it('has something to be asked about', () => {
    expect(round.targets.length).toBeGreaterThanOrEqual(3);
    expect(mapDiff.wellFormed(round)).toEqual([]);
  });

  it('records where a tap landed and which change it found', () => {
    const state = play(on(0));
    expect(state.taps).toEqual([{ at: round.targets[0]!.at, target: 0 }]);
    expect(foundIn(state)).toBe(1);
    expect(state.done).toBe(false);
  });

  it('records a tap on ordinary ground as a tap that found nothing', () => {
    const at = nowhere();
    const state = play({ type: 'tap', at });
    expect(state.taps).toEqual([{ at, target: null }]);
    expect(foundIn(state)).toBe(0);
  });

  it('ends the round when the taps are spent, and there are as many as there are changes', () => {
    const misses = Array.from({ length: round.targets.length }, () =>
      ({ type: 'tap', at: nowhere() }) as MapDiffEvent);
    const state = play(...misses);
    expect(state.taps).toHaveLength(round.targets.length);
    expect(state.done).toBe(true);
    // And it stays ended: a tap arriving after the last one cannot lengthen the round.
    expect(mapDiffReduce(round, state, on(0))).toBe(state);
  });

  it('does not spend a tap on a change already found', () => {
    // A finger that lands twice, or a player confirming what they saw. The same rule
    // Mapova dohledavka keeps about tapping one wrong kind twice — and here it matters
    // more, because a wasted tap is a change that can no longer be looked for.
    const state = play(on(0), on(0), on(0));
    expect(state.taps).toHaveLength(1);
    expect(state.done).toBe(false);
  });

  it('does spend a tap on each different miss, because each is a different guess', () => {
    const first = nowhere();
    const second = { x: first.x + round.tolerance * 3, y: first.y };
    const state = play({ type: 'tap', at: first }, { type: 'tap', at: second });
    expect(state.taps).toHaveLength(2);
  });

  it('ends the round on the clock and on the player saying there is nothing else', () => {
    for (const type of ['timeout', 'give-up'] as const) {
      const state = play(on(0), { type });
      expect(state.done).toBe(true);
      // What was found is kept: a round that ran out is answered with what was in it.
      expect(foundIn(state)).toBe(1);
    }
  });

  it('finds a change from anywhere inside its disc, and nowhere outside it', () => {
    const target = round.targets[0]!;
    const reach = target.radius + round.tolerance;
    for (const angle of [0, 1, 2, 3, 4, 5]) {
      const inside = {
        x: target.at.x + Math.cos(angle) * reach * 0.98,
        y: target.at.y + Math.sin(angle) * reach * 0.98,
      };
      const outside = {
        x: target.at.x + Math.cos(angle) * reach * 1.05,
        y: target.at.y + Math.sin(angle) * reach * 1.05,
      };
      expect(targetAt(round, inside), `angle ${angle} inside`).toBe(0);
      expect(targetAt(round, outside), `angle ${angle} outside`).not.toBe(0);
    }
  });

  it('scores what the reducer collected, which is what `Play` reports', () => {
    const state = play(on(1), { type: 'tap', at: nowhere() }, on(2));
    expect(mapDiff.score(round, state.taps)).toEqual({
      correct: 2,
      total: round.targets.length,
      passed: 2 >= Math.ceil(0.75 * round.targets.length),
    });
  });
});
