import { contours } from './contours/drill.ts';
import { dohledavka } from './dohledavka/drill.ts';
import { mapDohledavka } from './mapDohledavka/drill.ts';
import { mapMemory } from './mapMemory/drill.ts';
import { matchMadness } from './matchMadness/drill.ts';
import { pexeso } from './pexeso/drill.ts';
import type { AnyDrill } from './types.ts';

/**
 * The drill registry. Adding a drill is one import and one entry here — nothing else in
 * the app enumerates drills.
 */
export const DRILLS: readonly AnyDrill[] = [
  matchMadness,
  dohledavka,
  mapDohledavka,
  pexeso,
  contours,
  mapMemory,
];

export function drillById(id: string): AnyDrill | undefined {
  return DRILLS.find((d) => d.id === id);
}
