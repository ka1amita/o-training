// Generates the PWA icons. No image library on this machine and none worth adding for
// two files, so this writes the PNGs directly: zlib is in node, and the rest of the
// format is a header, one deflated block of scanlines, and three CRCs.
//
//   node scripts/make-icons.mjs
//
// The mark is the orienteering control flag — a square split corner to corner, white
// over orange — on the app's own background.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, paint) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = paint(x, y, size);
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [28, 25, 23, 255];       // stone-900, matches theme_color
const WHITE = [250, 250, 249, 255];
const ORANGE = [234, 88, 12, 255];  // orange-600

// Antialias by sampling each pixel on a 3x3 grid; edges of a diagonal read badly without it.
const paint = (x, y, size) => {
  const inset = size * 0.2;
  const side = size - inset * 2;
  let acc = [0, 0, 0, 0];
  const S = 3;
  for (let sy = 0; sy < S; sy++) {
    for (let sx = 0; sx < S; sx++) {
      const px = x + (sx + 0.5) / S;
      const py = y + (sy + 0.5) / S;
      const u = (px - inset) / side;
      const v = (py - inset) / side;
      const c = u < 0 || u > 1 || v < 0 || v > 1 ? BG : u + v < 1 ? WHITE : ORANGE;
      for (let i = 0; i < 4; i++) acc[i] += c[i];
    }
  }
  return acc.map((n) => Math.round(n / (S * S)));
};

for (const size of [192, 512]) {
  const file = new URL(`../public/icon-${size}.png`, import.meta.url);
  writeFileSync(file, png(size, paint));
  console.log(`wrote public/icon-${size}.png`);
}
