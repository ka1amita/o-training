import { defineDrill, type Score } from '@/drills/types.ts';
import {
  GeneratedProvider,
  type MapProvider, type RoundContext, type WindowRequirement,
} from '@/lib/maps/provider.ts';
import type { Rng } from '@/lib/rng.ts';
import { sameGround, type Crop, type OMap } from '@/lib/terrain/omap.ts';
import { byKind, sitesOf, type ControlKind, type Site } from './features.ts';
import Play from './Play.tsx';

/**
 * Mapova dohledavka — Dobble, played on two map extracts instead of two discs of glyphs.
 *
 * Each card is a map of its own ground with a few controls drawn on it: bare circles, no
 * numbers, no course line, exactly as a control is drawn before anyone tells you what is
 * in it. **One kind of feature is circled on both cards**, and that is the answer.
 * Everything else the two maps have in common is ground, and most of what is on them —
 * the boulders and knolls nobody circled — is there to be ruled out.
 *
 * What this trains that the pictogram version does not: a symbol on a description sheet is
 * read, while a feature under a circle has to be *found* first, in among everything else
 * the surveyor drew. That is the half second at the start of every leg.
 */
export interface Control {
  readonly kind: ControlKind;
  readonly x: number;
  readonly y: number;
}

export interface MapCard {
  readonly map: OMap;
  /**
   * The window this card shows.
   *
   * A card is a window and not a whole map, because the ground comes from a `MapProvider`
   * now and a surveyed map is two kilometres of forest where a card is three hundred
   * metres of it. On the generator the window *is* the whole map, which is exactly what
   * this drill drew before.
   */
  readonly crop: Crop;
  readonly controls: readonly Control[];
}

export interface MapDobbleRound {
  readonly cards: readonly [MapCard, MapCard];
  /** The one kind of feature circled on both cards. */
  readonly shared: ControlKind;
  /** Control circle radius, in metres of ground. Both cards are the same map scale. */
  readonly radius: number;
}

export interface MapDobbleAnswer {
  readonly kind: ControlKind;
  readonly correct: boolean;
}

/**
 * The circle, as a fraction of the card.
 *
 * ISOM draws a control circle 6 mm across, which at 1:15000 is 90 m of ground — a quarter
 * of one of these cards. Five of those on a card would touch each other, and each would
 * take in the features around whatever it marks: a ring holding two nameable things marks
 * neither. So the circle here is 3 mm of paper, which is the size at which `sitesOf` still
 * finds a card's worth of places to put one — see the measurement there.
 */
export const CIRCLE_FRACTION = 0.05;

/**
 * Least distance between two circles on a card, in radii.
 *
 * Rings this close read as one pair of spectacles, and it is also what gives each circle a
 * tap target: `Cards` takes half of it, so the targets meet and never overlap.
 */
export const MIN_CONTROL_GAP = 2.5;

export interface MapDobbleParams {
  readonly controls: number;
  /** Side of the card, in metres of ground. */
  readonly size: number;
}

/**
 * Two axes, asking different things.
 *
 * More controls is more to scan, which is the Dobble axis. A bigger card is the
 * orienteering one: a feature is so many metres wide whatever the card, so 400 m of ground
 * in the same square is the same map printed smaller, and a knoll stops being a dot that
 * cannot be missed.
 */
export function paramsFor(level: number): MapDobbleParams {
  const clamped = Math.min(10, Math.max(1, level));
  return {
    controls: clamped <= 3 ? 3 : clamped <= 7 ? 4 : 5,
    size: Math.round(280 + ((360 - 280) * (clamped - 1)) / 9),
  };
}

/**
 * The ground one card needs, stated once — the drill asks a `MapProvider` for it rather
 * than calling the generator, like every other terrain drill.
 *
 * Density rises with the level for the same reason the card grows: the decoys are the
 * features nobody circled, and a map with four things on it has none.
 *
 * `needsRelief` because a third of the answer vocabulary is relief: a picture of a map has
 * no height field, so nothing on it would ever stand out as a hilltop or a re-entrant.
 */
export function requirementFor(level: number): WindowRequirement {
  const clamped = Math.min(10, Math.max(1, level));
  const scale = (low: number, high: number) =>
    Math.round(low + ((high - low) * (clamped - 1)) / 9);
  return {
    size: paramsFor(level).size,
    needsRelief: true,
    minFeatures: {
      // Six is the floor, not a taste: `placeLandforms` only digs a depression at six or
      // more, and a card whose relief offers three kinds instead of four is a card short
      // of answers.
      landform: scale(6, 10),
      point: scale(12, 20),
      line: scale(2, 3),
      area: scale(3, 6),
    },
    // Both off, and still for the same reason, though only one of the two reasons it used
    // to be: a site is a ring holding one nameable thing. A ride is a *path* now and no
    // longer a look-alike, but two families of dead-straight lines across a card put a
    // black line through a great many rings that would otherwise hold one thing; and a
    // cluster is boulders, crags, knolls and pits in one patch (`CLUSTER_KINDS`), which is
    // four words inside every circle any of them could have. With either of them on, a
    // level 10 pair of cards runs out of sites before it has the five circles the level
    // asks for.
    rides: 0,
    clusters: 0,
  };
}

interface Draft {
  readonly map: OMap;
  readonly crop: Crop;
  readonly sites: Map<ControlKind, Site[]>;
}

function draft(
  rng: Rng,
  maps: MapProvider,
  requirement: WindowRequirement,
  radius: number,
): Draft | null {
  const picked = maps.pick(rng, requirement);
  // Only a provider that can decline returns null, and one that declines everything is a
  // misconfiguration rather than a round to muddle through.
  if (!picked) return null;
  return { map: picked.map, crop: picked.crop, sites: byKind(sitesOf(picked.map, picked.crop, radius)) };
}

/**
 * How much of one card the other is also showing, 0 to 1.
 *
 * Zero for two different maps, and the share of the window for two windows of one — the
 * same window is 1, which is what `wellFormed` refuses outright. In between is what the
 * library actually hands out: a 360 m card cut from a 554 m map cannot move more than
 * 194 m, so two of them always share at least a fifth of their ground.
 */
function overlap(a: Draft, b: Draft): number {
  // `sameGround` and not `===`: the adjusted source returns a fresh object for every
  // window it hands out, so two crops of one surveyed sheet are two `OMap`s. Asking for
  // object identity made every adjusted pair look like two maps and turned this whole
  // rule off on the one source that needed it most.
  if (!sameGround(a.map, b.map)) return 0;
  const wide = Math.min(a.crop.x + a.crop.size, b.crop.x + b.crop.size) - Math.max(a.crop.x, b.crop.x);
  const high = Math.min(a.crop.y + a.crop.size, b.crop.y + b.crop.size) - Math.max(a.crop.y, b.crop.y);
  if (wide <= 0 || high <= 0) return 0;
  return (wide * high) / (a.crop.size * a.crop.size);
}

/**
 * How much of one card the other may repeat before it is worth looking again.
 *
 * Not a fairness bar — the answer is a *kind*, so two cards of one hillside still have one
 * shared kind and `wellFormed` still says so. It is what the cards are for: two windows
 * that are mostly the same ground offer mostly the same decoys, and the same boulder drawn
 * twice can be matched by where it is rather than by what it is.
 */
const MAX_OVERLAP = 0.25;

/** Redraws of the second card before it settles for the least repetitive one seen. */
const REDRAWS = 4;

/**
 * The generator, for the second card only, when the library cannot supply a second window.
 *
 * A `LibraryProvider` picks a window uniformly and has no memory of the one it just gave
 * out, so two cards off a one-bundle library landed on the same window about one round in
 * eight — and the same window is the one thing two cards may never be, since every kind on
 * one is then a kind on the other. Redrawing fixes it wherever there is a second window to
 * find; where there is not — one map, one window scored for this size — the honest answer
 * is ground from somewhere else rather than a round with no question in it. The badge says
 * `mix` when that happens, because it is true.
 */
const ELSEWHERE: MapProvider = new GeneratedProvider();

/**
 * A second card, on ground the first is not already showing.
 *
 * Takes the first draw that repeats little enough of the first card, and otherwise the
 * least repetitive of five — a library of one small map has nowhere far enough to go, and
 * refusing every window would be refusing the map. Only where every draw is the *same*
 * window does it go elsewhere.
 *
 * Deterministic, like everything else here: the redraws come out of the same rng stream in
 * a fixed order, so the round is still a function of `(seed, level, provider.id)`. The
 * generator is unaffected — it makes a new map for every pick, so the first draw shares no
 * ground and is taken, exactly as the single draw here used to be.
 */
function second(
  rng: Rng,
  maps: MapProvider,
  requirement: WindowRequirement,
  radius: number,
  first: Draft,
): Draft | null {
  let best: Draft | null = null;
  let least = Infinity;
  for (let tries = 0; tries <= REDRAWS; tries++) {
    const drawn = draft(rng, maps, requirement, radius);
    if (!drawn) return best;
    const share = overlap(first, drawn);
    if (share <= MAX_OVERLAP) return drawn;
    if (share < least) {
      least = share;
      best = drawn;
    }
  }
  // Every window this library has for the size is the one the first card is showing.
  return least >= 1 ? draft(rng, ELSEWHERE, requirement, radius) : best;
}

interface Handout {
  readonly shared: ControlKind;
  readonly a: readonly ControlKind[];
  readonly b: readonly ControlKind[];
}

/**
 * Which kinds go on which card.
 *
 * The two cards need `2n - 1` kinds between them — one shared, and two disjoint sets of
 * decoys — out of whatever the two maps happen to have grown. So the kinds only *one* map
 * can show are spent first, on that card, and the kinds either could show are what is left
 * to make up the numbers. Handing out the contested kinds first is what strands a card
 * with three decoys it cannot draw.
 */
function shareOut(rng: Rng, a: Draft, b: Draft, count: number): Handout | null {
  const inA = [...a.sites.keys()];
  const inB = new Set(b.sites.keys());
  const common = inA.filter((k) => inB.has(k));
  if (common.length === 0) return null;

  const shared = rng.pick(common);
  const contested = (mine: readonly ControlKind[], theirs: ReadonlySet<ControlKind>) => [
    ...rng.shuffle(mine.filter((k) => k !== shared && !theirs.has(k))),
    ...rng.shuffle(mine.filter((k) => k !== shared && theirs.has(k))),
  ];

  const forA = contested(inA, inB).slice(0, count - 1);
  if (forA.length < count - 1) return null;

  const taken = new Set<ControlKind>([shared, ...forA]);
  const forB = rng.shuffle([...inB].filter((k) => !taken.has(k))).slice(0, count - 1);
  if (forB.length < count - 1) return null;

  return { shared, a: forA, b: forB };
}

/**
 * One site per kind: clear of each other, and unreadable as anything else in the round.
 *
 * A search rather than a sweep, because the choices are not independent. The rarest kind
 * goes first — a card usually offers one place to put a re-entrant and a dozen to put a
 * tree — but taking the first free site for each kind in turn still strands the last kind
 * on a busy card, so a dead end backs up and tries the previous kind somewhere else.
 */
function place(
  rng: Rng,
  sites: Map<ControlKind, Site[]>,
  kinds: readonly ControlKind[],
  radius: number,
): Control[] | null {
  const order = [...kinds].sort(
    (p, q) => (sites.get(p)?.length ?? 0) - (sites.get(q)?.length ?? 0),
  );

  const options = order.map((kind) => rng.shuffle(sites.get(kind) ?? []).slice(0, WIDTH));

  const gap = radius * MIN_CONTROL_GAP;
  const chosen: Control[] = [];
  let steps = 0;

  const search = (depth: number): boolean => {
    if (depth === order.length) return true;
    for (const site of options[depth]!) {
      if (steps++ > STEPS) return false;
      if (chosen.some((c) => Math.hypot(c.x - site.at.x, c.y - site.at.y) < gap)) continue;
      chosen.push({ kind: order[depth]!, x: site.at.x, y: site.at.y });
      if (search(depth + 1)) return true;
      chosen.pop();
    }
    return false;
  };

  // Shuffled so the shared control is not the first circle on both cards, which would find
  // it by reading order rather than by reading the map.
  return search(0) ? rng.shuffle(chosen) : null;
}

function compose(rng: Rng, a: Draft, b: Draft, count: number, radius: number): MapDobbleRound | null {
  const handout = shareOut(rng, a, b, count);
  if (!handout) return null;

  const first = place(rng, a.sites, [handout.shared, ...handout.a], radius);
  const second = place(rng, b.sites, [handout.shared, ...handout.b], radius);
  if (!first || !second) return null;

  return {
    cards: [
      { map: a.map, crop: a.crop, controls: first },
      { map: b.map, crop: b.crop, controls: second },
    ],
    shared: handout.shared,
    radius,
  };
}

/** Sites per kind the search looks at, and nodes it may visit, so a busy card cannot
 *  turn the backtracking into a hang. */
const WIDTH = 10;
const STEPS = 400;

/** Handouts to try on one pair of maps before blaming the maps. */
const HANDOUTS = 10;
/** Pairs of maps to draw. */
const MAPS = 10;

export const mapDohledavka = defineDrill<MapDobbleRound, MapDobbleAnswer>({
  id: 'map-dohledavka',
  title: 'Mapova dohledavka',
  blurb: 'Two maps, one kind of feature circled on both. Find it.',
  engine: 'terrain',
  bounds: { min: 1, max: 10 },
  roundsPerSession: 10,
  // The round ends on the one right tap, and until it is marked on both cards the player
  // has no way to see which pair of circles agreed.
  review: true,

  generate(rng: Rng, level: number, ctx: RoundContext): MapDobbleRound {
    const { controls, size } = paramsFor(level);
    const requirement = requirementFor(level);
    const radius = size * CIRCLE_FRACTION;

    let lean: MapDobbleRound | null = null;

    for (let attempt = 0; attempt < MAPS; attempt++) {
      const a = draft(rng, ctx.maps, requirement, radius);
      const b = a && second(rng, ctx.maps, requirement, radius, a);
      if (!a || !b) throw new Error('map dohledavka: no map with relief for this level');

      // Down from what the level asked for: a pair of thin maps costs a circle rather than
      // the round. Measured over 800 rounds a level, it cost one once, at level 10.
      for (let wanted = controls; wanted >= 1; wanted--) {
        let round: MapDobbleRound | null = null;
        for (let tries = 0; tries < HANDOUTS && !round; tries++) {
          round = compose(rng, a, b, wanted, radius);
        }
        if (!round) continue;
        if (wanted === controls) return round;
        lean ??= round;
        break;
      }
    }

    // `wanted` walks down to a single circle on each card, which asks only that the two
    // maps have one kind in common with a site on it. Two maps failed that in 2 pairs out
    // of 5000, and ten pairs are drawn; the assertion stands on the measurement.
    return lean!;
  },

  wellFormed(round: MapDobbleRound): string[] {
    const problems: string[] = [];
    const [a, b] = round.cards;

    if (a.controls.length !== b.controls.length) {
      problems.push(`cards carry ${a.controls.length} and ${b.controls.length} controls`);
    }
    // The same window on the same map, which is the one thing two cards may never be:
    // every kind on one is then a kind on the other. Two windows on one big map are two
    // cards, and the library is what makes that possible.
    if (sameGround(a.map, b.map) && a.crop.x === b.crop.x && a.crop.y === b.crop.y
      && a.crop.size === b.crop.size) {
      problems.push('both cards are the same ground');
    }

    round.cards.forEach((card, index) => {
      const kinds = card.controls.map((c) => c.kind);
      if (kinds.length < 1) problems.push(`card ${index} has no controls`);
      if (new Set(kinds).size !== kinds.length) {
        // Two circles of one kind on a card is two right answers when that kind is the
        // shared one.
        problems.push(`card ${index} circles a kind twice`);
      }

      const sites = sitesOf(card.map, card.crop, round.radius);
      for (const control of card.controls) {
        const site = sites.find(
          (s) => s.kind === control.kind && s.at.x === control.x && s.at.y === control.y,
        );
        // The answer comes from the map and not from the drawing: a circle marks a
        // feature only if the terrain really has one of that kind there, alone in the ring.
        if (!site) problems.push(`card ${index}: no ${control.kind} alone in the circle`);
      }

      for (let i = 0; i < card.controls.length; i++) {
        for (let j = i + 1; j < card.controls.length; j++) {
          const p = card.controls[i]!;
          const q = card.controls[j]!;
          if (Math.hypot(p.x - q.x, p.y - q.y) < round.radius * MIN_CONTROL_GAP) {
            problems.push(`card ${index}: the ${p.kind} and ${q.kind} circles collide`);
          }
        }
      }
    });

    const common = a.controls
      .map((c) => c.kind)
      .filter((kind) => b.controls.some((c) => c.kind === kind));
    if (common.length !== 1) {
      problems.push(`cards share ${common.length} kinds, expected exactly 1`);
    } else if (common[0] !== round.shared) {
      problems.push(`shared is ${round.shared} but the cards share ${common[0]}`);
    }

    return problems;
  },

  // Same as the pictogram version: whether a tap was right was settled when it was made,
  // by the reducer that knows the shared kind.
  score(_round: MapDobbleRound, answers: readonly MapDobbleAnswer[]): Score {
    const found = answers.some((answer) => answer.correct);
    return {
      correct: found ? 1 : 0,
      total: 1,
      // Found it, and did not tap anything else on the way.
      passed: found && answers.length === 1,
    };
  },

  Play,
});
