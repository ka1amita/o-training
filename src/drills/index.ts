import { matchMadness } from './matchMadness/drill.ts';
import type { AnyDrill } from './types.ts';

/**
 * The drill registry. Adding a drill is one import and one entry here — nothing else in
 * the app enumerates drills.
 */
export const DRILLS: readonly AnyDrill[] = [matchMadness];

export function drillById(id: string): AnyDrill | undefined {
  return DRILLS.find((d) => d.id === id);
}
