import type { Rng } from '@/lib/rng.ts';
import {
  applyEdits, difference, proposeEdit,
  type Edit, type EditSpec, type Variant,
} from '@/lib/terrain/edits.ts';
import { suitsOnMask } from '@/lib/terrain/mask.ts';
import { positionOf, wholeMap, type Crop, type OMap, type RasterLayer } from '@/lib/terrain/omap.ts';
import { suits } from '@/lib/terrain/semantics.ts';
import { readGround, type Ground } from '@/lib/terrain/terrain.ts';

/**
 * A map and its near-identical siblings, shuffled, with the target's index.
 *
 * Both four-alternative terrain drills need the same thing and the same guarantee: every
 * distractor must differ from the target **in a way the player can actually see**. A
 * sibling whose one moved feature fell outside the visible window, or whose warp barely
 * dented the relief, is a second correct answer — which is invisible while playing and
 * reads as the drill being unfair.
 *
 * An option is `base` plus its edits, not a finished map: what makes it a sibling is the
 * edit list, and every check here reads that rather than what it would draw.
 */
export interface Siblings {
  readonly base: OMap;
  /** `count` of them; the answer is the one with no edits. */
  readonly variants: readonly Variant[];
  readonly correctIndex: number;
}

export interface SiblingOptions {
  /** How far the one edit moves something, in metres. Smaller is harder. */
  readonly distance: number;
  /** Which edits the drill will accept. Contours: `['warp']`. */
  readonly ops: readonly Edit['op'][];
  /** The change must show inside this window, if there is one. */
  readonly crop?: Crop;
  /** Least acceptable relief difference, in metres. */
  readonly minReliefDelta?: number;
}

const ATTEMPTS = 24;

/**
 * The ladder the fallback climbs when nothing at the level's own distance was visible.
 *
 * The fallback used to be a single unchecked draw at 2.5x — and an unchecked draw is a
 * distractor that may be identical to the answer inside the window, which is a round with
 * two right answers. It happened about once in five hundred map-memory rounds (`seed
 * 2492758438, level 3`) and the property tests flaked at exactly that rate.
 *
 * Bounded attempts at each rung, then a bigger move again: an edit that cannot be seen at
 * 2.5x is usually one whose pool keeps offering features outside the window, and more
 * distance is what eventually drags one across it. The first draw is still 2.5x, so a
 * round whose old fallback happened to be visible keeps the distractor it had.
 */
const FALLBACK_FACTORS: readonly number[] = [2.5, 5, 10];
const FALLBACK_ATTEMPTS = 12;

/**
 * Whether the changed thing still belongs where it now is.
 *
 * Once the generator places a marsh in flat, low ground and a crag on steep ground, an
 * edit that drops one somewhere else is a **tell**: a strong player learns to pick the odd
 * card out by spotting the marsh on the hillside rather than by remembering the ground,
 * which is a different skill and not the one being trained.
 *
 * It is a preference and not a filter. Insisting on it would push more rounds onto the
 * `distance * 2.5` fallback below, and a distractor that differs by far more than the
 * level asked for is a worse question than a slightly odd marsh.
 *
 * A warp has nothing to answer: it moves the ground itself, and the ground is never in
 * the wrong place.
 */
export function isPlausibleChange(variant: Variant, where: Plausibility): boolean {
  const after = applyEdits(variant.base, variant.edits);
  return variant.edits.every((edit) => {
    if (edit.op === 'warp') return true;
    if (edit.op === 'remove') return true;
    const id = edit.op === 'add' ? edit.feature.id : edit.feature;
    const moved = after.features.find((f) => f.id === id);
    if (!moved) return true;
    const at = positionOf(moved);
    return 'ground' in where
      ? suits(moved.code, where.ground, at)
      : suitsOnMask(moved.code, where.raster, at);
  });
}

/**
 * What the map can be asked whether a symbol belongs somewhere.
 *
 * §3.3: same question, two backends. A height field answers it about the shape of the
 * ground; a colour mask answers it about the ink. A map that has a relief is asked about
 * the relief — it is the stronger claim, and it is the one the generator's own placement
 * rules were written against — and a picture with no heights is asked about its mask.
 */
export type Plausibility =
  | { readonly ground: Ground }
  | { readonly raster: RasterLayer };

/** Which backend this map offers, or none, in which case nothing is ever implausible. */
export function plausibilityOf(map: OMap): Plausibility | null {
  if (map.relief.kind !== 'none') return { ground: readGround(map.relief) };
  if (map.raster) return { raster: map.raster };
  // A flat map with no picture: `suits` would ask a height field of zeros for its
  // steepest quarter and refuse every symbol that has an opinion, which is not a judgement
  // about the ground, it is a judgement about there being none.
  return null;
}

/** Whether this edit is one the player could notice. */
export function isVisibleChange(variant: Variant, options: SiblingOptions): boolean {
  const window_ = options.crop ?? wholeMap(variant.base);
  const report = difference(variant, window_);
  if (!report.visible) return false;
  // A warp that barely dents the shading is a second right answer. The drill that reads
  // relief states its own floor; one metre is the default for a caller that does not.
  const floor = options.minReliefDelta ?? (options.ops.every((op) => op === 'warp') ? 1 : 0);
  return report.reliefDelta >= floor;
}

export function siblings(
  rng: Rng,
  base: OMap,
  count: number,
  options: SiblingOptions,
): Siblings {
  const made: Variant[] = [];

  // Sampled once for the whole round. An edit that moves a feature leaves the height
  // field alone, so every candidate is judged against the same ground; a round that only
  // warps has nothing to ask it, and reading the ground is not free.
  const ground = options.ops.some((op) => op !== 'warp') ? plausibilityOf(base) : null;

  const spec = (distance: number): EditSpec => ({
    distance,
    ops: options.ops,
    ...(options.crop ? { within: options.crop } : {}),
    ...(options.minReliefDelta === undefined ? {} : { minReliefDelta: options.minReliefDelta }),
  });

  while (made.length < count - 1) {
    let accepted: Variant | null = null;
    let visibleOnly: Variant | null = null;
    for (let attempt = 0; attempt < ATTEMPTS && !accepted; attempt++) {
      const variant: Variant = {
        base,
        edits: [proposeEdit(base, rng, spec(options.distance))],
      };
      if (!isVisibleChange(variant, options)) continue;
      if (!ground || isPlausibleChange(variant, ground)) accepted = variant;
      else visibleOnly ??= variant;
    }
    accepted ??= visibleOnly;
    // Falling back to a bigger move is better than shipping an unanswerable round: an
    // easier distractor is a worse question, a duplicate of the answer is not a question.
    // Which is exactly why the fallback is checked too — see FALLBACK_FACTORS.
    if (!accepted) {
      let last: Variant | null = null;
      for (const factor of FALLBACK_FACTORS) {
        for (let attempt = 0; attempt < FALLBACK_ATTEMPTS && !accepted; attempt++) {
          last = { base, edits: [proposeEdit(base, rng, spec(options.distance * factor))] };
          if (isVisibleChange(last, options)) accepted = last;
        }
        if (accepted) break;
      }
      // Thirty-six draws at up to ten times the distance and still nothing shows: the
      // window holds nothing that can move. Ship the last one rather than loop forever,
      // and let `wellFormed` be the one that says the round is unanswerable.
      accepted ??= last;
    }
    made.push(accepted!);
  }

  const correctIndex = rng.int(count);
  const variants = [...made];
  // The answer is the base itself, and it says so: no edits.
  variants.splice(correctIndex, 0, { base, edits: [] });
  return { base, variants, correctIndex };
}
