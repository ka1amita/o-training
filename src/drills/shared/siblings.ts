import type { Rng } from '@/lib/rng.ts';
import { maxHeightDifference } from '@/lib/terrain/height.ts';
import {
  areasOf, insideCrop, pointsOf, positionOf, type Crop, type Vec,
} from '@/lib/terrain/omap.ts';
import { suits } from '@/lib/terrain/semantics.ts';
import {
  perturb, readGround, type Change, type GeneratedMap, type Ground,
} from '@/lib/terrain/terrain.ts';

/**
 * A target and its near-identical siblings, shuffled, with the target's index.
 *
 * Both four-alternative terrain drills need the same thing and the same guarantee: every
 * distractor must differ from the target **in a way the player can actually see**. A
 * sibling whose one moved feature fell outside the visible window, or whose moved landform
 * barely dented the relief, is a second correct answer — which is invisible while playing
 * and reads as the drill being unfair.
 */
export interface Siblings {
  readonly options: readonly GeneratedMap[];
  readonly correctIndex: number;
}

export interface SiblingOptions {
  /** How far the one moved feature travels, in metres. Smaller is harder. */
  readonly distance: number;
  readonly target?: 'landform' | 'any';
  /** The change must show inside this window, if there is one. */
  readonly crop?: Crop;
  /** Least acceptable relief difference, in metres. Only checked when targeting landforms. */
  readonly minHeightDifference?: number;
}

const ATTEMPTS = 24;

function movedFeature(before: GeneratedMap, after: GeneratedMap, change: Change) {
  const at = (map: GeneratedMap): Vec => {
    if (change.what === 'landform') {
      const f = map.relief.landforms[change.index]!;
      return { x: f.x, y: f.y };
    }
    const list = change.what === 'point' ? pointsOf(map) : areasOf(map);
    return positionOf(list[change.index]!);
  };
  return { from: at(before), to: at(after) };
}

/**
 * Whether the moved feature still belongs where it now is.
 *
 * Once the generator places a marsh in flat, low ground and a crag on steep ground, a
 * perturbation that drops one somewhere else is a **tell**: a strong player learns to
 * pick the odd card out by spotting the marsh on the hillside rather than by remembering
 * the ground, which is a different skill and not the one being trained.
 *
 * It is a preference and not a filter. Insisting on it would push more rounds onto the
 * `distance * 2.5` fallback below, and a distractor that differs by far more than the
 * level asked for is a worse question than a slightly odd marsh.
 */
export function isPlausibleChange(after: GeneratedMap, change: Change, ground: Ground): boolean {
  if (change.what === 'landform') return true;
  const moved = (change.what === 'area' ? areasOf(after) : pointsOf(after))[change.index]!;
  return suits(moved.code, ground, positionOf(moved));
}

/** Whether this perturbation is one the player could notice. */
export function isVisibleChange(
  before: GeneratedMap,
  after: GeneratedMap,
  change: Change,
  options: SiblingOptions,
): boolean {
  const { from, to } = movedFeature(before, after, change);
  if (options.crop && !insideCrop(from, options.crop) && !insideCrop(to, options.crop)) return false;
  if (options.target === 'landform') {
    const floor = options.minHeightDifference ?? 1;
    if (maxHeightDifference(before.relief, after.relief) < floor) return false;
  }
  return true;
}

export function siblings(
  rng: Rng,
  base: GeneratedMap,
  count: number,
  options: SiblingOptions,
): Siblings {
  const made: GeneratedMap[] = [];

  // Sampled once for the whole round. Perturbing a point or an area leaves the height
  // field alone, so every candidate is judged against the same ground; targeting a
  // landform changes the field, and there plausibility has nothing to say anyway.
  const ground = options.target === 'landform' ? null : readGround(base.relief);

  while (made.length < count - 1) {
    let accepted: GeneratedMap | null = null;
    let visibleOnly: GeneratedMap | null = null;
    for (let attempt = 0; attempt < ATTEMPTS && !accepted; attempt++) {
      const { map: candidate, change } = perturb(base, rng, {
        distance: options.distance,
        ...(options.target ? { target: options.target } : {}),
        ...(options.crop ? { within: options.crop } : {}),
      });
      if (!isVisibleChange(base, candidate, change, options)) continue;
      if (!ground || isPlausibleChange(candidate, change, ground)) accepted = candidate;
      else visibleOnly ??= candidate;
    }
    accepted ??= visibleOnly;
    // Falling back to a bigger move is better than shipping an unanswerable round: an
    // easier distractor is a worse question, a duplicate of the answer is not a question.
    made.push(
      accepted ??
        perturb(base, rng, {
          distance: options.distance * 2.5,
          ...(options.target ? { target: options.target } : {}),
          ...(options.crop ? { within: options.crop } : {}),
        }).map,
    );
  }

  const correctIndex = rng.int(count);
  const options_ = [...made];
  options_.splice(correctIndex, 0, base);
  return { options: options_, correctIndex };
}

/**
 * Whether two siblings differ somewhere the window can show.
 *
 * `siblings()` guarantees this when it builds a round; this is the same claim stated over
 * the finished terrains, so `wellFormed` can check it without being handed the change.
 * Perturbation preserves list order, so the comparison is index by index.
 */
export function differsWithin(a: GeneratedMap, b: GeneratedMap, crop: Crop): boolean {
  const lists: readonly (readonly [readonly Vec[], readonly Vec[]])[] = [
    [a.relief.landforms, b.relief.landforms],
    [pointsOf(a).map(positionOf), pointsOf(b).map(positionOf)],
    [areasOf(a).map(positionOf), areasOf(b).map(positionOf)],
  ];
  for (const [left, right] of lists) {
    if (left.length !== right.length) return true;
    for (let i = 0; i < left.length; i++) {
      const p = left[i]!;
      const q = right[i]!;
      if (p.x === q.x && p.y === q.y) continue;
      if (insideCrop(p, crop) || insideCrop(q, crop)) return true;
    }
  }
  return false;
}
