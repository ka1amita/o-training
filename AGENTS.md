# OB Training

Client-only PWA. No backend, no accounts, no personal data. React 19 + Vite 8 + TS 7 +
Tailwind 4, static output, hash routing (a path reload on GitHub Pages is a 404).

## The one rule

**An answer comes from a round's structure, never from what was rendered.** If `score()`
ever needs to read a canvas, that is the bug.

## The drill contract — `src/drills/types.ts`

`generate` / `wellFormed` / `score` are pure; `Play` only renders. A drill is one directory
plus one line in `src/drills/index.ts`; nothing else enumerates drills.

`generate` takes an `Rng` and never touches `Math.random` or `Date.now()`. Golden tests
depend on that, and so does P2P Dohledávka — both peers derive the same deck from a shared
seed instead of sending one.

## Testing

1. **Properties** (`fast-check`). The invariant everywhere: **exactly one correct answer
   exists**. A round with two is unfair and invisible while playing. `wellFormed()` also
   runs at runtime in dev, and is itself tested by breaking each invariant on purpose.
2. **Golden determinism.** One seed, one round, pinned by hash.
3. **Reducers.** Events carry their own timestamps, so no fake timers.
4. **Not tested: rendering.** Checked by eye — safe only because of the one rule.

**A drill's tap rules live in its own `state.ts`, not in `Play`.** Match Madness had them
in the component, reading `selected` out of a closure; two taps before a re-render both saw
stale state and the round could not finish.

## Traps

**Platform**

- `tsconfig` has no `baseUrl` — TS 7 removed it; path aliases are relative.
- `store.ts` treats a malformed record as no progress. Storage gets cleared, and a training
  screen must still open.
- `DrillPage` keys `Play` on the round index, or round two starts already finished.
- Response times are **medians**. One round with the phone put down hides the trend.
- Icons and symbols are generated (`scripts/`) and committed, so neither source package is
  a runtime dependency.

**Symbols**

- Only IOF **column D**. C/E/F/G are modifiers and compass directions that would flood the
  pool with near-identical glyphs. Duplicate English names are dropped — two symbols
  sharing a meaning is the one thing that makes a round unanswerable.
- Above level 3, all symbols come from one IOF category. More pairs is only more scanning;
  spur against re-entrant is the discrimination the sport asks for.
- **A Dobble deck is a projective plane and the order must be prime.** At order 4 this
  construction gives 16 of 210 pairs sharing no symbol and 16 sharing two — measured. A
  card with no answer, not a crash, so `buildDeck` refuses.
- Dobble symbol size is **solved for** from the layout geometry. Hand-picked sizes were
  rejected by the overlap property within ten cases.

**Networking**

- Only taps cross the wire; the deck comes from the seed in `hello`. Golden determinism is
  load-bearing here, not tidy.
- **The host decides every outcome.** Otherwise both peers see their own tap as first.
- **A joiner returns its answer before its data channel exists** — the channel only opens
  once the host has that answer. Waiting first is a deadlock that looks like a silent peer.
- `trimSdp`'s `(:|$)` stops `extmap` matching `a=extmap-allow-mixed`.
- Split screen is the same rules: `found` carries an optional `by`.
- STUN cannot fix symmetric or CGNAT. No relay exists, so it must time out and offer split
  screen, never hang.

**Terrain**

- **Features, not noise.** That is what makes `perturb` an operation — reseeding noise gives
  a different map, not a sibling. Landform falloff has compact support for the same reason.
- Feature sizes are **metres, not fractions of the map**: a marsh drawn for a 420 m map
  swamped a 110 m pexeso crop.
- Area kinds are weighted toward white forest; uniform picking filled every card.
- `MapView` culls to the window — a pexeso card went from 152 elements to 9.
- Perturb for contours must target a **landform** (a boulder has no relief); for map memory
  it must land **inside the window** (or two candidates are identical).

**Presentation**

- **Never signal right/wrong by colour alone.** The green and red here are ΔE 5.8 apart
  under deuteranopia, under the 8 that counts as separable. `Verdict` adds a tick or cross.
- The progress chart is one series on one axis. Accuracy sits in the stat tiles.

## Verify

```bash
npm run typecheck && npm test && npm run build
npm run preview      # PWA behaviour needs the built bundle, not the dev server
```

CI runs the first three on every push and pull request. A green run on `main` publishes
`dist/` to `gh-pages` — so a merge to `main` is a release, and the artifact that ships is
the one the checks ran against, never a rebuild.
