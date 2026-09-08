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
  swamped a 110 m pexeso crop. `areaOutline` wanders a third outside `rx`/`ry`, and the
  radius band was cut to pay for it.
- Area kinds are weighted toward white forest; uniform picking filled every card.
- `MapView` culls to the window — 381 elements to 228 on a 12-card board.
- Perturb for contours must target a **landform** (a boulder has no relief); for map memory
  it must land **inside the window** (or two candidates are identical).

**Terrain reads the ground**

`generateTerrain` runs in phases and the order is the point: landforms, then one
`readGround` sampling, then everything else placed by consulting it. A stream that ignores
the height field runs over hilltops; a marsh on a slope is wrongness an orienteer sees
instantly without being able to name.

- **`tilt` and `noiseSeed` survive `perturb` untouched.** Otherwise siblings differ
  everywhere and compact support stops meaning anything. `noiseSeed` 0 means *no*
  micro-relief and exists for the tracer's own geometry tests; generation sets the low bit
  so it cannot land there.
- Ground thresholds are **quantiles of this map**, not absolutes. The regional tilt alone
  spans 0.05–0.11 m/m, so an absolute "flat enough for a marsh" bar left steep maps with
  no legal spot and every marsh fell through to the unconditioned fallback.
- The ridge lies **across** the regional fall, so its spurs and re-entrants run down it.
  A re-entrant across the fall line is a closed basin, not a valley.
- `placePoints` **checks** `suitsPoint` rather than trusting the extremum it sampled: a
  grid maximum at 4.7 m spacing is not always a rise at the 10 m the eye reads.
- A stream may begin inland — that is a spring — but a path, fence or ride crosses the map.
  Where a stream sinks, a marsh is drawn; that marsh is the one area exempt from
  `suitsArea`, and the tests exempt it by matching the stream's last point.
- `siblings` **prefers** a plausible perturbation and settles for a merely visible one. A
  hard filter pushes rounds onto the `distance * 2.5` fallback, and a distractor far bigger
  than the level asked for is a worse question than a marsh on a slope.

**Cartography**

- Widths are **millimetres of paper at 1:15000** (`isom.ts`). `mm → unit` is `100 / 28`
  and window-independent, because a crop is the same map printed at a larger scale.
- **Slope tags are not decoration.** Without them a knoll and a hollow are the same
  picture, and the contours drill hands out cards that cannot answer their own question.
  `slopeTagsFor` probes inward from the polygon's own orientation and compares each probe
  with **its own vertex** — not with `contour.level`, which the trace nudges away from.
- A **closed contour repeats its first point**. Counting that copy as a vertex gives index
  0 a one-sided normal: harmless on a long ring, 45 degrees out on the four-segment ring
  at the bottom of a hollow, which was the one contour that never got tagged.
- `stitch` walks a chain **both ways**. Forwards only recovers any closed loop but shreds
  an open one, because the outer loop meets segments in cell order and enters a contour in
  its middle: 175 paths where there were 3.
- Form lines are **short**. Gentle ground is everywhere on a tilted map, so a slope test
  alone drew one down the whole card between every pair of contours — which says the
  interval should have been 2.5 m, not that there is a feature here.
- `areaOutline` hashes **shape fields only**. Hashing position makes `perturb` reshape the
  area it moves, so a map-memory distractor differs by more than its level asked for.
- Pattern ids come from `useId()`; a pexeso board mounts twelve `MapView`s in one document.
- **No north lines.** Drawn at fixed world positions, a pexeso pair's two crops would show
  them at a known offset — an answer coming from something other than the ground.

**Presentation**

- **Never signal right/wrong by colour alone.** The green and red here are ΔE 5.8 apart
  under deuteranopia, under the 8 that counts as separable. `Verdict` adds a tick or cross.
- The progress chart is one series on one axis. Accuracy sits in the stat tiles.

## Verify

```bash
npm run typecheck && npm test && npm run build
npm run preview      # PWA behaviour needs the built bundle, not the dev server
```

`#/dev/maps` is a contact sheet of many seeds at once — whole map, 110 m crop, contours
beside the relief they describe. Dev builds only; `App` loads it lazily behind
`import.meta.env.DEV` so it folds out of the bundle. Cartography is checked by eye, and
that is only safe while looking is cheap.
