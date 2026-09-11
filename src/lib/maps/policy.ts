import { POLICY_KEY, type KeyValue } from '@/lib/store.ts';
import type { OMap } from '@/lib/terrain/omap.ts';
import { BUNDLED_MAPS } from './library.ts';
import {
  AdjustedProvider, GeneratedProvider, LibraryProvider, MixedProvider, type MapProvider,
} from './provider.ts';

/**
 * Where this device's rounds come from.
 *
 * The tier switch, as one small record: the drills never learn which source they got, and
 * everything that decides it is here and on the settings screen. A round is a function of
 * `(seed, level, provider.id)`, so a policy is not a preference about presentation — it is
 * part of what a round *is*, which is why `providerFor` is the only way to turn one into a
 * provider and why the id it produces names every source that can appear.
 */
export type PolicySource = 'generated' | 'real' | 'mixed' | 'adjusted';

export interface MapPolicy {
  readonly source: PolicySource;
  /** `mixed` only: the share of rounds drawn from the library, 0 to 1. */
  readonly realShare?: number;
  /**
   * `adjusted` only: how much of a level's edit budget to spend, 0 to 1.
   *
   * Its own knob and **not** folded into `realShare`, because they answer different
   * questions: the share says how often a round is on a real map, and this says how much
   * was put back on the window when it is. One slider meaning both would make one id name
   * two different sets of rounds.
   */
  readonly intensity?: number;
  /**
   * Which maps the library holds, by bundle name — `forest-sample.json`, not a URL.
   *
   * A URL would rot: `import.meta.env.BASE_URL` is `/` in dev and `/o-training/` on
   * Pages, so a policy stored under one would name nothing under the other. The name is
   * the stable half; `bundleUrl` puts it back together.
   */
  readonly library: readonly string[];
}

/**
 * What a device that has never opened the settings screen trains on.
 *
 * **Generated**, and that is the whole point of it: this step adds a switch, not a change.
 * The bundled maps are listed as enabled so that turning the switch to real maps needs one
 * tap rather than two, but nothing is fetched while the source is `generated` — the
 * library list is read only when a provider that could use it is built.
 */
export const DEFAULT_POLICY: MapPolicy = { source: 'generated', library: BUNDLED_MAPS };

/** The share of real rounds a mix starts at, in the 10% steps the slider offers. */
export const DEFAULT_REAL_SHARE = 0.3;

/** How hard an adjusted window is adjusted before anybody moves the slider. Half. */
export const DEFAULT_INTENSITY = 0.5;

/**
 * A stored policy, or the default.
 *
 * Same rule as `loadProgress`: storage can be cleared, downgraded, or written by an older
 * build, and a screen the player opened to train has to open. Anything that is not a
 * policy this build understands reads as no policy at all — never as a partly applied one,
 * because a policy half-read is a provider whose id is a lie about which rounds it makes.
 */
export function parsePolicy(stored: unknown): MapPolicy {
  if (typeof stored !== 'object' || stored === null) return DEFAULT_POLICY;
  const raw = stored as Record<string, unknown>;
  const sources: readonly unknown[] = ['generated', 'real', 'mixed', 'adjusted'];
  if (!sources.includes(raw.source)) return DEFAULT_POLICY;
  if (!Array.isArray(raw.library) || raw.library.some((name) => typeof name !== 'string')) {
    return DEFAULT_POLICY;
  }
  // A record written before this build knew about intensity has none, and that is not a
  // malformed record — it is an older record, and it reads as the default. What is
  // refused is a value that is *there* and is not a fraction.
  const fraction = (value: unknown) =>
    value === undefined || (typeof value === 'number' && value >= 0 && value <= 1);
  const share = raw.realShare;
  const intensity = raw.intensity;
  if (!fraction(share) || !fraction(intensity)) return DEFAULT_POLICY;
  return {
    source: raw.source as PolicySource,
    library: raw.library as string[],
    ...(typeof share === 'number' ? { realShare: share } : {}),
    ...(typeof intensity === 'number' ? { intensity } : {}),
  };
}

export async function loadPolicy(kv: KeyValue): Promise<MapPolicy> {
  return parsePolicy(await kv.get<unknown>(POLICY_KEY));
}

export async function savePolicy(kv: KeyValue, policy: MapPolicy): Promise<void> {
  await kv.set(POLICY_KEY, policy);
}

/** The bundle names a policy needs fetched before a session starts. Empty for the
 *  default, because a generated round asks the network for nothing. */
export const bundlesFor = (policy: MapPolicy): readonly string[] =>
  policy.source === 'generated' ? [] : policy.library;

/**
 * A policy and the maps that actually loaded, as the provider a session runs on.
 *
 * The maps are passed in rather than fetched here: `pick` is pure and has to stay that
 * way — a provider that fetched while picking would make a round a function of the
 * network. Whatever failed to load is simply absent, and the id says so, which is the
 * honest answer for a phone in a forest with two of three maps cached.
 */
export function providerFor(policy: MapPolicy, maps: readonly OMap[]): MapProvider {
  const generated = new GeneratedProvider();
  // No maps means only one thing can happen, so the provider says only one thing can
  // happen. A `MixedProvider` wrapping an empty library would fall through to the
  // generator on every round and still call itself a mix — an id that describes rounds
  // this device cannot make, and two peers comparing ids would disagree over nothing.
  if (policy.source === 'generated' || maps.length === 0) return generated;

  const library = new LibraryProvider(maps);
  if (policy.source === 'real' || policy.source === 'adjusted') {
    // Zero, not absent: the library is the only source rounds are *drawn* from, and the
    // generator is what catches a requirement it cannot serve — the contours drill on a
    // library with no relief. See `MixedProvider`.
    const real = policy.source === 'real'
      ? library
      : new AdjustedProvider(library, policy.intensity ?? DEFAULT_INTENSITY);
    return new MixedProvider([
      { provider: real, weight: 1 },
      { provider: generated, weight: 0 },
    ]);
  }

  /**
   * **A mix is generated and real, and adjustment is not in it.**
   *
   * The obvious alternative — let the share slider spread rounds over three sources, or
   * quietly swap the real part for the adjusted one when the intensity is up — was turned
   * down twice over. The share and the intensity answer different questions (how often a
   * round is on a real map, and how much was put back on the window when it is), so one
   * slider driving both would make one id name two different sets of rounds. And every
   * device already storing `mixed` would change what it plays on the day this shipped,
   * for a source nobody asked it for.
   *
   * Adjustment is therefore a source of its own, sitting beside `real` and built the same
   * way. A player who wants some of their rounds adjusted picks `adjusted` and turns the
   * intensity down, which is the same knob from the other end.
   */
  const share = Math.min(1, Math.max(0, policy.realShare ?? DEFAULT_REAL_SHARE));
  return new MixedProvider([
    { provider: generated, weight: 1 - share },
    { provider: library, weight: share },
  ]);
}

/**
 * Which source a round ran on, from the map it holds.
 *
 * Read off the map's own `meta` — a bundle records where it came from — and off its id for
 * the generator, which has no file to have come from. Never off what was drawn: the badge
 * in the round header is a fact about the round's structure, like everything else here.
 *
 * `adj` is asked first and is a fact about the map rather than about the policy: a window
 * the adjusted source handed back with no edits on it is a **real** round and says so.
 */
export const sourceOf = (map: OMap): 'gen' | 'real' | 'adj' =>
  map.adjusted ? 'adj'
  : map.meta || map.id !== 'generated' ? 'real'
  : 'gen';

/**
 * One word for the maps a round is on, or nothing when it is on none.
 *
 * `mix` exists because a round can honestly be both: pexeso draws a map per pair, and
 * under a mixed policy two of six pairs can be real. Calling that round `real` because its
 * first pair was would be a badge that says something the round does not.
 */
export function sourceBadge(maps: readonly OMap[]): 'gen' | 'real' | 'adj' | 'mix' | null {
  if (maps.length === 0) return null;
  const first = sourceOf(maps[0]!);
  return maps.every((map) => sourceOf(map) === first) ? first : 'mix';
}
