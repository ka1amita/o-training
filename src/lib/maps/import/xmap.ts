import type { Colour } from '@/lib/terrain/semantics.ts';
import type { Geometry, Vec } from '@/lib/terrain/omap.ts';
import { attrNumber, childrenOf, findAll, parseXml, type XmlNode } from './xml.ts';

/**
 * OpenOrienteering Mapper's `.xmap` / `.omap`, into geometry in metres.
 *
 * Namespace `http://openorienteering.org/apps/mapper/xml/v2`; `.omap` is the same XML
 * minified. Confirmed against Mapper's own `examples/src/forest sample.xmap`.
 *
 * ## The two conventions that matter
 *
 * **Coordinates are 1/1000 mm of paper, y down.** So `metres = coord × scale / 10⁶`, and
 * the scale comes from `<georeferencing scale=…>` — 1:10000 for the forest sample against
 * the 1:15000 the app's line widths are written for, which is why `OMap.scale` exists and
 * why it is not the renderer that reads it.
 *
 * **A coord's flags say what the path does next**, and getting them wrong produces a map
 * that looks almost right:
 *
 * | bit | meaning | what happens here |
 * |---|---|---|
 * | 1 | curve start | the next two coords are cubic Bézier controls and the one after is the end point |
 * | 2 | close point | this point ends a ring and repeats the first |
 * | 4 | gap point | a dashed-line gap; nothing geometric, ignored |
 * | 16 | hole point | this point ends a **part** — the next ring of an area, or the next piece of a line |
 * | 32 | dash point | a forced dash; nothing geometric, ignored |
 *
 * A curve's two control points are ordinary `<coord>` entries, so a reader that ignores
 * flag 1 draws every curve as a zigzag through its own control net — which reads as a
 * badly generalised map rather than as a bug.
 */
export const XMAP_NAMESPACE = 'http://openorienteering.org/apps/mapper/xml/v2';

const CURVE_START = 1;
const CLOSE_POINT = 2;
const HOLE_POINT = 16;

/** Mapper stores paper coordinates in thousandths of a millimetre. */
const MICRONS_PER_MM = 1000;

export interface XmapColour {
  readonly priority: number;
  readonly name: string;
  readonly colour: Colour;
}

export interface XmapSymbol {
  /** What `<object symbol=…>` references. Only top-level symbols have one. */
  readonly id: string;
  /** The ISOM code as the file writes it: `'101'`, `'410.1'`, `''` for a decoration. */
  readonly code: string;
  readonly name: string;
  readonly geometry: 'point' | 'line' | 'area' | 'text' | 'combined';
  /** Its colour class, from the map's own colour table. The fallback for an unknown code. */
  readonly colour?: Colour;
}

export interface XmapObject {
  readonly symbol: string;
  readonly code: string;
  readonly geometry: Geometry;
}

export interface ParsedXmap {
  readonly scale: number;
  /** `<symbols id=…>`: `'ISOM2000'` on the forest sample. Which alias table applies. */
  readonly symbolSet: string;
  readonly colours: readonly XmapColour[];
  readonly symbols: readonly XmapSymbol[];
  readonly objects: readonly XmapObject[];
  /** Extent in metres, after translating the bounding box origin to (0, 0). */
  readonly width: number;
  readonly height: number;
}

export interface XmapOptions {
  /**
   * How far a flattened Bézier may stray from the curve, in metres.
   *
   * The default is a twentieth of a millimetre of paper at 1:10000 — finer than anything
   * printing at 0.14 mm can show, and the reason to state it in metres is that the ground
   * is what the drills measure in.
   */
  readonly tolerance?: number;
}

const DEFAULT_TOLERANCE = 0.5;

/** Mapper's `<symbol type=…>`, which is a bitmask in the file and five values in practice. */
const GEOMETRY_OF: Readonly<Record<number, XmapSymbol['geometry']>> = {
  1: 'point',
  2: 'line',
  4: 'area',
  8: 'text',
  16: 'combined',
};

export function parseXmap(xml: string, options: XmapOptions = {}): ParsedXmap {
  const root = parseXml(xml);
  if (root.name !== 'map') throw new Error(`xmap: root is <${root.name}>, expected <map>`);
  const namespace = root.attrs['xmlns'];
  // Checked rather than assumed: an OCAD export or a hand-written file could well have a
  // <map> root and mean something else entirely, and the flags would then be read as
  // Mapper's when they are not.
  if (namespace !== undefined && namespace !== XMAP_NAMESPACE) {
    throw new Error(`xmap: namespace ${namespace}, expected ${XMAP_NAMESPACE}`);
  }

  const georeferencing = findAll(root, 'georeferencing')[0];
  const scale = georeferencing ? attrNumber(georeferencing, 'scale', 0) : 0;
  if (!(scale > 0)) throw new Error('xmap: no <georeferencing scale>');

  const colours = childrenOf(root, 'colors', 'color').map((node, i): XmapColour => ({
    priority: attrNumber(node, 'priority', i),
    name: node.attrs['name'] ?? '',
    colour: classify(node),
  }));
  const byPriority = new Map(colours.map((c) => [c.priority, c]));

  const symbolsElement = findAll(root, 'symbols')[0];
  const symbolSet = symbolsElement?.attrs['id'] ?? '';

  const symbols: XmapSymbol[] = [];
  for (const node of childrenOf(root, 'symbols', 'symbol')) {
    // Only a symbol with an id is one an object can reference. The others are the start,
    // mid and end decorations nested inside a line symbol.
    const id = node.attrs['id'];
    if (id === undefined) continue;
    const colour = byPriority.get(colourIndexOf(node))?.colour;
    symbols.push({
      id,
      code: node.attrs['code'] ?? '',
      name: node.attrs['name'] ?? '',
      geometry: GEOMETRY_OF[attrNumber(node, 'type', 0)] ?? 'line',
      ...(colour ? { colour } : {}),
    });
  }
  const bySymbolId = new Map(symbols.map((s) => [s.id, s]));

  // Metres per stored unit. y stays down, which is `MapView`'s convention already.
  const perUnit = scale / (MICRONS_PER_MM * 1000);
  const raw = childrenOf(root, 'objects', 'object');

  // The origin is the bounding box of every coordinate, control points included: a Bézier
  // lies inside the hull of its controls, so a box that holds them holds the flattened
  // line too and no geometry can come out negative.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const coordsOf = (object: XmlNode): Coord[] => {
    // `<coords>` only: an area object also carries a `<pattern>` with a `<coord>` of its
    // own for the pattern's rotation origin, and counting that as geometry puts a stray
    // vertex at the map's corner on every patterned area.
    const holder = object.children.find((c) => c.name === 'coords');
    if (!holder) return [];
    return holder.children
      .filter((c) => c.name === 'coord')
      .map((c) => ({
        x: attrNumber(c, 'x'),
        y: attrNumber(c, 'y'),
        flags: attrNumber(c, 'flags'),
      }));
  };

  const all = raw.map(coordsOf);
  for (const coords of all) {
    for (const c of coords) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.y > maxY) maxY = c.y;
    }
  }
  if (!Number.isFinite(minX)) throw new Error('xmap: no objects with coordinates');

  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const objects: XmapObject[] = [];
  raw.forEach((object, index) => {
    const id = object.attrs['symbol'];
    const symbol = id === undefined ? undefined : bySymbolId.get(id);
    // A text object is dropped: it has no geometry a drill can read, and a map full of
    // control-value numbers is a map full of answers to the wrong question.
    if (!symbol || symbol.geometry === 'text') return;

    const coords = all[index]!.map((c) => ({
      x: (c.x - minX) * perUnit,
      y: (c.y - minY) * perUnit,
      flags: c.flags,
    }));
    if (coords.length === 0) return;

    if (symbol.geometry === 'point' || coords.length === 1) {
      objects.push({
        symbol: symbol.id,
        code: symbol.code,
        geometry: { kind: 'point', at: { x: coords[0]!.x, y: coords[0]!.y } },
      });
      return;
    }

    const parts = partsOf(coords, tolerance);
    if (parts.length === 0) return;

    const asArea = symbol.geometry === 'area' ||
      (symbol.geometry === 'combined' && parts[0]!.closed);
    if (asArea) {
      // Rings, outer first — which is the order Mapper writes them in, an area's holes
      // following its outline. `MapView` fills them evenodd.
      const rings = parts.filter((p) => p.points.length >= 3).map((p) => p.points);
      if (rings.length === 0) return;
      objects.push({ symbol: symbol.id, code: symbol.code, geometry: { kind: 'polygon', rings } });
      return;
    }

    // One feature per part: a line broken by a hole point is two lines on the ground, and
    // joining them would draw a path across the gap the surveyor put there.
    for (const part of parts) {
      if (part.points.length < 2) continue;
      objects.push({
        symbol: symbol.id,
        code: symbol.code,
        geometry: { kind: 'polyline', points: part.points },
      });
    }
  });

  return {
    scale,
    symbolSet,
    colours,
    symbols,
    objects,
    width: (maxX - minX) * perUnit,
    height: (maxY - minY) * perUnit,
  };
}

interface Coord {
  readonly x: number;
  readonly y: number;
  readonly flags: number;
}

interface Part {
  readonly points: Vec[];
  readonly closed: boolean;
}

/** Split a coordinate list into parts at hole points, and flatten each part's curves. */
function partsOf(coords: readonly Coord[], tolerance: number): Part[] {
  const parts: Part[] = [];
  let start = 0;
  for (let end = 0; end < coords.length; end++) {
    const last = end === coords.length - 1;
    if (!last && (coords[end]!.flags & HOLE_POINT) === 0) continue;
    const slice = coords.slice(start, end + 1);
    start = end + 1;
    if (slice.length === 0) continue;
    const closed = (slice[slice.length - 1]!.flags & CLOSE_POINT) !== 0;
    parts.push({ points: flatten(slice, tolerance), closed });
  }
  return parts;
}

/**
 * A part's coords into a polyline, expanding cubic Béziers.
 *
 * Mapper stores a curve as four consecutive coords — start, two controls, end — with the
 * start flagged `CURVE_START`. The end is the start of whatever follows, so the walk
 * steps by three across a curve and by one across a straight segment.
 */
function flatten(coords: readonly Coord[], tolerance: number): Vec[] {
  const points: Vec[] = [{ x: coords[0]!.x, y: coords[0]!.y }];
  let i = 0;
  while (i < coords.length - 1) {
    const from = coords[i]!;
    if ((from.flags & CURVE_START) !== 0 && i + 3 <= coords.length - 1) {
      subdivide(from, coords[i + 1]!, coords[i + 2]!, coords[i + 3]!, tolerance, points, 0);
      points.push({ x: coords[i + 3]!.x, y: coords[i + 3]!.y });
      i += 3;
    } else {
      points.push({ x: coords[i + 1]!.x, y: coords[i + 1]!.y });
      i += 1;
    }
  }
  return points;
}

/**
 * Recursion depth cap for curve flattening.
 *
 * Ten levels is 1024 segments for one curve, far past any tolerance a map needs, and it
 * is here so a degenerate curve — two coincident controls, or a tolerance of zero — costs
 * a bounded amount rather than the process.
 */
const MAX_DEPTH = 10;

/** De Casteljau, subdividing while a control point is further than `tolerance` from the
 *  chord. Emits the interior points only; the caller pushes the end. */
function subdivide(
  p0: Vec, p1: Vec, p2: Vec, p3: Vec,
  tolerance: number,
  into: Vec[],
  depth: number,
): void {
  if (depth >= MAX_DEPTH || flatEnough(p0, p1, p2, p3, tolerance)) return;
  const mid = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const p23 = mid(p2, p3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const centre = mid(p012, p123);
  subdivide(p0, p01, p012, centre, tolerance, into, depth + 1);
  into.push(centre);
  subdivide(centre, p123, p23, p3, tolerance, into, depth + 1);
}

function flatEnough(p0: Vec, p1: Vec, p2: Vec, p3: Vec, tolerance: number): boolean {
  return distanceToChord(p1, p0, p3) <= tolerance && distanceToChord(p2, p0, p3) <= tolerance;
}

function distanceToChord(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / length;
}

// ---------------------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------------------

/** The first colour reference in a symbol's subtree, or -1. */
function colourIndexOf(symbol: XmlNode): number {
  const fields = ['color', 'inner_color', 'outer_color'];
  const walk = (node: XmlNode): number => {
    for (const field of fields) {
      const raw = node.attrs[field];
      if (raw !== undefined) {
        const value = Number(raw);
        // -1 is Mapper's "no colour": a point symbol whose ink is in its elements.
        if (Number.isFinite(value) && value >= 0) return value;
      }
    }
    for (const child of node.children) {
      const found = walk(child);
      if (found >= 0) return found;
    }
    return -1;
  };
  return walk(symbol);
}

/**
 * A CMYK entry in the map's colour table, into one of the classes the app understands.
 *
 * **From the ink, not from the name.** The names in Mapper's own symbol sets are English
 * and would sort this file out in one line — and a map drawn in Czech, or with a
 * cartographer's own colour named "hnědá 50 %", would then fall back to black for every
 * unknown symbol on it. The ink is the same in every language.
 *
 * ISOM's palette is designed to be separable, which is why this is a handful of
 * thresholds rather than a colour-space conversion: brown and yellow are the only pair
 * that need care, and they part on the magenta-to-yellow ratio (brown 0.56, yellow 0.34).
 */
export function classify(node: XmlNode): Colour {
  const c = attrNumber(node, 'c');
  const m = attrNumber(node, 'm');
  const y = attrNumber(node, 'y');
  const k = attrNumber(node, 'k');

  if (c < 0.06 && m < 0.06 && y < 0.06) {
    if (k >= 0.5) return 'black';
    // 30% black is bare rock's grey, and white is the runnable forest everything is
    // drawn on — a symbol inked in it is meant not to show.
    return k >= 0.08 ? 'grey' : 'white';
  }
  if (m >= 0.5 && c < 0.5 && y < 0.2) return 'purple';
  if (c >= 0.2 && y >= 0.2) return 'green';
  if (c >= 0.2) return 'blue';
  if (y > 0 && m / y >= 0.45) return 'brown';
  if (y >= 0.2) return 'yellow';
  return 'black';
}
