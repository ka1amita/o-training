import { Link } from 'wouter';
import { DRILLS } from '@/drills/index.ts';

export default function Home() {
  return (
    <div className="flex flex-col gap-4 pt-2">
      <p className="text-sm leading-relaxed text-muted">
        Short drills for the parts of orienteering that are not running: symbols, map
        memory, and reading relief off contours. Everything is generated on your device
        and nothing leaves it.
      </p>

      {DRILLS.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-muted">
          No drills installed yet.
        </p>
      ) : (
        <ul className="flex list-none flex-col gap-3 p-0">
          {DRILLS.map((drill) => (
            <li key={drill.id}>
              <Link
                href={`/drill/${drill.id}`}
                className="block rounded-xl border border-line bg-ink-soft px-4 py-4 no-underline transition-colors hover:border-flag"
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="font-semibold">{drill.title}</span>
                  {drill.multiplayer && (
                    <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-xs text-muted">
                      2 players
                    </span>
                  )}
                </span>
                <span className="mt-1 block text-sm text-muted">{drill.blurb}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
