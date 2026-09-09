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
  /** Can a control sit on it? */
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
 * The sixteen codes the generator emits, plus the three contour codes.
 *
 * These are the aliases the design note fixes (`docs/real-maps-architecture.md` §2.1).
 * Where `isom.ts` names a different number beside a *drawing* constant — the boulder disc
 * is 204's, the knoll disc 109's — that is the picture the generator borrowed, not the
 * semantic key; the key is what a symbol table gives, and it is what an imported map will
 * arrive with.
 */
export const SEMANTICS: Readonly<Record<IsomCode, Semantics>> = {
  // Relief.
  '101': { code: '101', geometry: 'line', colour: 'brown', family: 'landform', reliefBound: true, minSizeMm: 0.14 },
  '102': { code: '102', geometry: 'line', colour: 'brown', family: 'landform', reliefBound: true, minSizeMm: 0.25 },
  '103': { code: '103', geometry: 'line', colour: 'brown', family: 'landform', reliefBound: true, minSizeMm: 0.1 },
  '112': {
    code: '112', geometry: 'point', colour: 'brown', family: 'landform',
    controlSite: true, reliefBound: true, minSizeMm: 0.5,
    ground: { at: 'maximum' },
  },
  '116': {
    code: '116', geometry: 'point', colour: 'brown', family: 'landform',
    controlSite: true, reliefBound: true, minSizeMm: 0.9,
    ground: { at: 'minimum' },
  },

  // Rock and boulders.
  '203': {
    code: '203', geometry: 'point', colour: 'black', family: 'rock',
    controlSite: true, reliefBound: true, minSizeMm: 0.5,
    ground: { slope: 'steepest', quantile: CRAG_STEEPEST },
  },
  // A boulder has **no** ground preference, and 203 does. A crag *is* a slope break, so
  // the table asks for steep ground; a boulder sits wherever the ice dropped it, and
  // asking the same of it pulled every scattered feature onto the one ridge and left the
  // rest of the map blank.
  '206': {
    code: '206', geometry: 'point', colour: 'black', family: 'rock',
    controlSite: true, minSizeMm: 0.4,
  },
  '212': {
    code: '212', geometry: 'area', colour: 'grey', family: 'rock',
    runnability: 0.8, minSizeMm: 1,
    ground: { slope: 'steepest', quantile: ROCK_STEEPEST },
  },

  // Water.
  '306': {
    code: '306', geometry: 'line', colour: 'blue', family: 'water',
    runnability: 0.7, controlSite: true, minSizeMm: 0.18,
  },
  '311': {
    code: '311', geometry: 'area', colour: 'blue', family: 'water',
    runnability: 0.6, controlSite: true, minSizeMm: 1,
    ground: { slope: 'flattest', quantile: MARSH_FLATTEST, low: true },
  },

  // Vegetation. Green is a runnability scale, so the three densities are three codes.
  '401': {
    code: '401', geometry: 'area', colour: 'yellow', family: 'vegetation',
    runnability: 1, minSizeMm: 1,
    ground: { slope: 'flattest', quantile: OPEN_MAX },
  },
  '403': {
    code: '403', geometry: 'area', colour: 'yellow', family: 'vegetation',
    runnability: 0.9, minSizeMm: 1,
    ground: { slope: 'flattest', quantile: OPEN_MAX },
  },
  '406': {
    code: '406', geometry: 'area', colour: 'green', family: 'vegetation',
    runnability: 0.7, minSizeMm: 1,
    // Vegetation grows anywhere the ground is not a crag.
    ground: { slope: 'flattest', quantile: VEGETATION_MAX },
  },
  '408': {
    code: '408', geometry: 'area', colour: 'green', family: 'vegetation',
    runnability: 0.5, minSizeMm: 1,
    ground: { slope: 'flattest', quantile: VEGETATION_MAX },
  },
  '410': {
    code: '410', geometry: 'area', colour: 'green', family: 'vegetation',
    runnability: 0.25, minSizeMm: 1,
    ground: { slope: 'flattest', quantile: VEGETATION_MAX },
  },
  '418': {
    code: '418', geometry: 'point', colour: 'green', family: 'vegetation',
    controlSite: true, minSizeMm: 0.7,
  },

  // Made by people.
  '505': { code: '505', geometry: 'line', colour: 'black', family: 'manmade', runnability: 1, minSizeMm: 0.25 },
  '508': { code: '508', geometry: 'line', colour: 'black', family: 'manmade', runnability: 1, minSizeMm: 0.14 },
  '516': {
    code: '516', geometry: 'line', colour: 'black', family: 'manmade',
    barrier: true, minSizeMm: 0.14,
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
 * mapping exists, a real map's `410.1` and a generated `fight` stop being the same thing
 * to the app, which is the whole point of the table above.
 */
export const CODE_OF: Readonly<Record<PointKind | LineKind | AreaKind, IsomCode>> = {
  boulder: '206',
  knoll: '112',
  pit: '116',
  crag: '203',
  tree: '418',
  marsh: '311',
  open: '401',
  rough: '403',
  slow: '406',
  walk: '408',
  fight: '410',
  rock: '212',
  path: '505',
  stream: '306',
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
