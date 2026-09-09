import { requirementFor as contoursRequirement } from '@/drills/contours/drill.ts';
import { requirementFor as memoryRequirement } from '@/drills/mapMemory/drill.ts';
import { requirementFor as pexesoRequirement } from '@/drills/pexeso/drill.ts';
import type { KeyValue } from '@/lib/store.ts';
import type { OMap } from '@/lib/terrain/omap.ts';
import { loadBundle, type MapBundle } from './bundle.ts';
import { requirementId, type WindowRequirement } from './provider.ts';

/**
 * Every requirement any drill can state, at any level.
 *
 * The pipeline scores a window list per entry, so this is the list that decides what an
 * imported map can be used for — and it is **derived from the drills** rather than
 * restated here. A second list would be a second place for a drill's needs to live, and
 * the day they drifted a drill would silently get windows scored for what it used to want.
 *
 * Deduplicated by `requirementId`, because most levels ask for the same ground: the three
 * drills across ten levels are thirty requirements and four distinct pieces of ground.
 */
export function libraryRequirements(): WindowRequirement[] {
  const out = new Map<string, WindowRequirement>();
  for (let level = 1; level <= 10; level++) {
    for (const requirement of [
      pexesoRequirement(level),
      contoursRequirement(level),
      memoryRequirement(level),
    ]) {
      const id = requirementId(requirement);
      // The first level to ask wins. What varies across levels is `minFeatures`, which is
      // a *floor* for a real map and does not change which windows are worth keeping;
      // what does change the id — size, relief, crop — is already in the key.
      if (!out.has(id)) out.set(id, requirement);
    }
  }
  return [...out.values()];
}

/**
 * Bundles kept beside progress, under their own prefix.
 *
 * `drill:` is progress and `map:` is a decoded map, and `clearAll` still deletes only the
 * first — "clear my progress" on the Progress screen means the training record, not a
 * forty-megabyte download the player would then be asked to fetch again on a phone in a
 * forest. Widening it is a deliberate change and a change to that screen's copy.
 */
const keyFor = (url: string) => `map:${url}`;

/**
 * Fetch the bundles a policy names, decoding each one once.
 *
 * The async half of the library, kept away from `LibraryProvider.pick`, which is pure and
 * has to stay that way: a round is a function of the rng and the fixed bundle list, and a
 * provider that fetched while picking would make it a function of the network.
 *
 * A bundle that fails — missing, malformed, a format from the future — is **skipped, not
 * thrown**. A player who is offline with two of three maps cached should get a session
 * from the two, and the one rule of this app's storage is that a training screen still
 * opens when storage is empty.
 */
export async function loadLibrary(
  urls: readonly string[],
  fetcher: typeof fetch,
  kv?: KeyValue,
): Promise<OMap[]> {
  const maps: OMap[] = [];
  for (const url of urls) {
    try {
      const cached = kv ? await kv.get<MapBundle>(keyFor(url)) : undefined;
      const bundle = cached ?? (await fetchBundle(url, fetcher));
      const map = loadBundle(bundle);
      // Cached after decoding succeeds, so a bundle that cannot be read is never stored
      // and cannot poison every later launch.
      if (kv && !cached) await kv.set(keyFor(url), bundle);
      maps.push(map);
    } catch {
      // Deliberately silent to the player and deliberately not fatal. Which maps a
      // library holds is a dev-time question, and `#/dev/maps` is where it is answered.
      continue;
    }
  }
  return maps;
}

async function fetchBundle(url: string, fetcher: typeof fetch): Promise<MapBundle> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return (await response.json()) as MapBundle;
}

/** Forget a cached bundle. Not wired to any screen; the counterpart to the cache above. */
export async function forgetBundle(kv: KeyValue, url: string): Promise<void> {
  await kv.del(keyFor(url));
}
