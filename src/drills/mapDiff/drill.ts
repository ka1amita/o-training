import { CONTROL_NAMES, wordFor } from '@/drills/mapDohledavka/features.ts';
import { defineDrill, type Score } from '@/drills/types.ts';
import type { RoundContext, WindowRequirement } from '@/lib/maps/provider.ts';
import type { Rng } from '@/lib/rng.ts';
import { difference, type Edit } from '@/lib/terrain/edits.ts';
import {
  footprintOf, proposeEnrichment, MIN_SALIENCE, type EnrichmentBudget,
} from '@/lib/terrain/enrich.ts';
import { insideCrop, type Crop, type OMap, type Vec } from '@/lib/terrain/omap.ts';
import Play from './Play.tsx';

/**
 * Mapa vs. skutecnost — the map against the ground.
 *
 * One window of one map, drawn twice: the **base** is what the surveyor left, and the card
 * on screen is the same window with a handful of plausible changes put onto it by
 * `proposeEnrichment` — a boulder that is not there, a knoll that has moved, a marsh that
 * has gone. The player taps where the two disagree.
 *
 * What it trains is the thing every leg begins with and no other drill here asks for:
 * reading a map *against* the ground in front of you and noticing that they do not match.
 * On a real course that is a control site that has been felled, a path that was widened
 * into a track, a new ditch — and the skill is not doubting the map, it is knowing which
 * of the two to believe and how fast.
 *
 * **The edits are the answer key.** Nothing here ever compares two drawings: a round holds
 * the base, the edit list and the disc each edit occupies, and a tap is scored against
 * those discs. The card the player sees is `applyEdits(base, edits)` and is made in
 * `Play`, which is the only part that draws.
 */

/** Where one change is, and what to call it. Read off the edit and the base map. */
export interface Target {
  /** Centre of the disc a tap has to land in, in metres of ground. */
  readonly at: Vec;
  /** The change's own reach. A tap counts within `radius + tolerance` of `at`. */
  readonly radius: number;
  /** What a control description would call it: "new boulder", "marsh gone". */
  readonly word: string;
}

export interface MapDiffRound {
  /** The map as it was. `mapsOfRound` reads this, so the badge is the base's source. */
  readonly base: OMap;
  /** What was done to it. The card on screen is `applyEdits(base, edits)`. */
  readonly edits: readonly Edit[];
  /** One per edit, in the same order. `k` is the length of both. */
  readonly targets: readonly Target[];
  /** The window both cards show. */
  readonly crop: Crop;
  /** How far outside a target's own disc a tap still counts, in metres. */
  readonly tolerance: number;
  readonly timeLimitMs: number;
  /** The bottom of the ladder gets the original beside the card. See `AID_TO_LEVEL`. */
  readonly withOriginal: boolean;
}

/** One tap: where it landed, and which change it found, if any. */
export interface MapDiffAnswer {
  readonly at: Vec;
  /** Index into `targets`, or null for a tap on ground that did not change. */
  readonly target: number | null;
}

/** Side of the card, in metres of ground. The window it is cut from is `WINDOW_SIZE`. */
export const CARD_SIZE = 180;
/** The ground the provider is asked for, so the card can be framed inside it. */
export const WINDOW_SIZE = 300;

/**
 * How far outside its own disc a tap still finds a change, as a share of the card.
 *
 * 9 m on a 180 m card, which is about a finger on a phone — a target is the change's own
 * drawn reach plus this, so a boulder is roughly 15 m across and a quarter of a second of
 * aiming. It does **not** move with the level: what a level scales is how many changes
 * there are and how long there is to find them, not how accurately they have to be
 * pointed at. A tolerance that shrank would be testing the touchscreen.
 */
export const TAP_FRACTION = 0.05;

/**
 * The largest a single change may be, as a share of the card.
 *
 * A removed area can be eighty metres across, and a target that size is not a place on the
 * card, it *is* the card: any tap finds it, and the round stops asking a question. Changes
 * bigger than this are dropped from the round rather than drawn smaller — the card still
 * shows them, they simply are not what is being asked about.
 */
export const MAX_TARGET_FRACTION = 0.2;

/** Up to here the original is on screen beside the card. See `withOriginal`. */
export const AID_TO_LEVEL = 2;

/**
 * How many changes a level asks for: one at the bottom, five at the top.
 *
 * One is the whole of level 1 — the question is only "what is different", and with the
 * original beside it that is a comparison anyone can make. Five is as many as a 180 m card
 * holds while every one of them stays a place of its own: the targets have to be
 * `2 * tolerance` apart or one tap could answer two, and at five they already are.
 */
export function targetsFor(level: number): number {
  const clamped = Math.min(10, Math.max(1, level));
  return Math.round(1 + (4 * (clamped - 1)) / 9);
}

/**
 * How many edits are proposed for every one the round keeps.
 *
 * A proposal is thrown away when it lands on top of one already claimed or is too big to
 * be a place on the card, and **measured that is a fifth of them**: at level 10 on
 * generated ground, 39 of 200 clashed and 13 were oversized. Without the headroom a level
 * asking for five changes got 3.77 of them, and the ladder said one thing while the rounds
 * did another. Half again covers it — every budget slot is spent (200 of 200 measured), so
 * the only question is how many survive the filter.
 */
const SLOT_HEADROOM = 0.5;

/**
 * The changes a level proposes, as an enrichment budget.
 *
 * Half of them are **adds**, which are the ones that can always be placed: a window with
 * nothing on it still has ground to stand a boulder on, where a remove needs something to
 * take away and a swap needs something that could have been read as something else. The
 * rest cycle move, remove, swap — in that order, because a feature that has slid twenty
 * metres is the discrepancy an orienteer actually meets, a missing one is the next, and a
 * boulder drawn as a knoll is the subtlest and belongs at the top of the ladder.
 *
 * This is not `enrich.budgetFor(level)`: that one is sized to make a thin window worth a
 * card and asks for up to fifteen edits. Here every edit is a question and five is already
 * a full card — so this asks for `k` plus the headroom, and the round keeps `k`.
 */
export function budgetFor(level: number): EnrichmentBudget {
  const slots = Math.ceil(targetsFor(level) * (1 + SLOT_HEADROOM));
  const adds = Math.max(1, Math.floor(slots / 2));
  const budget = { adds, removes: 0, swaps: 0, moves: 0 };
  const rest: ('moves' | 'removes' | 'swaps')[] = ['moves', 'removes', 'swaps'];
  for (let i = 0; i < slots - adds; i++) budget[rest[i % rest.length]!] += 1;
  return budget;
}

/**
 * How long there is to find them.
 *
 * Per target rather than per round, falling from 25 s to 12 s across the ladder: more to
 * find *and* less time for each of them, which is the same pair of axes map memory scales.
 * The clock is the round's, not the drill's — `Play` runs it and the reducer ends the
 * round on it, so a round that runs out is a round that was answered with what was found.
 */
export function timeLimitFor(level: number, targets: number): number {
  const clamped = Math.min(10, Math.max(1, level));
  const each = 25_000 + ((12_000 - 25_000) * (clamped - 1)) / 9;
  return Math.round(each * Math.max(1, targets));
}

/**
 * The ground one round needs.
 *
 * A 300 m window the card takes 180 m out of, as map memory takes 150: the card has to be
 * small enough that a boulder is a symbol rather than a dot, and the window around it is
 * what the provider scored. No relief is required — a picture with no height field is
 * still a map you can be shown a wrong boulder on, and `plausibilityOf` asks its colour
 * mask instead — and `level` is stated so that an adjusted source knows which rung asked.
 */
export function requirementFor(level: number): WindowRequirement {
  const clamped = Math.min(10, Math.max(1, level));
  const scale = (low: number, high: number) =>
    Math.round(low + ((high - low) * (clamped - 1)) / 9);
  return {
    size: WINDOW_SIZE,
    needsRelief: false,
    level,
    crop: CARD_SIZE,
    minFeatures: {
      landform: scale(5, 9),
      point: scale(10, 18),
      line: scale(2, 3),
      area: scale(4, 8),
    },
    rides: 1,
    // More to hide a change among, higher up. A cluster of crags is exactly the place a
    // moved one is hard to find, which is the difficulty this drill is about.
    clusters: scale(0, 2),
  };
}

/**
 * The word for what an edit did, in the vocabulary a control description uses.
 *
 * `wordFor` is the answer space of Mapova dohledavka, which is the same question asked the
 * other way round — what is in this circle — so there is one table of words and not two. A
 * code it cannot name is a code no description sheet names either, and "feature" is what
 * is left to say about it.
 */
export function wordForEdit(map: OMap, edit: Edit): string {
  if (edit.op === 'add') return `new ${nameOf(edit.feature.code)}`;
  // Nothing proposes a warp here — enrichment does not make them — but `footprintOf`
  // answers for one, so this does too rather than leaving a target with no word.
  if (edit.op === 'warp') return 'the ground has moved';
  const was = subject(map, edit.feature);
  const name = was ? nameOf(was.code) : 'feature';
  if (edit.op === 'remove') return `${name} gone`;
  if (edit.op === 'move') return `${name} moved`;
  return `${name} drawn as ${nameOf(edit.code)}`;
}

const subject = (map: OMap, id: string) =>
  map.features.find((f) => f.id === id) ?? map.analysis?.moveable?.find((f) => f.id === id);

const nameOf = (code: Parameters<typeof wordFor>[0]): string => {
  const word = wordFor(code);
  return word ? CONTROL_NAMES[word] : 'feature';
};

/**
 * The changes that can each be found on their own, in the order they were proposed.
 *
 * Two rules, and both of them are about the round having one answer per tap:
 *
 *  - **A target is a place, not a region.** A change whose own reach is a fifth of the
 *    card is not somewhere to point at, so it is dropped.
 *  - **Two targets never share a tap.** A tap counts within `radius + tolerance`, so two
 *    targets whose centres are closer than the sum of both discs could both be answered by
 *    one tap — one tap, two interpretations, which is this app's oldest rule broken in a
 *    new geometry. The later of the pair gives way; `wellFormed` then asserts what is left.
 *
 * It stops at `wanted`, which is the level's `k`: the budget asked for more than that on
 * purpose (`SLOT_HEADROOM`), and the surplus is what pays for the two rules above.
 *
 * Pure and rng-free: the proposal order is the rng's decision and this only filters it.
 */
function keepDisjoint(
  map: OMap,
  crop: Crop,
  edits: readonly Edit[],
  tolerance: number,
  wanted: number,
): { edits: Edit[]; targets: Target[] } {
  const kept: Edit[] = [];
  const targets: Target[] = [];
  for (const edit of edits) {
    if (kept.length >= wanted) break;
    const where = footprintOf(map, edit);
    if (!where) continue;
    if (where.radius > crop.size * MAX_TARGET_FRACTION) continue;
    if (!insideCrop(where.at, crop)) continue;
    const clash = targets.some((other) =>
      Math.hypot(other.at.x - where.at.x, other.at.y - where.at.y)
        <= other.radius + where.radius + 2 * tolerance);
    if (clash) continue;
    kept.push(edit);
    targets.push({ at: where.at, radius: where.radius, word: wordForEdit(map, edit) });
  }
  return { edits: kept, targets };
}

/** A budget of one add, which is what a window with nothing else to offer can always do. */
const LAST_RESORT: EnrichmentBudget = { adds: 1, removes: 0, swaps: 0, moves: 0 };

export const mapDiff = defineDrill<MapDiffRound, MapDiffAnswer>({
  id: 'map-diff',
  title: 'Mapa vs. skutecnost',
  blurb: 'The map has been changed. Tap everything that is not as it was.',
  engine: 'terrain',
  bounds: { min: 1, max: 10 },
  // Shorter than the four-option drills: a round is several taps and a card that has to be
  // read twice, so eight of them is about the same minutes as ten of map memory.
  roundsPerSession: 8,
  // Several taps a round, but one attempt at each of them and no marking as they go: the
  // player finds out what was there only when the round is over, which is exactly what a
  // reveal is for.
  review: true,

  generate(rng: Rng, level: number, ctx: RoundContext): MapDiffRound {
    const picked = ctx.maps.pick(rng, requirementFor(level));
    if (!picked) throw new Error('map vs reality: no map for this level');
    const { map: base, crop } = picked;
    const tolerance = crop.size * TAP_FRACTION;

    const proposed = proposeEnrichment(base, crop, rng, budgetFor(level));
    let { edits, targets } = keepDisjoint(base, crop, proposed, tolerance, targetsFor(level));
    // A window whose whole budget came back empty — or whose every proposal was too big or
    // stood on top of another — still has to ask something. One add is the smallest round
    // this drill has, and a window that cannot take a single boulder is one `wellFormed`
    // should be allowed to report rather than one to paper over.
    if (edits.length === 0) {
      ({ edits, targets } = keepDisjoint(
        base, crop, proposeEnrichment(base, crop, rng, LAST_RESORT), tolerance, 1,
      ));
    }

    return {
      base,
      edits,
      targets,
      crop,
      tolerance,
      timeLimitMs: timeLimitFor(level, targets.length),
      // The original beside the card at the bottom of the ladder, where the round asks for
      // one change: a comparison rather than a search, which is how the question is learnt
      // before it is asked properly.
      withOriginal: level <= AID_TO_LEVEL,
    };
  },

  wellFormed(round: MapDiffRound): string[] {
    const problems: string[] = [];
    const { crop, targets, edits, tolerance } = round;

    if (edits.length === 0) problems.push('nothing changed, so the round has no answer');
    if (targets.length !== edits.length) {
      problems.push(`${targets.length} targets for ${edits.length} edits`);
    }
    if (tolerance <= 0) problems.push('the tap tolerance must be positive');
    if (round.timeLimitMs <= 0) problems.push('the time limit must be positive');

    edits.forEach((edit, index) => {
      // Every change has to be findable on this card: inside it, and drawn loudly enough
      // to be seen at all. Both are read off the edit and the base map — the one rule, in
      // a drill whose whole question is about two drawings.
      const report = difference({ base: round.base, edits: [edit] }, crop);
      if (!report.visible) problems.push(`change ${index} is not inside the card`);
      if (report.salience < MIN_SALIENCE) {
        problems.push(`change ${index} is too faint to find (${report.salience.toFixed(2)})`);
      }
    });

    targets.forEach((target, index) => {
      if (!insideCrop(target.at, crop)) problems.push(`target ${index} is off the card`);
      if (target.radius > crop.size * MAX_TARGET_FRACTION) {
        problems.push(`target ${index} is a fifth of the card rather than a place on it`);
      }
      for (let other = index + 1; other < targets.length; other++) {
        const b = targets[other]!;
        const gap = Math.hypot(b.at.x - target.at.x, b.at.y - target.at.y);
        // The one-answer invariant, in this drill's geometry: a tap inside both discs
        // would be two answers at once.
        if (gap <= target.radius + b.radius + 2 * tolerance) {
          problems.push(`targets ${index} and ${other} can be answered by one tap`);
        }
      }
    });

    const { x, y, size } = crop;
    if (x < 0 || y < 0 || x + size > round.base.width || y + size > round.base.height) {
      problems.push('the window runs off the map');
    }

    return problems;
  },

  score(round: MapDiffRound, answers: readonly MapDiffAnswer[]): Score {
    const found = new Set<number>();
    for (const answer of answers) {
      if (answer.target !== null && round.targets[answer.target]) found.add(answer.target);
    }
    const total = round.targets.length;
    // Three quarters of them, rounded up: at one target that is the one, at five it is
    // four. A round where nothing changed has nothing to pass.
    return {
      correct: found.size,
      total,
      passed: total > 0 && found.size >= Math.ceil(0.75 * total),
    };
  },

  Play,
});
