import { defineDrill, type Score } from '@/drills/types.ts';
import type { Rng } from '@/lib/rng.ts';
import { generateTerrain, type Terrain, type TerrainParams } from '@/lib/terrain/terrain.ts';
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
  readonly terrain: Terrain;
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
 * A card is a whole map rather than a crop, so everything the question is about is on it.
 *
 * Density rises with the level for the same reason the card grows: the decoys are the
 * features nobody circled, and a map with four things on it has none.
 */
function terrainFor(level: number, size: number): TerrainParams {
  const clamped = Math.min(10, Math.max(1, level));
  const scale = (low: number, high: number) =>
    Math.round(low + ((high - low) * (clamped - 1)) / 9);
  return {
    size,
    // Six is the floor, not a taste: `placeLandforms` only digs a depression at six or
    // more, and a card whose relief offers three kinds instead of four is a card short of
    // answers.
    landforms: scale(6, 10),
    points: scale(12, 20),
    lines: scale(2, 3),
    areas: scale(3, 6),
  };
}

interface Draft {
  readonly terrain: Terrain;
  readonly sites: Map<ControlKind, Site[]>;
}

function draft(rng: Rng, params: TerrainParams, radius: number): Draft {
  const terrain = generateTerrain(rng, params);
  return { terrain, sites: byKind(sitesOf(terrain, radius)) };
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
      { terrain: a.terrain, controls: first },
      { terrain: b.terrain, controls: second },
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

  generate(rng: Rng, level: number): MapDobbleRound {
    const { controls, size } = paramsFor(level);
    const params = terrainFor(level, size);
    const radius = size * CIRCLE_FRACTION;

    let lean: MapDobbleRound | null = null;

    for (let attempt = 0; attempt < MAPS; attempt++) {
      const a = draft(rng, params, radius);
      const b = draft(rng, params, radius);

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
    if (a.terrain === b.terrain) problems.push('both cards are the same map');

    round.cards.forEach((card, index) => {
      const kinds = card.controls.map((c) => c.kind);
      if (kinds.length < 1) problems.push(`card ${index} has no controls`);
      if (new Set(kinds).size !== kinds.length) {
        // Two circles of one kind on a card is two right answers when that kind is the
        // shared one.
        problems.push(`card ${index} circles a kind twice`);
      }

      const sites = sitesOf(card.terrain, round.radius);
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
