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

/** The class at a point in map metres, or `unknown` off the image. */
export function classAt(raster: RasterLayer, x: number, y: number): ColourClass {
  const i = Math.floor((x - raster.originX) / raster.metresPerCell);
  const j = Math.floor((y - raster.originY) / raster.metresPerCell);
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
 * The mask, displaced through a warp.
 *
 * Sampled through the **inverse** displacement, exactly as `GridRelief.warped` resamples
 * a DEM: for each cell of the result, ask which cell of the original moved here. Applying
 * the forward field instead leaves holes wherever the field stretches, which on a mask is
 * a scatter of `unknown` through the middle of the moved ground.
 *
 * The pixels are not touched here — they are displaced at render time, from `warps` — but
 * the mask is, because everything that *reasons* about a raster map reads the mask, and a
 * mask that disagreed with the picture would make an edit plausible on ground that is no
 * longer under it.
 */
export function warpRaster(raster: RasterLayer, w: Warp): RasterLayer {
  const { maskWidth, maskHeight, metresPerCell: m } = raster;
  const mask = new Uint8Array(raster.mask.length);
  for (let j = 0; j < maskHeight; j++) {
    for (let i = 0; i < maskWidth; i++) {
      const x = raster.originX + (i + 0.5) * m;
      const y = raster.originY + (j + 0.5) * m;
      const d = warpDisplacement(w, x, y);
      if (d.x === 0 && d.y === 0) {
        mask[j * maskWidth + i] = raster.mask[j * maskWidth + i]!;
        continue;
      }
      const si = Math.floor((x - d.x - raster.originX) / m);
      const sj = Math.floor((y - d.y - raster.originY) / m);
      mask[j * maskWidth + i] =
        si < 0 || sj < 0 || si >= maskWidth || sj >= maskHeight
          ? MASK.unknown
          : raster.mask[sj * maskWidth + si]!;
    }
  }
  return { ...raster, mask, warps: [...(raster.warps ?? []), w] };
}
