import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { Link, useParams } from 'wouter';
import { drillById } from '@/drills/index.ts';
import { GeneratedProvider, type RoundContext } from '@/lib/maps/provider.ts';
import { seeded } from '@/lib/rng.ts';
import {
  currentSeed, reduce, start, summarise,
  type SessionEvent, type SessionState,
} from '@/lib/session.ts';
import { idb, loadProgress, saveSession } from '@/lib/store.ts';
import type { AnyDrill } from '@/drills/types.ts';

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
function Session({ drill }: { drill: AnyDrill }) {
  const [startLevel, setStartLevel] = useState<number | null>(null);

  useEffect(() => {
    void loadProgress(idb, drill.id).then((p) =>
      setStartLevel(p.level > 0 ? p.level : drill.bounds.min),
    );
  }, [drill]);

  if (startLevel === null) return <p className="pt-10 text-center text-muted">…</p>;
  return <RunningSession drill={drill} startLevel={startLevel} />;
}

function RunningSession({ drill, startLevel }: { drill: AnyDrill; startLevel: number }) {
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
      }),
  );

  const level = state.staircase.level;
  const seed = currentSeed(state);

  // The only provider there is for now. It is built here rather than inside a drill
  // because which source a round runs on is a decision about the session, not the drill:
  // a policy stored with progress will choose it (see docs/real-maps-architecture.md).
  const ctx = useMemo<RoundContext>(() => ({ maps: new GeneratedProvider() }), []);

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

  const onDone = useCallback(
    (answers: unknown[]) => {
      dispatch({ type: 'answered', score: drill.score(round, answers), at: Date.now() });
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
        {state.streak >= 2 && <span className="text-flag">×{state.streak}</span>}
      </div>
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
