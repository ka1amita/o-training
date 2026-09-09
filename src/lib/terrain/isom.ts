import { semanticsOf, type IsomCode } from './semantics.ts';

/**
 * ISOM 2017-2 drawing parameters.
 *
 * Every number here is **millimetres of printed paper at 1:15000**, the scale the standard
 * is written for, with the IOF symbol code beside it. Widths were eyeballed before this
 * file existed and were mutually inconsistent — a footpath drawn thinner than the contour
 * it crosses is not a thing any map does, and it is exactly the sort of wrongness that
 * reads as "generated" without being nameable.
 *
 * ## Why millimetres convert to a constant
 *
 * `MapView` measures its strokes in `unit = window / 100`, so a stroke keeps its width on
 * screen however small the crop. That is not a rendering trick, it is what printing at a
 * larger scale means: a 110 m window shown in the same box as a 420 m one *is* a
 * 1:3900 map, and ISOM widths are constant in millimetres of paper at every scale.
 *
 * So take the whole 420 m map as the 1:15000 reference: 420 m of ground is 28 mm of
 * paper, and `unit` is a hundredth of the window. One millimetre is therefore `100 / 28`
 * units, **whatever the window is**. Check it against the one width that was already
 * right: contour 0.14 mm x 3.571 = `unit * 0.5`.
 */
export const UNITS_PER_MM = 100 / 28;

/** The scale these millimetres are millimetres of. An `OMap` says which it was drawn for. */
export const ISOM_SCALE = 15000;

/** Width or length in `unit`s, from millimetres of paper. */
export const mm = (millimetres: number): number => millimetres * UNITS_PER_MM;

/**
 * Colours are the standard *screen* renderings, not conversions of the CMYK in the spec.
 * Brown is exact; the rest are the values every digital O map uses. (Naively inverting
 * ISOM's CMYK — as OpenOrienteering Mapper's symbol files do — turns green 100% into
 * `#3dff17`, which is a highlighter, not forest.)
 */
export const COLOUR = {
  ground: '#ffffff',
  brown: '#d15c00',
  blue: '#00a0c8',
  green: '#00a03c',
  yellow: '#ffba00',
  grey: '#b0b0b0',
  black: '#000000',
  /** Course overprint. Purple on paper, and the anchor a pexeso pair shares. */
  purple: '#e4007c',
} as const;

/**
 * Green screen percentages: 406 slow running, 408 walk, 410 fight.
 *
 * One flat wash of "thicket" throws away the whole point of green — it is a runnability
 * scale, and reading it is half of route choice.
 */
export const GREEN_SCREEN = { slow: 0.3, walk: 0.5, fight: 0.7 } as const;

/** 401 open land is full yellow; 403 rough open is a screen of it. */
export const YELLOW_SCREEN = { open: 1, rough: 0.5 } as const;

export const CONTOUR = {
  /** 101 */ width: mm(0.14),
  /** 102, every fifth line */ indexWidth: mm(0.25),
  /** 102: one index contour per this many ordinary ones. */
  indexEvery: 5,
  /** 103, dashed, between contours where the relief is too gentle for one. */
  formWidth: mm(0.1),
  formDash: [mm(2), mm(0.2)] as const,
  /** 101.1 — the tick that tells a depression from a knoll. */
  slopeTagWidth: mm(0.14),
  slopeTagLength: mm(0.35),
} as const;

export const POINT = {
  /** 109 small knoll, brown disc. */ knollRadius: mm(0.25),
  /** 204 boulder, black disc. */ boulderRadius: mm(0.2),
  /** 112 pit, brown triangle. */ pitRadius: mm(0.45),
  /** 202 cliff. */ cliffWidth: mm(0.25),
  cliffTagWidth: mm(0.12),
  cliffTagLength: mm(0.25),
  /** 418-ish distinctive vegetation feature, a green ring. */
  treeRadius: mm(0.35),
  treeWidth: mm(0.18),
} as const;

export const LINE = {
  /** 304 crossable watercourse. */ streamWidth: mm(0.3),
  /** 305 small crossable watercourse. */ smallStreamWidth: mm(0.18),
  /** 505 footpath. */ pathWidth: mm(0.25),
  pathDash: [mm(2), mm(0.25)] as const,
  /** 508 narrow ride: a dashed black line over a light background. */
  rideWidth: mm(0.14),
  rideDash: [mm(2), mm(0.25)] as const,
  rideBackground: mm(0.45),
  /** 516 fence: a solid line with ticks. */
  fenceWidth: mm(0.14),
  fenceTickSpacing: mm(2),
  fenceTickLength: mm(0.5),
} as const;

/**
 * 310 indistinct marsh: staggered rows of short horizontal blue dashes.
 *
 * Not a wash. Solid blue is open water, and to whoever is running the two mean opposite
 * things — one is crossable and slow, the other is a detour.
 */
export const MARSH = {
  rowSpacing: mm(0.6),
  /** Distance between dash starts along a row. */ pitch: mm(1.15),
  dashLength: mm(0.55),
  width: mm(0.25),
} as const;


/**
 * How each code is drawn.
 *
 * The renderer used to `switch` on the generator's `kind`, which meant only the sixteen
 * things the generator makes could ever be drawn. Keyed by code, an imported feature goes
 * through the same table, and a code the table does not know still draws — as the
 * plainest symbol of its geometry in its own colour class, which is what keeps a real map
 * legible on the day it arrives rather than one table row at a time.
 *
 * Widths and radii are the `mm()` values above, in `unit`s per unit of window; `MapView`
 * multiplies by `unit`. A symbol's picture is geometry and not only colour, so a point
 * names the primitive to draw — the app owns five of them, and a pit is a triangle
 * however the table is keyed.
 */
export interface AreaStyle {
  readonly geometry: 'area';
  /** 311 is a pattern and never a wash: solid blue is open water, and to whoever is
   *  running the two mean opposite things — one is crossable and slow, the other a detour. */
  readonly pattern?: 'marsh';
  readonly fill?: string;
  readonly opacity?: number;
}

export interface LineStyle {
  readonly geometry: 'line';
  readonly stroke: string;
  readonly width: number;
  readonly dash?: readonly [number, number];
  /** 508: the light corridor a ride is cut as, under its dashed line. */
  readonly casing?: { readonly stroke: string; readonly width: number };
  /** 516: the ticks that tell a fence from a path. */
  readonly ticks?: { readonly spacing: number; readonly length: number };
}

export interface PointStyle {
  readonly geometry: 'point';
  readonly shape: 'disc' | 'triangle' | 'ring' | 'cliff';
  readonly colour: string;
  readonly radius: number;
  readonly width?: number;
}

export type SymbolStyle = AreaStyle | LineStyle | PointStyle;

export const SYMBOL: Readonly<Record<IsomCode, SymbolStyle>> = {
  // Areas.
  '311': { geometry: 'area', pattern: 'marsh' },
  '401': { geometry: 'area', fill: COLOUR.yellow, opacity: YELLOW_SCREEN.open },
  '403': { geometry: 'area', fill: COLOUR.yellow, opacity: YELLOW_SCREEN.rough },
  '406': { geometry: 'area', fill: COLOUR.green, opacity: GREEN_SCREEN.slow },
  '408': { geometry: 'area', fill: COLOUR.green, opacity: GREEN_SCREEN.walk },
  '410': { geometry: 'area', fill: COLOUR.green, opacity: GREEN_SCREEN.fight },
  '212': { geometry: 'area', fill: COLOUR.grey, opacity: 0.5 },

  // Lines.
  '505': { geometry: 'line', stroke: COLOUR.black, width: LINE.pathWidth, dash: LINE.pathDash },
  '306': { geometry: 'line', stroke: COLOUR.blue, width: LINE.smallStreamWidth },
  '516': {
    geometry: 'line',
    stroke: COLOUR.black,
    width: LINE.fenceWidth,
    ticks: { spacing: LINE.fenceTickSpacing, length: LINE.fenceTickLength },
  },
  '508': {
    geometry: 'line',
    stroke: COLOUR.black,
    width: LINE.rideWidth,
    dash: LINE.rideDash,
    casing: { stroke: COLOUR.ground, width: LINE.rideBackground },
  },

  // Points.
  '206': { geometry: 'point', shape: 'disc', colour: COLOUR.black, radius: POINT.boulderRadius },
  '112': { geometry: 'point', shape: 'disc', colour: COLOUR.brown, radius: POINT.knollRadius },
  '116': { geometry: 'point', shape: 'triangle', colour: COLOUR.brown, radius: POINT.pitRadius },
  '418': {
    geometry: 'point', shape: 'ring', colour: COLOUR.green,
    radius: POINT.treeRadius, width: POINT.treeWidth,
  },
  '203': {
    geometry: 'point', shape: 'cliff', colour: COLOUR.black,
    radius: POINT.cliffWidth, width: POINT.cliffTagWidth,
  },
};

const PLAIN: Readonly<Record<'brown' | 'black' | 'blue' | 'green' | 'yellow' | 'grey' | 'purple', string>> = {
  brown: COLOUR.brown,
  black: COLOUR.black,
  blue: COLOUR.blue,
  green: COLOUR.green,
  yellow: COLOUR.yellow,
  grey: COLOUR.grey,
  purple: COLOUR.purple,
};

/**
 * The style for a code, or the plainest symbol of its colour class.
 *
 * An unknown code is not an error: ~120 symbols exist and sixteen are drawn here, so a
 * real map will arrive full of them. Drawing one plainly is what makes a map readable
 * from day one; fidelity then grows a row at a time, checked by eye on `#/dev/maps`.
 */
export function styleFor(code: IsomCode): SymbolStyle | undefined {
  const known = SYMBOL[code];
  if (known) return known;
  const semantics = semanticsOf(code);
  if (!semantics) return undefined;
  const colour = PLAIN[semantics.colour];
  if (semantics.geometry === 'area') return { geometry: 'area', fill: colour, opacity: 0.5 };
  if (semantics.geometry === 'line') return { geometry: 'line', stroke: colour, width: mm(0.14) };
  return { geometry: 'point', shape: 'disc', colour, radius: mm(0.25) };
}
