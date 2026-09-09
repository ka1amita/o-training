/**
 * A PNG reader and writer, in the subset a map export is.
 *
 * ## Why this exists rather than a package
 *
 * The pipeline has to decode a Livelox export in Node and write the cropped image back
 * out beside the bundle, and neither `pngjs` nor `sharp` may be added: `AGENTS.md` is
 * explicit that generated assets are committed so that no source package becomes a
 * runtime dependency, and this is the same argument one step earlier — a decoder used
 * once at import is not worth a node_modules entry, a licence and a supply chain.
 *
 * The subset is what these files actually are: **8-bit, non-interlaced, colour types 0,
 * 2, 3, 4 and 6**, filters 0–4. Everything else is refused by name rather than decoded
 * approximately, because a half-decoded map is a map whose colours are wrong and whose
 * mask is therefore a lie.
 *
 * ## Why inflate is an argument
 *
 * Nothing in `src/` may import `node:zlib`: this module sits in the import pipeline,
 * which the browser will run the day "bring your own map" arrives, and a bare
 * `node:zlib` import is a build error there. So the caller passes the one thing that is
 * genuinely platform-specific — `scripts/import-map.mjs` passes `zlib.inflateSync`, a
 * test passes the same, and a browser would pass a `DecompressionStream` shim. What is
 * left here is the part that can be got wrong: filters, palettes, and stride.
 */

/** Decoded pixels, RGBA, row-major. The one shape every raster stage works over. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** zlib inflate/deflate, supplied by the caller. See the note above. */
export type Codec = (data: Uint8Array) => Uint8Array;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Channels per pixel, by PNG colour type. Index 1 and 5 do not exist. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(bytes: Uint8Array, inflate: Codec): RgbaImage {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('png: not a PNG (bad signature)');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let palette: Uint8Array | null = null;
  let alphas: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  // Chunk CRCs are not checked. zlib's own adler-32 covers the only bytes whose
  // corruption would be silent — the pixels — and everything else here is length-checked
  // as it is read.
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at, false);
    const type = String.fromCharCode(
      bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!,
    );
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (at + 12 + length > bytes.length) throw new Error(`png: ${type} chunk runs off the end`);

    if (type === 'IHDR') {
      width = view.getUint32(at + 8, false);
      height = view.getUint32(at + 12, false);
      depth = bytes[at + 16]!;
      colourType = bytes[at + 17]!;
      const interlace = bytes[at + 20]!;
      if (depth !== 8) throw new Error(`png: ${depth}-bit samples; this reader does 8-bit only`);
      if (!(colourType in CHANNELS)) throw new Error(`png: colour type ${colourType}`);
      if (interlace !== 0) throw new Error('png: interlaced; save it non-interlaced');
    } else if (type === 'PLTE') palette = body.slice();
    else if (type === 'tRNS') alphas = body.slice();
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;

    at += 12 + length;
  }

  if (width === 0 || height === 0) throw new Error('png: no IHDR');
  if (idat.length === 0) throw new Error('png: no image data');
  if (colourType === 3 && !palette) throw new Error('png: palette image with no PLTE');

  const raw = inflate(concat(idat));
  const channels = CHANNELS[colourType]!;
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    throw new Error(`png: ${raw.length} bytes of pixels, expected ${(stride + 1) * height}`);
  }

  const lines = unfilter(raw, width, height, channels);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (colourType === 3) {
      const index = lines[s]!;
      data[d] = palette![index * 3] ?? 0;
      data[d + 1] = palette![index * 3 + 1] ?? 0;
      data[d + 2] = palette![index * 3 + 2] ?? 0;
      data[d + 3] = alphas ? (alphas[index] ?? 255) : 255;
    } else if (colourType === 0 || colourType === 4) {
      const grey = lines[s]!;
      data[d] = grey;
      data[d + 1] = grey;
      data[d + 2] = grey;
      data[d + 3] = colourType === 4 ? lines[s + 1]! : 255;
    } else {
      data[d] = lines[s]!;
      data[d + 1] = lines[s + 1]!;
      data[d + 2] = lines[s + 2]!;
      data[d + 3] = colourType === 6 ? lines[s + 3]! : 255;
    }
  }
  return { width, height, data };
}

/**
 * The five PNG row filters, undone in place into one contiguous buffer.
 *
 * `bpp` is bytes per pixel and **not** bytes per sample: Paeth and Sub reach back one
 * whole pixel, so a 3-channel image reaches back three bytes. Getting that wrong decodes
 * the first row correctly and smears every row after it, which is exactly the failure
 * that looks like a broken image rather than a broken decoder.
 */
function unfilter(raw: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let source = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[source++]!;
    const row = y * stride;
    const prior = row - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[source + i]!;
      const a = i >= channels ? out[row + i - channels]! : 0;
      const b = y > 0 ? out[prior + i]! : 0;
      const c = y > 0 && i >= channels ? out[prior + i - channels]! : 0;
      let value: number;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: value = x + paeth(a, b, c); break;
        default: throw new Error(`png: row ${y} uses filter ${filter}`);
      }
      out[row + i] = value & 0xff;
    }
    source += stride;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------

/**
 * RGB, filter 0, one IDAT.
 *
 * The pipeline writes an image back out because it **cropped** it: the banner and the
 * white margins are gone and the pixels are no longer the file the user handed over. A
 * bundle that pointed at the original would show the Livelox header inside a pexeso card.
 *
 * Alpha is dropped: an O map is opaque, the mask reads a colour and not a coverage, and
 * a quarter fewer bytes on a file that ships beside the bundle is worth the line it takes
 * to say so.
 */
export function encodePng(image: RgbaImage, deflate: Codec): Uint8Array {
  const { width, height, data } = image;
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = row + 1 + x * 3;
      raw[d] = data[s]!;
      raw[d + 1] = data[s + 1]!;
      raw[d + 2] = data[s + 2]!;
    }
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width, false);
  header.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return concat([
    Uint8Array.from(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)), false);
  return out;
}
