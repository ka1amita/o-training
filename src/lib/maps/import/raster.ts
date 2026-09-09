import {
  CLASS_RUNNABILITY, MASK, MASK_CLASSES, looksIsom, nearestClass,
} from '@/lib/terrain/isom.ts';
import type { Feature, RasterLayer, Vec } from '@/lib/terrain/omap.ts';
import type { RgbaImage } from './png.ts';

export type { RgbaImage } from './png.ts';

/**
 * Stage one for an image: pixels into a colour mask, §1.3 and §4.1 of the design note.
 *
 * Everything here is a **pure function over decoded RGBA**, which is the whole reason the
 * stages are split this way: a synthetic image built in a test goes through exactly the
 * code a 40-megapixel Livelox export goes through, and the failures this stage has are
 * the quiet ones — a banner counted as map, a georeference off by half a pixel, a mask
 * whose green is the wrong green.
 *
 * What it does **not** do is vectorise. An image-only map has no features and no heights;
 * it has a mask, and the mask is enough to say where the ground is runnable, where a
 * control could sit, and whether an edit is plausible (§5.3). Contour drills decline it.
 */

/**
 * The coarsest image that is still a map.
 *
 * A pexeso card is a 110 m window (`drills/pexeso/drill.ts`) and a card that cannot be
 * read is not a hard round, it is an unanswerable one. 220 px across is the floor for
 * something a player is asked to recognise, which is 0.5 m per pixel — and the design
 * note picked that number for the same reason before any of this was written. The
 * community downloaders fetch full-resolution tiles, so this refuses the *screenshot*,
 * which is the file people actually have to hand.
 */
export const MIN_METRES_PER_PIXEL = 0.5;

/** Metres per mask cell. One metre: below the smallest symbol, above the noise. */
export const DEFAULT_METRES_PER_CELL = 1;

export interface ClassRaster {
  readonly width: number;
  readonly height: number;
  /** One `MASK` byte per pixel, row-major. */
  readonly classes: Uint8Array;
}

/**
 * Every pixel into the class the cartographer inked it in.
 *
 * Nearest colour in the weighted space `isom.ts` defines, against the screens the app
 * itself paints — so the app can read back its own drawing, which is what makes the
 * synthetic fixture a real test of this stage rather than of a table of constants.
 *
 * Anti-aliased edges land wherever they land here, and are answered by the majority
 * filter in `maskOf` rather than by a cleverer metric: a boulder's edge pixel is halfway
 * between black and white and there is no right answer for it on its own, only for the
 * cell it is part of.
 */
export function classifyColours(image: RgbaImage): ClassRaster {
  const { width, height, data } = image;
  const classes = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const alpha = data[i * 4 + 3]!;
    // Transparent is not white: an export with a transparent margin would otherwise read
    // as runnable forest, and a window scored on it would be a card of nothing.
    if (alpha < 128) {
      classes[i] = MASK.unknown;
      continue;
    }
    classes[i] = nearestClass(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!).klass;
  }
  return { width, height, classes };
}

/**
 * How much a class outvotes white when a mask cell is mixed.
 *
 * A plain majority erases the map. Ink on an ISOM map is *designed* to be a minority of
 * the pixels — a contour is 0.14 mm of paper, which at 1:15000 is two metres of ground
 * and at 0.5 m/px is four pixels of a line crossing a two-pixel cell — so a straight vote
 * gives every cell to white and the mask comes back as an empty field with no relief
 * detail, no paths and no boulders. Ink counts double; white still wins a cell it almost
 * fills.
 */
const INK_VOTE = 2;

export interface Mask {
  readonly mask: Uint8Array;
  readonly maskWidth: number;
  readonly maskHeight: number;
  readonly metresPerCell: number;
}

/** The per-pixel classes down to one class per cell, by weighted majority. */
export function maskOf(
  raster: ClassRaster,
  metresPerPixel: number,
  metresPerCell: number = DEFAULT_METRES_PER_CELL,
): Mask {
  const perCell = Math.max(1, Math.round(metresPerCell / metresPerPixel));
  const maskWidth = Math.max(1, Math.ceil(raster.width / perCell));
  const maskHeight = Math.max(1, Math.ceil(raster.height / perCell));
  const mask = new Uint8Array(maskWidth * maskHeight);
  const votes = new Float64Array(MASK_CLASSES.length);

  for (let cy = 0; cy < maskHeight; cy++) {
    for (let cx = 0; cx < maskWidth; cx++) {
      votes.fill(0);
      const y1 = Math.min(raster.height, (cy + 1) * perCell);
      const x1 = Math.min(raster.width, (cx + 1) * perCell);
      for (let y = cy * perCell; y < y1; y++) {
        for (let x = cx * perCell; x < x1; x++) {
          const klass = raster.classes[y * raster.width + x]!;
          votes[klass] = (votes[klass] ?? 0) +
            (klass === MASK.white || klass === MASK.unknown ? 1 : INK_VOTE);
        }
      }
      let best = MASK.unknown;
      let bestVotes = 0;
      // Ties go to the lower class number, which is a fixed rule and not the array's
      // order of arrival: a mask that depended on iteration order would not survive a
      // re-import, and the bundle's content hash is what the goldens hang on.
      for (let klass = 0; klass < votes.length; klass++) {
        if (votes[klass]! > bestVotes) {
          bestVotes = votes[klass]!;
          best = klass;
        }
      }
      mask[cy * maskWidth + cx] = best;
    }
  }
  return { mask, maskWidth, maskHeight, metresPerCell };
}

// ---------------------------------------------------------------------------------------
// Cropping
// ---------------------------------------------------------------------------------------

/** How coarsely a row's colours are bucketed when looking for its own colour. */
const UNIFORM_BUCKET = 3;
/** How much of a row has to agree for it to be one colour with some writing on it. */
const UNIFORM_SHARE = 0.7;
/** How much of a row has to be white for it to be margin. */
const MARGIN_SHARE = 0.995;
/** A banner is a bar, not the map: refuse to eat more than this fraction of the image. */
const MAX_BANNER = 0.25;

export interface CropReport {
  readonly image: RgbaImage;
  /** Where the kept pixels start in the original, so a georeference stays right. */
  readonly offsetX: number;
  readonly offsetY: number;
  readonly notes: readonly string[];
}

/**
 * The Livelox header off the top, and the white margins off every side.
 *
 * A banner is a run of rows that are **one colour** (some writing on it is allowed) whose
 * colour is **not an ISOM class** — a chrome grey-blue, a brand bar. Both halves matter:
 * a run of one-colour rows that *is* an ISOM class is a lake or a field, and eating it
 * would take the map with it.
 *
 * The offsets come back because the whole point of a georeference is that a pixel knows
 * where it is on the ground. Cropping without reporting the shift moves the map by the
 * height of the banner, which is the kind of error that looks like a slightly wrong map
 * rather than like a bug.
 */
export function cropBanner(image: RgbaImage): CropReport {
  const { width, height } = image;
  const notes: string[] = [];

  let top = 0;
  const limit = Math.floor(height * MAX_BANNER);
  while (top < limit && isBanner(image, top)) top++;
  if (top > 0) notes.push(`banner: ${top} rows off the top`);

  let bottom = height;
  while (bottom > top && isMargin(image, bottom - 1)) bottom--;
  while (top < bottom && isMargin(image, top)) top++;

  let left = 0;
  let right = width;
  while (right > left && isMarginColumn(image, right - 1, top, bottom)) right--;
  while (left < right && isMarginColumn(image, left, top, bottom)) left++;

  if (left > 0 || right < width || bottom < height) {
    notes.push(`margins: ${left} left, ${width - right} right, ${height - bottom} bottom`);
  }
  if (left === 0 && top === 0 && right === width && bottom === height) {
    return { image, offsetX: 0, offsetY: 0, notes };
  }
  return { image: cut(image, left, top, right - left, bottom - top), offsetX: left, offsetY: top, notes };
}

/** Every nth pixel of a row. Sampling, because a 20000-pixel row is not free and a
 *  banner that is uniform is uniform at any stride. */
const stride = (width: number): number => Math.max(1, Math.floor(width / 512));

/**
 * Whether a row is a bar rather than a map.
 *
 * The row's **own** colour is its modal one, not its first pixel: a header carries a
 * title, a logo and a button, its left edge is as likely to be inside the logo as inside
 * the bar, and the first-pixel version of this quietly stopped cropping thirty rows into
 * a hundred-row banner because the writing began there. Bucketed to eight levels a
 * channel, so a gradient bar still agrees with itself.
 *
 * Then both halves of the rule: uniform, **and** a colour no ISOM map is printed in. A
 * run of one-colour rows that is an ISOM colour is a lake or an open field, and cropping
 * it would take the map with it.
 */
function isBanner(image: RgbaImage, y: number): boolean {
  const step = stride(image.width);
  const { data, width } = image;
  const counts = new Map<number, number>();
  let counted = 0;
  for (let x = 0; x < width; x += step) {
    const i = (y * width + x) * 4;
    const key =
      ((data[i]! >> UNIFORM_BUCKET) << 12) |
      ((data[i + 1]! >> UNIFORM_BUCKET) << 6) |
      (data[i + 2]! >> UNIFORM_BUCKET);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    counted++;
  }
  let mode = 0;
  let modeCount = 0;
  for (const [key, count] of counts) {
    if (count > modeCount) {
      modeCount = count;
      mode = key;
    }
  }
  if (modeCount < counted * UNIFORM_SHARE) return false;
  const half = 1 << (UNIFORM_BUCKET - 1);
  return !looksIsom(
    (((mode >> 12) & 63) << UNIFORM_BUCKET) + half,
    (((mode >> 6) & 63) << UNIFORM_BUCKET) + half,
    ((mode & 63) << UNIFORM_BUCKET) + half,
  );
}

const isWhite = (data: Uint8ClampedArray, i: number): boolean =>
  data[i + 3]! < 128 ||
  (data[i]! >= 250 && data[i + 1]! >= 250 && data[i + 2]! >= 250);

function isMargin(image: RgbaImage, y: number): boolean {
  const step = stride(image.width);
  let white = 0;
  let counted = 0;
  for (let x = 0; x < image.width; x += step) {
    counted++;
    if (isWhite(image.data, (y * image.width + x) * 4)) white++;
  }
  return white >= counted * MARGIN_SHARE;
}

function isMarginColumn(image: RgbaImage, x: number, top: number, bottom: number): boolean {
  const step = stride(bottom - top);
  let white = 0;
  let counted = 0;
  for (let y = top; y < bottom; y += step) {
    counted++;
    if (isWhite(image.data, (y * image.width + x) * 4)) white++;
  }
  return white >= counted * MARGIN_SHARE;
}

function cut(image: RgbaImage, x0: number, y0: number, width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((y0 + y) * image.width + x0) * 4;
    data.set(image.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { width, height, data };
}

// ---------------------------------------------------------------------------------------
// Georeferencing
// ---------------------------------------------------------------------------------------

export interface Georeference {
  readonly metresPerPixel: number;
  /** Map metres of the image's top-left corner. Zero unless the image outruns the map. */
  readonly originX: number;
  readonly originY: number;
  /** What the world file said the top-left corner is, in its own CRS. Provenance only. */
  readonly world?: { readonly x: number; readonly y: number };
}

/** How much rotation counts as none. A hundredth of a pixel per pixel is a rounded
 *  world file, not a rotated one. */
const ROTATION_TOLERANCE = 1e-2;

export interface GeoreferenceReport {
  readonly georeference: Georeference;
  readonly notes: readonly string[];
}

/**
 * An ESRI world file — `.pgw`, `.wld` — into metres per pixel and an origin.
 *
 * Six lines: A, D, B, E, C, F. A and E are the pixel size (E negative, because a
 * projected y runs north and an image row runs south), D and B are rotation, and C and F
 * are the **centre** of the top-left pixel — so the corner is half a pixel further out,
 * which is the half-metre nobody notices until a pexeso pair is half a metre apart.
 *
 * Rotation is **refused**, not applied. A rotated raster needs a resample to be square
 * with the map, and every window, crop and mask cell in this app assumes an axis-aligned
 * north-up image; quietly ignoring D and B would put a control a few metres off the thing
 * it is on, which is the kind of wrong that reads as the map being bad.
 */
export function parseWorldFile(text: string): GeoreferenceReport {
  const numbers = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(Number);
  if (numbers.length < 6 || numbers.some((n) => !Number.isFinite(n))) {
    throw new Error('world file: expected six numbers, A D B E C F');
  }
  const [a, d, b, e, c, f] = numbers as [number, number, number, number, number, number];
  const notes: string[] = [];
  const rotation = Math.max(Math.abs(d / a), Math.abs(b / a));
  if (rotation > ROTATION_TOLERANCE) {
    throw new Error(
      `world file: rotated by ${(Math.atan2(d, a) * 180 / Math.PI).toFixed(2)} degrees; ` +
        'rotate the export north-up and try again',
    );
  }
  if (rotation > 0) notes.push(`world file: rotation ${rotation.toExponential(1)}, treated as none`);
  if (Math.abs(Math.abs(e) - a) > a * 1e-3) {
    notes.push(`world file: pixels are ${a} x ${Math.abs(e)} m, using ${a}`);
  }
  return {
    georeference: {
      metresPerPixel: a,
      originX: 0,
      originY: 0,
      world: { x: c - a / 2, y: f - e / 2 },
    },
    notes,
  };
}

// ---------------------------------------------------------------------------------------
// The stage, end to end
// ---------------------------------------------------------------------------------------

export interface RasterInput {
  readonly image: RgbaImage;
  readonly georeference: Georeference;
  /** What the bundle records: a path beside it, or a `data:` URL. */
  readonly reference: string;
  readonly metresPerCell?: number;
  /** Skip the banner and margin crop, for an image that is already exactly the map. */
  readonly keepEdges?: boolean;
}

export interface RasterStage {
  readonly raster: RasterLayer;
  /** The pixels the bundle's image should be, which is not the file that was handed in. */
  readonly image: RgbaImage;
  readonly notes: readonly string[];
}

/** Decoded pixels and a georeference into the layer a bundle carries. */
export function buildRaster(input: RasterInput): RasterStage {
  const geo = input.georeference;
  if (!(geo.metresPerPixel > 0)) throw new Error('raster: no metres per pixel');
  if (geo.metresPerPixel > MIN_METRES_PER_PIXEL + 1e-9) {
    throw new Error(
      `raster: ${geo.metresPerPixel} m per pixel is too coarse. A ${110} m pexeso card ` +
        `needs 220 px, so the floor is ${MIN_METRES_PER_PIXEL} m/px — fetch the ` +
        'full-resolution tiles rather than a screenshot.',
    );
  }

  const cropped = input.keepEdges
    ? { image: input.image, offsetX: 0, offsetY: 0, notes: [] as readonly string[] }
    : cropBanner(input.image);
  const classes = classifyColours(cropped.image);
  const mask = maskOf(classes, geo.metresPerPixel, input.metresPerCell ?? DEFAULT_METRES_PER_CELL);

  const raster: RasterLayer = {
    image: input.reference,
    imageWidth: cropped.image.width,
    imageHeight: cropped.image.height,
    metresPerPixel: geo.metresPerPixel,
    originX: geo.originX,
    originY: geo.originY,
    mask: mask.mask,
    maskWidth: mask.maskWidth,
    maskHeight: mask.maskHeight,
    metresPerCell: mask.metresPerCell,
  };

  return {
    raster,
    image: cropped.image,
    notes: [
      ...cropped.notes,
      `raster: ${cropped.image.width}x${cropped.image.height} px at ${geo.metresPerPixel} m/px ` +
        `= ${(cropped.image.width * geo.metresPerPixel).toFixed(0)} x ` +
        `${(cropped.image.height * geo.metresPerPixel).toFixed(0)} m`,
      `mask: ${mask.maskWidth}x${mask.maskHeight} at ${mask.metresPerCell} m/cell, ` +
        histogram(mask),
    ],
  };
}

function histogram(mask: Mask): string {
  const counts = new Map<string, number>();
  for (const klass of mask.mask) {
    const name = MASK_CLASSES[klass] ?? 'unknown';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ${((count / mask.mask.length) * 100).toFixed(0)}%`)
    .join(' ');
}

// ---------------------------------------------------------------------------------------
// Stage four for an image: what the mask says about the map
// ---------------------------------------------------------------------------------------

/** A blob has to be at least this across to be a symbol rather than a stray pixel. */
const MIN_BLOB_METRES = 1.5;
/** ...and at most this, or it is a building, a lake or a path, not a point feature. */
const MAX_BLOB_METRES = 14;
/** How much of its own bounding box a blob has to fill. A path is long and thin. */
const BLOB_COMPACTNESS = 0.45;
/** How many blobs a bundle carries. More is a longer bundle, not a better map. */
const MAX_BLOBS = 256;

export interface RasterAnalysis {
  readonly controlSites: readonly Vec[];
  readonly moveable: readonly Feature[];
  readonly brown: readonly number[];
  readonly runnability: readonly number[];
}

/**
 * What `analyse.ts` derives from vector features, derived from the mask instead.
 *
 * The design note's §5.3 line for a raster map: pexeso picks a control from a black or
 * blue blob, map memory moves one, and the contours drill declines the map entirely. So
 * the three things wanted here are **control sites**, **things that can move**, and a
 * **cover raster** — the same inputs `scoreWindow` already takes, so one window scorer
 * serves both kinds of map.
 *
 * A blob is a connected run of one class that is small, compact and isolated: a boulder
 * dot, a knoll's own dot, a water hole. A path is long and thin, a building is large, a
 * contour is longer still — all three fail the same two tests, which is why this is a
 * shape filter and not a symbol recogniser. Getting a marsh or a crag out of pixels is
 * vectorisation, and vectorisation is an offline job with different tools (§1.3).
 *
 * Brown density is the relief-detail proxy: a raster map has no heights, so the only
 * thing the mask can say about relief is how much contour ink is here. Nothing may treat
 * it as a height field — `relief` stays `none` and the contours drill still declines.
 */
export function rasterAnalysis(raster: RasterLayer, size: number, cells: number): RasterAnalysis {
  const blobs = blobsOf(raster);
  const runnability = new Array<number>(cells * cells).fill(1);
  const brown = new Array<number>(cells * cells).fill(0);
  const step = size / cells;

  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      let total = 0;
      let counted = 0;
      let brownCells = 0;
      const x0 = Math.floor((i * step - raster.originX) / raster.metresPerCell);
      const x1 = Math.ceil(((i + 1) * step - raster.originX) / raster.metresPerCell);
      const y0 = Math.floor((j * step - raster.originY) / raster.metresPerCell);
      const y1 = Math.ceil(((j + 1) * step - raster.originY) / raster.metresPerCell);
      for (let y = Math.max(0, y0); y < Math.min(raster.maskHeight, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(raster.maskWidth, x1); x++) {
          const klass = MASK_CLASSES[raster.mask[y * raster.maskWidth + x]!] ?? 'unknown';
          total += CLASS_RUNNABILITY[klass];
          if (klass === 'brown') brownCells++;
          counted++;
        }
      }
      // A cell the image does not cover keeps the neutral 1: it is padding, and padding
      // scores nothing anyway because it holds no blobs.
      if (counted > 0) {
        runnability[j * cells + i] = total / counted;
        brown[j * cells + i] = brownCells / counted;
      }
    }
  }

  return {
    controlSites: blobs.map((b) => positionOfBlob(b)),
    moveable: blobs.map((blob, index): Feature => ({
      id: `blob-${index}`,
      code: blob.klass === MASK.blue ? '312' : '206',
      geometry: { kind: 'point', at: positionOfBlob(blob) },
      size: blob.radius,
    })),
    brown,
    runnability,
  };
}

interface Blob {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly klass: number;
  readonly area: number;
}

const positionOfBlob = (blob: Blob): Vec => ({ x: blob.x, y: blob.y });

/**
 * Connected components of black and blue, filtered to the ones shaped like a symbol.
 *
 * Flood filled with an explicit stack rather than recursion: a lake is tens of thousands
 * of cells and a recursive fill over it is a stack overflow at import time, on a map that
 * is otherwise fine.
 */
function blobsOf(raster: RasterLayer): Blob[] {
  const { mask, maskWidth: w, maskHeight: h, metresPerCell: m } = raster;
  const seen = new Uint8Array(mask.length);
  const found: Blob[] = [];
  const stack: number[] = [];
  const minCells = Math.max(1, Math.round((MIN_BLOB_METRES / m) ** 2 * 0.5));
  const maxSide = MAX_BLOB_METRES / m;

  for (let start = 0; start < mask.length; start++) {
    const klass = mask[start]!;
    if (seen[start] || (klass !== MASK.black && klass !== MASK.blue)) continue;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    while (stack.length > 0) {
      const at = stack.pop()!;
      const x = at % w;
      const y = (at - x) / w;
      area++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      // Four-connected: eight would join two boulders that touch at a corner into one
      // blob halfway between them, which is a control site on nothing.
      if (x > 0 && !seen[at - 1] && mask[at - 1] === klass) { seen[at - 1] = 1; stack.push(at - 1); }
      if (x + 1 < w && !seen[at + 1] && mask[at + 1] === klass) { seen[at + 1] = 1; stack.push(at + 1); }
      if (y > 0 && !seen[at - w] && mask[at - w] === klass) { seen[at - w] = 1; stack.push(at - w); }
      if (y + 1 < h && !seen[at + w] && mask[at + w] === klass) { seen[at + w] = 1; stack.push(at + w); }
    }
    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    if (area < minCells) continue;
    if (boxWidth > maxSide || boxHeight > maxSide) continue;
    if (area < BLOB_COMPACTNESS * boxWidth * boxHeight) continue;
    found.push({
      // Cell centres, in map metres: the mask is a grid of cells and a blob's centroid is
      // the middle of the cells it covers, not their top-left corners.
      x: raster.originX + ((sumX / area) + 0.5) * m,
      y: raster.originY + ((sumY / area) + 0.5) * m,
      radius: Math.sqrt(area / Math.PI) * m,
      klass,
      area,
    });
  }

  // Biggest first, ties by position: a re-import has to give the same list in the same
  // order or every window and every golden over this bundle moves.
  found.sort((a, b) => b.area - a.area || a.y - b.y || a.x - b.x);
  return found.slice(0, MAX_BLOBS);
}
