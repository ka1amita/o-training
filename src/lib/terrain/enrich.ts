import type { Rng } from '@/lib/rng.ts';
import { insidePolygon } from './analysis.ts';
import {
  difference, plausibilityOf, proposeEdit, suitsAt,
  type Edit, type Plausibility,
} from './edits.ts';
import {
  areasOf, boundsOf, insideCrop, linesOf, pointsOf, positionOf,
  type Crop, type Feature, type OMap, type Vec,
} from './omap.ts';
import { SEMANTICS, semanticsOf, type IsomCode } from './semantics.ts';
import { MIN_POINT_SEPARATION, separationOf } from './terrain.ts';

/**
 * Adjusting a real map: the edits that make a surveyed window busier, as a pure function.
 *
 * A surveyed map is not a generated one with better cartography — it is a map of ground
 * that happens to have nothing on it in places. Mapper's own forest sample carries 538
 * features and **32 point features** in 554 metres of forest, of which twelve are one
 * vegetation symbol; a three-hundred-metre window onto it routinely offers one nameable
 * kind where a level asks for four. Enrichment is what buys those kinds back without
 * giving up the thing a real map is for, which is that a human surveyed it.
 *
 * Two rules hold the whole module up:
 *
 *  - **Deterministic.** Same map, same window, same rng state, same edits. The edits are
 *    what a round is made of — `applyEdits` is the only thing that ever produces the map
 *    the player sees — so a round stays a function of `(seed, level, provider.id)` and
 *    the id can name what was done by hashing the list.
 *  - **Plausible.** Every added symbol stands where `suits` says it may, at the spacing
 *    print legibility asks for (`separationOf`), and never inside something that
 *    contradicts it — no boulder in a lake, none in a building, none in the middle of a
 *    car park. An implausible symbol is a **tell**: a player learns to find the odd thing
 *    by spotting the marsh on the hillside rather than by reading the ground, which is a
 *    different skill and not the one being trained.
 *
 * Nothing here knows about drills. The adjusted map source calls it to make a window
 * worth a card; the discrepancy drill calls it to make a window worth a question, and the
 * edits it gets back are its answer key.
 */

/** How many of each operation a level is worth. `budgetFor` sets it; intensity scales it. */
export interface EnrichmentBudget {
  readonly adds: number;
  readonly removes: number;
  readonly swaps: number;
  readonly moves: number;
}

/**
 * A level, as a budget.
 *
 * Level 1 is a couple of added symbols and nothing else: at the bottom of the ladder the
 * point is that the window has enough on it to ask a question about, not that the map has
 * been meddled with. Level 10 is several of each, which is where a discrepancy round has
 * enough to look for. Removing, swapping and moving start at zero on purpose — they take
 * something away from a map that was surveyed, and that is a cost a low level should not
 * pay for detail it can get by adding.
 */
export function budgetFor(level: number): EnrichmentBudget {
  const clamped = Math.min(10, Math.max(1, level));
  const scale = (low: number, high: number) =>
    Math.round(low + ((high - low) * (clamped - 1)) / 9);
  return {
    adds: scale(2, 6),
    removes: scale(0, 3),
    swaps: scale(0, 3),
    moves: scale(0, 3),
  };
}

/**
 * The same budget, turned down.
 *
 * Rounded rather than floored, so that a slider at 10% still does something on a level
 * that asks for two of an operation. **Zero is exactly nothing** — `proposeEnrichment`
 * with an empty budget proposes no edits and draws no numbers, which is what makes the
 * adjusted source at intensity 0 the real source draw for draw.
 */
export const scaledBy = (budget: EnrichmentBudget, intensity: number): EnrichmentBudget => {
  const share = Math.min(1, Math.max(0, intensity));
  const of = (count: number) => Math.round(count * share);
  return {
    adds: of(budget.adds),
    removes: of(budget.removes),
    swaps: of(budget.swaps),
    moves: of(budget.moves),
  };
};

/**
 * How visible an edit has to be to be worth making, in paper millimetres times contrast.
 *
 * `difference().salience` is the ISOM minimum size of what changed against the contrast
 * of its colour class, so this is one number over both. At 0.3 what falls out is the ink
 * that was never going to be seen: 405 white forest scores 0.05, a 103 form line 0.07, and
 * a single added boulder scores 0.8. It is the floor the whole module shares — an edit
 * nobody can see is not enrichment and, for the discrepancy drill, is a target with no
 * answer.
 */
export const MIN_SALIENCE = 0.3;

/** How many placements each added symbol gets before its budget slot is given up. */
const ADD_ATTEMPTS = 24;
/** How many draws a remove, a swap or a move gets. Shorter: these draw from a known pool. */
const EDIT_ATTEMPTS = 12;

/** Below this many already in the window, a symbol still counts as one the window lacks. */
const SCARCE = 2;

/**
 * How far a `move` slides a feature, as a share of the window.
 *
 * A surveyor's disagreement, not a relocation: about 24 m on a 300 m card. Far enough to
 * read as a different map, near enough that the symbol is still on the ground that suits
 * it — which is checked rather than assumed.
 */
const MOVE_FRACTION = 0.08;

/**
 * The symbols enrichment may invent, as ISOM codes.
 *
 * Derived from `SEMANTICS` rather than listed, so a code added to the table is a code this
 * can place: every **point** symbol a control description can name, in the four families
 * that describe ground rather than what people built on it. Two exclusions, both
 * deliberate:
 *
 *  - **Made by people.** A tower, a monument, a ruin or a feeding rack exists because
 *    somebody built it there. The ground has no opinion about that, so `suits` cannot
 *    judge one, and a symbol whose plausibility nothing can check is one this must not
 *    invent.
 *  - **The special-feature symbols** (115, 313, 419). They mean whatever the map's legend
 *    says they mean. Placing one is writing a legend entry the map does not have.
 *
 * Sorted, because the pool is drawn from with `rng.pick` and the order is therefore part
 * of what a seed decides.
 */
const SPECIAL_FEATURES: readonly IsomCode[] = ['115', '313', '419'];

export const ADDABLE: readonly IsomCode[] = Object.values(SEMANTICS)
  .filter((s) => s.geometry === 'point' && s.controlSite === true)
  .filter((s) => s.family === 'landform' || s.family === 'rock'
    || s.family === 'water' || s.family === 'vegetation')
  .filter((s) => !SPECIAL_FEATURES.includes(s.code))
  .map((s) => s.code)
  .sort();

/**
 * The ground a symbol covers, in metres, from its ISOM minimum size at this map's scale.
 *
 * `Feature.size` is metres of ground and `minSizeMm` is millimetres of paper, so the
 * scale is the whole of the conversion: 0.4 mm of boulder is 6 m at 1:15000 and 4 m at
 * the 1:10000 the forest sample was drawn at — which is the band the generator draws its
 * own boulders in, arrived at from the standard rather than copied from it.
 */
export function drawnSizeOf(code: IsomCode, scale: number): number {
  const mm = semanticsOf(code)?.minSizeMm ?? 0.4;
  return (mm / 1000) * scale;
}

/**
 * Where an edit happened and how much room it takes, for a caller that has to hit-test it.
 *
 * The discrepancy drill's whole question is "where did this change?", and the answer is a
 * position and a tolerance — read off the edit and the base map, never off the two
 * drawings. A warp answers with its own disc; everything else with the feature it names,
 * at the larger of the symbol's drawn size and the distance it moved.
 */
export function footprintOf(map: OMap, edit: Edit): { at: Vec; radius: number } | null {
  if (edit.op === 'warp') {
    const { centre, radius, dx, dy } = edit.warp;
    return { at: { x: centre.x + dx / 2, y: centre.y + dy / 2 }, radius: radius + Math.hypot(dx, dy) / 2 };
  }
  if (edit.op === 'add') {
    return { at: positionOf(edit.feature), radius: reachOf(edit.feature, map.scale) };
  }
  const was = map.features.find((f) => f.id === edit.feature)
    ?? map.analysis?.moveable?.find((f) => f.id === edit.feature);
  if (!was) return null;
  const from = positionOf(was);
  if (edit.op !== 'move') return { at: from, radius: reachOf(was, map.scale) };
  const to = { x: from.x + edit.dx, y: from.y + edit.dy };
  return {
    at: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
    radius: reachOf(was, map.scale) + Math.hypot(edit.dx, edit.dy) / 2,
  };
}

/** How far a feature reaches from its own position: its outline, or its drawn symbol. */
function reachOf(feature: Feature, scale: number): number {
  const box = boundsOf(feature);
  const at = positionOf(feature);
  const spread = Math.max(
    box.maxX - at.x, at.x - box.minX, box.maxY - at.y, at.y - box.minY,
  );
  return Math.max(spread, drawnSizeOf(feature.code, scale));
}

/**
 * The edits that enrich one window of one map.
 *
 * The operations run in a fixed order — adds, removes, swaps, moves — and each takes a
 * bounded number of draws. The order is not taste: it is what makes the rng stream a
 * function of the budget rather than of which pools happened to be empty, and an
 * operation that cannot find a candidate simply gives its slot up rather than looping.
 *
 * Every edit that comes back has been checked three ways against the base map: it is
 * **visible** inside the window (`difference().visible`, a position test on what changed),
 * it is **salient** enough to find (`MIN_SALIENCE`), and it is **plausible** — the ground
 * under it agrees with the symbol, and no two point symbols stand closer than print
 * allows. Nothing downstream re-checks any of that, so nothing downstream has to know the
 * map was adjusted.
 */
export function proposeEnrichment(
  map: OMap,
  crop: Crop,
  rng: Rng,
  budget: EnrichmentBudget,
): Edit[] {
  const edits: Edit[] = [];
  if (budget.adds + budget.removes + budget.swaps + budget.moves === 0) return edits;

  const where = plausibilityOf(map);
  // A raster map's blobs are point features that are deliberately not in `features` — the
  // picture already draws them — and a symbol added beside one still has to keep its
  // distance from the ink.
  const standing: Feature[] = [...pointsOf(map), ...(map.analysis?.moveable ?? [])];
  const touched = new Set<string>();
  /**
   * Whether the player could find this change in this window.
   *
   * Asked **inside** each proposer's attempt loop rather than after it, so a candidate
   * this turns down costs one draw and not the whole budget slot. It cost the slot once,
   * and the symbols it quietly deleted from the vocabulary were the faint ones — which is
   * to say the rule "add the kinds the window lacks" was being overruled by a rule that
   * never said which kinds it was overruling.
   */
  const accept = (edit: Edit): boolean => {
    const report = difference({ base: map, edits: [edit] }, crop);
    return report.visible && report.salience >= MIN_SALIENCE;
  };

  let index = nextAddIndex(map);
  for (let slot = 0; slot < budget.adds; slot++) {
    const added = proposeAdd(map, crop, rng, where, standing, `add:${index}`, accept);
    if (!added) continue;
    edits.push(added);
    standing.push(added.feature);
    touched.add(added.feature.id);
    index++;
  }

  for (let slot = 0; slot < budget.removes; slot++) {
    const edit = proposeRemoval(map, crop, rng, touched, accept);
    if (!edit) continue;
    edits.push(edit);
    touched.add(edit.feature);
  }

  for (let slot = 0; slot < budget.swaps; slot++) {
    const edit = proposeSwap(map, crop, rng, where, touched, accept);
    if (!edit) continue;
    edits.push(edit);
    touched.add(edit.feature);
  }

  for (let slot = 0; slot < budget.moves; slot++) {
    const edit = proposeMove(map, crop, rng, where, standing, touched, accept);
    if (!edit) continue;
    edits.push(edit);
    touched.add(edit.feature);
  }

  return edits;
}

/** Whether a proposed edit is one the player could find — see `proposeEnrichment`. */
type Accepts = (edit: Edit) => boolean;

/** Where `add:<n>` starts, so adjusting an already adjusted map cannot reuse an id. */
function nextAddIndex(map: OMap): number {
  let next = 0;
  for (const feature of map.features) {
    const n = /^add:(\d+)$/.exec(feature.id);
    if (n) next = Math.max(next, Number(n[1]) + 1);
  }
  return next;
}

/**
 * One symbol the window does not have enough of, somewhere it could legitimately be.
 *
 * The code is redrawn on every attempt rather than once: a knoll that finds no rise in
 * this window should cost one draw, not the whole slot. The pool is recomputed per
 * attempt too, so the symbols already added count towards "enough of" and a window ends
 * up with several kinds rather than six of one.
 */
function proposeAdd(
  map: OMap,
  crop: Crop,
  rng: Rng,
  where: Plausibility | null,
  standing: readonly Feature[],
  id: string,
  accept: Accepts,
): Extract<Edit, { op: 'add' }> | null {
  for (let attempt = 0; attempt < ADD_ATTEMPTS; attempt++) {
    const code = rng.pick(wantedCodes(standing, crop));
    const size = drawnSizeOf(code, map.scale);
    // Inset by the symbol's own ground, so what is added is drawn whole inside the window
    // and not clipped in half by the edge of the card.
    const lo = { x: Math.max(0, crop.x) + size, y: Math.max(0, crop.y) + size };
    const hi = {
      x: Math.min(map.width, crop.x + crop.size) - size,
      y: Math.min(map.height, crop.y + crop.size) - size,
    };
    if (hi.x <= lo.x || hi.y <= lo.y) return null;
    const at = { x: rng.range(lo.x, hi.x), y: rng.range(lo.y, hi.y) };

    if (!suitsAt(code, where, at)) continue;
    const feature: Feature = { id, code, geometry: { kind: 'point', at }, size };
    if (crowds(feature, at, standing)) continue;
    if (contradicted(map, code, at, size)) continue;
    const edit: Extract<Edit, { op: 'add' }> = { op: 'add', feature };
    if (!accept(edit)) continue;
    return edit;
  }
  return null;
}

/**
 * The codes this window lacks, or failing that has few of, or failing that any of them.
 *
 * Three tiers rather than a weighting, because what is wanted is a *different* symbol and
 * not a slightly more likely one: while anything is missing outright, that is what gets
 * added. The counts are over the window and one symbol's reach around it, which is the
 * ground a card can show.
 */
function wantedCodes(standing: readonly Feature[], crop: Crop): readonly IsomCode[] {
  const counts = new Map<IsomCode, number>();
  for (const feature of standing) {
    if (!insideCrop(positionOf(feature), crop)) continue;
    counts.set(feature.code, (counts.get(feature.code) ?? 0) + 1);
  }
  const missing = ADDABLE.filter((code) => !counts.has(code));
  if (missing.length > 0) return missing;
  const scarce = ADDABLE.filter((code) => (counts.get(code) ?? 0) <= SCARCE);
  return scarce.length > 0 ? scarce : ADDABLE;
}

/**
 * Whether a point symbol here would smear into one of its neighbours.
 *
 * `separationOf` and not one constant: a cliff is a line twice as long as a boulder is
 * wide, and a field of them at the boulder spacing reads as a single black mass. Asked of
 * the code, so an imported symbol takes the room its own drawing needs.
 */
function crowds(feature: Feature, at: Vec, standing: readonly Feature[]): boolean {
  for (const other of standing) {
    const p = positionOf(other);
    const bar = separationOf(feature, other);
    // A cheap box test first: on a two-kilometre map most of the list is nowhere near.
    if (Math.abs(p.x - at.x) > bar || Math.abs(p.y - at.y) > bar) continue;
    if (Math.hypot(p.x - at.x, p.y - at.y) < bar) return true;
  }
  return false;
}

/**
 * Whether something already drawn here says this symbol cannot be.
 *
 * `suits` reads the shape of the ground; this reads what is on it, which is the other half
 * of plausibility and the half a height field cannot see. A boulder in a lake, in a
 * building or in the middle of a paved yard is not a hard round, it is a wrong map — and
 * on a real map, unlike a generated one, there are lakes and buildings to land in.
 *
 * Lines are asked only about the two that are statements about the ground being
 * impossible: water, and anything the table calls a barrier. A contour is a line too, and
 * every point symbol on a map stands on one.
 */
function contradicted(map: OMap, code: IsomCode, at: Vec, size: number): boolean {
  const family = semanticsOf(code)?.family;
  for (const area of areasOf(map)) {
    const semantics = semanticsOf(area.code);
    if (!semantics) continue;
    const box = boundsOf(area);
    if (at.x < box.minX || at.x > box.maxX || at.y < box.minY || at.y > box.maxY) continue;
    if (!insidePolygon(at, area)) continue;
    // Nothing but water stands in water; nothing at all stands in what cannot be entered;
    // and nothing of the ground stands inside something built.
    if (semantics.family === 'water' && family !== 'water') return true;
    if (semantics.runnability === 0) return true;
    if (semantics.family === 'manmade' && family !== 'manmade') return true;
  }
  for (const line of linesOf(map)) {
    const semantics = semanticsOf(line.code);
    if (!semantics || (semantics.family !== 'water' && !semantics.barrier)) continue;
    if (line.geometry.kind !== 'polyline') continue;
    const box = boundsOf(line);
    if (at.x < box.minX - size || at.x > box.maxX + size) continue;
    if (at.y < box.minY - size || at.y > box.maxY + size) continue;
    if (nearPolyline(line.geometry.points, at, size)) return true;
  }
  return false;
}

/** Whether a point is within `reach` of any segment of a line. */
function nearPolyline(points: readonly Vec[], at: Vec, reach: number): boolean {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t = length === 0 ? 0 : Math.min(1, Math.max(0, ((at.x - a.x) * dx + (at.y - a.y) * dy) / length));
    if (Math.hypot(a.x + t * dx - at.x, a.y + t * dy - at.y) < reach) return true;
  }
  return false;
}

/**
 * One feature the window can afford to lose.
 *
 * Points and areas, never lines. A path or a stream runs off the window and out the other
 * side, so removing one inside a card leaves a line that stops in mid-air on every other
 * card cut from the same map — a map nobody drew, and the one thing enrichment must not
 * produce. An area has to lie **wholly** inside the window for the same reason.
 */
function proposeRemoval(
  map: OMap,
  crop: Crop,
  rng: Rng,
  touched: ReadonlySet<string>,
  accept: Accepts,
): Extract<Edit, { op: 'remove' }> | null {
  const pool = [
    ...pointsOf(map).filter((f) => insideCrop(positionOf(f), crop)),
    ...areasOf(map).filter((f) => {
      const box = boundsOf(f);
      return box.minX >= crop.x && box.maxX <= crop.x + crop.size
        && box.minY >= crop.y && box.maxY <= crop.y + crop.size;
    }),
  ].filter((f) => !touched.has(f.id));
  if (pool.length === 0) return null;
  for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt++) {
    const feature = rng.pick(pool);
    if (touched.has(feature.id)) continue;
    const edit: Extract<Edit, { op: 'remove' }> = { op: 'remove', feature: feature.id };
    // The salience floor is what keeps this off the white forest a map is mostly made of:
    // 405 scores 0.05, and a window with one patch of it silently removed is a window
    // nobody can see the difference in.
    if (!accept(edit)) continue;
    return edit;
  }
  return null;
}

/**
 * One point symbol read as another one, where the ground agrees with the new reading.
 *
 * **The family is not the filter; the ground is.** ISOM files a boulder under rock and the
 * knoll standing beside it under landform, and that pair is the one every beginner mixes
 * up — a rule that kept a swap inside its family would rule out the swap this exists to
 * make. What rules a swap out is `suits`: a boulder becomes a knoll only on ground that
 * rises, and a pit becomes a small depression only in ground that falls.
 *
 * Only symbols enrichment could have added in the first place are swapped, and only into
 * that same vocabulary — a fodder rack is not a boulder, and the map says it is there
 * because somebody built it.
 */
function proposeSwap(
  map: OMap,
  crop: Crop,
  rng: Rng,
  where: Plausibility | null,
  touched: ReadonlySet<string>,
  accept: Accepts,
): Extract<Edit, { op: 'swap' }> | null {
  const pool = pointsOf(map).filter((f) =>
    ADDABLE.includes(f.code) && insideCrop(positionOf(f), crop) && !touched.has(f.id));
  if (pool.length === 0) return null;
  for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt++) {
    const feature = rng.pick(pool);
    const at = positionOf(feature);
    const targets = ADDABLE.filter((code) => code !== feature.code && suitsAt(code, where, at));
    if (targets.length === 0) continue;
    const edit: Extract<Edit, { op: 'swap' }> = {
      op: 'swap', feature: feature.id, code: rng.pick(targets),
    };
    if (!accept(edit)) continue;
    return edit;
  }
  return null;
}

/**
 * One feature nudged, still standing on ground that suits it.
 *
 * `proposeEdit` chooses the candidate — the same pools a map-memory distractor draws from,
 * narrowed to the window — and this is the part that says whether the result is a map
 * anyone would have drawn: the symbol must suit its new ground, and it must not have
 * landed on top of its neighbour.
 */
function proposeMove(
  map: OMap,
  crop: Crop,
  rng: Rng,
  where: Plausibility | null,
  standing: readonly Feature[],
  touched: ReadonlySet<string>,
  accept: Accepts,
): Extract<Edit, { op: 'move' }> | null {
  // **The pools `proposeEdit` will actually draw from**, not the ones this function has
  // been keeping. `standing` grows as symbols are added, and an added symbol is not in
  // `map.features` yet — so a map with nothing to move but two fresh adds passed a guard
  // written over `standing` and then hit `rng.pick` on an empty pool. Ask the map.
  const candidates = [...pointsOf(map), ...(map.analysis?.moveable ?? []), ...areasOf(map)];
  if (candidates.length === 0) return null;

  const distance = Math.max(MIN_POINT_SEPARATION, crop.size * MOVE_FRACTION);
  for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt++) {
    const edit = proposeEdit(map, rng, { distance, ops: ['move'], within: crop });
    if (edit.op !== 'move' || touched.has(edit.feature)) continue;
    const feature = candidates.find((f) => f.id === edit.feature);
    if (!feature) continue;
    const from = positionOf(feature);
    const to = { x: from.x + edit.dx, y: from.y + edit.dy };
    // **A displacement the map has no room for is not the edit that was proposed.**
    // `applyEdits` clamps to the sheet, so a feature near the edge ends up somewhere
    // other than where this asked about the ground — and, at the corner, somewhere the
    // window's own boundary test then disagreed with by a hundredth of a nanometre.
    // Refusing the move outright costs one draw and leaves the two in step.
    if (to.x < 0 || to.y < 0 || to.x > map.width || to.y > map.height) continue;
    if (!insideCrop(to, crop)) continue;
    if (!suitsAt(feature.code, where, to)) continue;
    if (feature.geometry.kind === 'point'
      && crowds(feature, to, standing.filter((f) => f.id !== feature.id))) continue;
    if (!accept(edit)) continue;
    return edit;
  }
  return null;
}
