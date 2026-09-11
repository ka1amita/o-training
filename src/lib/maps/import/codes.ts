import { semanticsOf, type Colour, type IsomCode } from '@/lib/terrain/semantics.ts';
import type { Feature, MapType } from '@/lib/terrain/omap.ts';
import type { ParsedXmap, XmapObject, XmapSymbol } from './xmap.ts';

/**
 * A source's symbol codes onto the app's, and the report of what could not be resolved.
 *
 * ## Why an alias table exists at all
 *
 * `SEMANTICS` is **ISOM 2017-2** — see its own note — and a map is drawn to whichever
 * standard its surveyor had. The numbers moved between them, and not by a constant: ISOM
 * 2000's slope line 104 is 2017-2's 101.1, its boulder 206 is 204, its footpath 506 is
 * 505, and its fence 522 is 516. A code that lands in the wrong row is not a missing
 * symbol, it is a *wrong* one — a power line drawn as a fence, a marsh where a lake is —
 * so the translation happens once, here, at import, and the rest of the app only ever
 * sees canon.
 *
 * The tables are Mapper's own cross-reference tables read the other way round
 * (`symbol sets/ISOM2000-ISOM 2017-2.crt` and `symbol sets/ISOM 2017-2-ISSprOM 2019.crt`
 * in the OpenOrienteering repository), with the variant sub-codes folded onto the symbol
 * they are a variant of: this app does not distinguish an earth bank from an earth bank
 * at its minimum size, and a table that did would be a table with four rows nobody reads.
 *
 * ## Only for a symbol set that has been checked
 *
 * `detectSymbolSet` decides which layer applies. A set it cannot name passes its codes
 * **through unchanged**, which is the same choice the relief stage makes: a code that
 * lands in no table still draws in its own colour and is simply never chosen as an edit
 * target, and that is a great deal better than a guessed alias that silently turns a
 * power line into a fence.
 */
export type SymbolSet = 'ISOM2000' | 'ISOM2017' | 'ISSPROM2019';

export const ALIASES: Readonly<Record<SymbolSet, Readonly<Record<IsomCode, IsomCode>>>> = {
  /**
   * ISOM 2000 → 2017-2.
   *
   * The big one, and the one the forest sample needs. Two families shift wholesale: the
   * landforms lose the slope line and the contour value as numbers of their own, so
   * everything from the earth bank down moves two places; and the paths lose the motorway,
   * so the whole road ladder moves one. That second shift is why the generator's `505`
   * footpath, `508` ride and `516` fence were right all along — they were 2017-2 numbers
   * sitting in a table that called itself ISOM 2000.
   */
  ISOM2000: {
    // Relief. 104 is the tick on the low side of a closed contour, which Mapper carries
    // as 101.1 in its 2017-2 set and which `relief.ts` reads by that number.
    '104': '101.1',
    '105': '102',
    '106': '104',
    '106.0.1': '104',
    '106.1': '104',
    '106.1.1': '104',
    '106.2': '104',
    '107': '105',
    '108': '106',
    '109': '107',
    '110': '108',
    '112': '109',
    '113': '110',
    '115': '111',
    '116': '112',
    '117.1': '113.1',
    '117.2': '113.1',
    '118': '115',

    // Rock. An *area* of rock pillars has no line to be drawn along, so it goes to the
    // one area symbol 2017-2 has for solid rock rather than to the cliff line.
    '201.0.1': '201',
    '201.1': '201',
    '201.2': '201',
    '202': '206',
    '203': '202',
    '203.0.1': '202',
    '203.1': '202',
    '203.1.1': '202',
    '203.2': '202',
    '203.2.1': '202',
    '204': '203',
    '205': '203.2',
    '206': '204',
    '206.1': '204',
    '207': '205',
    '208': '208.1',
    '209': '207',
    '209.1': '207',
    '210': '210.1',
    '211': '213',
    '212': '214',

    // Water. 2000 numbered the marshes the other way about: its 309 is uncrossable and
    // its 311 indistinct, where 2017-2 runs 307 uncrossable, 308 marsh, 310 indistinct.
    '301.1': '301',
    '301.2': '301',
    '302': '301',
    '305': '304',
    '306': '305',
    '307': '306',
    '308': '309',
    '309': '307',
    '309.1': '307',
    '309.2': '307',
    '310': '308',
    '310.1': '308',
    '311': '310',
    '311.1': '310',
    '312': '311',
    '313': '312',
    '314': '313',

    // Vegetation. The three "runnable in one direction" areas are drawn as the density
    // they are, because the app has no way to say "but only northwards".
    '410.1': '410.4',
    '411.0': '406',
    '411.1': '408',
    '411.2': '410',
    '412': '413',
    '413': '414',
    '414': '415',
    '415': '412',
    '418': '419',
    '419': '417',
    '420': '418',

    // Made by people.
    '501.0': '502',
    '501.5': '502',
    '502.1': '502',
    '503': '502',
    '503.1': '502',
    '504': '503',
    '505': '504',
    '506': '505',
    '507': '506',
    '508': '507',
    '509': '508',
    '512': '512.2',
    '515': '509',
    '516': '510',
    '517': '511',
    '518': '512',
    '518.1': '512',
    '519': '513',
    '520': '514',
    '521': '515',
    '522': '516',
    '523': '517',
    '524': '518',
    '525': '519',
    '526': '521',
    '526.1': '521',
    '527': '520',
    '527.1': '520',
    '528': '520',
    '528.1': '520',
    '529': '501',
    '529.1': '501',
    '529.2': '501',
    '530': '523',
    '530.1': '523',
    '530.2': '523',
    // A firing range is a line nobody may cross, and 2017-2 has exactly one of those; a
    // grave is a cross, and 2017-2 draws whatever the standard has no symbol for as the
    // prominent man-made feature it is. Mapper's own table gives up on both.
    '531': '529',
    '532': '531',
    '533': '528',
    '534': '529',
    '535': '524',
    '536': '525',
    '537': '526',
    '538': '527',
    '539': '530',
    '540': '531',

    // Overprint.
    '705': '707',
    '707': '708',
    '710': '709',
  },

  /**
   * ISOM 2017 and 2017-2 → 2017-2.
   *
   * Identity for every whole number, which is the point of the canon. What it does say is
   * which **variant** codes are the same symbol here: a minimum-size earth bank, a cliff's
   * tag line and a building's outline are not symbols this app distinguishes, and folding
   * them onto the parent is what keeps a 2017-2 map resolving at a hundred per cent
   * rather than reporting twenty unresolved decorations.
   */
  ISOM2017: {
    '102.1': '102',
    '103.1': '101.1',
    '104.1': '104',
    '104.2': '104',
    '104.3': '104',
    '104.9': '104',
    '201.1': '201',
    '201.2': '201',
    '201.3': '201',
    '201.4': '201',
    '201.9': '201',
    '202.1': '202',
    '202.2': '202',
    '202.3': '202',
    '202.9': '202',
    '203.9': '203.2',
    '204.5': '204',
    '207.1': '207',
    '208.2': '208.1',
    '301.1': '301',
    '301.2': '301',
    '301.3': '301',
    '301.4': '301',
    '302.1': '302',
    '302.2': '302',
    '302.3': '302',
    '302.5': '302',
    '307.1': '307',
    '307.2': '307',
    '308.1': '308',
    '310.1': '310',
    '402.1': '402',
    '404.1': '404',
    '406.1': '406',
    '408.1': '408',
    '408.2': '408',
    '410.1': '410',
    '410.2': '410',
    '410.3': '410',
    '411.1': '411',
    '411.2': '411',
    '412.1': '412',
    '413.1': '413',
    '414.1': '414',
    '416.1': '416',
    '501.1': '501',
    '501.2': '501',
    '502.1': '502',
    '502.2': '502',
    '508.1': '508',
    '508.2': '508',
    '508.3': '508',
    '508.4': '508',
    '511.1': '511',
    '511.2': '511',
    '512.1': '512',
    '520.1': '520',
    '520.2': '520',
    '520.3': '520',
    '521.1': '521',
    '521.2': '521',
    '521.3': '521',
    '521.4': '521',
    '522.1': '522',
    '522.2': '522',
    '523.1': '523',
    '532.1': '532',
    '709.1': '709',
    '709.2': '709',
  },

  /**
   * ISSprOM 2019 → 2017-2.
   *
   * A sprint map is the same ground drawn under different rules, and the numbering mostly
   * agrees — but not where the rules differ, and those are exactly the rows that matter.
   * **410 is impassable vegetation under ISSprOM** and merely fight under ISOM, so it
   * lands on 411; the hedge 410.1 lands on the minimum-width fight line 410.4; and every
   * one of those canon rows carries `barrierStrict`, which is how "may not be crossed"
   * survives the translation when "expensive to cross" would not have.
   *
   * Paving is the other half. ISSprOM draws roads and paths as *areas with a footprint*
   * — 1.4 m, 2 m, 3 m, 4 m — where ISOM has a ladder of lines, so each width lands on the
   * line its width means. Two symbols have no 2017-2 meaning at all and keep their sprint
   * numbers instead of being flattened onto something they are not: `501.3` a paved area
   * with scattered trees, and `513.2` a passable retained wall, which is a wall and an
   * earth bank at once.
   */
  ISSPROM2019: {
    '102.1': '101.1',
    '102.2': '102',
    '104.1': '104',
    '104.2': '104',
    '113.2': '114',
    '113.6': '113.1',
    '201.1': '201',
    '201.3': '201',
    '201.4': '201',
    '201.8': '201',
    '201.9': '201',
    '202.1': '202',
    '202.2': '202',
    '202.3': '202',
    '202.4': '202',
    '202.8': '202',
    '202.9': '202',
    '203.1': '203.2',
    '203.9': '203.2',
    '207.1': '207',
    '208.2': '208.1',
    '208.5': '209',
    '210.2': '210',
    '210.3': '210.1',
    '301.1': '301',
    '301.2': '301',
    '301.3': '301',
    '301.6': '301',
    '302.1': '302',
    '302.6': '302',
    '307.1': '307',
    '307.2': '307',
    '308.1': '308',
    '310.1': '310',
    '402.1': '402',
    '404.1': '404',
    '406.1': '406',
    '406.2': '406',
    '408.1': '408',
    '408.2': '408',
    '408.3': '408',
    '410': '411',
    '410.1': '410.4',
    '412.1': '412',
    '413.1': '413',
    '414.1': '414',
    '501.1': '501',
    '501.2': '501',
    '501.5': '501',
    '501.6': '505',
    '501.7': '504',
    '501.8': '503',
    '501.9': '502',
    '501.10': '501',
    '501.11': '501',
    '501.12': '501',
    '501.16': '505',
    '501.17': '504',
    '501.18': '503',
    '501.19': '502',
    '505.1': '505',
    '505.2': '504',
    '509.1': '509',
    '509.2': '509',
    '511.1': '511',
    '512.1': '512',
    '512.2': '512',
    '513.1': '513',
    '520.1': '520',
    '521.1': '521',
    '521.3': '521',
    '521.4': '521',
    // A pillar holding up a canopy is a building's footprint and nothing else in ISOM.
    '522.1': '521',
    '522.3': '522',
    '522.4': '522',
    '532.6': '532',
    '532.7': '532',
    '532.8': '532',
    '532.9': '532',
    '714': '520',
    '714.1': '520',
  },
};

/** Which discipline a symbol set is for. ISSprOM is sprint; the rest are forest. */
export const MAP_TYPE_OF: Readonly<Record<SymbolSet, MapType>> = {
  ISOM2000: 'forest',
  ISOM2017: 'forest',
  ISSPROM2019: 'sprint',
};

/**
 * What `<symbols id=…>` calls each set, with the punctuation taken out.
 *
 * Mapper writes its own set's id into every file drawn with it — `ISOM2000`,
 * `ISOM 2017-2`, `ISSprOM 2019` — so on a map drawn in Mapper this is the whole answer,
 * and it is the one signal that does not depend on the surveyor working in English.
 */
const BY_ID: Readonly<Record<string, SymbolSet>> = {
  ISOM2000: 'ISOM2000',
  ISOM2017: 'ISOM2017',
  ISOM20172: 'ISOM2017',
  ISSPROM2019: 'ISSPROM2019',
};

const normalise = (id: string): string => id.replace(/[^a-z0-9]/gi, '').toUpperCase();

/**
 * A probe: a code the set has, and optionally what that set calls it.
 *
 * The name is a **substring, case-insensitively**, because the question is which of three
 * standards numbered this symbol, and "Vegetation: fight" against "Impassable vegetation"
 * answers it on one row. A code with no name is a code only one of the three sets has at
 * all, which is language-independent and is why the list carries both kinds.
 */
interface Probe {
  readonly code: IsomCode;
  readonly name?: string;
}

const PROBES: Readonly<Record<SymbolSet, readonly Probe[]>> = {
  ISOM2000: [
    { code: '116', name: 'pit' },
    { code: '206', name: 'boulder' },
    { code: '311', name: 'indistinct marsh' },
    { code: '509', name: 'narrow ride' },
    { code: '526', name: 'building' },
    { code: '117.1' },
    { code: '411.0' },
    { code: '529.2' },
  ],
  ISOM2017: [
    { code: '112', name: 'pit' },
    { code: '204', name: 'boulder' },
    { code: '202', name: 'cliff' },
    { code: '410', name: 'fight' },
    { code: '521', name: 'building' },
    { code: '114' },
    { code: '215' },
    { code: '508.1' },
  ],
  ISSPROM2019: [
    { code: '112', name: 'pit' },
    { code: '202', name: 'rock face' },
    { code: '410', name: 'impassable' },
    { code: '513.1', name: 'wall' },
    { code: '505.1' },
    { code: '532.6' },
    { code: '501.11' },
    { code: '714' },
  ],
};

export interface Detection {
  /** Undefined when nothing was recognised: the codes then pass through unchanged. */
  readonly set?: SymbolSet;
  readonly mapType: MapType;
  /** One line for the import log, so a wrong guess is visible rather than silent. */
  readonly reason: string;
}

/**
 * Which standard a parsed map was drawn to.
 *
 * The id first, then the symbols themselves. A map that names its set is believed; a map
 * that does not is scored against each set's probes and goes to the best, but only if it
 * beats the others outright and matched more than one probe — two standards share most of
 * their numbers, and a single coincidence is not evidence. Everything else resolves to
 * "no set", which aliases nothing.
 *
 * `override` is the escape hatch (`--symbol-set` in the import script) for a file that
 * lies or says nothing, and it is checked against nothing: someone who has read the
 * symbol table knows better than a heuristic.
 */
export function detectSymbolSet(parsed: ParsedXmap, override?: SymbolSet): Detection {
  if (override) {
    return { set: override, mapType: MAP_TYPE_OF[override], reason: `given as ${override}` };
  }

  const named = BY_ID[normalise(parsed.symbolSet)];
  if (named) {
    return {
      set: named,
      mapType: MAP_TYPE_OF[named],
      reason: `named by the file as "${parsed.symbolSet}"`,
    };
  }

  const byCode = new Map<string, string>();
  for (const symbol of parsed.symbols) {
    if (!byCode.has(symbol.code)) byCode.set(symbol.code, symbol.name.toLowerCase());
  }
  const scores = (Object.keys(PROBES) as SymbolSet[]).map((set) => ({
    set,
    score: PROBES[set].filter((probe) => {
      const name = byCode.get(probe.code);
      if (name === undefined) return false;
      return probe.name === undefined || name.includes(probe.name);
    }).length,
  }));
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0]!;
  const runnerUp = scores[1]!;
  if (best.score >= 2 && best.score > runnerUp.score) {
    return {
      set: best.set,
      mapType: MAP_TYPE_OF[best.set],
      reason: `read off the symbol names: ${best.set} on ${best.score} probes, ` +
        `next best ${runnerUp.set} on ${runnerUp.score}`,
    };
  }
  return {
    mapType: 'forest',
    reason: parsed.symbolSet
      ? `symbol set "${parsed.symbolSet}" is not one this app knows; codes pass through`
      : 'no symbol set named and the names do not say which; codes pass through',
  };
}

export interface Unresolved {
  readonly code: IsomCode;
  readonly name: string;
  readonly count: number;
  readonly colour?: Colour;
}

export interface Resolution {
  readonly features: readonly Feature[];
  /** How many features carry a code `SEMANTICS` knows. The rest still draw. */
  readonly resolved: number;
  /** Codes with no semantics, worst first — what the pipeline prints to stderr. */
  readonly unresolved: readonly Unresolved[];
  /** Every distinct code seen, resolved or not, in the order first met. */
  readonly codes: readonly IsomCode[];
}

/** One source code through the alias table for its symbol set. */
export const canonicalCode = (code: IsomCode, symbolSet?: SymbolSet): IsomCode =>
  (symbolSet ? ALIASES[symbolSet][code] : undefined) ?? code;

/**
 * Parsed objects into `Feature`s carrying codes the app understands.
 *
 * Ids are positional and stable within the map — `feature-0`, `feature-1` — because an
 * `Edit` names one and a bundle re-imported unchanged has to produce the same names or
 * every golden over a library round moves.
 *
 * A feature whose code resolves to nothing keeps that code and carries its **colour
 * class** instead, so `styleFor` can still draw it. Dropping it would be the tidier
 * option and the wrong one: about 190 ISOM symbols exist, the table knows a hundred, and
 * a map missing its buildings is not the map the surveyor drew.
 */
export function resolveSemantics(parsed: ParsedXmap, symbolSet?: SymbolSet): Resolution {
  const set = symbolSet ?? detectSymbolSet(parsed).set;
  const bySymbol = new Map<string, XmapSymbol>(parsed.symbols.map((s) => [s.id, s]));
  const features: Feature[] = [];
  const codes: IsomCode[] = [];
  const missing = new Map<IsomCode, { name: string; count: number; colour?: Colour }>();
  let resolved = 0;

  parsed.objects.forEach((object: XmapObject, index) => {
    const symbol = bySymbol.get(object.symbol);
    const code = canonicalCode(object.code, set);
    if (!codes.includes(code)) codes.push(code);

    const semantics = semanticsOf(code);
    if (semantics) resolved++;
    else {
      const seen = missing.get(code);
      if (seen) seen.count++;
      else {
        missing.set(code, {
          name: symbol?.name ?? '',
          count: 1,
          ...(symbol?.colour ? { colour: symbol.colour } : {}),
        });
      }
    }

    features.push({
      id: `feature-${index}`,
      code,
      geometry: object.geometry,
      // Only when the table cannot say: a known code's colour is the table's business,
      // and storing it twice is two places for it to disagree.
      ...(!semantics && symbol?.colour ? { colour: symbol.colour } : {}),
    });
  });

  const unresolved = [...missing.entries()]
    .map(([code, seen]): Unresolved => ({
      code,
      name: seen.name,
      count: seen.count,
      ...(seen.colour ? { colour: seen.colour } : {}),
    }))
    // Worst first, then by code, so the report is stable between runs.
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  return { features, resolved, unresolved, codes };
}
