import type { Rng } from '@/lib/rng.ts';
import type { Crop } from '@/lib/terrain/MapView.tsx';
import { maxHeightDifference } from '@/lib/terrain/height.ts';
import {
  perturb, readGround, suitsArea, suitsPoint,
  type Change, type Ground, type Terrain,
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
  readonly options: readonly Terrain[];
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

function movedFeature(before: Terrain, after: Terrain, change: Change) {
  const list = change.what === 'landform' ? 'landforms' : change.what === 'point' ? 'points' : 'areas';
  return { from: before[list][change.index]!, to: after[list][change.index]! };
}

const inside = (p: { x: number; y: number }, crop: Crop) =>
  p.x >= crop.x && p.x <= crop.x + crop.size && p.y >= crop.y && p.y <= crop.y + crop.size;

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
export function isPlausibleChange(after: Terrain, change: Change, ground: Ground): boolean {
  if (change.what === 'landform') return true;
  if (change.what === 'area') {
    const area = after.areas[change.index]!;
    return suitsArea(area.kind, ground, area);
  }
  const point = after.points[change.index]!;
  return suitsPoint(point.kind, ground, point);
}

/** Whether this perturbation is one the player could notice. */
export function isVisibleChange(
  before: Terrain,
  after: Terrain,
  change: Change,
  options: SiblingOptions,
): boolean {
  const { from, to } = movedFeature(before, after, change);
  if (options.crop && !inside(from, options.crop) && !inside(to, options.crop)) return false;
  if (options.target === 'landform') {
    const floor = options.minHeightDifference ?? 1;
    if (maxHeightDifference(before, after) < floor) return false;
  }
  return true;
}

export function siblings(
  rng: Rng,
  base: Terrain,
  count: number,
  options: SiblingOptions,
): Siblings {
  const made: Terrain[] = [];

  // Sampled once for the whole round. Perturbing a point or an area leaves the height
  // field alone, so every candidate is judged against the same ground; targeting a
  // landform changes the field, and there plausibility has nothing to say anyway.
  const ground = options.target === 'landform' ? null : readGround(base);

  while (made.length < count - 1) {
    let accepted: Terrain | null = null;
    let visibleOnly: Terrain | null = null;
    for (let attempt = 0; attempt < ATTEMPTS && !accepted; attempt++) {
      const { terrain, change } = perturb(base, rng, {
        distance: options.distance,
        ...(options.target ? { target: options.target } : {}),
        ...(options.crop ? { within: options.crop } : {}),
      });
      if (!isVisibleChange(base, terrain, change, options)) continue;
      if (!ground || isPlausibleChange(terrain, change, ground)) accepted = terrain;
      else visibleOnly ??= terrain;
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
        }).terrain,
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
export function differsWithin(a: Terrain, b: Terrain, crop: Crop): boolean {
  const lists = ['landforms', 'points', 'areas'] as const;
  for (const list of lists) {
    const left = a[list];
    const right = b[list];
    if (left.length !== right.length) return true;
    for (let i = 0; i < left.length; i++) {
      const p = left[i]!;
      const q = right[i]!;
      if (p.x === q.x && p.y === q.y) continue;
      if (inside(p, crop) || inside(q, crop)) return true;
    }
  }
  return false;
}
