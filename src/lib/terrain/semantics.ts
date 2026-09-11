import { sampleGridAt, slopeAt } from './height.ts';
import type { AreaKind, Ground, LineKind, PointKind, Vec } from './terrain.ts';

/**
 * What an ISOM symbol *means*, keyed by its code.
 *
 * One table, and it is the only place the app claims to understand a boulder, a marsh or
 * a cliff. The renderer asks it how to draw, the edit checks ask it where a thing may
 * legitimately be, and a real map's symbols will arrive already carrying these codes —
 * an OpenOrienteering `.xmap` names them on every symbol — so a generated feature and a
 * surveyed one go through the same rules rather than through two parallel `switch`es
 * that drift apart.
 *
 * Codes are strings, not a union: an unrecognised symbol from a real map must still
 * render and simply never be chosen as an edit target. `semanticsOf` returns undefined
 * for one, and every caller has a fallback.
 */
export type IsomCode = string;

export type Family = 'landform' | 'rock' | 'water' | 'vegetation' | 'manmade' | 'overprint';

/**
 * White is a colour here and not the absence of one: on an ISOM map it is **runnable
 * forest**, the ground everything else is the exception to, and an imported symbol inked
 * in it is a symbol meant not to show.
 */
export type Colour =
  | 'brown' | 'black' | 'blue' | 'green' | 'yellow' | 'grey' | 'purple' | 'white';

/**
 * Where a symbol may legitimately stand.
 *
 * Slope bars are **quantiles of this map**, never absolutes — see the note on the
 * constants below. `at` is the stronger claim a relief form makes: a knoll is on a rise
 * and a pit is in a hollow, whatever the slope around them says.
 */
export type GroundPreference =
  | { readonly slope: 'flattest' | 'steepest'; readonly quantile: number; readonly low?: boolean }
  | { readonly at: 'maximum' | 'minimum' };

export interface Semantics {
  readonly code: IsomCode;
  readonly geometry: 'point' | 'line' | 'area';
  readonly colour: Colour;
  /** What the symbol is *about*, for grouping and for "same category" difficulty. */
  readonly family: Family;
  /** 1 = white forest, 0 = impassable. Areas and lines only. The route-choice input. */
  readonly runnability?: number;
  /** A line you cannot cross: impassable cliff, high fence, uncrossable marsh border. */
  readonly barrier?: boolean;
  /**
   * A barrier that is **binding**, not advisory.
   *
   * Forest-O and sprint-O disagree about what "impassable" means, and it is a rule
   * difference rather than a drawing one: on a forest map an impassable cliff is a
   * statement about the ground, and a competitor who climbs it is merely foolish; under
   * ISSprOM it is a *rule*, and crossing an impassable wall, fence, hedge or out-of-bounds
   * area is a disqualification. So `barrier` stays the route-cost hint it always was and
   * this is the stronger claim, read together with `MapMeta.mapType`: on a sprint map a
   * strict barrier may not be crossed at all, on a forest map it is still only expensive.
   *
   * It says nothing about control sites. A control on the foot of an impassable cliff or
   * at the corner of a building is ordinary in both disciplines.
   */
  readonly barrierStrict?: boolean;
  /**
   * Can a control sit on it?
   *
   * The IOF control descriptions are the list, and it is longer than the sixteen things
   * the generator draws: a path bend, a clearing's corner, a wall, a stony-ground dot and
   * a boulder are all of them feature a description can name. Which *part* of the symbol
   * the circle goes on — a bend, a junction, an outline corner, never the middle of a
   * meadow — is geometry and belongs to the drill, not here.
   *
   * What is deliberately **not** a site: the contour lines themselves (the landform is the
   * feature, not the line that draws it), plain forest, and the out-of-bounds and course
   * overprint, which are rules printed over a map rather than things on the ground.
   */
  readonly controlSite?: boolean;
  /** Where this thing may legitimately be. */
  readonly ground?: GroundPreference;
  /**
   * A form of the ground rather than a thing standing on it: moving the ground moves it,
   * and it cannot be moved onto ground that does not have it. A boulder reads the ground
   * (it wants steep, broken ground) but is not a form of it, so it is not bound.
   */
  readonly reliefBound?: boolean;
  /** Drawn size in paper mm at the map's own scale — the salience floor. */
  readonly minSizeMm?: number;
}

/**
 * Where each kind of ground sits in **this map's own** slope distribution.
 *
 * Absolute thresholds were tried first and are wrong, because the regional tilt alone
 * ranges from 0.05 to 0.11 m/m: a steeply tilted map has no ground under an absolute
 * "flat enough for marsh" bar, so every marsh fell through to the unconditioned fallback
 * and landed anywhere — which is the behaviour the placement phase exists to remove. A
 * marsh belongs in the flattest ground *there is here*, and a crag on the steepest.
 */
const MARSH_FLATTEST = 0.25;
const ROCK_STEEPEST = 0.85;
export const CRAG_STEEPEST = 0.75;
const OPEN_MAX = 0.8;
const VEGETATION_MAX = 0.92;

/** A marsh is wet because water sits there, so it is also **low**: `low` reads this bar. */
const MARSH_LOWEST = 0.45;

/**
 * How far a point feature looks around itself to decide whether it is on a rise.
 *
 * Ten metres, not a grid step: what is wanted is the claim that survives a feature being
 * moved a few tens of metres — that the ground still agrees with the symbol. A knoll on a
 * hummock that is not quite the summit is a fine knoll; a knoll in a hollow is a
 * contradiction.
 */
const REACH = 10;

/**
 * The codes the app understands, generated or imported.
 *
 * ## Which standard these numbers are
 *
 * **ISOM 2017-2, and that is now the whole answer.** It was ISOM 2000 with two numbers
 * borrowed from elsewhere, documented as 2017-2 in one file and as 2000 in another, and
 * the confusion was a *version* confusion rather than a sprint-versus-forest one. The
 * canon is the current standard; every other numbering — ISOM 2000, the 2017 first
 * edition, ISSprOM 2019 — is aliased onto it at import by `maps/import/codes.ts`, which
 * is the only place a source's own numbers exist.
 *
 * Checked symbol by symbol against OpenOrienteering Mapper's own `ISOM 2017-2` symbol set
 * and its cross-reference tables (`symbol sets/ISOM2000-ISOM 2017-2.crt` and
 * `ISOM 2017-2-ISSprOM 2019.crt`), which is where the mapping in `codes.ts` comes from
 * too: 109 is a small knoll, 112 a pit, 202 a cliff, 204 a boulder, 214 bare rock, 305 a
 * small crossable watercourse, 310 an indistinct marsh, 417 a prominent large tree.
 *
 * The two that used to be the generator's private meanings are **the standard's** now,
 * which is the tell that 2017-2 was the right canon: **508** really is a narrow ride and
 * **516** really is a fence — under ISOM 2000 they were a less distinct small path and a
 * power line, and that is what `codes.ts` moves an imported 2000 map's codes out of.
 *
 * The renumbering the generator went through, once, in the commit that made this the
 * canon: boulder 206 → 204, knoll 112 → 109, pit 116 → 112, crag 203 → 202, tree
 * 418 → 417, marsh 311 → 310, stream 306 → 305, bare rock 212 → 214. Contours, the
 * vegetation scale, the footpath, the ride and the fence kept their numbers. **Nothing
 * about the generator's decisions moved with them** — where every feature stands, what
 * shape it has and which landform it belongs to hash the same with the code strings
 * taken out.
 *
 * ## Geometry is the standard's, not the generator's
 *
 * `geometry` is what the *symbol* is in ISOM: 202 is a line, because on a surveyed map a
 * cliff is drawn along the break it marks. The generator draws its crag as a point with a
 * size, and that is allowed — a `Feature` carries its own geometry and `styleFor` asks
 * for the picture of the geometry it has. The table's geometry is for grouping symbols,
 * not for deciding what is on the map.
 *
 * The rest of the table is what a forest or sprint map actually contains. An unrecognised
 * code still renders, in its own colour class from the map's colour table, and is simply
 * never chosen as an edit target: about 190 symbols exist in Mapper's set and a table
 * that has to be complete before a map can be opened is a table no map is ever opened
 * with.
 */
export const SEMANTICS: Readonly<Record<IsomCode, Semantics>> = {
  // -------------------------------------------------------------------------------------
  // Landforms. Brown.
  // -------------------------------------------------------------------------------------
  '101': { code: '101', geometry: 'line', colour: 'brown', family: 'landform', reliefBound: true, minSizeMm: 0.14 },
  /** The tick on the low side of a closed contour. The standard folds it into 101; Mapper
   *  numbers it 101.1, and `maps/import/relief.ts` reads it by that number. */
  '101.1': { code: '101.1', geometry: 'line', colour: 'brown', family: 'landform', reliefBound: true, minSizeMm: 0.14 },
  '102': { code: '102', geometry: 'line', colour: 'brown', family: 'landform', reliefBound: true, minSizeMm: 0.25 },
  '103': { code: '103', geometry: 'line', colour: 'brown', family: 'landform', reliefBound: true, minSizeMm: 0.1 },
  /** 104 earth bank, 105 earth wall, 106 ruined earth wall — 2017-2 shifted these two down
   *  from ISOM 2000's 106/107/108, because the slope line and the contour value stopped
   *  being numbers of their own. */
  '104': {
    code: '104', geometry: 'line', colour: 'brown', family: 'landform',
    reliefBound: true, controlSite: true, minSizeMm: 0.18,
  },
  '105': {
    code: '105', geometry: 'line', colour: 'brown', family: 'landform',
    reliefBound: true, controlSite: true, minSizeMm: 0.18,
  },
  '106': {
    code: '106', geometry: 'line', colour: 'brown', family: 'landform',
    reliefBound: true, controlSite: true, minSizeMm: 0.18,
  },
  '107': {
    code: '107', geometry: 'line', colour: 'brown', family: 'landform',
    reliefBound: true, controlSite: true, minSizeMm: 0.25,
  },
  '108': {
    code: '108', geometry: 'line', colour: 'brown', family: 'landform',
    reliefBound: true, controlSite: true, minSizeMm: 0.14,
  },
  /** 109 small knoll — the generator's `knoll`. */
  '109': {
    code: '109', geometry: 'point', colour: 'brown', family: 'landform',
    controlSite: true, reliefBound: true, minSizeMm: 0.5,
    ground: { at: 'maximum' },
  },
  '110': {
    code: '110', geometry: 'point', colour: 'brown', family: 'landform',
    controlSite: true, reliefBound: true, minSizeMm: 0.6,
    ground: { at: 'maximum' },
  },
  '111': {
    code: '111', geometry: 'point', colour: 'brown', family: 'landform',
    controlSite: true, reliefBound: true, minSizeMm: 0.8,
    ground: { at: 'minimum' },
  },
  /** 112 pit — the generator's `pit`. */
  '112': {
    code: '112', geometry: 'point', colour: 'brown', family: 'landform',
    controlSite: true, reliefBound: true, minSizeMm: 0.9,
    ground: { at: 'minimum' },
  },
  '113': {
    code: '113', geometry: 'area', colour: 'brown', family: 'landform',
    runnability: 0.8, controlSite: true, minSizeMm: 1,
  },
  /** The single dot the broken-ground pattern is made of, which a surveyor also places
   *  alone. A point, so it is not the area above. */
  '113.1': { code: '113.1', geometry: 'point', colour: 'brown', family: 'landform', controlSite: true, minSizeMm: 0.4 },
  '114': {
    code: '114', geometry: 'area', colour: 'brown', family: 'landform',
    runnability: 0.6, controlSite: true, minSizeMm: 1,
  },
  '115': { code: '115', geometry: 'point', colour: 'brown', family: 'landform', controlSite: true, minSizeMm: 0.6 },

  // -------------------------------------------------------------------------------------
  // Rock and boulders. Black, and grey where it is ground rather than a thing.
  // -------------------------------------------------------------------------------------
  '201': {
    code: '201', geometry: 'line', colour: 'black', family: 'rock',
    barrier: true, barrierStrict: true, reliefBound: true, controlSite: true, minSizeMm: 0.35,
  },
  /**
   * 202 cliff — the generator's `crag`, which draws it as a point with a size.
   *
   * A line in the standard and on every surveyed map, and that is what `geometry` says.
   * The generator's crag is a short mark across the slope and is a point feature; both
   * carry this code, because they are the same thing to a player and to the edit rules.
   */
  '202': {
    code: '202', geometry: 'line', colour: 'black', family: 'rock',
    controlSite: true, reliefBound: true, minSizeMm: 0.5,
    ground: { slope: 'steepest', quantile: CRAG_STEEPEST },
  },
  /** 203 rocky pit or cave. Mapper splits it into 203.1 without a distinct entrance and
   *  203.2 with one; a map that writes the bare number still resolves. */
  '203': {
    code: '203', geometry: 'point', colour: 'black', family: 'rock',
    controlSite: true, reliefBound: true, minSizeMm: 0.5,
    ground: { at: 'minimum' },
  },
  '203.1': {
    code: '203.1', geometry: 'point', colour: 'black', family: 'rock',
    controlSite: true, reliefBound: true, minSizeMm: 0.5,
    ground: { at: 'minimum' },
  },
  '203.2': {
    code: '203.2', geometry: 'point', colour: 'black', family: 'rock',
    controlSite: true, reliefBound: true, minSizeMm: 0.5,
  },
  // A boulder has **no** ground preference, and 202 does. A cliff *is* a slope break, so
  // the table asks for steep ground; a boulder sits wherever the ice dropped it, and
  // asking the same of it pulled every scattered feature onto the one ridge and left the
  // rest of the map blank.
  /** 204 boulder — the generator's `boulder`. */
  '204': {
    code: '204', geometry: 'point', colour: 'black', family: 'rock',
    controlSite: true, minSizeMm: 0.4,
  },
  '205': { code: '205', geometry: 'point', colour: 'black', family: 'rock', controlSite: true, minSizeMm: 0.6 },
  /** 206 gigantic boulder: an area, and one of the few things on a forest map you truly
   *  cannot cross. */
  '206': {
    code: '206', geometry: 'area', colour: 'black', family: 'rock',
    runnability: 0, barrier: true, barrierStrict: true, controlSite: true, minSizeMm: 1,
  },
  '207': { code: '207', geometry: 'point', colour: 'black', family: 'rock', controlSite: true, minSizeMm: 0.6 },
  '208': {
    code: '208', geometry: 'area', colour: 'black', family: 'rock',
    runnability: 0.6, controlSite: true, minSizeMm: 1,
  },
  /** The single triangle the boulder-field pattern is made of, which ISOM 2000 numbered
   *  208 outright and a surveyor also places alone. A point, so it is not the area. */
  '208.1': { code: '208.1', geometry: 'point', colour: 'black', family: 'rock', controlSite: true, minSizeMm: 0.6 },
  '209': {
    code: '209', geometry: 'area', colour: 'black', family: 'rock',
    runnability: 0.4, controlSite: true, minSizeMm: 1,
  },
  /** 210, 211, 212 stony ground: one symbol at three densities, which is a runnability
   *  scale exactly as the greens are. */
  '210': {
    code: '210', geometry: 'area', colour: 'black', family: 'rock',
    runnability: 0.8, controlSite: true, minSizeMm: 1,
  },
  '210.1': { code: '210.1', geometry: 'point', colour: 'black', family: 'rock', controlSite: true, minSizeMm: 0.35 },
  '211': {
    code: '211', geometry: 'area', colour: 'black', family: 'rock',
    runnability: 0.6, controlSite: true, minSizeMm: 1,
  },
  '212': {
    code: '212', geometry: 'area', colour: 'black', family: 'rock',
    runnability: 0.4, controlSite: true, minSizeMm: 1,
  },
  '213': {
    code: '213', geometry: 'area', colour: 'yellow', family: 'rock',
    runnability: 0.9, controlSite: true, minSizeMm: 1,
  },
  /** 214 bare rock — the generator's `rock`. */
  '214': {
    code: '214', geometry: 'area', colour: 'grey', family: 'rock',
    runnability: 0.8, controlSite: true, minSizeMm: 1,
    ground: { slope: 'steepest', quantile: ROCK_STEEPEST },
  },
  '215': {
    code: '215', geometry: 'line', colour: 'black', family: 'rock',
    controlSite: true, reliefBound: true, minSizeMm: 0.1,
  },

  // -------------------------------------------------------------------------------------
  // Water. A body of it is a barrier, and that is a route-choice fact before it is a
  // drawing one.
  // -------------------------------------------------------------------------------------
  '301': {
    code: '301', geometry: 'area', colour: 'blue', family: 'water',
    runnability: 0, barrier: true, barrierStrict: true, controlSite: true, minSizeMm: 1,
    ground: { slope: 'flattest', quantile: MARSH_FLATTEST, low: true },
  },
  '302': {
    code: '302', geometry: 'area', colour: 'blue', family: 'water',
    runnability: 0.4, controlSite: true, minSizeMm: 1,
    ground: { slope: 'flattest', quantile: MARSH_FLATTEST, low: true },
  },
  '303': { code: '303', geometry: 'point', colour: 'blue', family: 'water', controlSite: true, minSizeMm: 0.5 },
  '304': {
    code: '304', geometry: 'line', colour: 'blue', family: 'water',
    runnability: 0.7, controlSite: true, minSizeMm: 0.3,
  },
  /** 305 small crossable watercourse — the generator's `stream`. */
  '305': {
    code: '305', geometry: 'line', colour: 'blue', family: 'water',
    runnability: 0.7, controlSite: true, minSizeMm: 0.18,
  },
  '306': {
    code: '306', geometry: 'line', colour: 'blue', family: 'water',
    runnability: 0.9, controlSite: true, minSizeMm: 0.18,
  },
  '307': {
    code: '307', geometry: 'area', colour: 'blue', family: 'water',
    runnability: 0, barrier: true, barrierStrict: true, controlSite: true, minSizeMm: 1,
    ground: { slope: 'flattest', quantile: MARSH_FLATTEST, low: true },
  },
  '308': {
    code: '308', geometry: 'area', colour: 'blue', family: 'water',
    runnability: 0.5, controlSite: true, minSizeMm: 1,
    ground: { slope: 'flattest', quantile: MARSH_FLATTEST, low: true },
  },
  '309': {
    code: '309', geometry: 'line', colour: 'blue', family: 'water',
    runnability: 0.6, controlSite: true, minSizeMm: 0.1,
  },
  /** 310 indistinct marsh — the generator's `marsh`. */
  '310': {
    code: '310', geometry: 'area', colour: 'blue', family: 'water',
    runnability: 0.6, controlSite: true, minSizeMm: 1,
    ground: { slope: 'flattest', quantile: MARSH_FLATTEST, low: true },
  },
  '311': { code: '311', geometry: 'point', colour: 'blue', family: 'water', controlSite: true, minSizeMm: 0.5 },
  '312': { code: '312', geometry: 'point', colour: 'blue', family: 'water', controlSite: true, minSizeMm: 0.5 },
  '313': { code: '313', geometry: 'point', colour: 'blue', family: 'water', controlSite: true, minSizeMm: 0.5 },

  // -------------------------------------------------------------------------------------
  // Vegetation. Green is a runnability scale, so the densities are separate codes; white
  // is a colour and 405 is the runnable forest everything else is the exception to.
  // -------------------------------------------------------------------------------------
  '401': {
    code: '401', geometry: 'area', colour: 'yellow', family: 'vegetation',
    runnability: 1, controlSite: true, minSizeMm: 1,
    ground: { slope: 'flattest', quantile: OPEN_MAX },
  },
  '402': {
    code: '402', geometry: 'area', colour: 'yellow', family: 'vegetation',
    runnability: 1, controlSite: true, minSizeMm: 1,
    ground: { slope: 'flattest', quantile: OPEN_MAX },
  },
  '403': {
    code: '403', geometry: 'area', colour: 'yellow', family: 'vegetation',
    runnability: 0.9, controlSite: true, minSizeMm: 1,
    ground: { slope: 'flattest', quantile: OPEN_MAX },
  },
  '404': {
    code: '404', geometry: 'area', colour: 'yellow', family: 'vegetation',
    runnability: 0.9, controlSite: true, minSizeMm: 1,
    ground: { slope: 'flattest', quantile: OPEN_MAX },
  },
  '405': { code: '405', geometry: 'area', colour: 'white', family: 'vegetation', runnability: 1, minSizeMm: 1 },
  '406': {
    code: '406', geometry: 'area', colour: 'green', family: 'vegetation',
    runnability: 0.7, controlSite: true, minSizeMm: 1,
    // Vegetation grows anywhere the ground is not a cliff.
    ground: { slope: 'flattest', quantile: VEGETATION_MAX },
  },
  '407': {
    code: '407', geometry: 'area', colour: 'green', family: 'vegetation',
    runnability: 0.6, controlSite: true, minSizeMm: 1,
    ground: { slope: 'flattest', quantile: VEGETATION_MAX },
  },
  '408': {
    code: '408', geometry: 'area', colour: 'green', family: 'vegetation',
    runnability: 0.5, controlSite: true, minSizeMm: 1,
    ground: { slope: 'flattest', quantile: VEGETATION_MAX },
  },
  '409': {
    code: '409', geometry: 'area', colour: 'green', family: 'vegetation',
    runnability: 0.4, controlSite: true, minSizeMm: 1,
    ground: { slope: 'flattest', quantile: VEGETATION_MAX },
  },
  '410': {
    code: '410', geometry: 'area', colour: 'green', family: 'vegetation',
    runnability: 0.25, controlSite: true, minSizeMm: 1,
    ground: { slope: 'flattest', quantile: VEGETATION_MAX },
  },
  /** 410.4 fight vegetation at its minimum width — a hedge, and under ISSprOM the
   *  impassable one every sprint map is full of. */
  '410.4': {
    code: '410.4', geometry: 'line', colour: 'green', family: 'vegetation',
    runnability: 0, barrier: true, barrierStrict: true, controlSite: true, minSizeMm: 0.25,
  },
  '411': {
    code: '411', geometry: 'area', colour: 'green', family: 'vegetation',
    runnability: 0, barrier: true, barrierStrict: true, controlSite: true, minSizeMm: 1,
  },
  '412': { code: '412', geometry: 'area', colour: 'yellow', family: 'vegetation', runnability: 0.9, controlSite: true, minSizeMm: 1 },
  '413': { code: '413', geometry: 'area', colour: 'yellow', family: 'vegetation', runnability: 0.9, controlSite: true, minSizeMm: 1 },
  '414': { code: '414', geometry: 'area', colour: 'yellow', family: 'vegetation', runnability: 0.7, controlSite: true, minSizeMm: 1 },
  '415': { code: '415', geometry: 'line', colour: 'black', family: 'vegetation', controlSite: true, minSizeMm: 0.14 },
  '416': {
    code: '416', geometry: 'line', colour: 'green', family: 'vegetation',
    controlSite: true, minSizeMm: 0.25,
  },
  /** 417 prominent large tree — the generator's `tree`, and drawn to this symbol's own
   *  ring: 0.27 mm inner radius, 0.18 mm wide, in green. */
  '417': { code: '417', geometry: 'point', colour: 'green', family: 'vegetation', controlSite: true, minSizeMm: 0.7 },
  '418': { code: '418', geometry: 'point', colour: 'green', family: 'vegetation', controlSite: true, minSizeMm: 0.5 },
  '419': { code: '419', geometry: 'point', colour: 'green', family: 'vegetation', controlSite: true, minSizeMm: 0.7 },

  // -------------------------------------------------------------------------------------
  // Made by people. 2017-2 shifted the whole road ladder down one from ISOM 2000, which
  // is why the generator's 505 footpath was right all along and its 508 and 516 with it.
  // -------------------------------------------------------------------------------------
  '501': { code: '501', geometry: 'area', colour: 'grey', family: 'manmade', runnability: 1, controlSite: true, minSizeMm: 1 },
  /**
   * ISSprOM's paved area with scattered trees.
   *
   * One of two rows that keep a **sprint** number because 2017-2 has no symbol that means
   * this; `513.2` below is the other. Both are numbers 2017-2 does not use at all, which
   * is the condition for keeping one — ISSprOM's `501.2`, a paved area inside a multilevel
   * structure, is *not*, because 2017-2's own `501.2` is a paved area's bounding line, so
   * that one is aliased onto plain paving instead of quietly redefining a number.
   */
  '501.3': { code: '501.3', geometry: 'area', colour: 'grey', family: 'manmade', runnability: 1, controlSite: true, minSizeMm: 1 },
  '502': { code: '502', geometry: 'line', colour: 'black', family: 'manmade', runnability: 1, controlSite: true, minSizeMm: 0.3 },
  '503': { code: '503', geometry: 'line', colour: 'black', family: 'manmade', runnability: 1, controlSite: true, minSizeMm: 0.35 },
  '504': { code: '504', geometry: 'line', colour: 'black', family: 'manmade', runnability: 1, controlSite: true, minSizeMm: 0.35 },
  /** 505 footpath — the generator's `path`. */
  '505': { code: '505', geometry: 'line', colour: 'black', family: 'manmade', runnability: 1, controlSite: true, minSizeMm: 0.25 },
  '506': { code: '506', geometry: 'line', colour: 'black', family: 'manmade', runnability: 1, controlSite: true, minSizeMm: 0.18 },
  '507': { code: '507', geometry: 'line', colour: 'black', family: 'manmade', runnability: 1, controlSite: true, minSizeMm: 0.18 },
  /** 508 narrow ride — the generator's `ride`, and the standard's own meaning for the
   *  number since 2017. */
  '508': { code: '508', geometry: 'line', colour: 'black', family: 'manmade', runnability: 1, controlSite: true, minSizeMm: 0.14 },
  '509': { code: '509', geometry: 'line', colour: 'black', family: 'manmade', runnability: 0.9, controlSite: true, minSizeMm: 0.25 },
  '510': { code: '510', geometry: 'line', colour: 'black', family: 'manmade', controlSite: true, minSizeMm: 0.14 },
  '511': { code: '511', geometry: 'line', colour: 'black', family: 'manmade', controlSite: true, minSizeMm: 0.4 },
  '512': { code: '512', geometry: 'line', colour: 'black', family: 'manmade', controlSite: true, minSizeMm: 0.18 },
  /** 512.2 footbridge: a point, where 512 is the line a bridge or tunnel is drawn as. */
  '512.2': { code: '512.2', geometry: 'point', colour: 'black', family: 'manmade', controlSite: true, minSizeMm: 0.5 },
  '513': { code: '513', geometry: 'line', colour: 'black', family: 'manmade', controlSite: true, minSizeMm: 0.14 },
  /** ISSprOM's passable retained wall — a wall that is also an earth bank. 2017-2 has one
   *  or the other and no symbol for both, so this keeps the sprint number. */
  '513.2': {
    code: '513.2', geometry: 'line', colour: 'black', family: 'manmade',
    reliefBound: true, controlSite: true, minSizeMm: 0.14,
  },
  '514': { code: '514', geometry: 'line', colour: 'black', family: 'manmade', controlSite: true, minSizeMm: 0.14 },
  '515': {
    code: '515', geometry: 'line', colour: 'black', family: 'manmade',
    barrier: true, barrierStrict: true, controlSite: true, minSizeMm: 0.25,
  },
  /**
   * 516 fence — the generator's `fence`.
   *
   * A barrier and not a strict one: a fence is crossable under both sets of rules, and it
   * is here as the route cost it is. 518 is the one that is binding.
   */
  '516': {
    code: '516', geometry: 'line', colour: 'black', family: 'manmade',
    barrier: true, controlSite: true, minSizeMm: 0.14,
  },
  '517': { code: '517', geometry: 'line', colour: 'black', family: 'manmade', controlSite: true, minSizeMm: 0.14 },
  '518': {
    code: '518', geometry: 'line', colour: 'black', family: 'manmade',
    barrier: true, barrierStrict: true, controlSite: true, minSizeMm: 0.25,
  },
  '519': { code: '519', geometry: 'point', colour: 'black', family: 'manmade', controlSite: true, minSizeMm: 0.5 },
  /** 520 area that shall not be entered: olive, which classifies out of the ink as green,
   *  and forbidden rather than merely slow. */
  '520': {
    code: '520', geometry: 'area', colour: 'green', family: 'manmade',
    runnability: 0, barrier: true, barrierStrict: true, minSizeMm: 1,
  },
  '521': {
    code: '521', geometry: 'area', colour: 'black', family: 'manmade',
    runnability: 0, barrier: true, barrierStrict: true, controlSite: true, minSizeMm: 1,
  },
  /** 522 canopy: a roof over ground you can run under, so it is not a barrier. */
  '522': {
    code: '522', geometry: 'area', colour: 'black', family: 'manmade',
    runnability: 0.9, controlSite: true, minSizeMm: 1,
  },
  '523': { code: '523', geometry: 'line', colour: 'black', family: 'manmade', controlSite: true, minSizeMm: 0.16 },
  '524': { code: '524', geometry: 'point', colour: 'black', family: 'manmade', controlSite: true, minSizeMm: 0.7 },
  '525': { code: '525', geometry: 'point', colour: 'black', family: 'manmade', controlSite: true, minSizeMm: 0.5 },
  '526': { code: '526', geometry: 'point', colour: 'black', family: 'manmade', controlSite: true, minSizeMm: 0.5 },
  '527': { code: '527', geometry: 'point', colour: 'black', family: 'manmade', controlSite: true, minSizeMm: 0.5 },
  '528': { code: '528', geometry: 'line', colour: 'black', family: 'manmade', controlSite: true, minSizeMm: 0.14 },
  '529': {
    code: '529', geometry: 'line', colour: 'black', family: 'manmade',
    barrier: true, barrierStrict: true, controlSite: true, minSizeMm: 0.25,
  },
  '530': { code: '530', geometry: 'point', colour: 'black', family: 'manmade', controlSite: true, minSizeMm: 0.5 },
  '531': { code: '531', geometry: 'point', colour: 'black', family: 'manmade', controlSite: true, minSizeMm: 0.5 },
  '532': {
    code: '532', geometry: 'line', colour: 'black', family: 'manmade',
    runnability: 1, controlSite: true, minSizeMm: 0.4,
  },

  // -------------------------------------------------------------------------------------
  // Overprint. A course is printed over the map, in purple, and out of bounds is the only
  // part of it the app reads as ground.
  // -------------------------------------------------------------------------------------
  '707': { code: '707', geometry: 'line', colour: 'purple', family: 'overprint', minSizeMm: 0.35 },
  '708': {
    code: '708', geometry: 'line', colour: 'purple', family: 'overprint',
    barrier: true, barrierStrict: true, minSizeMm: 0.35,
  },
  '709': {
    code: '709', geometry: 'area', colour: 'purple', family: 'overprint',
    runnability: 0, barrier: true, barrierStrict: true, minSizeMm: 1,
  },
};

/**
 * How strongly each colour separates from the white forest it is drawn on.
 *
 * The input to salience, and the reason a moved boulder is a fairer question than a moved
 * form line at the same distance: black on white is the strongest mark ISOM has, and a
 * light yellow wash is the weakest. Eyeballed, not measured — it orders the colours, and
 * nothing yet depends on the gaps between them.
 */
export const CONTRAST: Readonly<Record<Colour, number>> = {
  black: 1,
  purple: 0.9,
  brown: 0.7,
  blue: 0.6,
  green: 0.5,
  grey: 0.4,
  yellow: 0.35,
  // Not zero, because a white symbol still has an outline and a shape, but as near to
  // invisible as this scale goes: it is the ground the rest is drawn on.
  white: 0.05,
};

export function semanticsOf(code: IsomCode): Semantics | undefined {
  return SEMANTICS[code];
}

/**
 * The generator's own vocabulary, resolved to codes — in **one place**.
 *
 * `kind` stays on a generated feature for now because the tests and the tracer still
 * speak it, but nothing may derive a code from a kind anywhere else: the moment a second
 * mapping exists, a real map's `410` and a generated `fight` stop being the same thing
 * to the app, which is the whole point of the table above.
 *
 * Every number here is ISOM 2017-2, and that is the only claim it makes: the generator
 * decides what to draw and where, and then says which symbol it drew — so renumbering
 * this table changed sixteen strings and no decision.
 */
export const CODE_OF: Readonly<Record<PointKind | LineKind | AreaKind, IsomCode>> = {
  boulder: '204',
  knoll: '109',
  pit: '112',
  crag: '202',
  tree: '417',
  marsh: '310',
  open: '401',
  rough: '403',
  slow: '406',
  walk: '408',
  fight: '410',
  rock: '214',
  path: '505',
  stream: '305',
  fence: '516',
  ride: '508',
};

/**
 * Whether the ground at `p` agrees with the symbol.
 *
 * This is the whole of "plausible combinations": a marsh is wet because water sits there,
 * so it is in a hollow and it is flat; bare rock is exposed because nothing holds soil on
 * it, so it is steep. Placed uniformly at random, a marsh halfway up a hillside is the
 * kind of wrongness an orienteer sees instantly without being able to name.
 *
 * A code the table does not know — and every code with nothing to say about the ground,
 * a tree or a path — suits everywhere, because refusing to place what we cannot judge
 * would empty a real map of everything but the sixteen symbols this generator draws.
 */
export function suits(code: IsomCode, ground: Ground, p: Vec): boolean {
  const preference = semanticsOf(code)?.ground;
  if (!preference) return true;

  if ('at' in preference) {
    const here = sampleGridAt(ground.grid, p.x, p.y);
    const around =
      [[REACH, 0], [-REACH, 0], [0, REACH], [0, -REACH]]
        .reduce((sum, [dx, dy]) => sum + sampleGridAt(ground.grid, p.x + dx!, p.y + dy!), 0) / 4;
    return preference.at === 'maximum' ? here > around : here < around;
  }

  const slope = slopeAt(ground.grid, p.x, p.y);
  const bar = ground.slopeQuantile(preference.quantile);
  if (preference.slope === 'flattest' ? !(slope < bar) : !(slope > bar)) return false;
  if (preference.low && !(sampleGridAt(ground.grid, p.x, p.y) < ground.quantile(MARSH_LOWEST))) {
    return false;
  }
  return true;
}
