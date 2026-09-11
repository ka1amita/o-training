import { describe, it, expect } from 'vitest';
import { deflateSync, inflateSync } from 'node:zlib';
import { CLASS_RGB, MASK, MASK_CLASSES, looksIsom, nearestClass } from '@/lib/terrain/isom.ts';
import { classAt, suitsOnMask, warpRaster } from '@/lib/terrain/mask.ts';
import type { RasterLayer } from '@/lib/terrain/omap.ts';
import { loadBundle, saveBundle, type MapBundle } from '../bundle.ts';
import { blank, disc, paint } from './__fixtures__/paint.ts';
import { decodePng, encodePng } from './png.ts';
import {
  buildRaster, classifyColours, cropBanner, maskOf, parseWorldFile, rasterAnalysis,
  MIN_METRES_PER_PIXEL,
} from './raster.ts';

/**
 * The raster tier, from pixels to a mask.
 *
 * Every stage here is pure over decoded RGBA, which is what lets a synthetic image built
 * in twenty lines go through exactly the code a Livelox export goes through. No Livelox
 * image is committed — it is somebody's cartography and this repository has no licence to
 * it — and the synthetic one is a better test anyway: it is painted in the app's *own*
 * ISOM screens, so a mask that comes back wrong is a bug in the classifier rather than a
 * disagreement about what colour a printer used.
 */

const inflate = (data: Uint8Array): Uint8Array => new Uint8Array(inflateSync(data));
const deflate = (data: Uint8Array): Uint8Array => new Uint8Array(deflateSync(data));

describe('png', () => {
  it('round-trips pixels through a real deflate', () => {
    const image = blank(37, 21, CLASS_RGB.white);
    paint(image, 4, 4, 12, 9, CLASS_RGB.brown);
    disc(image, 20, 12, 5, CLASS_RGB['green-mid']);
    const back = decodePng(encodePng(image, deflate), inflate);
    expect(back.width).toBe(37);
    expect(back.height).toBe(21);
    // Byte for byte on the colours; alpha comes back opaque because the writer drops it.
    for (let i = 0; i < image.width * image.height; i++) {
      expect([back.data[i * 4], back.data[i * 4 + 1], back.data[i * 4 + 2]]).toEqual(
        [image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]],
      );
    }
  });

  it('undoes every row filter, not only the one it writes', () => {
    // The writer uses filter 0, so a round trip would never exercise Sub, Up, Average or
    // Paeth — and Paeth is the one whose `bpp` is easy to get wrong. So: encode by hand,
    // one row per filter, over a gradient that makes each filter's prediction differ.
    const width = 8;
    const height = 5;
    const stride = width * 3;
    const pixels = new Uint8Array(stride * height);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7 + 3) & 0xff;

    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      const filter = y; // 0..4, one of each
      raw[y * (stride + 1)] = filter;
      for (let i = 0; i < stride; i++) {
        const x = pixels[y * stride + i]!;
        const a = i >= 3 ? pixels[y * stride + i - 3]! : 0;
        const b = y > 0 ? pixels[(y - 1) * stride + i]! : 0;
        const c = y > 0 && i >= 3 ? pixels[(y - 1) * stride + i - 3]! : 0;
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        const predicted = [0, a, b, (a + b) >> 1, paeth][filter]!;
        raw[y * (stride + 1) + 1 + i] = (x - predicted) & 0xff;
      }
    }
    const png = handmadePng(width, height, raw, deflate);
    const back = decodePng(png, inflate);
    for (let i = 0; i < width * height; i++) {
      expect([back.data[i * 4], back.data[i * 4 + 1], back.data[i * 4 + 2]], `pixel ${i}`)
        .toEqual([pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2]]);
    }
  });

  it('refuses what it cannot decode by name rather than decoding it wrongly', () => {
    expect(() => decodePng(new Uint8Array(64), inflate)).toThrow(/not a PNG/);
    const image = encodePng(blank(4, 4, CLASS_RGB.white), deflate);
    const sixteenBit = Uint8Array.from(image);
    sixteenBit[24] = 16; // IHDR bit depth
    expect(() => decodePng(sixteenBit, inflate)).toThrow(/16-bit/);
    const interlaced = Uint8Array.from(image);
    interlaced[28] = 1; // IHDR interlace method
    expect(() => decodePng(interlaced, inflate)).toThrow(/interlaced/);
  });
});

/** An RGB PNG around already-filtered rows, for the filter test above. */
function handmadePng(
  width: number,
  height: number,
  raw: Uint8Array,
  compress: (data: Uint8Array) => Uint8Array,
): Uint8Array {
  // Reuse the writer for the framing, then swap its single IDAT for our own rows: the
  // chunk layout and the CRCs are the writer's business and are not what is under test.
  const shell = encodePng({ width, height, data: new Uint8ClampedArray(width * height * 4) }, compress);
  const body = compress(raw);
  const out = new Uint8Array(shell.length + body.length);
  // 8 signature + 25 IHDR is where IDAT starts; keep the tail (IEND) as it is.
  const idatStart = 8 + 25;
  const idatLength = new DataView(shell.buffer, shell.byteOffset).getUint32(idatStart, false);
  out.set(shell.subarray(0, idatStart), 0);
  const chunk = new Uint8Array(body.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.length, false);
  chunk.set([0x49, 0x44, 0x41, 0x54], 4);
  chunk.set(body, 8);
  // CRC, the same polynomial the writer uses.
  let c = 0xffffffff;
  for (const byte of chunk.subarray(4, chunk.length - 4)) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  view.setUint32(chunk.length - 4, (c ^ 0xffffffff) >>> 0, false);
  out.set(chunk, idatStart);
  const tail = shell.subarray(idatStart + 12 + idatLength);
  out.set(tail, idatStart + chunk.length);
  return out.subarray(0, idatStart + chunk.length + tail.length);
}

describe('colour classes', () => {
  it('puts every screen the renderer paints back into its own class', () => {
    // The property that makes the whole tier work: the app can read back its own drawing.
    for (const name of MASK_CLASSES) {
      if (name === 'unknown') continue;
      const [r, g, b] = CLASS_RGB[name];
      expect(MASK_CLASSES[nearestClass(r, g, b).klass], name).toBe(name);
    }
  });

  it('tells the three greens apart, which is the whole of reading a green', () => {
    for (const name of ['green-light', 'green-mid', 'green-dark'] as const) {
      const [r, g, b] = CLASS_RGB[name];
      // Nudged by a printer's worth of drift, they still land on themselves.
      expect(MASK_CLASSES[nearestClass(r + 6, g - 5, b + 4).klass], name).toBe(name);
    }
  });

  it('knows a chrome bar is not an ISOM colour', () => {
    expect(looksIsom(...CLASS_RGB.brown)).toBe(true);
    expect(looksIsom(...CLASS_RGB['green-dark'])).toBe(true);
    // The Livelox header: a dark slate blue-grey that is near nothing on a map.
    expect(looksIsom(38, 50, 66)).toBe(false);
    expect(looksIsom(120, 20, 160)).toBe(false);
  });
});

describe('classifyColours and the mask', () => {
  it('keeps a thin line that a plain majority would erase', () => {
    // Ink on an O map is a minority of the pixels by design. A contour two metres wide
    // over one-metre cells is two pixels of four, and a straight vote loses every one of
    // them — which is a mask with no relief detail and no paths on a map full of both.
    const image = blank(40, 40, CLASS_RGB.white);
    paint(image, 0, 18, 40, 20, CLASS_RGB.brown);
    const mask = maskOf(classifyColours(image), 0.5, 1);
    expect(mask.maskWidth).toBe(20);
    const row = 9;
    const brown = [...mask.mask.subarray(row * 20, row * 20 + 20)]
      .filter((c) => c === MASK.brown).length;
    expect(brown).toBe(20);
  });

  it('reads a transparent margin as unknown rather than as white forest', () => {
    const image = blank(8, 8, CLASS_RGB.white);
    for (let i = 0; i < 8; i++) image.data[i * 4 + 3] = 0;
    expect(classifyColours(image).classes[0]).toBe(MASK.unknown);
    expect(classifyColours(image).classes[8]).toBe(MASK.white);
  });
});

describe('cropBanner', () => {
  it('takes the header off the top and reports how far it moved the map', () => {
    const image = blank(60, 50, CLASS_RGB.white);
    paint(image, 0, 0, 60, 8, [38, 50, 66]);
    // Writing on the banner: a run of rows is still one colour with some text on it.
    paint(image, 4, 2, 9, 5, [255, 255, 255]);
    disc(image, 30, 30, 6, CLASS_RGB.black);
    const cropped = cropBanner(image);
    // Eight rows of banner, then the white between it and the map: both are margin, and
    // the offset has to carry both or the georeference is off by the difference.
    expect(cropped.notes.join(' ')).toMatch(/banner: 8 rows/);
    expect(cropped.offsetY).toBe(24);
    expect(cropped.offsetX).toBe(24);
    expect(cropped.image.width).toBe(13);
    expect(cropped.image.height).toBe(13);
  });

  it('does not eat a lake, which is also a run of one-colour rows', () => {
    // Both halves of the rule matter: uniform *and* not an ISOM colour. A map that opens
    // on water would otherwise lose its first hundred metres.
    const image = blank(60, 50, CLASS_RGB.blue);
    paint(image, 0, 30, 60, 50, CLASS_RGB.white);
    disc(image, 30, 40, 5, CLASS_RGB.black);
    expect(cropBanner(image).offsetY).toBe(0);
  });

  it('trims white margins on every side', () => {
    const image = blank(60, 60, CLASS_RGB.white);
    paint(image, 10, 12, 50, 44, CLASS_RGB['green-mid']);
    const cropped = cropBanner(image);
    expect(cropped.offsetX).toBe(10);
    expect(cropped.offsetY).toBe(12);
    expect(cropped.image.width).toBe(40);
    expect(cropped.image.height).toBe(32);
  });
});

describe('parseWorldFile', () => {
  const world = (rotation = 0) => `0.5\n${rotation}\n${rotation}\n-0.5\n400000.25\n5500000.75\n`;

  it('reads the pixel size and the corner, not the pixel centre', () => {
    const { georeference } = parseWorldFile(world());
    expect(georeference.metresPerPixel).toBe(0.5);
    // C and F name the centre of the top-left pixel, so the corner is half a pixel out.
    expect(georeference.world).toEqual({ x: 400000, y: 5500001 });
  });

  it('refuses a rotated world file rather than ignoring the rotation', () => {
    expect(() => parseWorldFile(world(0.2))).toThrow(/rotated/);
    // ...but a rounded one is not a rotated one.
    expect(parseWorldFile(world(1e-6)).notes.join(' ')).toMatch(/treated as none/);
  });

  it('says what it wanted when the file is not one', () => {
    expect(() => parseWorldFile('0.5\n0\n0\n')).toThrow(/six numbers/);
  });
});

describe('buildRaster', () => {
  const image = blank(200, 200, CLASS_RGB.white);

  it('refuses an image too coarse to be a pexeso card', () => {
    // §1.3: a 110 m card needs 220 px. Anything coarser is a screenshot, not a map.
    expect(() =>
      buildRaster({
        image,
        georeference: { metresPerPixel: 2, originX: 0, originY: 0 },
        reference: 'x.png',
      }),
    ).toThrow(/too coarse/);
    expect(MIN_METRES_PER_PIXEL).toBe(0.5);
  });

  it('carries the mask, its scale and where the picture sits', () => {
    const built = buildRaster({
      image,
      georeference: { metresPerPixel: 0.5, originX: 10, originY: 20 },
      reference: 'x.png',
      keepEdges: true,
    });
    expect(built.raster.mask.length).toBe(built.raster.maskWidth * built.raster.maskHeight);
    expect(built.raster.maskWidth).toBe(100);
    expect(built.raster.metresPerCell).toBe(1);
    expect(built.raster.originX).toBe(10);
    expect(built.notes.join(' ')).toMatch(/100 x 100 m/);
  });
});

describe('rasterAnalysis', () => {
  /** A 100 m square with four boulders, a pond, a path and a lake. */
  const layer = (): RasterLayer => {
    const image = blank(200, 200, CLASS_RGB.white);
    for (const [x, y] of [[40, 40], [150, 40], [40, 150], [150, 150]]) {
      disc(image, x!, y!, 5, CLASS_RGB.black);
    }
    disc(image, 100, 140, 4, CLASS_RGB.blue);
    paint(image, 160, 160, 200, 200, CLASS_RGB.blue);
    paint(image, 10, 10, 30, 190, CLASS_RGB['green-dark']);
    // The path last, so it is one line across the map rather than two stubs either side
    // of the green — two short stubs are exactly the shape a blob is, and finding one is
    // the filter working, not failing.
    paint(image, 0, 96, 200, 100, CLASS_RGB.black);
    return buildRaster({
      image,
      georeference: { metresPerPixel: 0.5, originX: 0, originY: 0 },
      reference: 'x.png',
      keepEdges: true,
    }).raster;
  };

  it('finds the dots and refuses the path and the lake', () => {
    const analysis = rasterAnalysis(layer(), 100, 48);
    expect(analysis.moveable).toHaveLength(5);
    expect(analysis.moveable.filter((f) => f.code === '204')).toHaveLength(4);
    expect(analysis.moveable.filter((f) => f.code === '311')).toHaveLength(1);
    // A blob is at the middle of the dot it came from, in metres.
    const pond = analysis.moveable.find((f) => f.code === '311')!;
    expect(pond.geometry.kind === 'point' && pond.geometry.at.x).toBeCloseTo(50, 0);
    expect(pond.geometry.kind === 'point' && pond.geometry.at.y).toBeCloseTo(70, 0);
    expect(analysis.controlSites).toHaveLength(5);
  });

  it('reads the green as ground you cannot run through', () => {
    const analysis = rasterAnalysis(layer(), 100, 48);
    const at = (x: number, y: number) =>
      analysis.runnability[Math.floor((y / 100) * 48) * 48 + Math.floor((x / 100) * 48)]!;
    expect(at(10, 50)).toBeLessThan(0.4);
    expect(at(70, 30)).toBe(1);
  });

  it('is deterministic, so a re-import gives the same blobs in the same order', () => {
    const once = rasterAnalysis(layer(), 100, 48).moveable.map((f) => f.id + JSON.stringify(f.geometry));
    const again = rasterAnalysis(layer(), 100, 48).moveable.map((f) => f.id + JSON.stringify(f.geometry));
    expect(once).toEqual(again);
  });
});

describe('reading the mask at runtime', () => {
  const raster = buildRaster({
    image: (() => {
      const image = blank(200, 200, CLASS_RGB.white);
      paint(image, 0, 0, 100, 200, CLASS_RGB.blue);
      paint(image, 100, 0, 200, 100, CLASS_RGB.yellow);
      for (let y = 100; y < 200; y += 6) paint(image, 100, y, 200, y + 3, CLASS_RGB.brown);
      return image;
    })(),
    georeference: { metresPerPixel: 0.5, originX: 0, originY: 0 },
    reference: 'x.png',
    keepEdges: true,
  }).raster;

  it('knows where it is and where it is not', () => {
    expect(classAt(raster, 20, 20)).toBe('blue');
    expect(classAt(raster, 70, 20)).toBe('yellow');
    expect(classAt(raster, -5, 20)).toBe('unknown');
    expect(classAt(raster, 500, 20)).toBe('unknown');
  });

  it('is the plausibility check a map with no height field gets', () => {
    // §3.3: same question, two backends. A boulder on the open yellow is fine, a boulder
    // in the lake is not, and a marsh where the contours are crowded is not.
    expect(suitsOnMask('204', raster, { x: 70, y: 20 })).toBe(true);
    expect(suitsOnMask('204', raster, { x: 20, y: 20 })).toBe(false);
    expect(suitsOnMask('310', raster, { x: 70, y: 70 })).toBe(false);
    expect(suitsOnMask('310', raster, { x: 20, y: 20 })).toBe(true);
    // Off the picture nothing is claimed, so nothing is refused.
    expect(suitsOnMask('310', raster, { x: 500, y: 500 })).toBe(true);
  });

  it('displaces the mask through the same bump the relief uses', () => {
    const warped = warpRaster(raster, { centre: { x: 70, y: 20 }, radius: 30, dx: 25, dy: 0 });
    expect(warped.warps).toHaveLength(1);
    // The centre of the support has moved a full 25 m: what was blue at 45 is now here.
    expect(classAt(raster, 45, 20)).toBe('blue');
    expect(classAt(warped, 70, 20)).toBe('blue');
    // ...and outside the support nothing moved at all, which is what compact support is for.
    expect(classAt(warped, 150, 20)).toBe(classAt(raster, 150, 20));
    expect(classAt(warped, 10, 150)).toBe(classAt(raster, 10, 150));
  });
});

describe('a raster in a bundle', () => {
  const built = buildRaster({
    image: blank(120, 80, CLASS_RGB['yellow-light']),
    georeference: { metresPerPixel: 0.5, originX: 2, originY: 3 },
    reference: 'sample.png',
    keepEdges: true,
  });
  const map = {
    id: 'unwritten',
    width: 60,
    height: 60,
    scale: 10000,
    relief: new (class {
      readonly kind = 'none' as const;
      heightAt() { return 0; }
      sampleGrid(n: number) {
        return { n, size: 60, values: new Float32Array((n + 1) * (n + 1)), min: 0, max: 0 };
      }
      contours() { return []; }
      warped() { return this; }
    })(),
    features: [],
    raster: built.raster,
    analysis: { landforms: [] },
    windows: {},
    meta: { name: 'sample', scale: 10000, source: 'image' as const },
  };

  it('survives the round trip through base64', () => {
    const bundle = saveBundle(map);
    const back = loadBundle(JSON.parse(JSON.stringify(bundle)) as MapBundle);
    expect(back.raster!.mask).toEqual(built.raster.mask);
    expect(back.raster!.metresPerPixel).toBe(0.5);
    expect(back.raster!.originY).toBe(3);
    expect(back.raster!.imageWidth).toBe(120);
  });

  it('resolves a sibling image against the bundle it came from', () => {
    const bundle = JSON.parse(JSON.stringify(saveBundle(map))) as MapBundle;
    expect(loadBundle(bundle, { url: '/o-training/maps/sample.json' }).raster!.image)
      .toBe('/o-training/maps/sample.png');
    // A data URL is already resolved, and so is an absolute path.
    const inline = { ...bundle, raster: { ...bundle.raster!, image: 'data:image/png;base64,AAA' } };
    expect(loadBundle(inline, { url: '/maps/sample.json' }).raster!.image)
      .toBe('data:image/png;base64,AAA');
  });

  it('refuses a mask that does not match the size it claims', () => {
    const bundle = JSON.parse(JSON.stringify(saveBundle(map))) as MapBundle;
    const broken = { ...bundle, raster: { ...bundle.raster!, maskWidth: 7 } };
    expect(() => loadBundle(broken)).toThrow(/mask says/);
  });

  it('leaves a bundle with no picture serialising exactly as it did', () => {
    // The field order is the hash. A map with no raster must not gain a key, or every
    // bundle already written changes its id.
    const { raster: _raster, ...flat } = map;
    expect(Object.keys(saveBundle(flat))).toEqual([
      'format', 'meta', 'width', 'height', 'features', 'relief', 'analysis', 'windows', 'id',
    ]);
  });
});
