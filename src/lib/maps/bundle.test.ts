import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { decodeFloats, encodeFloats, fromBase64, sha256, toBase64 } from './codec.ts';
import { idMatches, loadBundle, saveBundle, type MapBundle } from './bundle.ts';
import type { Contour } from '@/lib/terrain/contours.ts';
import type { Grid } from '@/lib/terrain/height.ts';
import type { OMap } from '@/lib/terrain/omap.ts';
import { ContourRelief, GridRelief, NoRelief } from '@/lib/terrain/relief.ts';

const grid = (n: number, f: (x: number, y: number) => number, size = 100): Grid => {
  const values = new Float32Array((n + 1) * (n + 1));
  const step = size / n;
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const h = f(i * step, j * step);
      values[j * (n + 1) + i] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  return { n, size, values, min, max };
};

describe('codec / base64', () => {
  it('round-trips any bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
      }),
    );
  });

  it('agrees with the encoding everything else uses', () => {
    // Pinned against known answers rather than only against itself: a self-consistent
    // encoder that is not base64 round-trips perfectly and is still unreadable to gzip,
    // to a browser, and to whoever opens the file.
    expect(toBase64(Uint8Array.from([]))).toBe('');
    expect(toBase64(Uint8Array.from([102]))).toBe('Zg==');
    expect(toBase64(Uint8Array.from([102, 111]))).toBe('Zm8=');
    expect(toBase64(Uint8Array.from([102, 111, 111]))).toBe('Zm9v');
    expect(toBase64(Uint8Array.from([255, 254, 253]))).toBe('//79');
  });

  it('refuses a corrupted array rather than decoding it approximately', () => {
    expect(() => fromBase64('Zm9v!')).toThrow(/base64/);
  });
});

describe('codec / floats', () => {
  it('round-trips a height field exactly', () => {
    // Exactly, not approximately: these are Float32 in and Float32 out, so the values
    // survive unrounded and a bundle's contours land where the DEM put them.
    fc.assert(
      fc.property(fc.array(fc.float(), { maxLength: 200 }), (xs) => {
        const values = Float32Array.from(xs);
        const back = decodeFloats(encodeFloats(values));
        expect([...back]).toEqual([...values]);
      }),
    );
  });
});

describe('codec / sha256', () => {
  it('matches the published vectors', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('hashes multibyte text as its UTF-8 bytes', () => {
    // The name of a Czech map is not ASCII and it goes into the payload the id hashes, so
    // the hand-rolled UTF-8 encoder has to agree with everyone else's.
    expect(sha256('ř')).toBe('069f39aeb41bfbc63bac24061e31a07b9193e2d465c2bde974cb3e78d5d9f929');
    expect(sha256('Příbram'))
      .toBe('766b00f240ba6913993a1e310ba1cbbd840436a425fe2dfaa04cde15388b5359');
  });
});

const meta = { name: 'test', scale: 10000, source: 'xmap' as const };
const analysis = { landforms: [{ centre: { x: 10, y: 20 }, radius: 30, amplitude: 4 }] };

const lines: Contour[] = [
  {
    level: 5,
    points: [{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 0 }],
    closed: false,
    index: true,
    form: false,
    tags: [],
  },
  {
    level: 10,
    points: [{ x: 30, y: 30 }, { x: 40, y: 30 }, { x: 40, y: 40 }, { x: 30, y: 30 }],
    closed: true,
    index: false,
    form: false,
    tags: [{ x: 30, y: 30, dx: 0, dy: 1 }],
  },
];

const withRelief = (relief: OMap['relief']): OMap => ({
  id: 'unwritten',
  width: 100,
  height: 100,
  scale: 10000,
  relief,
  features: [
    { id: 'p0', code: '206', geometry: { kind: 'point', at: { x: 12, y: 34 } }, size: 4 },
    {
      id: 'a0',
      code: '410',
      geometry: { kind: 'polygon', rings: [[{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 9 }]] },
    },
  ],
  analysis,
  meta,
  windows: { pexeso: [{ x: 0, y: 0, size: 50 }], 'map-memory': [] },
});

describe('bundle / round trip', () => {
  it('a DEM comes back sample for sample', () => {
    const map = withRelief(new GridRelief(grid(16, (x, y) => Math.sin(x / 9) * 3 + y / 20)));
    const back = loadBundle(JSON.parse(JSON.stringify(saveBundle(map))));
    expect(back.relief.kind).toBe('grid');
    const before = map.relief.sampleGrid(16);
    const after = back.relief.sampleGrid(16);
    expect([...after.values]).toEqual([...before.values]);
    expect(after.size).toBe(100);
  });

  it('drawn contour lines come back as the lines that were drawn', () => {
    const map = withRelief(new ContourRelief({ interval: 5, lines, grid: grid(8, () => 0) }));
    const back = loadBundle(JSON.parse(JSON.stringify(saveBundle(map))));
    expect(back.relief.kind).toBe('contours');
    expect(back.relief.contours(5)).toEqual(lines);
    // Whatever interval is asked for: they are the map, not a rendering choice.
    expect(back.relief.contours(2.5)).toEqual(lines);
  });

  it('carries the features, the analysis, the meta and the windows', () => {
    const map = withRelief(new NoRelief(100));
    const back = loadBundle(JSON.parse(JSON.stringify(saveBundle(map))));
    expect(back.features).toEqual(map.features);
    expect(back.analysis).toEqual(analysis);
    expect(back.meta).toEqual(meta);
    expect(back.windows?.pexeso).toEqual([{ x: 0, y: 0, size: 50 }]);
    expect(back.scale).toBe(10000);
  });

  it('names itself by the hash of what it carries', () => {
    const map = withRelief(new GridRelief(grid(8, (x) => x / 10)));
    const bundle = saveBundle(map);
    expect(bundle.id).toMatch(/^[0-9a-f]{64}$/);
    expect(idMatches(bundle)).toBe(true);
    // The same map twice is the same bundle: a re-import that changed nothing must not
    // invalidate a golden over library rounds, which pins (bundle id, window, edits).
    expect(saveBundle(map).id).toBe(bundle.id);
  });

  it('changes its id when the ground changes', () => {
    const a = saveBundle(withRelief(new GridRelief(grid(8, (x) => x / 10))));
    const b = saveBundle(withRelief(new GridRelief(grid(8, (x) => x / 11))));
    expect(a.id).not.toBe(b.id);
    expect(idMatches({ ...a, id: b.id } as MapBundle)).toBe(false);
  });
});

describe('bundle / refusals', () => {
  const good = saveBundle(withRelief(new NoRelief(100)));

  it('refuses a format it does not know', () => {
    expect(() => loadBundle({ ...good, format: 2 })).toThrow(/format 2/);
  });

  it('refuses a bundle missing its parts', () => {
    expect(() => loadBundle({ ...good, features: undefined })).toThrow(/features/);
    expect(() => loadBundle({ ...good, analysis: undefined })).toThrow(/analysis/);
    expect(() => loadBundle({ ...good, windows: undefined })).toThrow(/windows/);
    expect(() => loadBundle(null)).toThrow(/object/);
  });

  it('refuses a grid whose length disagrees with its n', () => {
    const map = withRelief(new GridRelief(grid(8, () => 1)));
    const bundle = saveBundle(map);
    expect(() => loadBundle({ ...bundle, relief: { ...bundle.relief, n: 9 } }))
      .toThrow(/carries/);
  });

  it('refuses to write a map with no analysis', () => {
    const { analysis: _dropped, ...rest } = withRelief(new NoRelief(100));
    expect(() => saveBundle(rest)).toThrow(/analysis/);
  });

  it('refuses to write a relief that has no bundle form', () => {
    // The generator's ground is a seed and a handful of parameters, not a file. Writing
    // it as a bundle would silently flatten it.
    const analytic = { ...withRelief(new NoRelief(100)) };
    expect(() =>
      saveBundle({ ...analytic, relief: { ...analytic.relief, kind: 'analytic' } as OMap['relief'] }),
    ).toThrow(/analytic/);
  });
});
