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
                </span>
                <span className="mt-1 block text-sm text-muted">{drill.blurb}</span>
              </Link>
              {drill.multiplayer && (
                <Link
                  href="/match"
                  className="mt-2 block rounded-xl border border-dashed border-line px-4 py-2 text-center text-sm text-muted no-underline hover:border-flag hover:text-paper"
                >
                  Play {drill.title} against someone
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Below the drills on purpose: the default policy is the generated maps this app
          has always used, so this is a door and never a step on the way in. */}
      <Link
        href="/settings"
        className="rounded-xl border border-dashed border-line px-4 py-3 text-center text-sm text-muted no-underline hover:border-flag hover:text-paper"
      >
        Maps &mdash; generated, real, or a mix
      </Link>
    </div>
  );
}
