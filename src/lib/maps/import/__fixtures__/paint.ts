import { CLASS_RGB } from '@/lib/terrain/isom.ts';
import type { RgbaImage } from '../png.ts';

/**
 * A map painted in code, for the raster tier's tests.
 *
 * **No Livelox image is committed.** It is somebody's cartography and this repository has
 * no licence to it — and a synthetic one is the better fixture anyway: it is painted in
 * the app's own ISOM screens, so a mask that comes back wrong is a bug in the classifier
 * rather than a disagreement about what colour a printer used. `AGENTS.md` says generated
 * assets are committed rather than their sources; this is a step further, and generates
 * the asset in the test.
 *
 * It lives beside `tiny.xmap` because it is the same kind of thing: the smallest input
 * that exercises every stage.
 */
export type Rgb = readonly [number, number, number];

export const blank = (width: number, height: number, rgb: Rgb): RgbaImage => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
};

const put = (image: RgbaImage, x: number, y: number, rgb: Rgb): void => {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const i = (y * image.width + x) * 4;
  image.data[i] = rgb[0];
  image.data[i + 1] = rgb[1];
  image.data[i + 2] = rgb[2];
  image.data[i + 3] = 255;
};

export const paint = (
  image: RgbaImage,
  x0: number, y0: number, x1: number, y1: number,
  rgb: Rgb,
): void => {
  for (let y = Math.max(0, y0); y < Math.min(image.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(image.width, x1); x++) put(image, x, y, rgb);
  }
};

export const disc = (image: RgbaImage, cx: number, cy: number, r: number, rgb: Rgb): void => {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) put(image, x, y, rgb);
    }
  }
};

/** Metres per pixel the fixture is drawn at — the floor `raster.ts` refuses below. */
export const FIXTURE_METRES_PER_PIXEL = 0.5;

/**
 * 600 x 600 px at half a metre: a 300 m map, which is the window pexeso and map memory
 * both ask for.
 *
 * What it holds is what those two drills need and nothing else — dots to stand a control
 * on and to move, vegetation and contour ink so a window is not a blank card, a path and
 * a stream so the blob filter has long thin things to refuse. There is no height field
 * and there cannot be one: the brown here is a picture of contour lines, which is exactly
 * why the contours drill declines a map like this.
 */
export function syntheticMap(): RgbaImage {
  const image = blank(600, 600, CLASS_RGB.white);

  // Vegetation, in three of the five screens the mask can tell apart.
  paint(image, 40, 60, 220, 240, CLASS_RGB['green-mid']);
  paint(image, 380, 90, 560, 260, CLASS_RGB.yellow);
  paint(image, 90, 380, 250, 520, CLASS_RGB['green-light']);
  paint(image, 430, 420, 520, 500, CLASS_RGB['green-dark']);
  paint(image, 260, 300, 360, 380, CLASS_RGB['yellow-light']);

  // Contour lines: wavy, three pixels wide, which is the ink a plain majority would erase.
  for (let k = 0; k < 9; k++) {
    for (let x = 10; x < 590; x++) {
      const y = 40 + k * 62 + Math.round(22 * Math.sin(x / 70 + k));
      for (let t = 0; t < 3; t++) put(image, x, y + t, CLASS_RGB.brown);
    }
  }

  // A path and a stream: long, thin, and never blobs.
  for (let x = 20; x < 580; x++) {
    for (let t = 0; t < 3; t++) put(image, x, 300 + t + Math.round(28 * Math.sin(x / 110)), CLASS_RGB.black);
  }
  for (let y = 30; y < 570; y++) {
    for (let t = 0; t < 3; t++) put(image, 470 + t + Math.round(30 * Math.sin(y / 90)), y, CLASS_RGB.blue);
  }

  // Boulders and water holes on a spread grid: the control sites, and the things an edit
  // can move. Thirty-six of them, because pexeso at level 10 wants six pairs and a window
  // score refuses ground with fewer sites than the round needs.
  let n = 0;
  for (let gy = 0; gy < 6; gy++) {
    for (let gx = 0; gx < 6; gx++) {
      const x = 55 + gx * 98 + (gy % 2) * 22;
      const y = 50 + gy * 100;
      disc(image, x, y, 5, ++n % 6 === 0 ? CLASS_RGB.blue : CLASS_RGB.black);
    }
  }
  return image;
}
