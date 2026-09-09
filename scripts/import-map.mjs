// Imports an OpenOrienteering Mapper .xmap into a bundle the app can load.
//
//   node scripts/import-map.mjs <map.xmap> [options]
//
//     --out <dir>          where to write; default public/maps
//     --name <name>        the map's name in the bundle; default the file's
//     --licence <text>     licence, recorded in meta
//     --attribution <text> who to credit, recorded in meta
//     --dem <grid.asc>     an Esri ASCII grid over the map's extent
//     --interval <metres>  contour interval; default 5, and no .xmap states its own
//     --tolerance <metres> Bezier flattening tolerance; default 0.5
//     --crop <x,y,size>    take this square of the map, in metres, and drop the rest
//     --resolution <n>     samples a side for a grid reconstructed from contours
//
// Like scripts/build-symbols.mjs: it runs on a machine, its output is committed or
// hosted, and nothing it uses is a runtime dependency. This is where the heavy and
// licence-encumbered parts of importing a map belong — see docs/real-maps-architecture.md
// §4.2 — and it is why the app stays a small, deterministic PWA that loads a normalised
// document rather than parsing a four-megabyte drawing on a phone.
//
// ## Why this file is a shell and nothing more
//
// Everything it does lives in src/lib/maps/import/, in TypeScript, under test. The
// browser will run the same parse stage the day "bring your own map" arrives, and a
// second implementation here would be a second thing to keep right. The modules are
// loaded through **Vite's own SSR loader**, which is already a devDependency, so there is
// no new dependency and no build step: no tsx, no ts-node, no compile-to-a-scratch-dir.
// The config is built inline rather than read from vite.config.ts, because that file
// carries the React, Tailwind and PWA plugins and none of them has anything to say about
// a map.
//
// ## Bundles are not precached
//
// The output goes to public/maps/*.json, and vite.config.ts's `globPatterns` deliberately
// does not list json. A cold offline launch must fetch the precache before it can show
// anything, and a map with a height field is bigger than the whole app.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) options[arg.slice(2)] = argv[++i];
    else positional.push(arg);
  }
  return { positional, options };
}

const { positional, options } = parseArgs(process.argv.slice(2));
const source = positional[0];
if (!source) {
  console.error('usage: node scripts/import-map.mjs <map.xmap> [--out dir] [--dem grid.asc] ...');
  process.exit(2);
}

// Vite's SSR loader, with only the alias the source uses. `configFile: false` keeps the
// app's plugins out: React, Tailwind and the PWA have nothing to say about a map, and
// loading them here would make this script depend on the app's build working.
const server = await createServer({
  configFile: false,
  root,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  // Nothing here is served to a browser, so the dependency scan has nothing to pre-bundle
  // for — and left on it walks index.html into main.tsx and complains about the PWA's
  // virtual module, which is a plugin this config deliberately does not load.
  optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { '@': join(root, 'src') } },
});

const load = (path) => server.ssrLoadModule(path);
const { importXmap } = await load('/src/lib/maps/import/pipeline.ts');
const { libraryRequirements } = await load('/src/lib/maps/library.ts');
const { parseAsciiGrid, gridFromAscii } = await load('/src/lib/maps/import/relief.ts');
const { parseXmap } = await load('/src/lib/maps/import/xmap.ts');

const xml = readFileSync(source, 'utf8');
const name = options.name ?? basename(source).replace(/\.[^.]+$/, '');

const crop = options.crop
  ? (([x, y, size]) => ({ x: Number(x), y: Number(y), size: Number(size) }))(options.crop.split(','))
  : undefined;

// The DEM has to be resampled onto the map's own square extent, which means knowing that
// extent — so the file is parsed once for its size before the real run. Cheap next to
// everything else, and the alternative is threading a callback through the pipeline.
let dem;
if (options.dem) {
  const parsed = parseXmap(xml);
  const size = crop ? crop.size : Math.max(parsed.width, parsed.height);
  const asc = parseAsciiGrid(readFileSync(options.dem, 'utf8'));
  const samples = Number(options.resolution ?? 256);
  dem = gridFromAscii(asc, size, samples);
  console.error(`dem: ${asc.ncols}x${asc.nrows} at ${asc.cellsize} m, resampled to ${samples}`);
}

const report = importXmap(xml, {
  name,
  requirements: libraryRequirements(),
  ...(options.licence ? { licence: options.licence } : {}),
  ...(options.attribution ? { attribution: options.attribution } : {}),
  ...(options.interval ? { interval: Number(options.interval) } : {}),
  ...(options.tolerance ? { tolerance: Number(options.tolerance) } : {}),
  ...(options.resolution ? { resolution: Number(options.resolution) } : {}),
  ...(crop ? { crop } : {}),
  ...(dem ? { dem } : {}),
});

for (const note of report.notes) console.error(note);
// Unresolved codes go to stderr and not into the bundle's silence: they still draw, in
// their own colour from the map's colour table, but they are never chosen as an edit
// target, and a code worth a row in semantics.ts is found by reading this list.
for (const unknown of report.unresolved) {
  console.error(
    `  unresolved ${unknown.code} (${unknown.name || 'unnamed'}) x${unknown.count}` +
      `${unknown.colour ? `, drawn ${unknown.colour}` : ''}`,
  );
}
if (report.bundle.relief.kind === 'none') {
  console.error('  NOTE: this bundle has no relief. The contours drill will decline it.');
}

const out = options.out ?? join(root, 'public', 'maps');
mkdirSync(out, { recursive: true });
const file = join(out, `${name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.json`);
// No pretty printing: a bundle is machine-read, and the whitespace of a two-megabyte
// document is not free on a phone. Gzip is the host's job.
writeFileSync(file, JSON.stringify(report.bundle));
const bytes = readFileSync(file).length;
console.error(`wrote ${file}, ${(bytes / 1024).toFixed(0)} kB`);

await server.close();
