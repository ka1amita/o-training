import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { Link, useParams } from 'wouter';
import { drillById } from '@/drills/index.ts';
import { bundleUrl, loadLibrary } from '@/lib/maps/library.ts';
import {
  bundlesFor, loadPolicy, providerFor, sourceBadge, type MapPolicy,
} from '@/lib/maps/policy.ts';
import type { RoundContext } from '@/lib/maps/provider.ts';
import { seeded } from '@/lib/rng.ts';
import {
  currentSeed, reduce, start, summarise,
  type SessionEvent, type SessionState,
} from '@/lib/session.ts';
import { idb, loadProgress, saveSession } from '@/lib/store.ts';
import { mapsOfRound, type AnyDrill } from '@/drills/types.ts';
import type { OMap } from '@/lib/terrain/omap.ts';

export default function DrillPage() {
  const { id } = useParams<{ id: string }>();
  const drill = drillById(id);
  if (!drill) return <p className="pt-10 text-center text-muted">No such drill.</p>;
  return <Session key={drill.id} drill={drill} />;
}

/**
 * The session runner is written once, against the Drill contract, and knows nothing about
 * any particular drill: it asks for a round, hands it to `Play`, scores what comes back
 * and moves the staircase. A new drill needs no change here.
 */
interface Ready {
  readonly startLevel: number;
  readonly policy: MapPolicy;
  readonly maps: readonly OMap[];
  /** How many bundles the policy asked for, so a short library can be said out loud. */
  readonly wanted: number;
}

/**
 * Wait for everything the first round is a function of, then start.
 *
 * The level was always waited for; the policy and its bundles join it, for a sharper
 * reason. A round is a function of `(seed, level, provider.id)`, so a session that began
 * on the generator and swapped provider when a download finished would be two sessions
 * wearing one progress record, and its first rounds would not be reproducible from
 * anything stored.
 *
 * A bundle that fails to load is simply absent — `loadLibrary` is deliberately quiet about
 * it — and `providerFor` then names what is actually there. The default policy fetches
 * nothing at all, so the app that never opens the settings screen still opens a drill
 * without touching the network.
 *
 * **The wait is bounded** (`BUNDLE_TIMEOUT_MS`) and what it falls back to is said on
 * screen. Offline behind a captive portal with nothing cached, every bundle times out,
 * `providerFor` hands back the plain generator, and the round runs — the same shape as
 * a match that cannot reach its peer offering split screen rather than spinning. A screen
 * that silently swapped the ground under a player would be worse than one that waited.
 */
function Session({ drill }: { drill: AnyDrill }) {
  const [ready, setReady] = useState<Ready | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [progress, policy] = await Promise.all([
        loadProgress(idb, drill.id),
        loadPolicy(idb),
      ]);
      const names = bundlesFor(policy);
      const maps = names.length === 0 ? [] : await loadLibrary(names.map(bundleUrl), fetch, idb);
      if (!live) return;
      setReady({
        startLevel: progress.level > 0 ? progress.level : drill.bounds.min,
        policy,
        maps,
        wanted: names.length,
      });
    })();
    return () => {
      live = false;
    };
  }, [drill]);

  if (!ready) return <p className="pt-10 text-center text-muted">…</p>;
  return <RunningSession drill={drill} ready={ready} />;
}

/**
 * What to say when the library came up short, or nothing when it did not.
 *
 * Counted rather than caught: `loadLibrary` returns what arrived and never says what did
 * not, which is right — a missing bundle is not an error, it is a smaller library. The
 * difference between asked and arrived is the whole of what the player needs told, and the
 * wording has to be **true of this session**: with nothing loaded `providerFor` returns
 * the plain generator and the rounds really are generated, but with two maps of three the
 * session is still on real ground and saying otherwise would be a notice that lies.
 */
export function shortLibraryNotice(wanted: number, got: number): string | null {
  if (wanted === 0 || got >= wanted) return null;
  if (got === 0) return 'Maps could not be loaded — this session is on generated ground.';
  return `${wanted - got} of ${wanted} maps could not be loaded; playing on the rest.`;
}

function RunningSession({ drill, ready }: { drill: AnyDrill; ready: Ready }) {
  const { startLevel, policy, maps } = ready;
  const notice = shortLibraryNotice(ready.wanted, maps.length);
  const [state, dispatch] = useReducer(
    (s: SessionState, e: SessionEvent) => reduce(s, e, drill.bounds),
    undefined,
    () =>
      start({
        drillId: drill.id,
        // The one place a session is allowed to be non-deterministic: which seed it
        // starts from. Everything after this is derived.
        seed: (Math.random() * 0x1_0000_0000) >>> 0,
        total: drill.roundsPerSession,
        bounds: drill.bounds,
        level: startLevel,
        at: Date.now(),
        policySource: policy.source,
      }),
  );

  const level = state.staircase.level;
  const seed = currentSeed(state);

  // Built here rather than inside a drill because which source a round runs on is a
  // decision about the session, not the drill — and built once, because its id is half of
  // what a round is: rebuilding it mid-session would silently re-generate the round the
  // player is looking at.
  const ctx = useMemo<RoundContext>(() => ({ maps: providerFor(policy, maps) }), [policy, maps]);

  // Regenerated only when the round actually changes; `Play` may re-render freely
  // without the item shifting under the player.
  const round = useMemo(() => {
    const generated = drill.generate(seeded(seed), level, ctx);
    if (import.meta.env.DEV) {
      const problems = drill.wellFormed(generated);
      if (problems.length > 0) {
        // A malformed round is usually one with two right answers, which is invisible
        // while playing and reads as the drill being unfair.
        console.error(`[${drill.id}] seed ${seed} level ${level}:`, problems);
      }
    }
    return generated;
  }, [drill, seed, level, ctx]);

  const badge = useMemo(() => sourceBadge(mapsOfRound(round)), [round]);

  const onDone = useCallback(
    (answers: unknown[]) => {
      // One clock reading for both: the response time is taken at the answer, and the
      // next round's starts where this one ends.
      const at = Date.now();
      dispatch({ type: 'answered', score: drill.score(round, answers), at });
      dispatch({ type: 'continue', at });
    },
    [drill, round],
  );

  const summary = summarise(state);
  useEffect(() => {
    if (summary) void saveSession(idb, drill.id, summary, state.staircase.level);
  }, [summary, drill.id, state.staircase.level]);

  if (summary) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
        <h2 className="m-0 text-base font-semibold text-muted">{drill.title}</h2>
        <p className="m-0 text-5xl font-semibold tabular-nums">
          {summary.correct}
          <span className="text-muted">/{summary.total}</span>
        </p>
        <dl className="m-0 grid grid-cols-3 gap-6">
          <Stat label="median" value={`${(summary.medianResponseMs / 1000).toFixed(1)}s`} />
          <Stat label="best streak" value={String(summary.bestStreak)} />
          <Stat label="level" value={String(summary.endLevel)} />
        </dl>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border border-flag bg-flag px-4 py-2 font-semibold text-ink"
          >
            Again
          </button>
          <Link
            href="/"
            className="rounded-lg border border-line px-4 py-2 text-muted no-underline"
          >
            Done
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center gap-3 pb-3 text-xs text-muted tabular-nums">
        <span>
          {state.index + 1}/{state.total}
        </span>
        <span className="h-1 flex-1 overflow-hidden rounded-full bg-ink-soft">
          <span
            className="block h-full bg-flag transition-[width] duration-200"
            style={{ width: `${(state.index / state.total) * 100}%` }}
          />
        </span>
        <span>lvl {level}</span>
        {/* Which ground this round is on, read off the round's own map — the same rule as
            an answer: never from what was drawn. Absent for the symbol drills, which hold
            no map to read. */}
        {badge && <span title="where this round's map came from">{badge}</span>}
        {state.streak >= 2 && <span className="text-flag">×{state.streak}</span>}
      </div>
      {/* One line, above the round rather than instead of it: the session already started
          on whatever ground it could get, and this only says which. */}
      {notice && <p className="m-0 pb-2 text-xs text-muted">{notice}</p>}
      {/* Keyed by round: Play holds per-round state (what is matched, whether it has
          reported) in refs, and without a fresh instance the second round would start
          already finished. */}
      <drill.Play key={state.index} round={round} level={level} onDone={onDone} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dd className="m-0 text-xl font-semibold tabular-nums">{value}</dd>
      <dt className="mt-0.5 text-xs text-muted">{label}</dt>
    </div>
  );
}
