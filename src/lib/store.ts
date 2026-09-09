import { get, set, del, keys } from 'idb-keyval';
import type { SessionSummary } from './session.ts';

/**
 * On-device storage, and the only place this app persists anything.
 *
 * What is kept: a level per drill and a list of finished-session summaries. What is not:
 * names, identifiers, device fingerprints, anything about a peer. There is no account to
 * attach a record to and nothing is ever sent anywhere — see README.
 */
export interface DrillProgress {
  readonly level: number;
  readonly sessions: readonly SessionSummary[];
}

/** How many session summaries to keep per drill. Enough to show the curve the training
 *  literature says bends through roughly session 7, without growing without bound. */
export const HISTORY_LIMIT = 200;

export const EMPTY: DrillProgress = { level: 0, sessions: [] };

/** The storage surface this module needs, so tests can run without IndexedDB. */
export interface KeyValue {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export const idb: KeyValue = {
  get: (key) => get(key),
  set: (key, value) => set(key, value),
  del: (key) => del(key),
  keys: async () => (await keys()).map(String),
};

export function memoryStore(seed: Record<string, unknown> = {}): KeyValue {
  const map = new Map<string, unknown>(Object.entries(seed));
  return {
    get: async <T,>(k: string) => map.get(k) as T | undefined,
    set: async (k, v) => void map.set(k, v),
    del: async (k) => void map.delete(k),
    keys: async () => [...map.keys()],
  };
}

const keyFor = (drillId: string) => `drill:${drillId}`;

/**
 * Where the map policy is kept.
 *
 * The key lives here because this module owns the key space — `clearAll` is the thing that
 * has to know every key the training record is made of — while what the value *means* is
 * `maps/policy.ts`, which reads and writes it. Splitting it the other way would drag the
 * providers, and through them the drills, into the storage module.
 */
export const POLICY_KEY = 'policy';

export async function loadProgress(kv: KeyValue, drillId: string): Promise<DrillProgress> {
  const stored = await kv.get<DrillProgress>(keyFor(drillId));
  // Storage can be cleared, downgraded, or written by an older build. A missing or
  // malformed record reads as "no progress yet" rather than throwing on a screen the
  // player opened to train.
  if (!stored || typeof stored.level !== 'number' || !Array.isArray(stored.sessions)) {
    return EMPTY;
  }
  return stored;
}

export async function saveSession(
  kv: KeyValue,
  drillId: string,
  summary: SessionSummary,
  level: number,
): Promise<DrillProgress> {
  const current = await loadProgress(kv, drillId);
  const next: DrillProgress = {
    level,
    sessions: [...current.sessions, summary].slice(-HISTORY_LIMIT),
  };
  await kv.set(keyFor(drillId), next);
  return next;
}

/**
 * Erase the training record: every drill's progress, and the map policy with it.
 *
 * The policy goes because it is a choice this device made and the screen offering to erase
 * everything should not quietly keep one. Cached map bundles (`map:`) do **not** — they are
 * a download, not a record, and re-fetching forty megabytes on a phone in a forest is not
 * what "erase my progress" asks for. The Progress screen says both.
 */
export async function clearAll(kv: KeyValue): Promise<void> {
  const all = await kv.keys();
  const mine = (k: string) => k.startsWith('drill:') || k === POLICY_KEY;
  await Promise.all(all.filter(mine).map((k) => kv.del(k)));
}
