# Real orienteering maps beside generated ones

A design note. Nothing here is implemented; it describes how the terrain engine would
change so a drill can run on a real map — an OpenOrienteering Mapper `.xmap`, an OCAD
`.ocd`, or a plain image exported from Livelox — as well as on the generated one, and
switch between them per drill, per round, or per member tier without the drills noticing.

The short version:

1. Split what a **map is** from how the generator **makes** one. Today `Terrain` is both:
   its `landforms` are the parameters of the height field *and* the features on the map.
   A real map has features and relief, but no landform parameters. So: one source-neutral
   `OMap` type, and the generator becomes one of several **sources** that produce it.
2. Give every feature an **ISOM code** and one table that says what that code means for
   navigation. That table — not the renderer, not the drill — is where the app
   "understands" a boulder, a marsh, an impassable cliff. Generated and real features go
   through the same table.
3. Replace "move one feature" with **edits as data**, including a compact-support **warp**
   that moves a landform on *any* relief representation — analytic, DEM, contour lines, or
   raster pixels — and carries the features and contour lines standing on it. A distractor
   is `base + edits`, and similarity is measured on the edits, never on pixels.
4. Import real maps **offline into one bundle format**, not in the browser. The pipeline
   is where the heavy and licence-encumbered tools live (OCAD parser, contour tracing,
   LiDAR); the app loads a normalised bundle and stays a small, deterministic PWA.
5. Drills ask a **`MapProvider`** for a map that satisfies their requirements. Which
   provider — generated, library, or a weighted mix — is decided outside the drill, and
   that is the tier switch.

Everything below is the long version, in that order, then the migration path and the
risks.

---

## 1. What a real map actually gives us

Three formats were examined. They differ in what the app can know without work.

### 1.1 OpenOrienteering Mapper `.xmap` / `.omap`

The user's link ([henrikopersson/mapping-example](https://github.com/henrikopersson/mapping-example))
is a guide to keeping a Mapper `.xmap` in git; the format itself is Mapper's XML. `.omap`
is the same XML minified. Both parse with `DOMParser`. Confirmed against Mapper's own
`examples/src/*.xmap`:

| Element | What it is | Note for us |
|---|---|---|
| `<georeferencing scale="10000">` | Map scale 1:N; optionally a PROJ string and a reference point in a projected CRS | Scale is enough to turn paper into metres. The CRS is what lets a DEM be attached. |
| `<colors>` | The CMYK colour table with priorities | Fallback styling for symbols we do not know |
| `<symbols>` → `<symbol type= code= name=>` | `type` 1 point, 2 line, 4 area, 8 text, 16 combined. `code` is the **ISOM code as a string**: `"101"`, `"206"`, `"410.1"` | The code is the semantic key. Names differ between ISOM 2000 and 2017-2 symbol sets; codes mostly agree, and where they moved (slope line 104 → 101.1) a small alias table covers it. |
| `<object type= symbol=>` → `<coords><coord x y flags>` | `type` 0 point, 1 path, 4 text. Coordinates in **1/1000 mm of paper**, y down | `metres = coord × scale / 10⁶`. Flags: 1 curve start (next two coords are Bézier controls), 2 close point, 4 gap, 16 hole point, 32 dash point. Flatten curves at import. |

What is **not** in the file: heights. Contours are line objects with symbol 101/102/103
and no elevation. Relief has to be reconstructed (section 1.4) or supplied.

### 1.2 OCAD `.ocd`

Binary, versioned, and well covered by
[`ocad2geojson`](https://github.com/perliedman/ocad2geojson) (same author as the
control-description symbols we already vendor). It is **AGPL-3.0**, which is one of the
two reasons import runs offline in `scripts/` and not in the bundle: the parser and its
licence stay out of the app. The other is that Mapper opens `.ocd` and saves `.xmap`, so
the OCAD path can simply be "convert first".

### 1.3 A raster export (the Livelox PNG)

Pixels, and only pixels. The example in the request is about 1500 px across for what
looks like 3 km of ground, so roughly 2 m per pixel, with a banner to crop off and no
georeferencing inside the file. Community downloaders
([routechoices map-downloader](https://github.com/routechoiceslivegps/map-downloader))
fetch the full-resolution tiles and a world file, which is what we want: a **110 m pexeso
card needs at least 220 px** to be readable, so anything coarser than 0.5 m/px is
unusable for the small windows.

An image can still be *understood* to a useful degree without vectorising it, because
ISOM colours are designed to be separable: classify each pixel into {brown, blue, green
×3 densities, yellow ×2, black, grey, white, purple}. That gives a **semantic mask** —
enough to score windows, to know where relief detail is dense, to keep an edit plausible,
and to place a control on a black dot. It does not give vector features or heights.

Full vectorisation is an offline job, and the tools the request lists are the ones for
it: Mapper's built-in **CoVe** (colour classification → thinning → line vectorisation),
**ContourTrace** (an AutoTrace extension for pulling contour lines from a raster). Both
produce lines that then go through the `.xmap` path, so the raster source has two tiers:
*image-only* and *vectorised*, and the second is just an `.xmap`.

### 1.4 Where relief comes from

Every relief drill needs a height field. Sources, best first:

1. **A DEM by georeference.** If the map is georeferenced, sample a LiDAR DEM over its
   extent in the pipeline. For Czech maps that is ČÚZK DMR 5G, open data; most European
   mapping agencies have an equivalent. The **Laserscan tool** and **Kartapullautin**
   both take a point cloud and produce 1 m contours or a DEM raster from it. This is the
   only route that gives *true* heights, and it is a one-off offline step.
2. **Contour lines with assigned levels.** Without a DEM, levels can be assigned to the
   contour graph: index contours (102) are every fifth line, form lines (103) sit at half
   intervals, slope lines (101.1/104) mark the downhill side of a closed line, contour
   value texts (105) pin absolute values where present, and neighbours differ by ±1
   interval. Constraint propagation over the contour adjacency graph resolves most maps;
   where it cannot, the window is tagged `relief: 'unknown'` and relief drills skip it.
   Then rasterise: interpolate between contours (any DEM-from-contours method; a
   distance-weighted blend between the two bounding lines is adequate for shading).
3. **None.** A raster-only map with no DEM. Pexeso and map memory still work; the
   contours drill does not, and the provider says so (section 5).

---

## 2. The map model: `OMap`

```ts
/** Metres, origin top-left, y down — the convention MapView already uses. */
interface OMap {
  readonly id: string;              // content hash of the bundle, or 'generated:<seed>'
  readonly width: number;
  readonly height: number;
  /** The scale the cartography was drawn for. ISOM widths are paper millimetres at this
   *  scale; the generator's maps are 1:15000 (see isom.ts). */
  readonly scale: number;
  readonly relief: Relief;
  readonly features: readonly Feature[];
  /** Present for the image source; may coexist with features once vectorised. */
  readonly raster?: RasterLayer;
  /** Precomputed once per map, never per round (section 5.2). */
  readonly analysis?: MapAnalysis;
}

interface Feature {
  readonly id: string;              // stable within the map; edits refer to it
  readonly code: IsomCode;          // '206', '410.1' — the semantic key
  readonly geometry: Point | Polyline | Polygon;   // Polygon = rings, first outer
  readonly size?: number;           // point features: drawn size in metres, as today
}
```

`Terrain` today carries `tilt`, `noiseSeed`, `landforms` — those are *how the generator
parameterises relief*, and they move into one implementation of `Relief`:

```ts
interface Relief {
  heightAt(x: number, y: number): number;
  sampleGrid(n: number): Grid;                  // height.ts already works over Grid
  /** Cartographic contour lines if the source drew them; otherwise traced from the grid. */
  contours(interval: number): readonly Contour[];
  /** Section 3: the one relief edit that exists on every representation. */
  warped(w: Warp): Relief;
  readonly kind: 'analytic' | 'grid' | 'contours' | 'none';
}
```

- `AnalyticRelief` — tilt + landforms + micro-relief. Exactly `heightAt` in `height.ts`.
  `contours()` traces by marching squares as now.
- `GridRelief` — a DEM. `heightAt` is `sampleGridAt`. `contours()` traces.
- `ContourRelief` — the map's own contour lines with levels, plus a grid rasterised from
  them. `contours()` returns **the drawn lines**, because real contours are cartography:
  smoothed, cut at knolls, thickened for index lines. Retracing them from a
  reconstructed DEM would make the real map look generated.
- `NoRelief` — flat. Present so a raster-only map is still an `OMap`.

`readGround(terrain)` becomes `readGround(map.relief)` and is otherwise unchanged; it only
ever consumed the sampled grid. `Relief.tsx` and `contours.ts` already take a `Grid`.

### 2.1 The semantic table

This is the part the request calls *understanding the objects and their meaning*. One
table, keyed by ISOM code, consulted by the renderer, the edit plausibility check, the
control placer, window scoring, and later a route-choice cost surface:

```ts
interface Semantics {
  readonly code: IsomCode;
  readonly geometry: 'point' | 'line' | 'area';
  readonly colour: 'brown' | 'black' | 'blue' | 'green' | 'yellow' | 'grey' | 'purple';
  /** What the symbol is *about*, for grouping and for "same category" difficulty. */
  readonly family: 'landform' | 'rock' | 'water' | 'vegetation' | 'manmade' | 'overprint';
  /** 1 = white forest, 0 = impassable. Areas and lines only. The route-choice input. */
  readonly runnability?: number;
  /** A line you cannot cross: impassable cliff, high fence, uncrossable marsh border. */
  readonly barrier?: boolean;
  /** Can a control sit on it? Point features and line/area corners, per ISCD. */
  readonly controlSite?: boolean;
  /** Section 3.3: where this thing may legitimately be. */
  readonly ground?: GroundPreference;
  /** Bound to the relief: moving the ground moves it (knoll, pit, cliff), and it cannot
   *  be moved onto ground that does not have it. */
  readonly reliefBound?: boolean;
  /** ISOM minimum size in paper mm — the salience floor used by similarity. */
  readonly minSizeMm?: number;
}

type GroundPreference =
  | { readonly slope: 'flattest' | 'steepest'; readonly quantile: number; readonly low?: boolean }
  | { readonly at: 'maximum' | 'minimum' };
```

`suitsArea` / `suitsPoint` in `terrain.ts` already encode `ground` for seven area kinds
and five point kinds as `if` chains. The table is those rules made data and extended to
the codes a forest map actually uses (about 60 matter; the ISOM 2017-2 set is ~120, and
unknown codes fall back to `colour` + `geometry` from the source's own colour table, so an
unrecognised symbol still renders and is simply never chosen as an edit target).

The generator's `PointKind`/`AreaKind`/`LineKind` enums become code aliases:
`boulder → '206'`, `knoll → '112'`, `pit → '116'`, `crag → '203'`, `tree → '418'`,
`marsh → '311'`, `open → '401'`, `rough → '403'`, `slow → '406'`, `walk → '408'`,
`fight → '410'`, `rock → '212'`, `path → '505'`, `stream → '306'`, `fence → '516'`,
`ride → '508'`. Nothing about the generator's *decisions* changes.

### 2.2 The raster layer

```ts
interface RasterLayer {
  readonly image: ImageBitmap | string;     // decoded, or a blob URL
  readonly metresPerPixel: number;
  /** Per-pixel ISOM colour class at reduced resolution, from the pipeline. */
  readonly mask: Uint8Array; readonly maskWidth: number; readonly maskHeight: number;
}
```

`MapView` draws `<image>` under whatever vector features exist, in the same `viewBox`
metres, so a crop is still just a `viewBox`. The mask is what the analysis and the
plausibility check read when there are no features to read.

---

## 3. Edits: what `perturb` becomes

Today `perturb` changes one `(x, y)` in one of three arrays and reports
`{ what, index, distance }`. `siblings` filters on visibility and plausibility, and
`differsWithin` recovers the difference afterwards by comparing arrays index by index.
That works only because the generator owns the arrays.

Make the change itself the value:

```ts
type Edit =
  | { readonly op: 'move';   readonly feature: string; readonly dx: number; readonly dy: number }
  | { readonly op: 'remove'; readonly feature: string }
  | { readonly op: 'add';    readonly feature: Feature }
  | { readonly op: 'swap';   readonly feature: string; readonly code: IsomCode }   // boulder ↔ knoll
  | { readonly op: 'warp';   readonly warp: Warp };

/** A compact-support displacement: everything inside `radius` of `centre` slides by
 *  (dx, dy), fading to zero at the edge with the same bump the landforms use. */
interface Warp {
  readonly centre: Vec; readonly radius: number; readonly dx: number; readonly dy: number;
}

interface Variant { readonly base: OMap; readonly edits: readonly Edit[]; }

function applyEdits(map: OMap, edits: readonly Edit[]): OMap;
```

A drill round holds `base` and, per distractor, its `edits`. `applyEdits` is pure and is
what the renderer receives. `wellFormed` reasons about edits and the window; **it never
looks at what `applyEdits` produced beyond structure**, which keeps the one rule.

### 3.1 Why a warp

Moving a landform is the perturbation the contours drill needs, and a DEM has no
landforms to index. A warp moves a piece of ground on every representation:

- `AnalyticRelief.warped(w)` — equivalent to `heightAt(p − d(p))` where `d` is the
  displacement field; for the generator it can also be applied exactly by moving the
  landform whose centre is nearest `w.centre`, which is what `perturb` does today.
- `GridRelief.warped(w)` — resample the grid through the inverse displacement.
- `ContourRelief.warped(w)` — displace the **contour polylines' vertices** inside the
  support, and resample the grid. The lines stay cartographic; only the ground under
  the moved knoll shifts.
- `RasterLayer` — displace pixels through the inverse map, same as the grid.

And the same `Warp` is applied to features inside its support: a boulder on the knoll
moves with the knoll, which is what a `reliefBound` feature must do and what keeps the
distractor plausible without a separate rule.

Compact support is not new — `AGENTS.md` already insists on it for landform falloff, for
the same reason: a change must be local so the distractor differs *only there*.

### 3.2 Choosing an edit for a level

`perturb(map, rng, { distance, target })` becomes `proposeEdit(map, rng, spec)`, where
`spec` is what the drill asks for:

```ts
interface EditSpec {
  readonly distance: number;                   // metres, as today
  readonly ops: readonly Edit['op'][];         // contours drill: ['warp'] only
  readonly families?: readonly Semantics['family'][];
  readonly within?: Crop;                       // map memory: inside the window
  readonly minReliefDelta?: number;             // contours drill: 1.5 m
}
```

Candidates come from `map.features` filtered through the semantic table (`controlSite`,
`family`, `reliefBound`), or from `map.analysis.landforms` for a warp (section 5.2).
`siblings` keeps its shape — try, check visible, prefer plausible, fall back to a bigger
move — with the checks rewritten over `Edit` + `Semantics`.

### 3.3 Plausibility, generalised

`isPlausibleChange` today asks `suitsArea`/`suitsPoint`. With the table it asks
`suits(feature.code, ground, newPosition)`; `ground` is `readGround(map.relief)` for
vector maps and the colour mask for raster-only maps (a marsh pasted onto dense brown is
implausible; a boulder onto yellow is fine). Same function, two backends.

### 3.4 Similarity, quantified

The request asks for similarity to be a number. Today it is three separate implicit
measures: the requested `distance`, `maxHeightDifference`, and a boolean
`differsWithin`. Make it one report computed from the edits:

```ts
interface Difference {
  /** Fraction of the window whose rendering can differ. Warp: its disc ∩ crop. Move:
   *  the union of the feature's old and new footprints, padded by its drawn size. */
  readonly footprint: number;
  /** Largest |Δheight| inside the window; 0 for non-relief edits. */
  readonly reliefDelta: number;
  /** How hard the moved thing is to see: its ISOM minimum size in paper mm × colour
   *  contrast against what it sits on. A black boulder scores higher than a form line. */
  readonly salience: number;
  /** Which semantic families the edit touches. Same-family edits are harder to notice. */
  readonly families: readonly Semantics['family'][];
  /** Whether the change lies inside the window at all — the current differsWithin. */
  readonly visible: boolean;
}

function difference(variant: Variant, crop: Crop): Difference;
```

`wellFormed` asserts floors (`visible`, `reliefDelta ≥ 1.5` for contours). The
staircase can later drive `distance` *and* `salience` instead of distance alone, which is
how a real map — far more varied in what can move than the generator — gets a difficulty
that means the same thing from one map to the next. Everything is computed from
structure and semantics; no canvas is read.

---

## 4. Sources and the bundle

```
 .xmap ─┐                                  ┌─ GeneratedSource  (in app, pure, seeded)
 .omap ─┤  scripts/import-map.mjs          │
 .ocd  ─┤  ─ parse ─ semantics ─ relief ─  ├─ LibrarySource    (bundles, in app)
 image ─┤  ─ analysis ─ windows ─ write ─▶ │
 DEM   ─┘         *.obmap.json(.gz)        └─ MixedSource      (weights) ─▶ MapProvider
```

### 4.1 Offline pipeline, in `scripts/`

Like `build-symbols.mjs`: run on a machine, output committed or hosted, no runtime
dependency. Stages, each a pure function on the previous stage's output so the parts are
testable:

1. **Parse** — `.xmap` with a ~300-line TypeScript reader (namespace
   `openorienteering.org/apps/mapper/xml/v2`; the same module runs in the browser later
   for "bring your own map"). `.ocd` via `ocad2geojson` here only. Image: decode, crop the
   banner, read the world file, classify colours into the mask.
2. **Semantics** — resolve each object's symbol `code` against the table; alias ISOM 2000
   codes; record unknowns with their colour.
3. **Relief** — attach a DEM if a georeference and a source are given; else assign
   contour levels (section 1.4); else `none`.
4. **Analysis** — `readGround` once; extract landform candidates (local extrema and
   their extents from the grid, exactly what `readGround` already finds as `maxima` /
   `minima`); build the barrier set; compute a runnability raster from area codes.
5. **Windows** — score a grid of candidate windows per drill requirement (below) and
   write the top N as a deterministic list, so `generate` picks from a list rather than
   searching a 2 km map on a phone.
6. **Write** — one JSON document, gzipped, content-hashed. Geometry in metres, curves
   flattened, Float32 arrays base64.

```ts
interface MapBundle {
  readonly format: 1;
  readonly id: string;                       // sha-256 of the payload
  readonly meta: { name; scale; source: 'xmap' | 'ocad' | 'image'; licence?: string; attribution?: string };
  readonly width: number; readonly height: number;
  readonly features: readonly Feature[];
  readonly relief: { kind: 'grid'; n; values: string } | { kind: 'contours'; interval; lines: ... ; grid: ... } | { kind: 'none' };
  readonly raster?: { png: string; metresPerPixel; mask: string; maskWidth; maskHeight };
  readonly analysis: MapAnalysis;
  readonly windows: Record<WindowRequirementId, readonly Crop[]>;
}
```

### 4.2 Why not parse in the browser

Because the browser is the wrong place for every hard part: GDAL and LiDAR, CoVe,
`ocad2geojson`'s licence, and a 4 MB `.xmap` on a phone before the first round. The app
loads bundles lazily and keeps them in IndexedDB beside progress (the PWA precache stays
the hashed JS; `vite.config.ts` says why). Browser-side `.xmap` import is a later
feature that reuses the parse stage unchanged, not a different design.

### 4.3 Window requirements

What a drill needs from a piece of map, stated once so the pipeline can precompute it
and the generator can be asked for the same thing:

```ts
interface WindowRequirement {
  readonly size: number;                              // 300 / 380 / 420 m today
  readonly relief?: { readonly minRange: number; readonly maxRange: number };  // 20–40 m
  readonly minFeatures?: Partial<Record<Semantics['family'], number>>;
  readonly minControlSites?: number;                  // pexeso
  readonly maxRunnabilityCover?: number;              // not one green wash
  readonly needsRelief: boolean;                      // contours drill: true
}
```

The generator satisfies these by construction (`paramsFor` is a requirement in disguise);
a real map satisfies them by selection. Scoring is over `analysis`, so it is the same
code for both.

---

## 5. The provider: where the switch lives

### 5.1 Contract

```ts
interface MapProvider {
  readonly id: string;                        // 'generated' | 'library:<hash>' | 'mixed:<...>'
  /** Pure. Same rng state, same requirement → same map and window. */
  pick(rng: Rng, requirement: WindowRequirement): { map: OMap; crop: Crop } | null;
}

interface RoundContext { readonly maps: MapProvider; }

interface Drill<Round, Answer> extends DrillMeta {
  generate(rng: Rng, level: number, ctx: RoundContext): Round;   // ctx is the one new arg
  ...
}
```

- `GeneratedProvider` — wraps `generateTerrain(rng, paramsFor(requirement))`; the crop
  is the whole map or a random window as today.
- `LibraryProvider(bundles)` — picks a bundle then a window from its precomputed list
  with `rng`. Returns `null` when no bundle meets the requirement (no relief, say), and
  the drill falls through to whatever it was composed with.
- `MixedProvider([{ provider, weight }])` — the tier knob: 100 % generated, 30 % real,
  100 % real. Deterministic given the rng.

`RunningSession` builds the provider from a `MapPolicy` stored with progress
(`{ source: 'generated' | 'real' | 'mixed', library: string[] }`) and passes it in. The
drills do not know which one they got; `Home` and a settings screen decide.

### 5.2 Determinism and P2P

Golden tests and peer-to-peer Dohledávka both depend on `generate` being a function of
`(seed, level)`. With a provider it is a function of `(seed, level, provider.id)`. The
`hello` message gains `mapPolicy`; a peer that lacks a bundle answers with what it has
and both fall back to `generated` — the map content never crosses the wire, only its
hash, which is the same privacy stance as today. Golden hashes over library rounds pin
`(bundle id, window index, edits)`, not geometry, so a bundle can be re-imported without
breaking them unless its analysis changed.

### 5.3 Drill by drill

| Drill | Requirement | Edit spec | What changes in the drill |
|---|---|---|---|
| Posunuté pexeso | `size 300`, `minControlSites ≥ pairs`, mixed cover | none (pairs are two windows on one map) | `controlFor` picks from `features` where `controlSite`; a raster-only map picks black/blue blobs from the mask |
| Contours → relief | `size 380`, `needsRelief`, `relief 20–40 m` | `['warp']`, `minReliefDelta 1.5` | `contoursOnly` draws `relief.contours()`; `Relief.tsx` unchanged. Skips maps with `relief: none` |
| Map memory | `size 300`, some of every family | `['move','remove','swap','warp']` within the crop | `differsWithin` → `difference(...).visible` |
| A future route-choice drill | barriers + runnability raster | none | cost surface from `analysis`; same for both sources |

---

## 6. Rendering

`MapView` keeps its shape — a `viewBox` in metres, widths in paper mm via `unit`. Two
changes:

- **Style by code.** `Area`/`Line`/`Point` switch on `kind`; they switch on `code` via a
  style table that sits next to the semantic table in `isom.ts` (the numbers there
  already carry their codes in comments). Unknown code → colour class from the bundle's
  colour table, drawn as the plainest symbol of its geometry. Polygons with holes fill
  `evenodd`. Text objects are dropped.
- **Contours from the relief**, not traced in the component: `relief.contours(interval)`.
  For the generator that is the same marching squares, memoised per map as now.
- **Raster underlay**: `<image>` in world metres when `map.raster` exists.
- **Scale stays as it is.** `UNITS_PER_MM` anchors line weights to a 420 m reference map
  at 1:15000, and a smaller window is the same map printed larger. That is a property of
  the *drill window*, not of the source, so a real map's 300 m window gets the same
  weights as a generated one. `OMap.scale` is used at import (paper → metres) and by
  `salience` (ISOM minimum sizes are paper millimetres), never by the renderer.

The generated map at level 5 must look identical before and after this refactor; the
`#/dev/maps` contact sheet gains a **library** row per bundle beside the seeded rows so
the comparison is one page.

---

## 7. Migration, in steps that each leave the suite green

0. **Codes on kinds.** Add `code` to the generator's features and the `Semantics` table
   with the sixteen codes it emits; rewrite `suitsArea`/`suitsPoint` to read the table.
   Behaviour identical; golden hashes re-pinned **once, on purpose** because the objects
   gained a field (they are quantised to pin the generator, and this is a generator
   change).
1. **`Relief` interface.** `AnalyticRelief` wraps `tilt`/`noiseSeed`/`landforms`;
   `heightAt`, `sampleGrid`, `readGround`, `Relief.tsx`, `contours.ts` consume it.
   `Terrain` becomes `OMap` with `relief: AnalyticRelief`. Pure rename plus one indirection.
2. **Edits.** `perturb` → `proposeEdit` + `applyEdits`; `siblings` returns
   `{ base, variants: Variant[] }`; `differsWithin` → `difference`. Property tests carry
   over one to one ("exactly one correct answer" is `difference().visible` for every
   distractor). Warp implemented for `AnalyticRelief` only, by moving the nearest
   landform — identical output to today.
3. **Provider.** `RoundContext` threaded through `Drill.generate` and `DrillPage`;
   `GeneratedProvider` is the only one. Goldens unchanged.
4. **Bundle + pipeline.** `scripts/import-map.mjs` for `.xmap` with an optional DEM;
   `LibraryProvider`; `GridRelief` and `ContourRelief` with `warped`; `MapView` styling
   by code; a library row on `#/dev/maps`. The first real bundle is Mapper's own
   `examples/src/forest sample.xmap` (GPL, fine for a dev fixture, not for shipping).
5. **Raster tier.** Image + world file → mask → `RasterLayer`; pexeso and map memory over
   image-only maps; contours drill declines them.
6. **Policy.** `MapPolicy` in the store, a settings screen, `MixedProvider`; `hello`
   carries the policy.

Steps 0–3 are a refactor of the existing engine with no new capability and can ship on
their own. Steps 4–6 are the feature.

---

## 8. Risks and what bounds them

- **Relief reconstruction from contours is the hard algorithm.** Mitigation: it is
  optional. A DEM by georeference is the recommended path and a one-off; without either,
  a map still serves two of three drills. Do not block the raster tier on it.
- **Real maps are busier and more varied than the generator**, so "distance 18 m" is not
  one difficulty. `Difference.salience` exists for this; until the staircase uses it,
  expect the level to settle differently on real maps and keep progress per
  `(drill, policy)` rather than per drill.
- **Bundle size.** A 2 km map with a 1 m DEM is tens of MB. Store the grid at 2–4 m
  (the generator samples at 96 over 300 m, about 3 m), gzip, and load per map on demand.
  Never in the precache.
- **Rendering fidelity.** ~120 ISOM symbols against the sixteen drawn now. Fallback by
  colour class keeps every map drawable from day one; fidelity grows table row by table
  row, checked by eye on the contact sheet, which is the existing practice.
- **Licence provenance.** The request says not to worry, and the architecture does not
  depend on it — but a `licence` and `attribution` field in `meta` costs nothing and is
  what a member-tier product will need the day a map owner asks.
- **The one rule.** Everything that scores or validates reads `Variant`, `Difference`,
  and `Semantics`. If anything ever needs a pixel, that is the bug — the same sentence
  as `AGENTS.md`, now covering pixels that came from a PNG too.

## References

- Mapper XML examples: `OpenOrienteering/mapper` → `examples/src/*.xmap` (coordinates in
  1/1000 mm; symbol `code` = ISOM code; `<georeferencing scale=…>`).
- [henrikopersson/mapping-example](https://github.com/henrikopersson/mapping-example) —
  `.xmap` in git, the format the request names.
- [perliedman/ocad2geojson](https://github.com/perliedman/ocad2geojson) — OCAD 10–2018 →
  GeoJSON/SVG, AGPL-3.0, Node.
- [routechoiceslivegps/map-downloader](https://github.com/routechoiceslivegps/map-downloader) —
  full-resolution georeferenced images from Livelox and others.
- [karttapullautin](https://github.com/karttapullautin/karttapullautin) — LiDAR →
  contours/vegetation/cliffs, GPL-3.0, Rust; produces DXF contours and a DEM-derived PNG.
- OpenOrienteering Contour Trace, Laserscan tool, Mapper (CoVe) — openorienteering.org/apps.
