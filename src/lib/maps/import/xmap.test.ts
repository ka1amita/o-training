import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseXmap } from './xmap.ts';
import { findAll, parseXml, unescapeXml } from './xml.ts';

const tiny = readFileSync(new URL('./__fixtures__/tiny.xmap', import.meta.url), 'utf8');
const map = parseXmap(tiny);

describe('xml', () => {
  it('reads elements, attributes and nesting', () => {
    const root = parseXml('<a x="1"><b y="2"/><b y="3">text</b></a>');
    expect(root.name).toBe('a');
    expect(root.attrs['x']).toBe('1');
    expect(root.children.map((c) => c.attrs['y'])).toEqual(['2', '3']);
    expect(root.children[1]!.text).toBe('text');
  });

  it('drops the declaration and comments, and keeps CDATA', () => {
    const root = parseXml('<?xml version="1.0"?><!-- gone --><a><![CDATA[<kept>]]></a>');
    expect(root.name).toBe('a');
    expect(root.text).toBe('<kept>');
  });

  it('resolves entities in attributes and text', () => {
    expect(unescapeXml('a &amp; b &lt;c&gt; &#65; &#x42;')).toBe('a & b <c> A B');
    expect(parseXml('<a n="&quot;q&quot;"/>').attrs['n']).toBe('"q"');
  });

  it('drops a namespace prefix, since this format uses exactly one', () => {
    expect(parseXml('<m:map xmlns:m="x"><m:a/></m:map>').children[0]!.name).toBe('a');
  });

  it('refuses malformed input rather than guessing at it', () => {
    expect(() => parseXml('<a><b></a>')).toThrow();
    expect(() => parseXml('<a>')).toThrow(/left open/);
    expect(() => parseXml('nothing')).toThrow(/no root/);
  });
});

describe('parseXmap / the file', () => {
  it('reads the scale and the symbol set', () => {
    expect(map.scale).toBe(10000);
    expect(map.symbolSet).toBe('ISOM2000');
  });

  it('takes only the symbols an object can reference', () => {
    // Mapper nests a whole <symbol> inside a line symbol for its mid decoration. Counting
    // those gives six symbols where the map has five, and shifts nothing — which is worse
    // than an error, because objects reference by id and the ids still resolve.
    expect(map.symbols.map((s) => s.code)).toEqual(['101', '112', '410', '105', '777']);
    expect(map.symbols.map((s) => s.geometry))
      .toEqual(['line', 'point', 'area', 'text', 'line']);
  });

  it('gives every symbol its colour class from the map table', () => {
    const byCode = new Map(map.symbols.map((s) => [s.code, s]));
    expect(byCode.get('101')?.colour).toBe('brown');
    expect(byCode.get('410')?.colour).toBe('green');
    // The unknown one: black ink, which is what lets it draw at all.
    expect(byCode.get('777')?.colour).toBe('black');
  });
});

describe('parseXmap / geometry', () => {
  it('turns paper thousandths into metres and moves the origin to (0, 0)', () => {
    // 1/1000 mm at 1:10000 is a centimetre of ground, so 1000 units is 10 m. The bounding
    // box starts at (500, 300) and every coordinate comes out relative to it.
    expect(map.width).toBeCloseTo(30, 9);
    expect(map.height).toBeCloseTo(55, 9);
    const line = map.objects[0]!;
    expect(line.geometry).toEqual({
      kind: 'polyline',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    });
  });

  it('leaves a pattern coordinate out of the geometry and out of the extent', () => {
    // An area object carries a <pattern> with a <coord> for its rotation origin. The
    // fixture puts that coord far off the map: if it counted, the extent would be 995 m
    // and every area would have a stray vertex in the corner.
    expect(map.width).toBeLessThan(100);
    const area = map.objects.find((o) => o.code === '410')!;
    if (area.geometry.kind !== 'polygon') throw new Error('expected a polygon');
    expect(area.geometry.rings.flat().every((p) => p.x <= 30 && p.y <= 55)).toBe(true);
  });

  it('flattens a Bezier instead of drawing its control net', () => {
    const curve = map.objects[1]!;
    if (curve.geometry.kind !== 'polyline') throw new Error('expected a polyline');
    const points = curve.geometry.points;
    // Ignoring the curve flag would give exactly the four stored coords, which is the
    // control net: a zigzag out to (0, 20) and (10, 20) and back.
    expect(points.length).toBeGreaterThan(4);
    expect(points[0]).toEqual({ x: 0, y: 10 });
    expect(points[points.length - 1]).toEqual({ x: 10, y: 10 });
    // The curve bulges to three quarters of the control offset, never to the controls.
    const lowest = Math.max(...points.map((p) => p.y));
    expect(lowest).toBeGreaterThan(15);
    expect(lowest).toBeLessThan(19);
    expect(points.every((p) => p.x >= -0.001 && p.x <= 10.001)).toBe(true);
  });

  it('honours the tolerance it is given', () => {
    const coarse = parseXmap(tiny, { tolerance: 5 });
    const fine = parseXmap(tiny, { tolerance: 0.05 });
    const count = (m: typeof map) => {
      const g = m.objects[1]!.geometry;
      return g.kind === 'polyline' ? g.points.length : 0;
    };
    expect(count(coarse)).toBeLessThan(count(fine));
  });

  it('splits a line at a hole point rather than joining across the gap', () => {
    const parts = map.objects.filter(
      (o) => o.geometry.kind === 'polyline' && o.geometry.points[0]!.x >= 15,
    );
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => (p.geometry.kind === 'polyline' ? p.geometry.points : [])))
      .toEqual([
        [{ x: 15, y: 0 }, { x: 20, y: 0 }],
        [{ x: 25, y: 0 }, { x: 30, y: 0 }],
      ]);
  });

  it('reads an area as rings, outer first', () => {
    const area = map.objects.find((o) => o.code === '410')!;
    if (area.geometry.kind !== 'polygon') throw new Error('expected a polygon');
    expect(area.geometry.rings).toHaveLength(2);
    expect(area.geometry.rings[0]![0]).toEqual({ x: 0, y: 30 });
    // The hole is inside the outline, which is what `fill-rule="evenodd"` then punches out.
    expect(area.geometry.rings[1]!.every((p) => p.x >= 5 && p.x <= 15)).toBe(true);
  });

  it('reads a point object as a point', () => {
    const point = map.objects.find((o) => o.code === '112')!;
    expect(point.geometry).toEqual({ kind: 'point', at: { x: 5, y: 7 } });
  });

  it('drops text objects', () => {
    // A contour value is an answer written on the map, and it has no geometry a drill can
    // read anyway.
    expect(map.objects.some((o) => o.code === '105')).toBe(false);
    expect(findAll(parseXml(tiny), 'text')).not.toHaveLength(0);
  });

  it('keeps a symbol it does not understand', () => {
    // The whole point of a colour fallback: an unknown code still arrives, still draws,
    // and is simply never chosen as an edit target.
    expect(map.objects.some((o) => o.code === '777')).toBe(true);
  });

  it('refuses a file that is not a map, or has no scale', () => {
    expect(() => parseXmap('<notamap/>')).toThrow(/expected <map>/);
    expect(() => parseXmap('<map><objects/></map>')).toThrow(/georeferencing/);
  });

  it('refuses a <map> that is somebody else’s format', () => {
    // A <map> root is not rare. Reading another format's coordinate flags as Mapper's
    // produces a map rather than an error, which is the worst outcome available.
    expect(() => parseXmap('<map xmlns="http://example.com/maps"/>')).toThrow(/namespace/);
  });
});
