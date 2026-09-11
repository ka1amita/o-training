import { hashJson, type Rng } from '@/lib/rng.ts';
import { applyEdits } from '@/lib/terrain/edits.ts';
import { budgetFor, proposeEnrichment, scaledBy } from '@/lib/terrain/enrich.ts';
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
  /**
   * Which rung of the ladder asked, when the drill is willing to say.
   *
   * Deliberately **not** part of `requirementId`: a level does not change which ground
   * answers the question — `minFeatures` is a floor on a real map — so two levels asking
   * for the same square of forest must keep sharing one scored window list. It is here
   * for a provider that makes ground rather than only selecting it, which so far is
   * `AdjustedProvider`: how much a window is worth adjusting is a difficulty knob, and
   * the requirement is the only thing that crosses from the drill to the provider.
   *
   * Optional, and a provider that reads it has to have an answer for its absence.
   */
  readonly level?: number;
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
    // **Held in the order the id names them, not the order they arrived in.** The id sorts
    // by content hash so that the same maps in a different order are one library — and
    // `pick` walks `bundles`, so if that order were the arrival order the id would be a
    // claim the provider does not keep: two devices holding the same two maps, enabled in
    // the settings screen in the opposite order or fetched in the opposite order, would
    // publish the same id and then draw different maps from the same seed. Measured before
    // this line existed: forty seeds, forty different rounds, one id. A round is a function
    // of `(seed, level, provider.id)` or it is not, and that is what P2P agreement and
    // every golden rest on.
    this.bundles = [...bundles].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.id = `library:${this.bundles.map((b) => b.id).join(',')}`;
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

/**
 * The level a requirement that names none is adjusted at.
 *
 * The middle of the ladder. A drill that has not been taught to say which rung it is on
 * still gets an adjusted window — the alternative is a source that quietly does nothing
 * for one drill and everything for the others, which is worse than a middling answer.
 */
const UNSTATED_LEVEL = 5;

/**
 * A library of real maps, made busier — the third source.
 *
 * A surveyed map is not a generated one with better cartography. It is a map of ground
 * that happens to have nothing on it in places, and a window onto it can be four hundred
 * metres of white forest with a path across the corner. This picks a real window exactly
 * as `LibraryProvider` does and then lets `proposeEnrichment` put back the detail a drill
 * needs, at the level's own budget and this policy's intensity.
 *
 * Three things make it safe to put a round on:
 *
 *  - **The edits are the map.** `applyEdits` is the only thing that produces what the
 *    player sees, so a round is still a function of the rng, and everything downstream —
 *    `siblings`, `sitesOf`, `wellFormed`, `score` — reads features and never pixels. A
 *    distractor is still `base + edits` where the base is now this map.
 *  - **The id names what was done.** `adjusted:<bundle>:<hash of the edits>`, so two
 *    windows of one bundle adjusted differently are two maps and say so. `sourceOf` reads
 *    `adjusted` and badges the round `adj`.
 *  - **It declines exactly when the library does.** No window, no map: `MixedProvider`
 *    then falls through to the generator, which is what keeps the contours drill working
 *    on a library with no relief.
 *
 * At intensity 0 it is the library, **draw for draw** — an empty budget proposes nothing
 * and consumes no numbers — and the map that comes back is the bundle's own, unadjusted
 * and badged `real`, because that is what the round is on.
 */
export class AdjustedProvider implements MapProvider {
  readonly id: string;
  readonly library: LibraryProvider;
  readonly intensity: number;

  constructor(library: LibraryProvider | readonly OMap[], intensity: number) {
    this.library = library instanceof LibraryProvider ? library : new LibraryProvider(library);
    this.intensity = Math.min(1, Math.max(0, intensity));
    // Both halves, because both change the rounds: which maps, and how hard they are
    // adjusted. Two decimals and no trailing zeros, as `MixedProvider` writes a share.
    this.id = `adjusted:${Number(this.intensity.toFixed(2))}:${this.library.id}`;
  }

  pick(rng: Rng, requirement: WindowRequirement): { map: OMap; crop: Crop } | null {
    const picked = this.library.pick(rng, requirement);
    if (!picked) return null;
    const budget = scaledBy(budgetFor(requirement.level ?? UNSTATED_LEVEL), this.intensity);
    const edits = proposeEnrichment(picked.map, picked.crop, rng, budget);
    // Nothing proposed is nothing to say: the window is the bundle's own, and a map that
    // wore an `adjusted:` id with an empty edit list would be a badge claiming a change
    // the round does not have.
    if (edits.length === 0) return picked;
    return {
      map: {
        ...applyEdits(picked.map, edits),
        id: `adjusted:${picked.map.id}:${hashJson(edits)}`,
        adjusted: true,
      },
      crop: picked.crop,
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
