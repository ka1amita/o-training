import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import SessionChart, { type Point } from '@/components/SessionChart.tsx';
import { DRILLS } from '@/drills/index.ts';
import { idb, loadProgress, clearAll, type DrillProgress } from '@/lib/store.ts';

export default function Progress() {
  const [progress, setProgress] = useState<Record<string, DrillProgress>>({});

  const reload = () => {
    void Promise.all(DRILLS.map(async (d) => [d.id, await loadProgress(idb, d.id)] as const)).then(
      (entries) => setProgress(Object.fromEntries(entries)),
    );
  };
  useEffect(reload, []);

  const played = DRILLS.filter((d) => (progress[d.id]?.sessions.length ?? 0) > 0);

  return (
    <div className="flex flex-col gap-5 pt-2">
      <h2 className="m-0 text-base font-semibold">Progress</h2>

      {played.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-muted">
          No finished sessions yet.
        </p>
      ) : (
        played.map((drill) => {
          const stored = progress[drill.id]!;
          const last = stored.sessions.at(-1)!;
          const points: Point[] = stored.sessions.map((s, i) => ({
            session: i + 1,
            seconds: s.medianResponseMs / 1000,
          }));
          return (
            <section key={drill.id} className="rounded-xl border border-line bg-ink-soft p-4">
              <h3 className="m-0 text-sm font-semibold">{drill.title}</h3>
              <dl className="m-0 mt-3 grid grid-cols-4 gap-2 text-center">
                <Stat label="sessions" value={String(stored.sessions.length)} />
                <Stat label="median" value={`${(last.medianResponseMs / 1000).toFixed(1)}s`} />
                <Stat label="accuracy" value={`${Math.round(last.accuracy * 100)}%`} />
                <Stat label="level" value={String(stored.level)} />
              </dl>
              <div className="mt-3">
                <SessionChart points={points} />
              </div>
            </section>
          );
        })
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Link href="/" className="text-sm text-muted no-underline">Back</Link>
          <button
            type="button"
            onClick={() => {
              void clearAll(idb).then(reload);
            }}
            className="rounded-lg border border-line bg-transparent px-3 py-2 text-sm text-muted hover:border-bad hover:text-bad"
          >
            Erase all progress
          </button>
        </div>
        {/* What it does and does not touch, said before it is pressed. Downloaded maps
            are a download and not a record; re-fetching them on a phone in a forest is
            not what "erase my progress" asks for. */}
        <p className="m-0 text-right text-xs text-muted">
          Levels, session history and your map choice. Downloaded maps stay.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dd className="m-0 text-lg font-semibold tabular-nums">{value}</dd>
      <dt className="mt-0.5 text-xs text-muted">{label}</dt>
    </div>
  );
}
