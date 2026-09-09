import { semanticsOf, type Colour, type IsomCode } from '@/lib/terrain/semantics.ts';
import type { Feature } from '@/lib/terrain/omap.ts';
import type { ParsedXmap, XmapObject, XmapSymbol } from './xmap.ts';

/**
 * A source's symbol codes onto the app's, and the report of what could not be resolved.
 *
 * ## Why an alias table exists at all
 *
 * `SEMANTICS` is ISOM 2000 numbering — see its own note; the generator's codes were
 * already that. Two of them are not: **508** is a narrow ride there and a less distinct
 * small path in the standard, **516** a fence there and a power line in the standard.
 * They cannot move: every golden hash in the suite is over generated features carrying
 * them. So the imported codes move instead, and this is the table that moves them.
 *
 * The rest of the entries are the real thing the design note asks for — where ISOM 2000
 * and ISOM 2017-2 genuinely renumbered the same symbol, the slope line 104 → 101.1 being
 * the one it names.
 *
 * ## Only for a symbol set we have checked
 *
 * Keyed by `<symbols id=…>`. `ISOM2000` was checked symbol by symbol against Mapper's own
 * set. Anything else passes its codes **through unchanged**, which is the same choice the
 * relief stage makes: a code that lands in no table still draws in its own colour and is
 * simply never chosen as an edit target, and that is a great deal better than a guessed
 * alias that silently turns a power line into a fence.
 */
export const ALIASES: Readonly<Record<string, Readonly<Record<IsomCode, IsomCode>>>> = {
  ISOM2000: {
    // The renumbering the design note names: the tick on the low side of a contour.
    '104': '101.1',
    // Out of the way of the generator's two. A less distinct small path is drawn as the
    // small path it is a less distinct version of — one step of generalisation, and the
    // alternative is drawing it as a ride.
    '508': '507',
    // ISOM 2000's power lines are 516 and 517, which are the fence and the ruined fence
    // in 2017-2 and in this app. Onto the 2017-2 numbers, which nothing here uses.
    '516': '511',
    '517': '512',
    // ...and the fences onto the app's one fence code, which is already a barrier.
    '522': '516',
    '523': '517',
    '524': '516',
    // 511/512 in ISOM 2000 are the footbridge and the railway's neighbours; leave them.
  },
};

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
export const canonicalCode = (code: IsomCode, symbolSet: string): IsomCode =>
  ALIASES[symbolSet]?.[code] ?? code;

/**
 * Parsed objects into `Feature`s carrying codes the app understands.
 *
 * Ids are positional and stable within the map — `feature-0`, `feature-1` — because an
 * `Edit` names one and a bundle re-imported unchanged has to produce the same names or
 * every golden over a library round moves.
 *
 * A feature whose code resolves to nothing keeps that code and carries its **colour
 * class** instead, so `styleFor` can still draw it. Dropping it would be the tidier
 * option and the wrong one: 120 ISOM symbols exist, the table knows ninety, and a map
 * missing its buildings is not the map the surveyor drew.
 */
export function resolveSemantics(parsed: ParsedXmap): Resolution {
  const bySymbol = new Map<string, XmapSymbol>(parsed.symbols.map((s) => [s.id, s]));
  const features: Feature[] = [];
  const codes: IsomCode[] = [];
  const missing = new Map<IsomCode, { name: string; count: number; colour?: Colour }>();
  let resolved = 0;

  parsed.objects.forEach((object: XmapObject, index) => {
    const symbol = bySymbol.get(object.symbol);
    const code = canonicalCode(object.code, parsed.symbolSet);
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
