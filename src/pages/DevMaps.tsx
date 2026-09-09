import { useEffect, useState } from 'react';
import { CardView } from '@/drills/mapDohledavka/Cards.tsx';
import { mapDohledavka } from '@/drills/mapDohledavka/drill.ts';
import { CONTROL_NAMES } from '@/drills/mapDohledavka/features.ts';
import { BUNDLED_MAPS, loadLibrary } from '@/lib/maps/library.ts';
import { GeneratedProvider } from '@/lib/maps/provider.ts';
import { seeded } from '@/lib/rng.ts';
import { CLASS_CSS, MASK_CLASSES } from '@/lib/terrain/isom.ts';
import MapView from '@/lib/terrain/MapView.tsx';
import Relief from '@/lib/terrain/Relief.tsx';
import type { Crop, OMap, RasterLayer } from '@/lib/terrain/omap.ts';
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
 * The **library** row above them is every bundle in `public/maps/`, in the same framings,
 * because "does an imported map look like the generated ones" is a question that can only
 * be answered with both on one page — and because a bundle that failed to load is simply
 * absent from it, which is the fastest answer there is to "did the import work".
 *
 * A bundle that is a **picture** shows its colour mask beside it. That is the only view of
 * the mask there is, and the mask is what the app understands about an image-only map:
 * green in the wrong place, contour ink read as grey, a banner counted as map — all of it
 * is a glance here and is invisible in the picture itself, which looks right whatever the
 * classifier made of it.
 *
 * Dev build only. `App` loads it lazily behind `import.meta.env.DEV` so the module is
 * dropped from the production bundle rather than merely made unreachable.
 */
const SEEDS = [1, 2, 3, 4, 5, 6];
const LEVELS = [1, 5, 10];

/** The pexeso window, so a row shows the hardest thing the generator has to fill. */
const CROP = 110;

/** The map-memory window, the other framing a drill shows. */
const WINDOW = 300;

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

      <Library />

      <div className="flex flex-col gap-1">
        <div className="text-xs text-muted">mapova dohledavka, level {level}</div>
        {[1, 2].map((seed) => {
          const round = mapDohledavka.generate(seeded(seed), level, { maps: new GeneratedProvider() });
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

      <div className="pt-2 text-xs text-muted">generated</div>

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

/**
 * The imported maps, in the same framings as the generated ones.
 *
 * The whole reason this row exists: cartography is checked by eye, and "does a real map
 * look like the generated ones" is a question that can only be answered by having both on
 * one page. A bundle that failed to load simply does not appear — which is itself the
 * answer to "did the import work".
 */
function Library() {
  const [maps, setMaps] = useState<readonly OMap[]>([]);

  useEffect(() => {
    let live = true;
    const urls = BUNDLED_MAPS.map((name) => `${import.meta.env.BASE_URL}maps/${name}`);
    // No key-value store: the contact sheet should show what is in `public/maps/` right
    // now, not what IndexedDB remembers from the last import.
    void loadLibrary(urls, fetch).then((loaded) => {
      if (live) setMaps(loaded);
    });
    return () => {
      live = false;
    };
  }, []);

  if (maps.length === 0) {
    return (
      <div className="text-xs text-muted">
        library: nothing loaded from public/maps — run scripts/import-map.mjs
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {maps.map((map) => (
        <LibraryRow key={map.id} map={map} />
      ))}
    </div>
  );
}

function LibraryRow({ map }: { map: OMap }) {
  const lists = map.windows ?? {};
  // Whichever list the pipeline scored for a window of this size — the ids are built from
  // what a requirement asks for, so this reads them rather than restating them.
  const listFor = (size: number): readonly Crop[] =>
    Object.entries(lists).find(([id]) => id.startsWith(`s${size}`))?.[1] ?? [];

  const window_ = listFor(WINDOW)[0];
  // The pexeso card is a crop the drill makes for itself, not a scored window, so it is
  // taken from the middle of a scored one — which is where the ground the score liked is.
  const card: Crop | undefined = window_
    ? { x: window_.x + (window_.size - CROP) / 2, y: window_.y + (window_.size - CROP) / 2, size: CROP }
    : undefined;

  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs text-muted">
        {map.meta?.name ?? map.id.slice(0, 8)} · 1:{map.scale} · {Math.round(map.width)} m ·{' '}
        {map.features.length} features · relief {map.relief.kind} ·{' '}
        {map.analysis?.landforms.length ?? 0} landforms
        {map.raster
          ? ` · ${map.raster.imageWidth}x${map.raster.imageHeight} px at ` +
            `${map.raster.metresPerPixel} m · ${map.analysis?.moveable?.length ?? 0} blobs`
          : ''}
        {map.meta?.attribution ? ` · ${map.meta.attribution}` : ''}
      </div>
      <div className="grid grid-cols-6 gap-2">
        <Cell label="map">
          <MapView map={map} className="block h-full w-full" />
        </Cell>
        <Cell label={map.raster ? 'mask' : 'no mask'}>
          {map.raster ? <MaskSwatches raster={map.raster} /> : null}
        </Cell>
        <Cell label={card ? `window ${CROP} m` : 'no window'}>
          {card ? <MapView map={map} crop={card} className="block h-full w-full" /> : null}
        </Cell>
        <Cell label={window_ ? `window ${WINDOW} m` : 'no window'}>
          {window_ ? <MapView map={map} crop={window_} className="block h-full w-full" /> : null}
        </Cell>
        <Cell label="contours">
          <MapView map={map} contoursOnly className="block h-full w-full" />
        </Cell>
        <Cell label="relief">
          {map.relief.kind === 'none' ? null : (
            <Relief relief={map.relief} className="block h-full w-full" />
          )}
        </Cell>
      </div>
    </div>
  );
}

/** How many swatches a side the mask is shown at. Diagnostic, so nearest-neighbour. */
const SWATCHES = 60;

/**
 * The colour mask, as a grid of swatches.
 *
 * Sampled rather than aggregated: a majority over each swatch would hide exactly what
 * this is for. Thin ink — a contour, a path — survives the mask as a single cell, and a
 * swatch that averaged it away would draw the same picture whether the classifier had
 * found the line or lost it.
 */
function MaskSwatches({ raster }: { raster: RasterLayer }) {
  const cells: React.ReactElement[] = [];
  for (let j = 0; j < SWATCHES; j++) {
    for (let i = 0; i < SWATCHES; i++) {
      const x = Math.min(raster.maskWidth - 1, Math.floor(((i + 0.5) / SWATCHES) * raster.maskWidth));
      const y = Math.min(raster.maskHeight - 1, Math.floor(((j + 0.5) / SWATCHES) * raster.maskHeight));
      const klass = MASK_CLASSES[raster.mask[y * raster.maskWidth + x]!] ?? 'unknown';
      cells.push(
        <rect key={`${i}-${j}`} x={i} y={j} width={1} height={1} fill={CLASS_CSS[klass]} />,
      );
    }
  }
  return (
    <svg
      viewBox={`0 0 ${SWATCHES} ${SWATCHES}`}
      className="block h-full w-full"
      role="img"
      aria-label="colour mask"
    >
      {cells}
    </svg>
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
