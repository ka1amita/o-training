import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { BUNDLED_MAPS, bundleUrl, loadLibrary } from '@/lib/maps/library.ts';
import {
  DEFAULT_INTENSITY, DEFAULT_POLICY, DEFAULT_REAL_SHARE, loadPolicy, savePolicy,
  type MapPolicy, type PolicySource,
} from '@/lib/maps/policy.ts';
import { idb } from '@/lib/store.ts';
import type { OMap } from '@/lib/terrain/omap.ts';

/**
 * Where the rounds come from.
 *
 * The one screen that writes a `MapPolicy`, and the reason it is a screen rather than a
 * constant: which source a player trains on is a preference, and the tier switch the
 * design note describes is this list of radio buttons. Everything below it is unchanged —
 * the drills never learn which source they got.
 *
 * Saved on every tap rather than behind a button: there is one record, it is local, and a
 * settings screen that can be left in an unsaved state is a screen that loses the setting.
 */
export default function Settings() {
  const [policy, setPolicy] = useState<MapPolicy | null>(null);
  const [maps, setMaps] = useState<{ name: string; map: OMap | undefined }[] | null>(null);

  useEffect(() => {
    void loadPolicy(idb).then(setPolicy);
  }, []);

  useEffect(() => {
    // One at a time, so a bundle that fails to load is a row that says so rather than a
    // gap: `loadLibrary` returns only what succeeded and cannot be lined up with the
    // names afterwards. It reads the cache first, so this is a download once and never
    // again.
    void Promise.all(
      BUNDLED_MAPS.map(async (name) => ({
        name,
        map: (await loadLibrary([bundleUrl(name)], fetch, idb))[0],
      })),
    ).then(setMaps);
  }, []);

  if (!policy) return <p className="pt-10 text-center text-muted">…</p>;

  const update = (next: MapPolicy) => {
    setPolicy(next);
    void savePolicy(idb, next);
  };

  const toggle = (name: string) => {
    const on = policy.library.includes(name);
    update({
      ...policy,
      library: on ? policy.library.filter((n) => n !== name) : [...policy.library, name],
    });
  };

  const share = Math.round((policy.realShare ?? DEFAULT_REAL_SHARE) * 100);
  const intensity = Math.round((policy.intensity ?? DEFAULT_INTENSITY) * 100);

  return (
    <div className="flex flex-col gap-5 pt-2">
      <h2 className="m-0 text-base font-semibold">Maps</h2>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="p-0 text-sm text-muted">Where a round&rsquo;s ground comes from.</legend>
        <Source
          value="generated"
          policy={policy}
          onPick={update}
          title="Generated"
          note="Made on your device, one map per round. The default."
        />
        <Source
          value="real"
          policy={policy}
          onPick={update}
          title="Real maps"
          note="Windows onto the surveyed maps below. Falls back to a generated map where none of them can answer a drill."
        />
        <Source
          value="adjusted"
          policy={policy}
          onPick={update}
          title="Adjusted real maps"
          note="The same surveyed maps, with plausible extra detail added to each extract — a boulder where the ground is broken, a knoll on a rise. Real ground that a drill has enough to ask about."
        />
        <Source
          value="mixed"
          policy={policy}
          onPick={update}
          title="Mixed"
          note="Generated and real, in proportion."
        />
      </fieldset>

      {policy.source === 'adjusted' && (
        <label className="flex flex-col gap-2">
          <span className="text-sm text-muted">
            How much is added: <span className="tabular-nums text-paper">{intensity}%</span>
            {intensity === 0 && ' — nothing, so these are the real maps'}
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={10}
            value={intensity}
            onChange={(e) => update({ ...policy, intensity: Number(e.target.value) / 100 })}
            className="w-full accent-flag"
          />
        </label>
      )}

      {policy.source === 'mixed' && (
        <label className="flex flex-col gap-2">
          <span className="text-sm text-muted">
            Real maps: <span className="tabular-nums text-paper">{share}%</span> of rounds
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={10}
            value={share}
            onChange={(e) => update({ ...policy, realShare: Number(e.target.value) / 100 })}
            className="w-full accent-flag"
          />
        </label>
      )}

      {/* A policy `providerFor` will resolve to the plain generator, said before the
          player finds out by playing. Real maps with nothing ticked is a legal record and
          a legal provider — the generator is what catches a source that cannot answer —
          but a screen showing "Real maps" over an empty list is the screen claiming
          rounds the device cannot make, which is the badge lying in another place. */}
      {policy.source !== 'generated' && policy.library.length === 0 && (
        <p className="m-0 rounded-xl border border-dashed border-line px-4 py-3 text-sm text-muted">
          No maps are turned on, so rounds will be generated. Tick one below.
        </p>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="m-0 text-sm font-semibold">Available maps</h3>
        <p className="m-0 text-sm text-muted">
          Each is downloaded the first time it is used and then kept on this device, so a
          session in the forest needs no signal. Erasing your progress keeps them.
        </p>
        {maps === null ? (
          <p className="text-sm text-muted">…</p>
        ) : (
          maps.map(({ name, map }) => (
            <MapRow
              key={name}
              name={name}
              map={map}
              on={policy.library.includes(name)}
              onToggle={() => toggle(name)}
            />
          ))
        )}
      </section>

      <div className="flex items-center justify-between">
        <Link href="/" className="text-sm text-muted no-underline">Back</Link>
        <button
          type="button"
          onClick={() => update(DEFAULT_POLICY)}
          className="rounded-lg border border-line bg-transparent px-3 py-2 text-sm text-muted hover:border-flag hover:text-paper"
        >
          Reset to generated
        </button>
      </div>
    </div>
  );
}

function Source({
  value, policy, onPick, title, note,
}: {
  value: PolicySource;
  policy: MapPolicy;
  onPick: (next: MapPolicy) => void;
  title: string;
  note: string;
}) {
  const chosen = policy.source === value;
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-xl border px-4 py-3 ${
        chosen ? 'border-flag bg-ink-soft' : 'border-line'
      }`}
    >
      <input
        type="radio"
        name="source"
        checked={chosen}
        onChange={() => onPick({ ...policy, source: value })}
        className="mt-1 accent-flag"
      />
      <span>
        {/* The border colour is the second signal, never the only one: the radio itself
            says which is chosen, and it is what a screen reader reads. */}
        <span className="block font-semibold">{title}</span>
        <span className="mt-0.5 block text-sm text-muted">{note}</span>
      </span>
    </label>
  );
}

/**
 * One map, as the facts a player would choose it by.
 *
 * All of it comes from the bundle's own `meta` and geometry — where it came from, what it
 * was drawn at, how much ground it is, whether it carries relief — because those are the
 * things that decide which drills it can serve. A bundle that would not load says so
 * instead of vanishing.
 */
function MapRow({
  name, map, on, onToggle,
}: {
  name: string;
  map: OMap | undefined;
  on: boolean;
  onToggle: () => void;
}) {
  const km = map ? Math.max(map.width, map.height) / 1000 : 0;
  const facts = map
    ? [
        `1:${map.meta?.scale ?? map.scale}`,
        map.meta?.source ?? 'bundle',
        km >= 1 ? `${km.toFixed(1)} km across` : `${Math.round(km * 1000)} m across`,
        map.relief.kind === 'none' ? 'no relief' : 'relief',
      ].join(' · ')
    : 'could not be loaded';

  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line px-4 py-3">
      <input type="checkbox" checked={on} onChange={onToggle} className="mt-1 accent-flag" />
      <span className="min-w-0">
        <span className="block font-semibold">{map?.meta?.name ?? name}</span>
        <span className="mt-0.5 block text-sm text-muted">{facts}</span>
        {(map?.meta?.attribution || map?.meta?.licence) && (
          <span className="mt-0.5 block text-xs text-muted">
            {[map.meta?.attribution, map.meta?.licence].filter(Boolean).join(' · ')}
          </span>
        )}
      </span>
    </label>
  );
}
