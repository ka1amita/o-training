import type { Vec } from '@/lib/terrain/omap.ts';
import type { MapDiffAnswer, MapDiffRound } from './drill.ts';

/**
 * Tap rules, as a reducer — where every drill here keeps them, and for the same reason:
 * a rule that lives in the component reads stale state when two taps land before a
 * re-render, and cannot be tested without a DOM.
 *
 * The whole of this drill's geometry is `targetAt`, and it is a rule about **map
 * coordinates**. `Play` turns a pointer into metres of ground and nothing else; what
 * counts as finding a change is decided here, against the discs the round carries. No
 * pixel is read on either side of that line.
 */
export interface MapDiffState {
  /** In the order they were made. `Play` reports these as the round's answers. */
  readonly taps: readonly MapDiffAnswer[];
  readonly done: boolean;
}

export type MapDiffEvent =
  /** Where the player tapped, in metres of ground. */
  | { readonly type: 'tap'; readonly at: Vec }
  /** The "Done" control: everything findable has been found. */
  | { readonly type: 'give-up' }
  /** The clock ran out. `Play` owns the clock; the rule about what it means is here. */
  | { readonly type: 'timeout' };

export const initialState: MapDiffState = { taps: [], done: false };

/**
 * Which change a tap finds, or null for a tap on ground that did not change.
 *
 * A tap counts inside a target's own disc widened by the round's tolerance. `wellFormed`
 * guarantees no two of those widened discs meet, so at most one target can contain a tap
 * — this is the drill's form of the rule the whole app is built on, that **a round has
 * exactly one interpretation of an answer**. The nearest is taken anyway, because a
 * tie-break that cannot happen is cheaper to write than a comment explaining why it
 * cannot, and because it is what makes the rule survive a round that is malformed.
 */
export function targetAt(round: MapDiffRound, at: Vec): number | null {
  let found: number | null = null;
  let nearest = Infinity;
  round.targets.forEach((target, index) => {
    const gap = Math.hypot(target.at.x - at.x, target.at.y - at.y) - target.radius;
    if (gap <= round.tolerance && gap < nearest) {
      nearest = gap;
      found = index;
    }
  });
  return found;
}

/** How many distinct changes have been found so far. */
export const foundIn = (state: MapDiffState): number =>
  new Set(state.taps.map((t) => t.target).filter((t) => t !== null)).size;

/**
 * The round has as many taps as it has changes, and it ends when they are spent.
 *
 * That is the whole of the scoring pressure: nothing is marked as it goes, so a player
 * cannot probe, and a tapper with no idea where to look scores what chance gives them —
 * measured at about a tenth of a round at level 10, which is what makes the score a
 * measurement rather than a lottery.
 */
export function mapDiffReduce(
  round: MapDiffRound,
  state: MapDiffState,
  event: MapDiffEvent,
): MapDiffState {
  if (state.done) return state;

  switch (event.type) {
    case 'give-up':
    case 'timeout':
      return { ...state, done: true };

    case 'tap': {
      const target = targetAt(round, event.at);
      // A second tap on a change already found is not a second answer and must not cost a
      // tap: a finger that lands twice, or a player confirming what they saw, would
      // otherwise end the round with a change unlooked for. The same rule Mapova
      // dohledavka keeps about tapping one wrong kind twice.
      if (target !== null && state.taps.some((t) => t.target === target)) return state;

      const taps = [...state.taps, { at: event.at, target }];
      return { taps, done: taps.length >= round.targets.length };
    }
  }
}
