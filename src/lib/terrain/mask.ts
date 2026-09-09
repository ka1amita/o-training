import { MASK, MASK_CLASSES, type ColourClass } from './isom.ts';
import type { RasterLayer, Vec } from './omap.ts';
import { warpDisplacement, type Warp } from './relief.ts';
import { semanticsOf, type IsomCode } from './semantics.ts';

/**
 * Reading a raster map's colour mask.
 *
 * The mask is what an image-only map has instead of features: `suits(code, ground, p)`
 * asks a height field whether a symbol belongs where it now is, and `suitsOnMask` asks
 * the same question of the ink. Same question, two backends — §3.3 of the design note —
 * and `siblings` uses whichever the map offers.
 *
 * This module is the only thing that turns mask bytes into meaning, so that the byte
 * numbering stays an implementation detail of `isom.ts` and nothing else counts cells.
 */

/**
 * How far around a point the mask is read, in metres.
 *
 * The same ten metres `semantics.ts` probes a height field over, and for the same reason:
 * what is wanted is the claim that survives a feature being moved a few tens of metres —
 * that the ground still agrees with the symbol — not the class of the one cell under it,
 * which on a map full of ink is as likely to be a contour line as the ground it crosses.
 */
const REACH = 10;

/** Above this share of contour ink, the ground here is steep enough to argue with. */
const BROWN_STEEP = 0.22;

/**
 * The class at a point in map metres, or `unknown` off the image.
 *
 * Warps are applied **here**, on the way in, rather than by rewriting the mask: a point is
 * carried back through each warp's inverse displacement and then looked up in the mask the
 * pipeline wrote. The renderer resamples the picture by exactly the same chain, so the two
 * agree by construction rather than by two implementations agreeing.
 *
 * The alternative — displacing the whole mask inside `applyEdits` — copies four million
 * cells for a two-kilometre map, thirty-six times per round, to answer questions about a
 * few dozen points. `siblings` calls `difference` (and so `applyEdits`) on every attempt.
 */
export function classAt(raster: RasterLayer, x: number, y: number): ColourClass {
  let px = x;
  let py = y;
  for (const warp of raster.warps ?? []) {
    const d = warpDisplacement(warp, px, py);
    px -= d.x;
    py -= d.y;
  }
  const i = Math.floor((px - raster.originX) / raster.metresPerCell);
  const j = Math.floor((py - raster.originY) / raster.metresPerCell);
  if (i < 0 || j < 0 || i >= raster.maskWidth || j >= raster.maskHeight) return 'unknown';
  return MASK_CLASSES[raster.mask[j * raster.maskWidth + i]!] ?? 'unknown';
}

/** What each class covers in a disc, as shares that sum to one. */
export function classesAround(
  raster: RasterLayer,
  p: Vec,
  reach: number = REACH,
): Readonly<Record<ColourClass, number>> {
  const counts = Object.fromEntries(MASK_CLASSES.map((c) => [c, 0])) as Record<ColourClass, number>;
  const step = raster.metresPerCell;
  let total = 0;
  for (let y = p.y - reach; y <= p.y + reach; y += step) {
    for (let x = p.x - reach; x <= p.x + reach; x += step) {
      if ((x - p.x) ** 2 + (y - p.y) ** 2 > reach * reach) continue;
      counts[classAt(raster, x, y)]++;
      total++;
    }
  }
  if (total > 0) for (const c of MASK_CLASSES) counts[c] /= total;
  return counts;
}

/**
 * The class a patch over this spot should be painted in.
 *
 * The ground *around* the thing, not under it: what is wanted is what the surveyor would
 * have drawn had the boulder never been there, and under the boulder is the boulder. Ink
 * classes are skipped for the same reason — a contour line crossing the ring is not the
 * ground either — and white forest is the fallback, which is the one thing on an O map
 * that means "nothing here".
 */
export function surroundOf(raster: RasterLayer, p: Vec, radius: number): number {
  const shares = classesAround(raster, p, Math.max(radius * 2.5, REACH));
  let best: ColourClass = 'white';
  let bestShare = 0;
  for (const klass of MASK_CLASSES) {
    if (klass === 'black' || klass === 'brown' || klass === 'purple' || klass === 'unknown') continue;
    if (shares[klass] > bestShare) {
      bestShare = shares[klass];
      best = klass;
    }
  }
  return MASK[best];
}

/**
 * Whether the ink at `p` agrees with the symbol — `suits`, backed by a mask.
 *
 * Deliberately a short list of contradictions rather than a list of preferences. A height
 * field can say "the flattest quarter of this map", which is a real claim about a real
 * surface; a mask can only say what is drawn here, and inventing preferences out of that
 * would reject most of a real map's ground for symbols that are perfectly at home on it.
 * So: nothing but water stands in water, nothing stands on a building or a road, and a
 * water feature does not go where the contours are crowded — a marsh on a steep hillside
 * being the example §3.3 names, and dense brown being the only word a mask has for steep.
 */
export function suitsOnMask(code: IsomCode, raster: RasterLayer, p: Vec): boolean {
  const family = semanticsOf(code)?.family;
  const shares = classesAround(raster, p);
  const here = classAt(raster, p.x, p.y);
  if (here === 'unknown') return true;
  if (shares.blue > 0.35) return family === 'water';
  if (shares.black > 0.5) return false;
  if (family === 'water') return shares.brown < BROWN_STEEP;
  return true;
}

/**
 * The layer, through a warp.
 *
 * The warp is **recorded, not applied**: the mask stays what the pipeline wrote and every
 * reader goes through `classAt`, which carries its point back through this list. The
 * renderer does the same to the pixels. One definition of the displacement — the compact
 * bump in `relief.ts` — reaching the ground, the features, the mask and the picture, which
 * is the whole reason a warp is one operation rather than four.
 */
export const warpRaster = (raster: RasterLayer, w: Warp): RasterLayer =>
  ({ ...raster, warps: [...(raster.warps ?? []), w] });
