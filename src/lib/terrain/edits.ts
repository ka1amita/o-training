import type { Rng } from '@/lib/rng.ts';
import {
  areasOf, boundsOf, insideCrop, movedTo, pointsOf, positionOf, translated,
  type Crop, type Feature, type OMap, type Vec,
} from './omap.ts';
import { AnalyticRelief, warpDisplacement, type Relief, type Warp } from './relief.ts';
import { CONTRAST, semanticsOf, SEMANTICS, type Family, type IsomCode } from './semantics.ts';

export type { Warp } from './relief.ts';

/**
 * A distractor is `base + edits`, and the edits are the value.
 *
 * `perturb` used to change one `(x, y)` in one of three arrays and report which, and the
 * checks afterwards recovered what it had done by comparing the arrays index by index.
 * That only works while the generator owns the arrays: on an imported map with 4000
 * features and no index worth the name, "what changed" has to be something the round
 * carries rather than something recovered from the result.
 *
 * So the round holds `base` and, per option, the edits that make it. `applyEdits` is pure
 * and is what the renderer receives; `wellFormed` reads the edits and the window and
 * never what came out of it, which is the one rule.
 */
export type Edit =
  | { readonly op: 'move'; readonly feature: string; readonly dx: number; readonly dy: number }
  | { readonly op: 'remove'; readonly feature: string }
  | { readonly op: 'add'; readonly feature: Feature }
  /** Boulder to knoll: the same thing drawn, a different thing meant. */
  | { readonly op: 'swap'; readonly feature: string; readonly code: IsomCode }
  | { readonly op: 'warp'; readonly warp: Warp };

export interface Variant {
  readonly base: OMap;
  readonly edits: readonly Edit[];
}

/** What a drill asks for when it wants a sibling of a map. */
export interface EditSpec {
  /** Metres. Smaller is harder. */
  readonly distance: number;
  /** Contours: `['warp']` only — a boulder somewhere else is the same relief. */
  readonly ops: readonly Edit['op'][];
  /** Only touch these families. Nothing asks yet; a same-family edit is the harder one. */
  readonly families?: readonly Family[];
  /** Map memory: the window the change has to happen in. See `proposeEdit`. */
  readonly within?: Crop;
  /** Contours: the least relief the edit may leave. Checked by the caller, not here. */
  readonly minReliefDelta?: number;
}

export function applyEdits(map: OMap, edits: readonly Edit[]): OMap {
  return edits.reduce(applyOne, map);
}

function applyOne(map: OMap, edit: Edit): OMap {
  switch (edit.op) {
    case 'move': {
      const feature = map.features.find((f) => f.id === edit.feature);
      if (!feature) return map;
      // Clamped here rather than in the edit: an edit is a request for a displacement,
      // and how much of it the map has room for is the map's answer, not the asker's.
      const from = positionOf(feature);
      const to = {
        x: Math.min(map.width, Math.max(0, from.x + edit.dx)),
        y: Math.min(map.height, Math.max(0, from.y + edit.dy)),
      };
      return { ...map, features: map.features.map((f) => (f === feature ? movedTo(f, to) : f)) };
    }
    case 'remove':
      return { ...map, features: map.features.filter((f) => f.id !== edit.feature) };
    case 'add':
      return { ...map, features: [...map.features, edit.feature] };
    case 'swap':
      return {
        ...map,
        features: map.features.map((f) => {
          if (f.id !== edit.feature) return f;
          // `kind` goes: it is the generator's word for what this was, and it is no
          // longer true. `shape` stays exactly as it is — it seeds the outline, and an
          // area that changed symbol must not also change its edges.
          const { kind: _was, ...rest } = f;
          return { ...rest, code: edit.code };
        }),
      };
    case 'warp':
      return {
        ...map,
        relief: map.relief.warped(edit.warp),
        ...(edit.warp.carries
          ? { features: map.features.map((f) => carried(f, edit.warp, map)) }
          : {}),
      };
  }
}

/**
 * A feature standing on warped ground moves with the ground it stands on.
 *
 * The displacement is the warp's own falloff — the bump the landforms use — so a boulder
 * at the centre of a moved knoll travels the full distance and one at the edge of its
 * support does not move at all. Without it a knoll slides out from under its own boulder,
 * which is not a map any surveyor would draw and is the tell a strong player would learn
 * to read instead of the ground.
 */
function carried(feature: Feature, w: Warp, map: OMap): Feature {
  const p = positionOf(feature);
  const d = warpDisplacement(w, p.x, p.y);
  if (d.x === 0 && d.y === 0) return feature;
  // Clamped to the map, exactly as `move` is and for the same reason: how far a
  // displacement can actually be taken is the map's answer, not the asker's. A warp on
  // the border therefore slides its knoll (`AnalyticRelief.warped` clamps too) and leaves
  // a boulder pinned at the edge — a corner case, and a visible map beats a feature off it.
  const to = {
    x: Math.min(map.width, Math.max(0, p.x + d.x)),
    y: Math.min(map.height, Math.max(0, p.y + d.y)),
  };
  return translated(feature, to.x - p.x, to.y - p.y);
}

/**
 * Where a warp can pick up a piece of ground.
 *
 * The analytic relief knows its own landforms; an imported map does not, and its
 * candidates come from the pipeline's analysis — local extrema and their extents, which
 * is what `readGround` already finds. Nothing else may reach into `AnalyticRelief`.
 */
function warpCandidates(map: OMap): readonly { readonly centre: Vec; readonly radius: number }[] {
  if (map.analysis) {
    return map.analysis.landforms.map((l) => ({ centre: l.centre, radius: l.radius }));
  }
  if (map.relief instanceof AnalyticRelief) {
    return map.relief.landforms.map((f) => ({
      centre: { x: f.x, y: f.y },
      radius: f.radius * f.elongation,
    }));
  }
  return [];
}

interface Pool {
  readonly op: Edit['op'];
  /** Empty for a warp, whose candidates are pieces of ground rather than features. */
  readonly features: readonly Feature[];
}

/**
 * One edit, for a level.
 *
 * The pools are built in a fixed order and one is picked uniformly, which is what makes a
 * boulder as likely to move as a landform on a map that has both.
 *
 * **`within` narrows the candidates rather than filtering the proposals.** Drawing over
 * the whole map and rejecting what fell outside the window was fine while features were
 * spread evenly; once they arrive in clusters, a window that misses the rocky band holds
 * almost nothing and the retries run out — one map-memory round in three then had a
 * distractor identical to the answer. Choosing from what is *in* the window makes it
 * structural instead of probable, and it costs no extra draw: the pick is one `rng.int`
 * over a shorter list. A window that holds nothing of a kind falls back to the whole
 * list, because there is nothing to be done here and `wellFormed` is what catches it.
 *
 * An empty pool throws, as `rng.pick` always did: there is nothing to propose on a map
 * with no landforms and no features, and inventing something quietly would hide it.
 */
export function proposeEdit(map: OMap, rng: Rng, spec: EditSpec): Edit {
  const wanted = (f: Feature) =>
    !spec.families || spec.families.includes(semanticsOf(f.code)?.family ?? 'overprint');
  const shown = <T,>(list: readonly T[], at: (item: T) => Vec): readonly T[] => {
    if (!spec.within) return list;
    const inside = list.filter((item) => insideCrop(at(item), spec.within!));
    return inside.length > 0 ? inside : list;
  };
  const points = shown(pointsOf(map).filter(wanted), positionOf);
  const areas = shown(areasOf(map).filter(wanted), positionOf);
  const warps = shown(warpCandidates(map), (w) => w.centre);
  const has = (op: Edit['op']) => spec.ops.includes(op);

  const pools: Pool[] = [];
  if (has('warp') && warps.length > 0) pools.push({ op: 'warp', features: [] });
  if (has('move')) {
    if (points.length > 0) pools.push({ op: 'move', features: points });
    if (areas.length > 0) pools.push({ op: 'move', features: areas });
  }
  if (has('remove')) {
    if (points.length > 0) pools.push({ op: 'remove', features: points });
    if (areas.length > 0) pools.push({ op: 'remove', features: areas });
  }
  if (has('swap') && points.length > 0) pools.push({ op: 'swap', features: points });

  const pool = rng.pick(pools);

  if (pool.op === 'warp' || pool.op === 'move') {
    // A random direction at a fixed distance: the move is always exactly as large as
    // asked, so difficulty is the number that was requested rather than one that came out
    // of a uniform square and averaged smaller.
    const angle = rng.range(0, 2 * Math.PI);
    const dx = Math.cos(angle) * spec.distance;
    const dy = Math.sin(angle) * spec.distance;
    if (pool.op === 'warp') {
      const chosen = warps[rng.int(warps.length)]!;
      // Carrying, as §3.1 always said a warp should: the ground moves and what stands on
      // it moves with it. It was off through the refactor because switching it on rewrites
      // every map-memory round; this is the commit where that is the point rather than a
      // side effect, and the goldens are re-pinned with it.
      return {
        op: 'warp',
        warp: { centre: chosen.centre, radius: chosen.radius, dx, dy, carries: true },
      };
    }
    return { op: 'move', feature: pool.features[rng.int(pool.features.length)]!.id, dx, dy };
  }

  const feature = pool.features[rng.int(pool.features.length)]!;
  if (pool.op === 'remove') return { op: 'remove', feature: feature.id };
  return { op: 'swap', feature: feature.id, code: rng.pick(swapsFor(feature.code)) };
}

/** Codes a feature could plausibly be mistaken for: same family, same geometry. */
function swapsFor(code: IsomCode): readonly IsomCode[] {
  const semantics = semanticsOf(code);
  const others = Object.values(SEMANTICS).filter(
    (s) => s.code !== code && s.family === semantics?.family && s.geometry === semantics?.geometry,
  );
  return others.length > 0 ? others.map((s) => s.code) : [code];
}

/**
 * How different a variant is inside a window, as numbers rather than as a boolean.
 *
 * Difficulty used to be three separate implicit measures — the requested distance, a max
 * height difference, and a boolean "differs within" — none of which said the same thing
 * on a map busier than the generator's. This is one report, computed from the edits and
 * the semantic table and never from anything rendered.
 */
export interface Difference {
  /** Fraction of the window whose drawing can differ. A budget, not a measurement: the
   *  warp's disc is taken as its bounding square, and overlapping edits are summed. */
  readonly footprint: number;
  /** Largest |Δheight| inside the window; 0 when nothing touched the ground. */
  readonly reliefDelta: number;
  /** How hard the change is to see: ISOM minimum size in paper mm against the contrast of
   *  its colour. Nothing reads it yet — it is what the staircase will drive on a real map,
   *  where "distance 18 m" is not one difficulty. */
  readonly salience: number;
  /** Which semantic families the edit touches. Same-family edits are harder to notice. */
  readonly families: readonly Family[];
  /**
   * Whether the change lies inside the window at all.
   *
   * A **position** test on what moved, and deliberately not `footprint > 0`: a warp whose
   * disc clips the corner of the window but whose landform sits well outside it does not
   * count, exactly as it did not when this was `differsWithin`. Loosening it changes which
   * distractor a round accepts, and every golden with it.
   */
  readonly visible: boolean;
}

/** Grid the relief difference is sampled on, as `maxHeightDifference` samples the map. */
const RELIEF_SAMPLES = 32;

export function difference(variant: Variant, crop: Crop): Difference {
  const after = applyEdits(variant.base, variant.edits);
  const cropArea = crop.size * crop.size;
  const families: Family[] = [];
  let footprint = 0;
  let salience = 0;
  let visible = false;
  let movedGround = false;

  const note = (code: IsomCode | undefined) => {
    const semantics = code === undefined ? undefined : semanticsOf(code);
    const family = semantics?.family ?? 'landform';
    if (!families.includes(family)) families.push(family);
    const size = semantics?.minSizeMm ?? 1;
    salience = Math.max(salience, size * CONTRAST[semantics?.colour ?? 'brown']);
  };

  for (const edit of variant.edits) {
    if (edit.op === 'warp') {
      const { centre, radius, dx, dy } = edit.warp;
      const to = { x: centre.x + dx, y: centre.y + dy };
      if (insideCrop(centre, crop) || insideCrop(to, crop)) visible = true;
      footprint += overlap(
        { minX: centre.x - radius, maxX: centre.x + radius, minY: centre.y - radius, maxY: centre.y + radius },
        crop,
      ) / cropArea;
      movedGround = true;
      // A warp moves the ground, and the contour lines drawn on it are what is seen.
      note('101');
      continue;
    }

    if (edit.op === 'add') {
      if (insideCrop(positionOf(edit.feature), crop)) visible = true;
      footprint += overlap(boundsOf(edit.feature), crop) / cropArea;
      note(edit.feature.code);
      continue;
    }

    const was = variant.base.features.find((f) => f.id === edit.feature);
    if (!was) continue;
    note(was.code);
    if (insideCrop(positionOf(was), crop)) visible = true;
    footprint += overlap(boundsOf(was), crop) / cropArea;
    if (edit.op === 'move') {
      const now = after.features.find((f) => f.id === edit.feature);
      if (now) {
        if (insideCrop(positionOf(now), crop)) visible = true;
        footprint += overlap(boundsOf(now), crop) / cropArea;
      }
    }
  }

  return {
    footprint: Math.min(1, footprint),
    reliefDelta: movedGround ? reliefDeltaIn(variant.base.relief, after.relief, crop) : 0,
    salience,
    families,
    visible,
  };
}

interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

const overlap = (box: Box, crop: Crop): number =>
  Math.max(0, Math.min(box.maxX, crop.x + crop.size) - Math.max(box.minX, crop.x)) *
  Math.max(0, Math.min(box.maxY, crop.y + crop.size) - Math.max(box.minY, crop.y));

/**
 * The largest height difference inside a window.
 *
 * Over the whole map this is `maxHeightDifference` sample for sample, which is what lets
 * the contours drill state its floor here instead of there.
 */
function reliefDeltaIn(a: Relief, b: Relief, crop: Crop): number {
  const step = crop.size / RELIEF_SAMPLES;
  let worst = 0;
  for (let j = 0; j <= RELIEF_SAMPLES; j++) {
    for (let i = 0; i <= RELIEF_SAMPLES; i++) {
      const x = crop.x + i * step;
      const y = crop.y + j * step;
      const d = Math.abs(a.heightAt(x, y) - b.heightAt(x, y));
      if (d > worst) worst = d;
    }
  }
  return worst;
}
