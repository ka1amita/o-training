/**
 * A 3-down-1-up transformed staircase: three consecutive correct answers raise the
 * level, a single miss lowers it.
 *
 * The rule is worth preferring over a hand-tuned difficulty curve because its
 * convergence point is a property of the rule rather than a guess — it settles where
 * the player is right about 79% of the time, which is hard enough to be work and easy
 * enough to stay bearable. Nothing here needs tuning per drill; only the bounds differ.
 */
export interface StaircaseState {
  readonly level: number;
  /** Correct answers since the last miss or the last level change. */
  readonly runOfCorrect: number;
}

export interface StaircaseBounds {
  readonly min: number;
  readonly max: number;
}

/** How many consecutive correct answers it takes to move up. */
export const RUN_TO_ADVANCE = 3;

export function initial(bounds: StaircaseBounds, level = bounds.min): StaircaseState {
  return { level: clamp(level, bounds), runOfCorrect: 0 };
}

export function advance(
  state: StaircaseState,
  correct: boolean,
  bounds: StaircaseBounds,
): StaircaseState {
  if (!correct) {
    // Down on the first miss, and the run resets whether or not the level could move.
    return { level: clamp(state.level - 1, bounds), runOfCorrect: 0 };
  }
  const run = state.runOfCorrect + 1;
  if (run < RUN_TO_ADVANCE) return { level: state.level, runOfCorrect: run };
  // The run resets on advancing, so a streak of six is two steps and not four.
  return { level: clamp(state.level + 1, bounds), runOfCorrect: 0 };
}

function clamp(level: number, { min, max }: StaircaseBounds): number {
  return Math.min(max, Math.max(min, level));
}
