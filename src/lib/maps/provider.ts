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
