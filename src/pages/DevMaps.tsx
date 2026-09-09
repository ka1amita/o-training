import { useState } from 'react';
import { CardView } from '@/drills/mapDohledavka/Cards.tsx';
import { mapDohledavka } from '@/drills/mapDohledavka/drill.ts';
import { CONTROL_NAMES } from '@/drills/mapDohledavka/features.ts';
import { seeded } from '@/lib/rng.ts';
import MapView from '@/lib/terrain/MapView.tsx';
import Relief from '@/lib/terrain/Relief.tsx';
import { generateTerrain, paramsFor } from '@/lib/terrain/terrain.ts';

/**
 * A contact sheet, for eyes only.
 *
 * `AGENTS.md`: rendering is not tested, it is checked by eye. That is only safe if
 * looking is cheap, and reaching a pexeso board through four rounds of a real session is
 * not cheap. This shows many seeds at once, in the framings the drills actually use —
 * whole map, 110 m crop, contours beside the relief they describe, and a pair of Mapova
 * dohledavka cards, where what has to be checked is whether a circle says which feature
 * it is on.
 *
 * Dev build only. `App` loads it lazily behind `import.meta.env.DEV` so the module is
 * dropped from the production bundle rather than merely made unreachable.
 */
const SEEDS = [1, 2, 3, 4, 5, 6];
const LEVELS = [1, 5, 10];

/** The pexeso window, so a row shows the hardest thing the generator has to fill. */
const CROP = 110;

export default function DevMaps() {
  const [level, setLevel] = useState(5);
  const [size, setSize] = useState(300);
  /** One seed across the full width. Line weights cannot be judged at thumbnail size. */
  const [big, setBig] = useState(false);

  return (
    <div className="flex flex-col gap-4 pb-10">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted">level</span>
        {LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => setLevel(l)}
            className={`rounded px-2 py-1 ${level === l ? 'bg-flag' : 'bg-ink-soft'}`}
          >
            {l}
          </button>
        ))}
        <span className="ml-3 text-muted">map</span>
        {[300, 380, 420].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSize(s)}
            className={`rounded px-2 py-1 ${size === s ? 'bg-flag' : 'bg-ink-soft'}`}
          >
            {s} m
          </button>
        ))}
        <button
          type="button"
          onClick={() => setBig((b) => !b)}
          className={`ml-3 rounded px-2 py-1 ${big ? 'bg-flag' : 'bg-ink-soft'}`}
        >
          big
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs text-muted">mapova dohledavka, level {level}</div>
        {[1, 2].map((seed) => {
          const round = mapDohledavka.generate(seeded(seed), level);
          return (
            <div key={seed} className="grid grid-cols-2 gap-2">
              {round.cards.map((card, i) => (
                <Cell
                  key={i}
                  label={`${card.controls.map((c) => CONTROL_NAMES[c.kind]).join(', ')}${
                    i === 1 ? ` — shared: ${CONTROL_NAMES[round.shared]}` : ''
                  }`}
                >
                  <CardView
                    card={card}
                    radius={round.radius}
                    onTap={() => {}}
                    className="h-full w-full"
                  />
                </Cell>
              ))}
            </div>
          );
        })}
      </div>

      {SEEDS.map((seed) => {
        const map = generateTerrain(seeded(seed), paramsFor(level, size));
        // Somewhere with ground in it: the middle of the map, offset per seed so the
        // sheet is not six views of the same corner.
        const crop = {
          x: (size - CROP) * (0.2 + 0.1 * (seed % 5)),
          y: (size - CROP) * (0.2 + 0.1 * ((seed * 3) % 5)),
          size: CROP,
        };
        return (
          <div key={seed} className="flex flex-col gap-1">
            <div className="text-xs text-muted">seed {seed}</div>
            <div className={`grid gap-2 ${big ? 'grid-cols-1' : 'grid-cols-4'}`}>
              <Cell label="map">
                <MapView map={map} className="block h-full w-full" />
              </Cell>
              <Cell label={`crop ${CROP} m`}>
                <MapView map={map} crop={crop} className="block h-full w-full" />
              </Cell>
              <Cell label="contours">
                <MapView map={map} contoursOnly className="block h-full w-full" />
              </Cell>
              <Cell label="relief">
                <Relief relief={map.relief} className="block h-full w-full" />
              </Cell>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <figure className="m-0">
      <div className="aspect-square overflow-hidden rounded-lg border border-line">
        {children}
      </div>
      <figcaption className="pt-1 text-[10px] text-muted">{label}</figcaption>
    </figure>
  );
}
