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
