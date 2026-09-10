import { requirementFor as contoursRequirement } from '@/drills/contours/drill.ts';
import { requirementFor as dohledavkaRequirement } from '@/drills/mapDohledavka/drill.ts';
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
 * Deduplicated by `requirementId`, because most levels ask for the same ground: the four
 * drills across ten levels are forty requirements and fourteen distinct pieces of ground.
 * Map dohledavka is the one that grows the list — the card size *is* one of its two
 * difficulty axes, so each of its ten levels asks for a different square of forest.
 */
export function libraryRequirements(): WindowRequirement[] {
  const out = new Map<string, WindowRequirement>();
  for (let level = 1; level <= 10; level++) {
    for (const requirement of [
      pexesoRequirement(level),
      contoursRequirement(level),
      memoryRequirement(level),
      dohledavkaRequirement(level),
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
 * The bundles that ship in `public/maps/`.
 *
 * A list rather than a directory scan, because `public/` is copied verbatim and there is
 * nothing at runtime to ask what is in it. Step 6's `MapPolicy` chooses among these; until
 * then only `#/dev/maps` reads it.
 */
export const BUNDLED_MAPS: readonly string[] = ['forest-sample.json'];

/**
 * A bundle name, as somewhere to fetch it from.
 *
 * `BASE_URL` is `/` in dev and `/o-training/` on Pages, which is exactly why a `MapPolicy`
 * stores the **name** and never the URL: a policy written under one base would name nothing
 * under the other, and the player's maps would quietly stop loading after a deploy.
 */
export const bundleUrl = (name: string): string => `${import.meta.env.BASE_URL}maps/${name}`;

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
 * How long one bundle may take before the library gives up on it.
 *
 * **A fetch with no timeout is a hang.** A captive portal completes the connection and
 * then answers nothing; a phone that has lost the network mid-request waits on a socket
 * that will never speak. `loadLibrary` is awaited before the first round exists, so that
 * wait is a drill screen showing three dots with nothing behind them — the same failure
 * STUN has, and `AGENTS.md` is explicit that the answer there is to time out and offer the
 * other thing, never to hang. This is the same 20 seconds `CONNECT_TIMEOUT_MS` gives a
 * peer, for the same reason: long enough that a slow phone is not cut off, short enough
 * that nobody is left staring at a screen with no way out of it.
 *
 * It bounds the *whole* fetch, body included, so it can cut a download that is genuinely
 * still arriving. That is the trade, and it is the right way round: a bundle is cached
 * after the first success, so the cost of cutting one is one retry, and the cost of not
 * bounding it is a screen that never resolves.
 */
export const BUNDLE_TIMEOUT_MS = 20_000;

/**
 * Fetch the bundles a policy names, decoding each one once.
 *
 * The async half of the library, kept away from `LibraryProvider.pick`, which is pure and
 * has to stay that way: a round is a function of the rng and the fixed bundle list, and a
 * provider that fetched while picking would make it a function of the network.
 *
 * A bundle that fails — missing, malformed, a format from the future, too slow — is
 * **skipped, not thrown**. A player who is offline with two of three maps cached should get
 * a session from the two, and the one rule of this app's storage is that a training screen
 * still opens when storage is empty. What the caller does with a short library is the
 * caller's: `providerFor` names only the maps that arrived, and `DrillPage` says so on
 * screen rather than pretending the session is on ground it is not.
 */
export async function loadLibrary(
  urls: readonly string[],
  fetcher: typeof fetch,
  kv?: KeyValue,
  timeoutMs = BUNDLE_TIMEOUT_MS,
): Promise<OMap[]> {
  const maps: OMap[] = [];
  for (const url of urls) {
    try {
      const cached = kv ? await kv.get<MapBundle>(keyFor(url)) : undefined;
      const bundle = cached ?? (await fetchBundle(url, fetcher, timeoutMs));
      // The URL, so a bundle that names its picture as a sibling — `forest.png` beside
      // `forest.json` — resolves it against the bundle rather than against the page. On a
      // project site the page is `/o-training/` and the map is not.
      const map = loadBundle(bundle, { url });
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

/**
 * One bundle, with a bound on how long it may take.
 *
 * The signal is passed **and** raced. A cooperative `fetch` aborts on the signal and that
 * is the tidy path; the race is what makes the bound a fact rather than a request, because
 * whether the wait ends is then this function's decision and not the fetcher's. A service
 * worker standing in for `fetch`, a polyfill, or a stubbed one in a test need not honour a
 * signal at all — and a timeout that a caller can decline to observe is not a timeout.
 */
async function fetchBundle(
  url: string,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<MapBundle> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const expired = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new Error(`${url}: no answer in ${timeoutMs} ms`));
      });
    });
    const read = (async () => {
      const response = await fetcher(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      return (await response.json()) as MapBundle;
    })();
    return await Promise.race([read, expired]);
  } finally {
    // Cleared on every path: a pending timer holds a Node process open, and an abort
    // fired after a bundle has already decoded would reject a promise nothing is reading.
    clearTimeout(timer);
  }
}

/** Forget a cached bundle. Not wired to any screen; the counterpart to the cache above. */
export async function forgetBundle(kv: KeyValue, url: string): Promise<void> {
  await kv.del(keyFor(url));
}
