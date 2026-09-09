import type { Rng } from '@/lib/rng.ts';
import { wholeMap, type Crop, type OMap } from '@/lib/terrain/omap.ts';
import { generateTerrain, type TerrainParams } from '@/lib/terrain/terrain.ts';

/**
 * Where a drill gets a piece of map.
 *
 * A drill states what it needs from the ground and is handed something that satisfies it.
 * *Which* source satisfied it — the generator, a library of imported maps, or a weighted
 * mix — is decided outside the drill and is the whole of the tier switch: the drills do
 * not know which one they got, and cannot be made to care.
 */
export interface MapProvider {
  /** `'generated'`, `'library:<hash>'`, `'mixed:<…>'`. Part of what a round is a function
   *  of, beside the seed and the level — see `AGENTS.md` on golden determinism and P2P. */
  readonly id: string;
  /** Pure. Same rng state, same requirement → same map and window. */
  pick(rng: Rng, requirement: WindowRequirement): { map: OMap; crop: Crop } | null;
}

export interface RoundContext {
  readonly maps: MapProvider;
}

/**
 * What a drill needs from a piece of map, stated once.
 *
 * The generator satisfies these **by construction** — `paramsFor` was always a
 * requirement in disguise, and it makes exactly what it is asked for. A real map will
 * satisfy them by **selection**, scoring windows over its own analysis, which is why this
 * is a description of the ground rather than a bag of generator parameters.
 */
export interface WindowRequirement {
  /** Side of the ground the round needs, in metres. */
  readonly size: number;
  /** The contours drill: a map with no relief cannot answer its question at all. */
  readonly needsRelief: boolean;
  /** Metres between the lowest and highest point of the window. */
  readonly relief?: { readonly minRange: number; readonly maxRange: number };
  /**
   * How much the ground should hold. Keyed by geometry rather than by family, because
   * that is the split the generator makes and the one a window score can check cheaply;
   * a floor for a real map, an exact count for the generator.
   */
  readonly minFeatures?: {
    readonly landform?: number;
    readonly point?: number;
    readonly line?: number;
    readonly area?: number;
  };
  /**
   * Families of parallel rides — the compartment grid. 0, 1 or 2.
   *
   * Not a difficulty knob and not a count of features: a managed forest *has* a grid, and
   * a map of one without it reads as heath. A surveyed map arrives with whatever grid was
   * cut, so nothing scores this — it is what the generator is asked to draw, and the
   * contours drill asks for none of it along with everything else.
   */
  readonly rides?: number;
  /**
   * Rock and boulder fields. Real point features come in patches, not evenly spread.
   *
   * Counted apart from `minFeatures.point`, which is the scatter around them.
   */
  readonly clusters?: number;
  /** Pexeso: a control has to be able to sit on something in every window. */
  readonly minControlSites?: number;
  /** Not one flat green wash. Nothing scores it until a real map can be turned down. */
  readonly maxRunnabilityCover?: number;
  /** A sub-window the provider should pick, if the drill shows less than all of it. */
  readonly crop?: number;
}

/**
 * The generator as a source.
 *
 * It never declines: it makes the map the requirement describes. That is what makes it
 * the fallback every other provider can be composed with.
 */
export class GeneratedProvider implements MapProvider {
  readonly id = 'generated';

  pick(rng: Rng, requirement: WindowRequirement): { map: OMap; crop: Crop } {
    const map = generateTerrain(rng, terrainParamsFor(requirement));
    if (requirement.crop === undefined) return { map, crop: wholeMap(map) };
    // Drawn after the map and in this order, because a round is a function of the rng
    // stream and moving a draw moves every round after it.
    const size = requirement.crop;
    const x = rng.range(0, map.width - size);
    const y = rng.range(0, map.height - size);
    return { map, crop: { x, y, size } };
  }
}

/**
 * A requirement's name in a bundle's window lists.
 *
 * Derived from **what it asks for** rather than from which drill asked, because two drills
 * that want the same ground should share a list, and a drill that changes what it needs
 * should stop matching windows scored for what it used to need — silently getting the old
 * ones would be a drill quietly running on the wrong map. Rounded to whole metres so a
 * floating-point size cannot produce two names for one requirement.
 */
export function requirementId(requirement: WindowRequirement): string {
  const parts = [`s${Math.round(requirement.size)}`];
  if (requirement.needsRelief) parts.push('relief');
  if (requirement.relief) {
    parts.push(`r${Math.round(requirement.relief.minRange)}-${Math.round(requirement.relief.maxRange)}`);
  }
  if (requirement.crop !== undefined) parts.push(`c${Math.round(requirement.crop)}`);
  if (requirement.minControlSites !== undefined) parts.push(`k${requirement.minControlSites}`);
  return parts.join('.');
}

/**
 * A library of imported maps, as a source.
 *
 * Unlike the generator it **declines**: a bundle with no relief cannot answer the contours
 * drill's question, and a bundle whose windows for a requirement came out empty has no
 * ground that satisfies it. Returning null rather than the best of a bad set is the whole
 * point — a real map is selected from, not made to order, and a provider that never says
 * no would hand the contours drill a flat map and call it a hard round.
 *
 * `pick` is **pure**: the bundles are fixed, their window lists were written by the
 * pipeline in a deterministic order, and the only thing that varies is the rng. Loading is
 * the async part and it happens outside, in `loadLibrary`.
 */
export class LibraryProvider implements MapProvider {
  readonly id: string;
  readonly bundles: readonly OMap[];

  constructor(bundles: readonly OMap[]) {
    this.bundles = bundles;
    // The id is part of what a round is a function of, so it names the bundles rather than
    // the library: two devices with different maps must not think they agree. Sorted, so
    // the same set in a different order is the same library.
    this.id = `library:${[...bundles].map((b) => b.id).sort().join(',')}`;
  }

  pick(rng: Rng, requirement: WindowRequirement): { map: OMap; crop: Crop } | null {
    const id = requirementId(requirement);
    const usable = this.bundles.filter((map) => {
      if (requirement.needsRelief && map.relief.kind === 'none') return false;
      return (map.windows?.[id]?.length ?? 0) > 0;
    });
    if (usable.length === 0) return null;
    // Two draws, in this order and always both: a provider whose rng consumption depended
    // on which map it happened to pick would make every round after it depend on that too.
    const map = usable[rng.int(usable.length)]!;
    const windows = map.windows![id]!;
    const window_ = windows[rng.int(windows.length)]!;
    if (requirement.crop === undefined) return { map, crop: window_ };
    // The drill shows less than the window it was given: the sub-window is drawn here, in
    // the same place in the stream as `GeneratedProvider` draws it.
    const size = Math.min(requirement.crop, window_.size);
    return {
      map,
      crop: {
        x: window_.x + rng.range(0, window_.size - size),
        y: window_.y + rng.range(0, window_.size - size),
        size,
      },
    };
  }
}

/** One source in a mix, and how much of the rounds it should get. */
export interface MixPart {
  readonly provider: MapProvider;
  /**
   * Relative, not a percentage: what matters is a part's share of the total, so `[7, 3]`
   * and `[0.7, 0.3]` are one mix and have one id.
   *
   * **Zero is not absent.** A part at zero is never drawn, but it is still in the
   * fall-through order below: "I want my rounds on real maps" is not "I would rather have
   * no round at all than a generated one", and a library that cannot answer the contours
   * drill has to be caught by something.
   */
  readonly weight: number;
}

/**
 * Several sources, in proportion. The tier knob.
 *
 * 100% generated, 30% real, 100% real are all this one class with different weights, and
 * nothing below it knows: the drill asks for ground and is handed some.
 *
 * Two things make it usable as the thing a policy builds:
 *
 *  - **It falls through.** A `LibraryProvider` declines what it cannot serve — the contours
 *    drill on a raster-only library, a small library with no window scored for a 380 m
 *    relief round — and a mix that then gave up would turn "30% real maps" into "70% of my
 *    rounds, and an error screen for the rest". So a null moves on to the next part, in
 *    order, wrapping; only when every part declines does the mix decline.
 *  - **A forced choice is not a draw.** With one part at a positive weight there is nothing
 *    to decide, so no number is drawn and the mix consumes the rng exactly as that provider
 *    alone would — which is what makes a policy at 100% one source produce the very rounds
 *    that source produces, rather than rounds shifted by one draw.
 */
export class MixedProvider implements MapProvider {
  readonly id: string;
  readonly parts: readonly MixPart[];

  constructor(parts: readonly MixPart[]) {
    if (parts.length === 0) throw new RangeError('MixedProvider needs at least one source');
    this.parts = parts;
    const total = parts.reduce((sum, p) => sum + Math.max(0, p.weight), 0);
    // The share, not the number that was passed, so one mix has one id. Two decimals is
    // the resolution the settings screen offers (10% steps), and trailing zeros go so that
    // 0.7 reads as 0.7. Order is part of the id because it is part of the behaviour: the
    // parts are tried in it. That is the opposite of `LibraryProvider`, which sorts.
    const share = (weight: number) =>
      total > 0 ? String(Number((Math.max(0, weight) / total).toFixed(2))) : '0';
    this.id = `mixed:${parts.map((p) => `${share(p.weight)}*${p.provider.id}`).join('+')}`;
  }

  pick(rng: Rng, requirement: WindowRequirement): { map: OMap; crop: Crop } | null {
    const start = this.draw(rng);
    for (let step = 0; step < this.parts.length; step++) {
      const picked = this.parts[(start + step) % this.parts.length]!.provider.pick(rng, requirement);
      if (picked) return picked;
    }
    return null;
  }

  /** Which part goes first. One draw, or none when there is nothing to decide. */
  private draw(rng: Rng): number {
    const weights = this.parts.map((p) => Math.max(0, p.weight));
    const total = weights.reduce((sum, w) => sum + w, 0);
    const drawable = weights.filter((w) => w > 0).length;
    // Nothing to decide: one source can be drawn, or none can, and either way the answer
    // does not depend on chance. Drawing anyway would move every round after it.
    if (drawable <= 1) return total > 0 ? weights.findIndex((w) => w > 0) : 0;
    let ticket = rng.range(0, total);
    for (let i = 0; i < weights.length; i++) {
      ticket -= weights[i]!;
      // A float sum can leave the last ticket a hair over the total, so the last positive
      // weight is the answer for anything that falls off the end.
      if (ticket < 0 && weights[i]! > 0) return i;
    }
    return weights.findLastIndex((w) => w > 0);
  }
}

/** A requirement, back into the numbers the generator takes. */
export function terrainParamsFor(requirement: WindowRequirement): TerrainParams {
  const wanted = requirement.minFeatures;
  return {
    size: requirement.size,
    // A requirement that names no landforms and needs relief still gets some ground:
    // four is where `paramsFor` starts. One that does not need relief gets the tilt.
    landforms: wanted?.landform ?? (requirement.needsRelief ? 4 : 0),
    points: wanted?.point ?? 0,
    lines: wanted?.line ?? 0,
    areas: wanted?.area ?? 0,
    // A requirement that says nothing asks for nothing, exactly as it does for the
    // feature counts: a drill states the ground it wants, and the compartment grid is
    // part of the ground.
    rides: requirement.rides ?? 0,
    clusters: requirement.clusters ?? 0,
  };
}
