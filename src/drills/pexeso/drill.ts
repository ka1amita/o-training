import { defineDrill, type Score } from '@/drills/types.ts';
import type { RoundContext, WindowRequirement } from '@/lib/maps/provider.ts';
import { deriveSeed, seeded, type Rng } from '@/lib/rng.ts';
import { pointsOf, positionOf, type Crop, type OMap, type Vec } from '@/lib/terrain/omap.ts';
import { AnalyticRelief } from '@/lib/terrain/relief.ts';
import Play from './Play.tsx';

/**
 * Posunute pexeso.
 *
 * A pair is **two overlapping windows on one map, offset from each other, both containing
 * the same control**. You match them by recognising the same ground seen through a
 * different frame — which is relocation, and is what the paper version trains.
 *
 * That is also why the terrain generator earns its place here rather than a pile of
 * images: an offset crop is a `viewBox`, so a pair costs one terrain and two numbers.
 */
export interface PexesoCard {
  /** Index into `maps`; the two cards sharing one are the pair. */
  readonly pairId: number;
  readonly crop: Crop;
  readonly control: Vec;
}

export interface PexesoRound {
  readonly pairs: number;
  readonly maps: readonly OMap[];
  /** 2 * pairs cards, shuffled. */
  readonly cards: readonly PexesoCard[];
  /** Distance between a pair's two crop centres, in metres. */
  readonly shift: number;
  readonly cropSize: number;
  readonly timeLimitMs: number;
}

export interface PexesoAnswer {
  readonly a: number;
  readonly b: number;
  readonly matched: boolean;
}

export const CROP_SIZE = 110;

/**
 * A perfect-memory player still cannot finish in `pairs` attempts — the first look at a
 * card teaches nothing about where its twin is — so the bar for a clean round is roughly
 * 1.8 attempts a pair. The exact figure matters less than it being reachable most of the
 * time: the staircase moves the level until it is.
 */
export const attemptBudget = (pairs: number): number => Math.ceil(pairs * 1.8);

export interface PexesoParams {
  readonly pairs: number;
  /** Offset as a fraction of the crop; more offset means less shared ground. */
  readonly shiftFraction: number;
}

/**
 * A smaller, busier map than the drills that show the whole thing.
 *
 * A card is one 110 m window, and what makes two windows matchable is the ground inside
 * them. On the default 420 m map a crop is 10% of the area and routinely came up holding
 * one contour and nothing else — two blank cards are a memory game about card position,
 * which is the one thing this drill is not for.
 */
export function requirementFor(level: number): WindowRequirement {
  const clamped = Math.min(10, Math.max(1, level));
  const scale = (low: number, high: number) =>
    Math.round(low + ((high - low) * (clamped - 1)) / 9);
  return {
    size: 300,
    needsRelief: false,
    minControlSites: paramsFor(level).pairs,
    minFeatures: {
      landform: scale(6, 10),
      point: scale(14, 24),
      line: scale(2, 3),
      area: scale(6, 12),
    },
    rides: 2,
    clusters: scale(3, 6),
  };
}

export function paramsFor(level: number): PexesoParams {
  const clamped = Math.min(10, Math.max(1, level));
  // 3, 4 and 6 pairs only: 6, 8 and 12 cards lay out on a phone without a ragged row.
  const pairs = clamped <= 3 ? 3 : clamped <= 7 ? 4 : 6;
  return { pairs, shiftFraction: 0.22 + ((0.58 - 0.22) * (clamped - 1)) / 9 };
}

/** Somewhere both crops can reach without leaving the map. */
function controlFor(rng: Rng, map: OMap, halfSpan: number): Vec {
  const lo = halfSpan;
  const hi = map.width - halfSpan;
  const candidates = [
    ...pointsOf(map).map(positionOf),
    // A summit is worth finding too. An imported map answers this from its analysis
    // instead; until then only the analytic relief has landforms to offer.
    ...(map.relief instanceof AnalyticRelief
      ? map.relief.landforms.map((f) => ({ x: f.x, y: f.y }))
      : []),
    // A picture has no features to stand a control on, so the pipeline read some off its
    // mask: black and blue blobs, which is a boulder or a water hole and is exactly what
    // a control sits on. Appended last, so a map that has features keeps offering them in
    // the order it always did — every golden here is a `rng.pick` over this array.
    ...(map.analysis?.controlSites ?? []),
  ].filter((f) => f.x >= lo && f.x <= hi && f.y >= lo && f.y <= hi);
  // Anchoring on a feature is what makes the control worth finding. A map whose features
  // all sit near the edge still has to produce a pair, so the fallback is the interior.
  return candidates.length > 0
    ? { x: rng.pick(candidates).x, y: rng.pick(candidates).y }
    : { x: rng.range(lo, hi), y: rng.range(lo, hi) };
}

export const pexeso = defineDrill<PexesoRound, PexesoAnswer>({
  id: 'pexeso',
  title: 'Posunute pexeso',
  blurb: 'Every pair is one place, framed two ways. Match them.',
  engine: 'terrain',
  bounds: { min: 1, max: 10 },
  roundsPerSession: 4,

  generate(rng: Rng, level: number, ctx: RoundContext): PexesoRound {
    const params = paramsFor(level);
    const shift = CROP_SIZE * params.shiftFraction;
    // Both crop centres sit shift/2 from the control, so the control stays inside both
    // as long as that is under half a crop — which the fraction cap guarantees.
    const halfSpan = CROP_SIZE / 2 + shift / 2;

    const maps: OMap[] = [];
    const cards: PexesoCard[] = [];

    for (let pairId = 0; pairId < params.pairs; pairId++) {
      // Each pair gets its own stream, so a pair's terrain does not depend on how many
      // pairs came before it — the same reason session rounds derive their seeds.
      const local = seeded(deriveSeed(rng.next(), pairId));
      const picked = ctx.maps.pick(local, requirementFor(level));
      if (!picked) throw new Error('pexeso: no map for this level');
      const map = picked.map;
      maps.push(map);

      const control = controlFor(local, map, halfSpan);
      const angle = local.range(0, 2 * Math.PI);
      const dx = (Math.cos(angle) * shift) / 2;
      const dy = (Math.sin(angle) * shift) / 2;

      for (const [ox, oy] of [[-dx, -dy], [dx, dy]] as const) {
        cards.push({
          pairId,
          control,
          crop: {
            x: control.x + ox - CROP_SIZE / 2,
            y: control.y + oy - CROP_SIZE / 2,
            size: CROP_SIZE,
          },
        });
      }
    }

    return {
      pairs: params.pairs,
      maps,
      cards: rng.shuffle(cards),
      shift,
      cropSize: CROP_SIZE,
      timeLimitMs: params.pairs * 20_000,
    };
  },

  wellFormed(round: PexesoRound): string[] {
    const problems: string[] = [];

    if (round.cards.length !== round.pairs * 2) {
      problems.push(`${round.cards.length} cards for ${round.pairs} pairs`);
    }

    const seen = new Map<number, number>();
    for (const card of round.cards) seen.set(card.pairId, (seen.get(card.pairId) ?? 0) + 1);
    for (let id = 0; id < round.pairs; id++) {
      if (seen.get(id) !== 2) problems.push(`pair ${id} has ${seen.get(id) ?? 0} cards`);
    }

    for (const card of round.cards) {
      const map: OMap | undefined = round.maps[card.pairId];
      if (!map) {
        problems.push(`card references missing map ${card.pairId}`);
        continue;
      }
      // The control has to be visible on both cards; it is the only thing they share
      // outright, and a pair without it is one nothing on screen connects.
      const { x, y, size } = card.crop;
      if (
        card.control.x < x || card.control.x > x + size ||
        card.control.y < y || card.control.y > y + size
      ) {
        problems.push(`pair ${card.pairId}: the control is outside a crop`);
      }
      if (x < 0 || y < 0 || x + size > map.width || y + size > map.width) {
        problems.push(`pair ${card.pairId}: a crop runs off the map`);
      }
    }

    for (let id = 0; id < round.pairs; id++) {
      const [a, b] = round.cards.filter((c) => c.pairId === id);
      if (!a || !b) continue;
      // Identical crops would be a matching game about nothing.
      if (a.crop.x === b.crop.x && a.crop.y === b.crop.y) {
        problems.push(`pair ${id}: both crops are the same window`);
      }
      if (a.control.x !== b.control.x || a.control.y !== b.control.y) {
        problems.push(`pair ${id}: the two cards name different controls`);
      }
    }

    if (round.timeLimitMs <= 0) problems.push('timeLimitMs must be positive');
    return problems;
  },

  score(round: PexesoRound, answers: readonly PexesoAnswer[]): Score {
    const found = answers.filter((a) => a.matched).length;
    return {
      correct: found,
      total: round.pairs,
      passed: found === round.pairs && answers.length <= attemptBudget(round.pairs),
    };
  },

  Play,
});
