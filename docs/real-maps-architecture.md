# Real orienteering maps beside generated ones

A design note, now implemented: **every step of section 7 is done** — the engine
refactor, the offline import pipeline, the raster tier, and the policy that switches
between sources. The per-step notes at the end of section 7 record where the code departs
from the text below and why. It describes how the terrain engine would
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
| Mapová dohledávka | `size 280–360`, `needsRelief`, no rides and no clusters | none (the two cards are two windows) | `sitesOf` reads `features` by code and `analysis.landforms`; a card is a window, so on a big map two cards can be two windows on one |
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

0. **Codes on kinds.** ✅ Done. `semantics.ts` holds the table; `suitsArea`/`suitsPoint`
   are two lines over `suits(code, ground, p)`. Golden hashes re-pinned **once, on
   purpose** because the objects gained a field.
1. **`Relief` interface.** ✅ Done. `relief.ts` and `omap.ts`; `MapView` styles by code
   through a table in `isom.ts`.
2. **Edits.** ✅ Done. `edits.ts`; `siblings` returns `{ base, variants, correctIndex }`.
3. **Provider.** ✅ Done. `lib/maps/provider.ts`; `GeneratedProvider` is the only one, and
   `DrillPage` and `MatchPage` build it. Goldens unchanged from step 0 on, which is what
   says the refactor changed no behaviour.
4. **Bundle + pipeline.** ✅ Done. `maps/bundle.ts` and `maps/codec.ts`;
   `scripts/import-map.mjs` over the tested stages in `maps/import/`; `LibraryProvider`
   and `loadLibrary`; `GridRelief` and `ContourRelief` with `warped`; a library row on
   `#/dev/maps`. The first real bundle is Mapper's own `examples/src/forest sample.xmap`
   (GPL, a dev fixture, not shipping cartography): 538 objects, 36 codes, all of them
   resolved, 41 contours at 5 m over 70 m of relief, 378 kB. `Warp.carries` was switched
   on and the `siblings` fallback fixed in the same commit, which is the deliberate
   re-pin step 3 promised; the goldens have not moved since.
5. **Raster tier.** ✅ Done. Image + world file → mask → `RasterLayer`;
   `maps/import/{png,raster}.ts` and `terrain/mask.ts`; pexeso and map memory over
   image-only maps; the contours drill declines them. See the step 5 notes at the end of
   this section.
6. **Policy.** ✅ Done. `maps/policy.ts` and `MixedProvider`; `#/settings` writes the
   policy and `DrillPage` builds the session's provider from it; `hello` carries the
   provider id and the joiner answers with its own. The generated maps gained an
   `analysis` from the same function the pipeline uses, which removed the two
   `instanceof AnalyticRelief` fallbacks — see the step 6 notes below.

Steps 0–3 are a refactor of the existing engine with no new capability and can ship on
their own. Step 4 is the feature; 5 and 6 extend it.

### Rebasing on to a `main` that changed the generator

This branch was written against the generator as it stood at `879e88f`. `main` then grew
**clustered detail and a compartment grid** — new `TerrainParams` fields (`rides`,
`clusters`), a per-pair `separationOf` in place of one `MIN_POINT_SEPARATION`, vegetation
drawn as chains of lobes, and **Mapová dohledávka**, a fourth terrain drill. Rebasing put
both on one history, and the joins are these:

- **No new symbol.** Main's additions are more of the kinds that already existed — a ride
  is 508 and a cluster is boulders, crags and knolls — so every one of them arrives with
  the ISOM code it always had and a `SEMANTICS` row that already existed. The one semantic
  change is **206**: main stopped requiring steep ground for a boulder ("it sits wherever
  the ice dropped it"), so the table's `ground` preference for it is gone, and
  `suitsPoint` still asks nothing but the table.
- **`rides` and `clusters` are `WindowRequirement` fields**, not `minFeatures` counts:
  they are what the generator is asked to draw rather than a floor a surveyed map is
  scored against. They are deliberately **not** in `requirementId` — like `minFeatures`,
  which is not either — so an imported map's window lists are unaffected by them.
- **`within` moved from `perturb` to `EditSpec`.** Main added it to `perturb` because
  clustered detail broke the draw-and-retry loop; this branch had deleted `perturb` in
  favour of `edits.ts`, so `proposeEdit` narrows its candidate pools instead. Same fix,
  same reason, one function along.
- **`MapAnalysis.landforms` gained optional `kind`, `rotation` and `elongation`.** Mapová
  dohledávka circles things a control description can name, and a candidate read off
  curvature has no name. The generator hands over the forms it was built from; `analyse`
  adds nothing, so an imported bundle is byte for byte what it was.
- **Areas are drawn one path per symbol**, keyed by code and colour rather than by main's
  `kind`, for the same reason `MapView` styles by code.
- **Every terrain golden was re-pinned once**, because main's generator answers
  differently. Mapová dohledávka's golden became a projection of the drill's *decisions*
  — which window, which circles, which shared kind — rather than a hash of the round's
  objects, for the reason `goldenMap` gives.

Where each hash ended up, and the step that pinned it:

| Golden | Value | Pinned in |
|---|---|---|
| `terrain.test.ts` — the generator | `b6b1aff3` | step 0, when features gained a code |
| `contours/drill.test.ts` — contours | `9818605d` | unchanged: a contours map has no points, lines or areas, so `goldenMap` projects exactly what `main` hashed |
| `contours/drill.test.ts` — map memory | `9847a464` | the commit that checks the `siblings` fallback and climbs it |
| `pexeso/drill.test.ts` | `3569fca9` | the commit that makes a control one draw and not two |
| `mapDohledavka/drill.test.ts` | `4a0dbebe` | the commit that puts the drill on the provider |
| `rng.test.ts`, `matchMadness`, `dohledavka` | unchanged | the symbol drills never touch the generator |
| `raster-tier.test.ts` — the markup pins | `0d1e89f8` / `a6b2e317` / `b10ee025`, and `77a61b90` for the imported map | re-measured against the commit before the raster tier, which is what they have always claimed |

### Where the implementation departs from the note above

- **A warp carries the features standing on it** (`Warp.carries`), as §3.1 always said it
  should. It was off through steps 0–3 so that their goldens could prove the refactor
  changed nothing, and step 4 turned it on with the deliberate re-pin that was promised.
  Carried features are clamped to the map exactly as `move` is, so a warp on the border
  slides its knoll and leaves a boulder pinned at the edge — the alternative is a feature
  off the map.
- **The `siblings` fallback checks visibility** and climbs 2.5x → 5x → 10x with twelve
  tries at each. Its single unchecked draw was the pre-existing flake recorded in step 3's
  note, and fixing it was the other half of the same deliberate re-pin.
- **`Warp` is declared in `relief.ts`**, not with the edits, because `Relief.warped` takes
  one and a relief must not depend on the edit vocabulary. `edits.ts` re-exports it.
- **The goldens hash `goldenMap`**, an explicit projection of the generator's decisions,
  rather than the round objects. Hashing the live objects would have forced a re-pin at
  every step of the refactor, which is exactly what makes a re-pin meaningless.
- **`WindowRequirement.minFeatures` is keyed by geometry** — landform, point, line, area —
  not by semantic family. That is the split the generator makes, and keying it by family
  would not map back to `TerrainParams`. It also carries `crop`, the sub-window a drill
  shows, because map memory drew that window from the same rng stream and the provider
  now has to draw it in the same place.
- **`Relief` has no extent.** `sampleGrid(n)` returns a `Grid` that knows its own size,
  and `maxHeightDifference` compares two sampled grids, so nothing needs a `size` on the
  interface — which is what a non-square imported map will want.
- **Generated areas stay parametric**, as §7 allows: `Feature.shape` holds centre, radii
  and rotation beside the outline traced from them, and `areaOutline` still seeds its
  wander from the generator's `kind` rather than the code so that no existing map
  reshapes.
- **`OMap.id` is `'generated'`**, not `'generated:<seed>'`: the generator is handed an
  `Rng`, not a seed, and drawing one for an id would move every round after it.

### Step 4, and where it departs from §1 and §4

- **One `.xmap` parser, not two.** §1.1 says `DOMParser` in the browser and something else
  in the pipeline. That is two readers of one subset, and the day they disagree a bundle
  imported on a laptop and one imported in the browser stop having the same content hash —
  which is the only thing that hash is for. `maps/import/xml.ts` is a tokenizer over
  exactly what Mapper emits, used in both places; a browser DOM would plug in behind
  `XmlNode` rather than beside it.
- **SHA-256 and base64 are written out** (`maps/codec.ts`) rather than taken from the
  platform, for the same reason plus one more: `crypto.subtle` is async and everything
  that reads a map here is not.
- **`saveBundle` takes an `OMap`**, so `OMap` gained `meta` and `windows`. Both are facts
  about a map that came from a file rather than from a seed — where it came from, and
  which of its ground answers which drill's question — and the alternative was a second
  type carried beside every map for the writer's convenience.
- **A map is stored square**, padded to its longer side. `Crop` is square, `wholeMap`
  reads `width`, and every drill compares its window against `width`: widening all of that
  for the first bundle would have been a change to five files with no test that could fail.
  The windows are scored, and empty padding scores nothing.
- **Landform candidates are curvature, not extrema** (§4.1 stage 4 says "local extrema").
  A surveyed hillside has almost none: its landforms are spurs and re-entrants, which are
  where the ground bends. Two candidates became fifty-four.
- **Contour levels are solved as a parity relation plus a maximum spanning tree**, rather
  than the constraint propagation over a nesting tree §1.4 describes. Nesting only relates
  *closed* contours and the forest sample has three of them out of sixty-nine; the transect
  constraint — along any line across the slope the levels are monotone — is what actually
  ties a hillside together, and point-in-polygon nesting survives only where it is needed,
  for finding the innermost rings to lift a summit onto.
- **`ContourRelief.warped` does not re-rasterise from the moved lines**, as §3.1 implies.
  It displaces the vertices forward and resamples the grid through the same field's
  inverse. Re-rasterising is a lossy round trip *everywhere*, including outside the
  support, which would leave a sibling differing over the whole map — the one thing compact
  support exists to prevent.
- **The generated maps left step 4 with no `analysis`**, so the `instanceof AnalyticRelief`
  fallbacks in `edits.ts` and pexeso's `controlFor` stayed for the moment. Filling it
  looked like it would change which ground a warp picks up on every generated round, and
  step 4's whole discipline after its first commit was that the goldens do not move again.
  Step 6 filled it without moving them — see its notes on why the candidates are the
  generator's own landforms.
- **`Colour` gained `white`.** On an ISOM map white is not the absence of ink, it is
  runnable forest, and an imported symbol drawn in it is one meant not to show.
- **`RasterLayer` and `MapBundle.raster` are declared and unfilled**, as §2.2 allows;
  step 5 fills them.

### Step 5, and where it departs from §1.3, §2.2 and §5.3

The raster tier. A picture with a world file becomes a bundle; pexeso and map memory run
on it; the contours drill declines it.

```
node scripts/import-map.mjs livelox.png --world livelox.pgw   --name kokorinsko --scale 10000 --attribution 'club, 2019'
node scripts/import-map.mjs livelox.png --mpp 0.5 --origin 0,0 --name kokorinsko
node scripts/import-map.mjs map.xmap --image map.png --world map.pgw --name kokorinsko
```

- **The colour-class table lives in `isom.ts`, beside the screens, and is computed from
  them.** `MASK_CLASSES` is the twelve classes §1.3 names; `CLASS_RGB` composites
  `GREEN_SCREEN` and `YELLOW_SCREEN` over white rather than restating the printed values.
  So the app classifies against its own drawing — which is what makes a synthetic fixture
  painted in those screens a test of the classifier rather than of a table of constants.
- **`RasterLayer.image` is a URL, not an `ImageBitmap`.** §2.2 offered either; the renderer
  is SVG, an `<image href>` takes a URL, and an `ImageBitmap` needs a canvas to get back
  out of. The bundle stores a **sibling path** — `forest.png` beside `forest.json` — and
  `loadBundle` accepts a `data:` URL too and resolves a relative one against the bundle's
  own URL. Inlining a 2 MB picture as base64 is 2.7 MB of JSON parsed before the first
  round.
- **The layer carries an origin and the mask's own cell size**, which §2.2 does not
  mention: an image may be larger than the map extent, and the mask is at about a metre
  rather than at the image's own resolution.
- **The PNG reader is written out** (`maps/import/png.ts`), 8-bit non-interlaced, colour
  types 0/2/3/4/6, filters 0–4, and it takes **inflate as an argument**. Nothing in `src/`
  may import `node:zlib` — the parse stage is meant to run in the browser one day — and no
  package may be added, for the reason `AGENTS.md` gives about generated assets. It writes
  as well as reads, because the pipeline **crops** the picture and a bundle pointing at the
  original file would draw the Livelox header inside a pexeso card.
- **The mask's majority filter is weighted.** §1.3 says "classify each pixel"; doing only
  that and downsampling by majority erases the map, because ink on an ISOM map is a
  minority of the pixels by design. Ink counts double, white still wins a cell it almost
  fills, and a contour line survives into the mask — which is what the brown-density proxy
  needs to exist at all.
- **The banner rule needs its second half and a modal colour.** §1.3 only says "a banner to
  crop off". Uniform-and-not-an-ISOM-colour is the rule, because a run of uniform rows that
  *is* an ISOM colour is a lake; and the row's own colour has to be its modal one, because
  a header has writing on it and the left edge is as likely to be inside the logo as inside
  the bar.
- **`rasterAnalysis` fills `analysis`, not `features`.** A blob is a `Feature` — that is
  what an edit names — but it lives in `analysis.moveable`, because the picture already
  draws it and a feature would draw a second boulder beside every boulder. `applyEdits`
  materialises a move as a **patch over the pixels plus the symbol at its new place**, and
  `difference` looks in both places. Control sites are the same blobs; pexeso's
  `controlFor` appends them after the candidates it already had, so no generated round
  moves.
- **The raster half of the analysis is filled only when there are no vector features.** A
  vectorised map's own symbols are a better answer to every one of those questions than a
  blob filter is, and two answers are two places for it to be wrong — a boulder that was
  both a `Feature` and a blob would be counted twice by every window score.
- **`suitsOnMask` is a short list of contradictions, not preferences.** §3.3 asks for
  `suits` with a mask backend. A height field can say "the flattest quarter of this map",
  which is a claim about a surface; a mask can only say what is drawn here. So: nothing but
  water stands in water, nothing stands on a building or a road, and a water feature does
  not go where the contour ink is crowded — the marsh-on-dense-brown case §3.3 names, and
  dense brown is the only word a mask has for steep.
- **The warped picture is a `useEffect`, not a `useMemo`.** The note guessed `useMemo`; a
  picture has to be **decoded** before it can be resampled, and decoding is asynchronous.
  Until it resolves — and in a test, and in a server render — the unwarped picture is
  drawn, which is the map with its ground unmoved and never a wrong map. The **mask is
  not rewritten** either: the warp is recorded on the layer and `classAt` carries a point
  back through the list before it reads a cell — the same chain the renderer applies to the
  pixels, and four million cells not copied on every one of the thirty-six draws a round
  can make.
- **A raster-only map is never offered a warp**, so the picture-warping path only runs for
  a drawing with a picture under it. `proposeEdit` takes warps from
  `analysis.landforms`, which is empty without a relief — and that is the guard that
  matters: a warp on a map with no height field and no features would be an edit that
  changes nothing, which is a round with two right answers.
- **`Difference.salience` compares a blob with a symbol.** A blob's drawn size in metres
  goes to paper millimetres at the map's own scale and is floored at the code's ISOM
  minimum, so a moved dot on a picture and a moved boulder on a drawing come out on one
  scale — which is what §3.4 wants salience for.
- **Nothing ships a raster bundle.** The fixture is painted in code in the test; a Livelox
  image is somebody's cartography and this repository has no licence to it. To look at a
  real one on `#/dev/maps`, import it into `public/maps/` and add the file to
  `BUNDLED_MAPS`.

### Step 6, and where it departs from §5

- **The generated map's landform candidates are the landforms it was built from.** Step 4
  left the generated maps without an `analysis` and named step 6 as the place to fill it,
  expecting the goldens to move. They did not, because filling it with the *curvature*
  candidates §4.1 describes would have been wrong here, and both reasons were measured
  before the choice was made. First, a generated map carries a metre of micro-relief at a
  sixty-metre wavelength, which bends the surface harder than a twelve-metre hill two
  hundred metres across: candidates came out at 4 m of amplitude where the landforms are at
  12, and 57% of them under 3 m. Second, and decisively, `AnalyticRelief.warped` moves
  **the landform nearest the warp's centre, whole**, and ignores the radius — so a warp
  centred on a curvature peak declares one support and moves another. Over 2200 candidates
  the ground that would actually move sat a median 49 m from the declared centre (p90
  116 m) and was 1.7x its declared extent, with about half of them further away than their
  own radius. `Warp.carries` would then carry features that never stood on the ground that
  moved — the tell carrying exists to remove — and `Difference.footprint`, the number the
  staircase is meant to drive on, would describe a disc the change is not in. Round quality
  was comparable either way (contours `reliefDelta` median 6.90 m at level 10 both ways
  against a 1.5 m floor, no `siblings` fallbacks, nothing invisible in map memory), so the
  choice is about which warp describes what it does. `analyse` takes the candidates as an
  option; everything else about a generated map's analysis is computed by the same code an
  imported map's is.
- **The analysis core moved to `terrain/analysis.ts`.** `maps/import/analyse.ts` imports
  the provider for `requirementId`, and the provider imports the generator — so the
  generator importing the analysis where it stood would have been a cycle. Stage five, the
  window scoring, stays in `analyse.ts` because it is the half that reads a
  `WindowRequirement`; `analyse.ts` re-exports `analyse`, `Analysis` and `RUNNABILITY_GRID`
  unchanged, so the pipeline did not move.
- **`MapPolicy.library` holds bundle names, not ids or URLs.** §5.1 says
  `library: string[]` without saying of what. A URL would rot across the dev and Pages
  bases; a content hash cannot be resolved to a file to fetch. The name is what a settings
  screen can list before anything is downloaded, and `bundleUrl` puts it back together.
- **A weight of zero is a fall-through, not an absence.** §5.1 gives `MixedProvider`
  weights and says a declining provider falls through to "whatever it was composed with".
  For `source: 'real'` that composition is the generator at weight zero: never drawn, still
  there to catch the contours drill on a library with no relief. Without it, "real maps
  only" is an error screen for a third of the drills.
- **A forced choice consumes no rng.** Not in the note. `MixedProvider` draws no number
  when only one part has a positive weight, so a policy at 100% one source produces exactly
  that source's rounds rather than rounds shifted by the draw that chose it — which is what
  makes the default's identity to `GeneratedProvider` exact rather than approximate.
- **`hello` carries the provider id, not the `MapPolicy`.** §5.2 says the message gains
  `mapPolicy`. The policy is not what has to match: two devices with the same policy and
  different bundles derive different rounds, and the id is precisely the thing that decides
  a round. It is also the smaller disclosure — a hash and a weight rather than a list of
  what someone has downloaded.
- **The joiner answers.** §5.2 says "a peer that lacks a bundle answers with what it has
  and both fall back to `generated`", and with `hello` alone only the joiner can see the
  disagreement. A `maps` message back is what makes *both* true; until it arrives the host
  stays on generated, so a peer too old to send one leaves the match where it would have
  been anyway. `PROTOCOL_VERSION` did not move, because a peer refuses any version but its
  own and the whole point was that an older build still plays.
- **Per-`(drill, policy)` progress is recorded but not yet used.** §8's second risk asks
  for it. `SessionSummary` gains an optional `policySource`; the level and the chart stay
  per drill, because splitting them now would divide the history every existing player has
  into a curve and an empty one. The field is what lets that split happen later without
  asking anyone to re-train, and it is optional because the summaries already on devices
  carry no source at all.
- **The settings screen loads every bundled map to list it.** §5 does not say where a map
  list's facts come from; they come from each bundle's own `meta` and geometry, which means
  reading the bundle. Cache-first, so it is one download per map ever, and the screen says
  so. The alternative — a table of names and scales restated in the app — is a second
  place for a map's facts to live and to drift.

### Package A — the canon is ISOM 2017-2, and §2.1 above is out of date

*Appended after the six steps shipped. Everything above this heading is the note as it was
written; this section says where §2.1 and the table under it no longer describe the code.*

§2.1 said the generator's kinds become code aliases and listed them —
`boulder → '206'`, `knoll → '112'`, `pit → '116'`, `crag → '203'`, `tree → '418'`,
`marsh → '311'`, `stream → '306'`, `rock → '212'`. Those were **ISOM 2000** numbers, and
`semantics.ts` said so while `isom.ts` cited 2017-2 beside the same rows and this note
claimed 2017-2 throughout. One numbering had to win. **ISOM 2017-2 wins**, and the eight
codes above are now `204`, `109`, `112`, `202`, `417`, `310`, `305`, `214`; the contours,
the vegetation scale, `505`, `508` and `516` are unchanged — the last two because 2017-2
already means by them what the generator meant, which is the strongest single argument for
this choice and was visible in the old note as an apology for them.

- **`SEMANTICS` is the standard's symbol list**, checked against OpenOrienteering
  Mapper's own `ISOM 2017-2` symbol set: relief `101`–`115`, rock `201`–`215`, water
  `301`–`313`, vegetation `401`–`419`, man-made `501`–`532`, three overprint rows, and
  `controlSite` on every symbol a control description can name. §2.1's "about 60 matter"
  was the right order of magnitude; the table now has a hundred rows and the ~190 in
  Mapper's set are what the colour fallback still exists for.
- **`Semantics` gained `barrierStrict`** — a barrier that *binds*. Forest-O's impassable
  cliff is a statement about the ground and sprint-O's impassable wall is a rule, and no
  drawing distinguishes them, so the symbol says which kind of barrier it is and
  `MapMeta.mapType` (`'forest' | 'sprint'`, default forest) says which rules apply. Two
  fields, no reader yet: `barrier` stays the route-cost hint §2.1 defined.
- **`MapMeta` also records `symbolSet`**, which is what the source's own codes were before
  the aliases moved them. The features carry canon and nothing else.
- **A code may have two pictures.** §2.1 gives `Semantics.geometry` one value and that is
  still right — it is the standard's geometry for the symbol — but `202` is a cliff, which
  a surveyor draws as a line and the generator stands at a point. `styleFor` takes the
  geometry the *feature* has and the style table may hold one entry per geometry. It is
  load-bearing rather than tidy: `MapView` renders nothing at all for a style whose
  geometry disagrees with the feature's, so the surveyed cliffs would have disappeared the
  day the generator took the code, silently and only on real maps.
- **`ALIASES` is three layers, not one**: `ISOM2000`, `ISOM2017` (identity plus the
  variant sub-codes folded onto their parent) and `ISSPROM2019`. Built from Mapper's own
  cross-reference tables (`symbol sets/*.crt`) read backwards, which is also the citation
  for every number in `SEMANTICS`. The sprint layer carries meanings and not only numbers:
  `410` is impassable vegetation under ISSprOM and fight vegetation under ISOM, so it
  lands on `411` and inherits `barrierStrict`; a paved corridor with a footprint lands on
  the road or path its width means; and the two ISSprOM symbols 2017-2 has no number for —
  `501.3` a paved area with scattered trees, `513.2` a passable retained wall — keep the
  sprint number and get a row of their own. A property test asserts every alias lands on a
  row that exists.
- **The symbol set is detected at import**, from `<symbols id=…>` first (Mapper writes its
  own into every file it draws) and then by probing symbol codes and names, with
  `--symbol-set` and `--map-type` to overrule it. It **refuses to guess**: two standards
  share almost every number, so an unrecognised set aliases nothing and its codes pass
  through, which is what §4.1's step 2 always did.
- **The forest sample was re-imported once**, filename unchanged. 538 of 538 features
  resolve on 36 codes, before and after — the aliases were never the difference between a
  known symbol and an unknown one, they are the difference between a boulder and a
  gigantic boulder. Its window lists are identical. Its barrier count moves 60 → 68,
  because ISOM 2000's *settlement* is 2017-2's *area that shall not be entered*.

Three goldens moved, once, in the commit that renumbered, and the table below is amended.
That they moved for the code strings and for nothing else is measured rather than
asserted: hashing the same projection with every `code` field stripped gives `049b8e41`
(terrain), `dde89444` (map memory) and `b756b321` (pexeso) on both sides of that commit.

| Golden | Was | Is | Why it moved |
|---|---|---|---|
| `terrain.test.ts` | `b6b1aff3` | `a1744b3b` | every feature carries a 2017-2 code string |
| `contours/drill.test.ts` — contours | `9818605d` | `9818605d` | a contours map has no features to carry one |
| `contours/drill.test.ts` — map memory | `9847a464` | `0ca4bf2c` | the maps, and a `swap` distractor's new code |
| `pexeso/drill.test.ts` | `3569fca9` | `9d86aef6` | the maps behind the cards |
| `mapDohledavka/drill.test.ts` | `4a0dbebe` | `4a0dbebe` | it hashes answer words, not codes |
| `raster-tier.test.ts` — the generated markup | `0d1e89f8` / `a6b2e317` / `b10ee025` | unchanged | the same pictures; only the keys they are looked up by moved |
| `raster-tier.test.ts` — the imported markup | `77a61b90` | `9fda80bd` | the bundle was re-imported onto the canon |


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

---

## 9. Reveal and confirm (package E)

Decision D3 of the widening plan, implemented here. It is not a map question, but it
touches every terrain drill and this is where the drills' shape is written down.

**The rule.** A single-attempt round is answered, then looked at, then confirmed. The
session reducer splits what used to be one event: `answered` records the score and the
time, `continue` advances the round, the staircase and the streak. Between the two the
session sits on a round whose score it already knows — which is exactly what a reveal is.

**What it costs the measurement: nothing.** Response time is still `answered.at −
shown.at`, and the next round's clock starts at `continue`, so the reveal is outside every
number Progress draws. A session that studies each answer for twenty seconds has the same
median as one that does not, and `session.test.ts` asserts the two medians against each
other rather than asserting the arithmetic again. The drills also lost their 700 ms
marking pause, which sat *inside* the measured round to do what the reveal does outside
it — so the numbers this app exists to show get slightly faster rather than slower, and
they get faster for a reason that is written down here.

**What it costs purity: nothing.** `generate`, `wellFormed` and `score` are untouched.
`PlayProps` gains a phase and the answers the drill reported; the marks are drawn from the
round's own structure — the shared kind, the correct index — and from what was reported,
never from what was rendered. `DrillMeta.review` is opt-in, so a drill that marks its own
taps (Match Madness, Pexeso) keeps its behaviour to the event.

**Multiplayer is the exception, and it is a deliberate one.** A match cannot wait for a
tap: two players, two screens, and neither of them owns the round. The host times the
reveal (`REVEAL_MS`, one constant) and moves both peers on with the `next` message it has
always sent — no protocol change, no new field, `PROTOCOL_VERSION` where it was. The
joiner's reveal is that window plus one hop, which is the latency it already pays for
every outcome it is told about.

**What a new single-attempt drill has to do** (package F's discrepancy drill, next): set
`review: true`, report on the attempt rather than after a pause of its own, and in
`phase: 'review'` draw its answer with `Verdict` beside whatever emphasis suits its
geometry — a ring, a border — and take no more input. Nothing else; `DrillPage` owns the
Continue, the focus and the keys.
