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

It also takes a `RoundContext`, and that is where a terrain drill gets its ground: it
states a `WindowRequirement` and a `MapProvider` satisfies it. The generator is one
provider; a library of imported maps will be another. So a round is a function of
`(seed, level, provider.id)`, which is the third thing two peers will have to agree on.

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
- **`loadLibrary` is the app's other network wait, and it is bounded too**
  (`BUNDLE_TIMEOUT_MS`). A captive portal completes the connection and then answers
  nothing, so a `fetch` with no timeout is a drill screen stuck on three dots before the
  first round exists. The signal is passed *and* raced: a fetcher — a service worker, a
  polyfill, a test stub — need not honour an abort, and a timeout a callee can decline to
  observe is not a timeout. What it falls back to is said in one line on the drill screen,
  and the line has to be true of *this* session: nothing loaded is generated ground, two
  maps of three is still real ground.

**Terrain**

- **Features, not noise.** That is what makes an `Edit` an operation — reseeding noise
  gives a different map, not a sibling. Landform falloff has compact support for the same
  reason, and a `warp` inherits it.
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
- The contours drill edits with a **warp** (a boulder has no relief); map memory's edit
  must land **inside the window**, or two candidates are identical.
- **A pexeso control is one draw from the candidate list, not two.**
  `{ x: rng.pick(c).x, y: rng.pick(c).y }` takes x from one feature and y from another and
  stands the control where neither of them is — an anchor on empty forest, which is the
  card the drill exists not to deal. It reads as an idiomatic pick, it passed every
  property the round had, and a test that met it wrote it down as a quirk of the generator
  and pinned it instead. Assert the whole point, never a coordinate at a time.
- **A distractor is `base + edits`.** `wellFormed` reads the edits and the window, never
  the map they make — `difference()` is where "how different" is answered, and its
  `visible` is a **position** test on what moved, not `footprint > 0`. A warp whose disc
  clips the window but whose landform sits outside it does not count, exactly as it did
  not when this was `differsWithin`; loosening it changes which distractor a round takes.
- **A warp carries the features standing on it** (`Warp.carries`, on for every warp
  `proposeEdit` makes). A knoll that slides out from under its own boulder is not a map
  anyone drew, and it is a tell a strong player reads instead of the ground. Carried
  features are clamped to the map, as `move` is. The flag stays because a caller that
  wants ground-only displacement should have to say so.

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

- **`tilt` and `noiseSeed` survive a warp untouched.** Otherwise siblings differ
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
- `siblings` **prefers** a plausible edit and settles for a merely visible one. A hard
  filter pushes rounds onto the `distance * 2.5` fallback, and a distractor far bigger
  than the level asked for is a worse question than a marsh on a slope.
- An **`EditSpec` takes `within`, and map memory passes its window.** Choosing uniformly
  over the map and retrying was fine while features were spread evenly; once they came in
  clusters, a window that missed the rocky band held almost nothing and the retries ran
  out — one round in three had a distractor identical to the answer. `proposeEdit` narrows
  its candidate pools to what the window can show, and falls back to the whole list only
  when the window holds none of them.
- **Point features cluster.** Uniform placement with a minimum separation is *more even
  than random*, and that evenness — more than the count — is what read as generated.
  Half the fields are crags on a slope break, half boulders on any ground: putting every
  field on the steepest ground stacked them on the one ridge and left the map bare.
- Rides are the **compartment grid** and are not a difficulty knob: a managed forest has
  one, and a map of one without it reads as heath. They are dead straight because they
  were cut; `tracePath` is for what was walked.
- That fallback **is checked for visibility too**, and climbs: twelve tries at 2.5x, then
  at 5x, then at 10x. A single unchecked draw is a distractor that may be identical to the
  answer inside the window, which was one map-memory round in five hundred with two right
  answers and a property suite that flaked at that rate (`seed 2492758438, level 3`). The
  first draw is still 2.5x, so a round whose old fallback happened to be visible kept the
  distractor it had.
- **`sampleWhere` returns null; it does not surrender to an unconditioned draw.** Same
  lesson one function along. It used to end its budget with a point that ignored the
  predicate, arguing that a map with no marsh is worse than a marsh on a gentle slope — but
  an unconditioned draw is not a gentle slope, it is anywhere, and it put a marsh on ground
  falling at 46% about one map in fifteen hundred (`seed 248, level 9`, where flat *and*
  low is 2.2% of the map because the flat parts are its tops). `placeAreas` **redraws the
  kind** instead: the count the requirement asked for is kept and nothing stands where it
  contradicts the ground. A caller that would still rather have a point than nothing says
  `?? anywhere(...)` at the call site, where the next line can be seen to check it.

**Real maps**

- **A bundle is never in the precache.** `vite.config.ts`'s `globPatterns` deliberately
  does not list `json`, and a test asserts it: a cold offline launch has to fetch the whole
  precache before it can show anything, and one map with a height field is bigger than the
  entire app. Bundles are fetched on demand and cached in IndexedDB under `map:`, beside
  `drill:` and never instead of it — `clearAll` still deletes only progress, because
  "clear my progress" does not mean "re-download a map in a forest".
- **`SEMANTICS` is ISOM 2000 numbering**, which is what the generator's codes already
  were. Two of them are not: **508** is a narrow ride here and a less distinct small path
  in the standard, **516** a fence here and a power line there. They cannot move — every
  golden is over generated features carrying them — so `maps/import/codes.ts` aliases the
  *imported* codes out of the way instead. That table applies only to a symbol set checked
  symbol by symbol (`ISOM2000`); anything else passes through unchanged, because a guessed
  alias turns a power line into a fence and an unaliased code still draws.
- **An unknown code keeps its colour.** `Feature.colour` carries the class the source
  inked it in, and `styleFor` falls back to it. ~120 ISOM symbols exist, the table knows
  92, and a map missing its buildings is not the map the surveyor drew. A *known* code
  carries no colour: the table owns that, and storing it twice is two places to disagree.
- **A map is stored square**, padded to its longer side, because `Crop` is square and
  every drill checks its window against `width`. Nothing is framed on the padding: the
  windows are scored and empty ground scores nothing. Landform candidates are clipped to
  the ground the surveyor drew, since a reconstructed surface runs on smoothly into the
  padding and invents a hollow there.
- **`.xmap` conventions that produce a wrong map rather than an error.** Coordinates are
  1/1000 mm of paper, y down, so `metres = coord x scale / 1e6`. Flag 1 is a curve start
  and the next two coords are its Bezier controls — ignore it and you draw the control
  net. Flag 16 ends a *part*: the next ring of an area, or the next piece of a line, and
  joining a line across it draws a path over the gap the surveyor left. Mapper nests whole
  `<symbol>`s inside a line symbol for its decorations, and `<object>`s inside those, so
  ask by parent (`childrenOf`) and not by name. An area object's `<pattern>` carries a
  `<coord>` of its own that is not geometry; counting it stretched the forest sample from
  554 x 510 m to 1246 x 781 m.
- **Colours are classified from the ink, not the name.** Mapper's English names would do
  it in a line, and a map drawn in Czech would then fall back to black for every symbol the
  table does not know. Brown and yellow are the only pair needing care and they part on the
  magenta-to-yellow ratio.
- **Contour level assignment gives up rather than guessing.** A map whose relief is wrong
  is worse than one with none: the contours drill would hand out cards whose answer is a
  hillside that is not there, and nothing downstream could tell. Every check returns
  `{ ok: false, reason }` and the pipeline says so on stderr. Three things a real map
  taught: contours are drawn in **pieces** and two pieces of one line are neighbours at no
  height difference at all; an observation is a **transect**, not the nearest line on that
  side, or two pieces either side of a crest get paired; and a leftover disagreement where
  both lines came out at the *same* level is that same break and is benign, while two
  intervals apart is a misreading and is not.
- **Laplace has no interior maximum.** The smoothest surface fitting a set of rings gives
  every hill a flat top — mesas, and nothing for `analyse` to find. Innermost rings get a
  point of their own six tenths of an interval above, or below where their slope tags say
  hollow.
- **Landform candidates are curvature, not extrema.** A surveyed hillside has almost no
  local extrema; its landforms are spurs and re-entrants, which are where the ground
  *bends*. The forest sample gave 2 candidates as extrema and 54 as curvature. Extent and
  amplitude are the residual against a ring of probes, not against the lowest one, because
  a regional fall of one in eight swamps a three-metre knoll.
- **`ContourRelief.contours()` returns the drawn lines and never retraces.** Real contours
  are cartography — smoothed, cut at a knoll, thickened every fifth line. Retracing them
  from a height field reconstructed out of those same lines is how a surveyed map comes to
  look generated.
- **A `LibraryProvider` holds its bundles in the order its id names them.** The id sorts by
  content hash so the same maps in a different order are one library; `pick` walks the
  array, so the array has to be sorted too. It was not, and two devices holding the same
  two maps — ticked in the settings screen in the opposite order, or fetched in the
  opposite order — published one id and drew different maps from the same seed, forty
  seeds out of forty. Wherever an id is a promise about behaviour, the thing the id sorts
  is the thing the behaviour must read.
- **`LibraryProvider.pick` is pure and it declines.** The bundles are fixed and their
  window lists were written in a deterministic order; loading is `loadLibrary`, outside. It
  returns null when no bundle satisfies a requirement, which is the whole difference from
  the generator — a provider that never says no hands the contours drill a flat map and
  calls it a hard round.
- **Every map carries an `analysis`, the generated ones included**, and it is the only
  place a warp or a pexeso control looks for landforms — the `instanceof AnalyticRelief`
  fallbacks are gone. See **Map policy** below for what the generator hands it and why.

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
- Areas are drawn **one path per code**, not one per feature. Vegetation is generated as
  overlapping lobes so a green reads as one region, and separate translucent shapes
  composite their overlaps twice — every chain showed its construction as a string of
  darker lenses. Keyed by code and not by kind, for the same reason `MapView` styles by
  code: an imported 406 and a generated `slow` are one symbol and have to composite as one.
- `areaOutline` hashes **shape fields only**. Hashing position makes a `move` reshape the
  area it moves, so a map-memory distractor differs by more than its level asked for.
  A generated area therefore keeps its `shape` beside the outline traced from it.
- Pattern ids come from `useId()`; a pexeso board mounts twelve `MapView`s in one document.
- **No north lines.** Drawn at fixed world positions, a pexeso pair's two crops would show
  them at a known offset — an answer coming from something other than the ground.

**Raster maps**

- **A picture is understood through its colour mask and nothing else.** ISOM colours are
  separable by design, so a pixel goes back into the class it was inked in
  (`MASK_CLASSES` in `isom.ts`, computed from the screens the renderer paints — classify
  against anything else and the app cannot read back its own drawing).
- The mask is built by a **weighted** majority. A plain one erases the map: ink is a
  minority of the pixels by design — a contour is two metres of ground and a cell is one —
  so a straight vote gives every cell to white and the mask comes back with no relief
  detail, no paths and no boulders.
- A banner is **uniform *and* not an ISOM colour**. A run of one-colour rows that is an
  ISOM colour is a lake or a field. And the row's own colour is its **modal** one: a
  header carries a title, and comparing against its first pixel stops the crop thirty rows
  into a hundred-row bar.
- **Cropping reports its offsets.** A crop without them moves the whole map by the height
  of the banner, which reads as a slightly wrong map rather than as a bug.
- Anything coarser than **0.5 m per pixel is refused**: a 110 m pexeso card needs 220 px,
  and a card nobody can read is not a hard round, it is an unanswerable one.
- **A raster map has `relief: none`, and brown ink is not a height field.** The contours
  drill declines it twice over — `LibraryProvider` refuses a map with no relief, and the
  window scores for a relief requirement come out empty. Do not "improve" this by tracing
  contours from pixels; that is vectorisation, offline, with other tools.
- **Blobs are not features.** A boulder read off the mask lives in `analysis.moveable`,
  never in `map.features`: the picture already draws it, and a feature would draw a second
  one beside it. `applyEdits` and `difference` both look in both places — looking in one
  is how every distractor on a raster round comes back reported as identical to the answer.
- A moved blob is a **cut and paste**: the renderer paints the source patch out in the
  surrounding class and draws the symbol at the new place. Both arrive as data on the map;
  the answer still comes from the edit, exactly as it does for a drawing.
- `suits` has **two backends** — a height field or the mask — and `siblings` asks whichever
  the map offers. A flat map with no picture is asked neither: a grid of zeros has no
  steepest quarter, and asking it refuses every symbol that has an opinion.
- **Bundles and their pictures are never precached.** `globPatterns` lists neither `json`
  nor `png`, and both tests say so, because it is a one-word change with a several-megabyte
  consequence.
- No Livelox export is committed. The fixture is **painted in code**
  (`maps/import/__fixtures__/paint.ts`), which also makes it a test of the classifier
  rather than of a printer's idea of green.

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

## Map policy

Where a round's ground comes from — `src/lib/maps/policy.ts`, the settings screen, and
`hello`. Step 6 of `docs/real-maps-architecture.md`.

- **The provider id is part of a round's identity.** A round is a function of
  `(seed, level, provider.id)`, not of `(seed, level)`. So an id has to name everything
  that changes a round: `MixedProvider`'s names its parts, their shares *and* the order it
  tries them in, because that order is the fall-through order. `LibraryProvider`'s names
  the bundle content hashes, sorted, because the same maps in a different order are the
  same library. Anything that builds a provider must go through `providerFor`, and a
  provider whose id claims a source the device cannot resolve is the bug this prevents:
  with nothing loaded, `providerFor` returns the plain generator and says `generated`.
- **The default must stay `generated`.** Someone who never opens the settings screen plays
  the rounds they played before this existed, and their device fetches nothing: `DrillPage`
  loads bundles only for a policy that could use them. `DEFAULT_POLICY` is also what a
  malformed stored record reads as — never a half-applied policy, because half a policy is
  a provider whose id lies about the rounds it makes.
- **A forced choice is not a draw.** `MixedProvider` draws no number when only one part has
  a positive weight, so a mix at 100% one source consumes the rng exactly as that source
  alone does. Drawing anyway would shift every round after it, and "100% generated" would
  not be the generated rounds.
- **A weight of zero is not absent.** It is never drawn but stays in the fall-through
  order: "my rounds on real maps" is not "no round at all rather than a generated one", and
  a library with no relief cannot answer the contours drill.
- **`hello` carries ids and never map content.** A `library:` id is a list of content
  hashes; two peers agree because the hashes agree, not because anyone described a map.
  The joiner answers with its own id — without that reply only one side could see a
  disagreement, and both falling back to `generated` would be one peer falling back alone.
  The field is optional and **the protocol version did not move**: a peer refuses any
  version but its own, so bumping it would end every game with an older phone to add a
  field that phone does not read.
- **The generated map's landform candidates are the landforms it was built from**, handed
  to `analyse` rather than read off its curvature. Curvature is right for a surveyed
  hillside and wrong here twice: a metre of micro-relief at a sixty-metre wavelength bends
  the surface harder than a twelve-metre hill does, and `AnalyticRelief.warped` moves *the
  landform nearest the warp's centre, whole* — so a candidate that is not a landform centre
  declares one support and moves another. Measured: median 49 m between the two, and 1.7x
  the declared extent. `Warp.carries` would then carry features that never stood on the
  ground that moved.
- **The badge is read off the round, not off the screen.** `mapsOfRound` finds the `OMap` a
  round holds (`base`, or `maps` for pexeso) and `sourceBadge` turns it into one word. The
  one rule applies to a badge exactly as it applies to an answer. `mix` is a real answer:
  pexeso draws a map per pair.
- **`SessionSummary.policySource` is optional and stays optional.** Summaries already on a
  device were written by a build that recorded none, and inventing `generated` for them
  would be a stored record claiming something it never said.

## Verify

```bash
npm run verify       # typecheck, tests, bundle — the same command CI runs
npm run preview      # PWA behaviour needs the built bundle, not the dev server
```

`#/dev/maps` is a contact sheet of many seeds at once — whole map, 110 m crop, contours
beside the relief they describe — with a **library** row above them showing every bundle
in `public/maps/` in the same framings, so a real map and a generated one are compared on
one page. Dev builds only; `App` loads it lazily behind `import.meta.env.DEV` so it folds
out of the bundle. Cartography is checked by eye, and that is only safe while looking is
cheap.

Importing a map is offline and its output is committed, like the icons and the symbols:

```bash
node scripts/import-map.mjs 'forest sample.xmap' --name forest-sample \
  --licence GPL-3.0-or-later --attribution 'OpenOrienteering Mapper'
```

It loads `src/lib/maps/import/*.ts` through Vite's own SSR loader, so there is no new
dependency and no build step, and every stage it runs is a tested pure function.

CI runs the first three on every push and pull request. A green run on `main` publishes
`dist/` to `gh-pages` — so a merge to `main` is a release, and the artifact that ships is
the one the checks ran against, never a rebuild.

## Merging

Commit work to a separate branch. At the end rebase on top of `main` and verify (I fast-forwarded manually to main).

## Style

Maintain manually edited configs (e.g., `.gitignore`) lexicographically sorted.
