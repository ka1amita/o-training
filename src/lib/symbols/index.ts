import { SYMBOLS, type SymbolCategory, type SymbolDef } from './data.ts';

export { SYMBOLS };
export type { SymbolCategory, SymbolDef };

export const CATEGORIES: readonly SymbolCategory[] = [
  'landform',
  'rock',
  'water',
  'vegetation',
  'man-made',
];

const byId = new Map(SYMBOLS.map((s) => [s.id, s]));

export function symbolById(id: string): SymbolDef | undefined {
  return byId.get(id);
}

export function symbolsIn(category: SymbolCategory): readonly SymbolDef[] {
  return SYMBOLS.filter((s) => s.category === category);
}

/** The smallest category, which bounds how many symbols a same-category round may ask for. */
export const SMALLEST_CATEGORY = Math.min(...CATEGORIES.map((c) => symbolsIn(c).length));
