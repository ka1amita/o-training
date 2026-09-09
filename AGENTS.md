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
2. **Golden determinism.** One seed, one round, pinned by hash — over `goldenMap`, the
   generator's *decisions*, not the objects that carry them. The engine's types are being
   taken apart (`docs/real-maps-architecture.md`); a hash over the live objects would need
   re-pinning at every step, and a re-pin you had to make is indistinguishable from one you
   should not have.
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
- Only **green** gets `VEGETATION_RADIUS`. A stand of plantation is a management unit and
  sprawls; a clearing has edges, and giving yellow the same sprawl washed a whole 110 m
  card in it.
- Point separation is **per pair** (`separationOf`), not one constant: a crag is a line
  twice as long as a boulder is wide, and a field of them at the boulder spacing smears
  into one black mass. `MIN_POINT_SEPARATION` is the advertised floor and is tested
  against every pair of kinds.
- `MapView` culls to the window — 381 elements to 228 on a 12-card board.
- Perturb for contours must target a **landform** (a boulder has no relief); for map memory
  it must land **inside the window** (or two candidates are identical).

**Terrain reads the ground**

- **A map is an `OMap`; the generator is one source of them.** `tilt`, `noiseSeed` and
  `landforms` are `AnalyticRelief`'s parameters, not the map's — a surveyed map has relief
  and no landforms at all. Everything that reads the ground reads `relief.heightAt`,
  `sampleGrid` or `contours`, and nothing outside `relief.ts` reaches for a landform.
- **One table says what a symbol means**: `semantics.ts`, keyed by ISOM code. `suitsArea`
  and `suitsPoint` are two lines over it, and the ground rules — quantiles, maxima, minima
  — are its data. A second `kind → code` mapping anywhere is the bug: a real map's `410`
  and a generated `fight` have to be one thing to the app, or the understanding lives in
  two places and they drift.

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
- `perturb` takes `within`, and map memory passes its window. Choosing uniformly over the
  map and retrying was fine while features were spread evenly; once they came in clusters,
  a window that missed the rocky band held almost nothing and the retries ran out — one
  round in three had a distractor identical to the answer.
- **Point features cluster.** Uniform placement with a minimum separation is *more even
  than random*, and that evenness — more than the count — is what read as generated.
  Half the fields are crags on a slope break, half boulders on any ground: putting every
  field on the steepest ground stacked them on the one ridge and left the map bare.
- Rides are the **compartment grid** and are not a difficulty knob: a managed forest has
  one, and a map of one without it reads as heath. They are dead straight because they
  were cut; `tracePath` is for what was walked.

**Cartography**

- **`MapView` styles by code**, through the table in `isom.ts` beside the widths. A code
  the table does not know still draws — the plainest symbol of its geometry in its colour
  class — because a real map arrives with about 120 of them and sixteen are drawn here.
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
- Areas are drawn **one path per kind**, not one per feature. Vegetation is generated as
  overlapping lobes so a green reads as one region, and separate translucent shapes
  composite their overlaps twice — every chain showed its construction as a string of
  darker lenses.
- `areaOutline` hashes **shape fields only**. Hashing position makes `perturb` reshape the
  area it moves, so a map-memory distractor differs by more than its level asked for.
- Pattern ids come from `useId()`; a pexeso board mounts twelve `MapView`s in one document.
- **No north lines.** Drawn at fixed world positions, a pexeso pair's two crops would show
  them at a known offset — an answer coming from something other than the ground.

**Map dohledavka**

- The answer is a **kind of feature**, so two cards need `2n - 1` of them between them:
  nine at five controls. What a map supplies is not a free choice, and `shareOut` spends
  the kinds only one card can draw *first* — handing out the contested ones strands a card
  with decoys it has no site for.
- **One nameable thing to a ring.** This is Dobble's no-overlap rule in map form: a circle
  with a boulder at its centre and a knoll inside the ring can be read either way, and if
  the other card circles a knoll the round has two answers. It is also what sizes the
  circle: at ISOM's own 6 mm — 90 m of ground — a card offers a median of **one** usable
  kind, at 4 mm four, and at the 3 mm drawn here seven. Nine at five controls is why
  `generate` draws up to ten pairs of maps: only two pairs in three can supply them.
- **A ride and rough open block a site without ever being answers.** A ride is a black
  line like a path; 403 is the yellow of a clearing at half the screen. The greens are not
  in that list: nothing in the vocabulary is a wash of green, and half the control circles
  on a real map have some.
- **`placePoints` puts knolls on `ground.maxima`** — which is exactly where a hilltop is.
  Hill and knoll shadow each other constantly, and that is the map being honest rather
  than the rule being harsh.
- Symbols are **drawn wider than their feature point**: a crag is a line across the slope,
  so its centre can be outside a ring with half of it inside. `drawnReach` measures what
  the eye sees, not what the feature list says.
- A landform is a site only if the **ground shows it** — `standsOut` asks the height field
  for a full contour interval of relief, since an 8 m hill on ground already falling 10 m
  over the same distance closes no contour. Round ones are then circled at the summit the
  ground has, not at the centre the feature list gives, which on a ridge flank differ by
  more than the circle's radius.
- Generation trades the **control count** and nothing else: a pair of thin maps costs a
  circle rather than the round. Measured over 800 rounds a level: once, at level 10.

**Presentation**

- **Never signal right/wrong by colour alone.** The green and red here are ΔE 5.8 apart
  under deuteranopia, under the 8 that counts as separable. `Verdict` adds a tick or cross.
- The progress chart is one series on one axis. Accuracy sits in the stat tiles.

## Verify

```bash
npm run verify       # typecheck, tests, bundle — the same command CI runs
npm run preview      # PWA behaviour needs the built bundle, not the dev server
```

`#/dev/maps` is a contact sheet of many seeds at once — whole map, 110 m crop, contours
beside the relief they describe. Dev builds only; `App` loads it lazily behind
`import.meta.env.DEV` so it folds out of the bundle. Cartography is checked by eye, and
that is only safe while looking is cheap.

CI runs the first three on every push and pull request. A green run on `main` publishes
`dist/` to `gh-pages` — so a merge to `main` is a release, and the artifact that ships is
the one the checks ran against, never a rebuild.

## Merging

Commit work to a separate branch. At the end rebase on top of `main` and verify (I fast-forwarded manually to main).

## Style

Maintain manually edited configs (e.g., `.gitignore`) lexicographically sorted.
