/**
 * `pnpm catalog:build [--limit N] [--queries file] [--refresh-prices]` and `pnpm catalog:status`.
 *
 * Builds the LOCAL product catalogue (personal use, this machine only) in apps/server/local-assets/ikea-fr (gitignored):
 * a curated query list, politely (see build.ts). Options:
 *   --limit N            read at most N product pages in this run (a small sample; the default is no limit)
 *   --queries FILE       your own query list: one per line, `query` or `query | category`, `#` comments
 *   --from-scene FILE    also fetch the IKEA products used in a *.flat.json scene
 *   --no-seeds           skip the built-in list of products from the design sessions
 *   --refresh-prices     update price and availability of the existing entries only (one page read each)
 *   --per-query N        results kept per query (default 12)
 *   --max-products N     catalogue size cap (default 600)
 *   --max-age-days N     entries younger than this are fresh and skipped (default 30)
 *   --no-photos          do not download photos
 *   --texture-max N      longest texture side kept in the GLBs (default 1024)
 *   --no-optimize        keep textures and geometry as downloaded (fit checks still run)
 *   --out DIR            another catalogue folder
 * `pnpm catalog:reclassify [--dry] [--out DIR]` recomputes category and mount of the existing entries offline (no download).
 * `pnpm catalog:refit [--dry] [--sku X] [--out DIR]` recomputes the orientation (quarter turn) and overall dims of the existing models offline (no download).
 * `pnpm catalog:import-page <page.html> [--photos-dir DIR] [...]` adds a product from a page the user saved in their own browser (fully offline; `--help` lists the steps).
 * Ctrl-C finishes the product in hand, saves and stops; run the command again to resume.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryCache } from '../cache';
import { createNetwork } from '../http';
import { createIkeaFrProvider } from '../ikea-fr';
import type { ProviderContext } from '../types';
import { buildCatalog, cleanTemp, refreshPrices, DEFAULTS } from './build';
import { importSavedPage, type PageOverrides } from './import-page';
import { DEFAULT_QUERIES, SEED_SKUS, parseQueriesFile, skusFromScene } from './queries';
import { reclassifyCatalog } from './reclassify';
import { refitCatalog } from './refit';
import { formatStatus, statusReport } from './status';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
export const DEFAULT_DIR = here('../../../local-assets/ikea-fr');

interface Args {
  command: string;
  /** Arguments without `--` (the page file of `import-page`). */
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) {
      if (command !== 'import-page') throw new Error(`unexpected argument "${a}"`);
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = rest[i + 1];
    if (['refresh-prices', 'dry', 'no-photos', 'no-optimize', 'no-seeds', 'help', 'force'].includes(key)) flags.set(key, true);
    else if (next === undefined || next.startsWith('--')) throw new Error(`--${key} needs a value`);
    else {
      flags.set(key, next);
      i++;
    }
  }
  return { command, positional, flags };
}

const num = (flags: Args['flags'], key: string): number | undefined => {
  const v = flags.get(key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${key} must be a positive integer`);
  return n;
};

/** Paths in arguments are relative to where the user typed the command (pnpm runs us inside apps/server). */
const fromUser = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);

function liveContext(log: (m: string) => void): { ctx: ProviderContext; provider: ReturnType<typeof createIkeaFrProvider> } {
  const clock = { now: () => Date.now() };
  const net = createNetwork({ clock, log: (l, m) => (l === 'info' ? undefined : log(`  [${l}] ${m}`)) }).forProvider('ikea-fr');
  const cache = new MemoryCache({ clock }).scope('ikea-fr');
  const ctx: ProviderContext = { fetch: net.fetch, cache, clock, log: (l, m) => (l === 'info' ? undefined : log(`  [${l}] ${m}`)) };
  return { ctx, provider: createIkeaFrProvider() };
}

const MB = 1024 * 1024;

const IMPORT_HELP = `pnpm catalog:import-page <page.html> [options]       (OFFLINE: nothing is fetched, no cookie or login is used)

Adds a product that has no 3D model and cannot be read automatically (a shop that blocks scripts, a marketplace item) to the
local catalogue, from the page YOU saved in your own browser:
  1. Open the product page in your browser, then Save the page: Cmd+S (Ctrl+S) -> Format "Web page, complete".
     This writes <name>.html and a <name>_files folder with the pictures.
  2. Run:  pnpm catalog:import-page ~/Downloads/<name>.html
     It reads the product data (schema.org JSON-LD, Open Graph, the characteristics table: Largeur / Profondeur / Hauteur /
     Longueur / Dimensions, colour, material), copies the main photo from <name>_files (320 px WebP) and writes a manual
     entry (source "manual", personal use only, the page address kept in the gitignored catalogue only).
  3. The product appears in the library and the search as "ikea-fr:<8 digits>" (the number is printed). Place it as usual:
     it has no model, so the viewer draws the category's parametric stand-in at the listed size (a kitchen island, with a
     swivel top and shelf / wine bays when its name says so). Prices are counted in the bill of materials.
Options:
  --photos-dir DIR   folder of the saved pictures (default: <page>_files next to the page)
  --url URL          the product page address, when the saved file does not carry it
  --name TEXT  --price 123.45  --currency EUR   fill in what the page does not give
  --dims w,d,h       width, depth, height in cm (overrides the page), e.g. --dims 140,60,90
  --sku 12345678     8-digit reference (default: the page's own 8-digit reference, else one taken from the address)
  --category C       force a category (e.g. kitchen_island, table); default: from the product type and name
  --dry              show what would be written, change nothing     --force   replace a shop product with the same reference
  --out DIR          another catalogue folder
Not available on purpose: fetching the page for you, or passing cookies / session tokens.`;

async function runImportPage(file: string, flags: Args['flags'], dir: string): Promise<number> {
  const known = new Set(['out', 'photos-dir', 'url', 'name', 'price', 'currency', 'dims', 'sku', 'category', 'dry', 'force', 'help']);
  for (const k of flags.keys()) if (!known.has(k)) throw new Error(`unknown option --${k} (import-page works from the saved file only; see --help)`);
  const text = (k: string) => (typeof flags.get(k) === 'string' ? String(flags.get(k)) : undefined);
  const overrides: PageOverrides = {};
  if (text('url')) overrides.url = text('url')!;
  if (text('name')) overrides.name = text('name')!;
  if (text('currency')) overrides.currency = text('currency')!;
  if (text('sku')) overrides.sku = text('sku')!;
  if (text('price')) {
    const p = Number(text('price')!.replace(',', '.'));
    if (!Number.isFinite(p) || p < 0) throw new Error('--price must be a number');
    overrides.price = p;
  }
  if (text('dims')) {
    const n = text('dims')!.split(/[,x;\s]+/).filter(Boolean).map((v) => Number(v.replace(',', '.')));
    if (n.length !== 3 || n.some((v) => !Number.isFinite(v) || v <= 0)) throw new Error('--dims needs three numbers in cm: width,depth,height');
    overrides.dims = { w: n[0]! / 100, d: n[1]! / 100, h: n[2]! / 100 };
  }
  const r = await importSavedPage({
    dir,
    file: fromUser(file),
    ...(text('photos-dir') ? { photosDir: fromUser(text('photos-dir')!) } : {}),
    overrides,
    ...(text('category') ? { category: text('category')! } : {}),
    force: flags.has('force'),
    dryRun: flags.has('dry'),
    log: (m) => console.log(m),
  });
  const rec = r.entry.record;
  const cm = (v: number) => Math.round(v * 1000) / 10;
  console.log(`${r.written ? (r.replaced ? 'updated' : 'added') : 'would add'} ${r.productId}  ${rec.name.slice(0, 80)}`);
  console.log(`  ${rec.price} ${rec.currency}${rec.priceTtc ? ' TTC' : ''}; ${cm(rec.dims.w)} x ${cm(rec.dims.d)} x ${cm(rec.dims.h)} cm (w x d x h, ${rec.dimsSource}); category ${rec.category}, mount ${rec.mount}; colours: ${rec.colours.join(', ') || '-'}; photo: ${r.photo ?? 'none'}; no 3D model (parametric stand-in)`);
  for (const f of r.entry.flags) console.log(`  note: ${f}`);
  if (r.written) console.log('Search it in the app, or place it by id. The CLIP image index is not rebuilt here (pnpm imagegen:index later).');
  return 0;
}

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const dir = flags.get('out') ? fromUser(String(flags.get('out'))) : DEFAULT_DIR;
  const log = (m: string) => console.log(m);
  if (command === 'status') {
    console.log(formatStatus(await statusReport(dir)));
    return 0;
  }
  if (command === 'reclassify') {
    const r = await reclassifyCatalog(dir, { dryRun: flags.has('dry') });
    for (const c of r.changes) console.log(`  ${c.sku} ${c.name.slice(0, 50)}  [${c.typeName}]  ${c.from.category}/${c.from.mount} -> ${c.to.category}/${c.to.mount}`);
    console.log(`${flags.has('dry') ? 'would change' : 'changed'} ${r.changes.length} of ${r.total} entries (category and mount only)`);
    return 0;
  }
  if (command === 'refit') {
    const sku = flags.get('sku');
    const r = await refitCatalog(dir, { dryRun: flags.has('dry'), ...(typeof sku === 'string' ? { sku } : {}) });
    const cm = (d: { w: number; d: number; h: number }) => `${Math.round(d.w * 1000) / 10}x${Math.round(d.d * 1000) / 10}x${Math.round(d.h * 1000) / 10}`;
    for (const c of r.changes) console.log(`  ${c.sku} ${c.name.slice(0, 55)}  [${c.typeName}]  turn ${c.turn.from} -> ${c.turn.to}; dims (w x d x h cm) ${cm(c.dims.from)} -> ${cm(c.dims.to)}`);
    for (const k of r.skipped) console.log(`  skipped ${k.sku} ${k.name.slice(0, 45)}: ${k.reason}`);
    console.log(`${flags.has('dry') ? 'would change' : 'changed'} ${r.changes.length} of ${r.withModel} models (${r.total} entries); ${r.skipped.length} skipped`);
    return 0;
  }
  if (command === 'import-page') {
    if (flags.has('help') || positional.length !== 1) {
      console.log(IMPORT_HELP);
      return flags.has('help') ? 0 : 2;
    }
    return runImportPage(positional[0]!, flags, dir);
  }
  if (command !== 'build' || flags.has('help')) {
    console.log(['usage: pnpm catalog:build [--limit N] [--queries file] [--from-scene file] [--refresh-prices] [--per-query N] [--max-products N] [--no-photos] [--no-optimize] [--no-seeds] [--out dir]', '       pnpm catalog:reclassify [--dry] [--out dir]', '       pnpm catalog:refit [--dry] [--sku X] [--out dir]', '       pnpm catalog:import-page <page.html> [--photos-dir dir] [--url U] [--name N] [--price P] [--dims w,d,h] [--sku S] [--category C] [--dry] [--force] [--out dir]  (offline; --help for the steps)', '       pnpm catalog:status'].join('\n'));
    return command === 'help' || flags.has('help') ? 0 : 2;
  }

  let stopRequested = false;
  process.on('SIGINT', () => {
    if (stopRequested) process.exit(130);
    stopRequested = true;
    console.log('\nStopping after the product in hand (Ctrl-C again to quit now)...');
  });
  const { ctx, provider } = liveContext(log);
  await cleanTemp(dir);
  console.log(`Personal use only: the catalogue stays in ${dir} (gitignored). Polite requests: one at a time, 1.5 s apart.`);
  const t0 = Date.now();

  if (flags.has('refresh-prices')) {
    const limit = num(flags, 'limit');
    const r = await refreshPrices({ dir, ctx, ...(limit ? { limit } : {}), log, shouldStop: () => stopRequested });
    console.log(`refreshed ${r.checked} pages in ${Math.round((Date.now() - t0) / 1000)} s: ${r.changed.length} price change(s), ${r.discontinued.length} no longer sold, ${r.failed.length} failed`);
    for (const f of r.failed.slice(0, 10)) console.log(`  failed ${f.sku}: ${f.reason}`);
    return 0;
  }

  let queries = DEFAULT_QUERIES.slice();
  if (flags.has('queries')) queries = parseQueriesFile(readFileSync(fromUser(String(flags.get('queries'))), 'utf8'));
  const seeds = new Set<string>(flags.has('no-seeds') || flags.has('queries') ? [] : SEED_SKUS);
  if (flags.has('from-scene')) for (const s of skusFromScene(JSON.parse(readFileSync(fromUser(String(flags.get('from-scene'))), 'utf8')))) seeds.add(s);
  const limit = num(flags, 'limit');
  console.log(`${queries.length} queries, ${seeds.size} seed products, ${num(flags, 'per-query') ?? DEFAULTS.perQuery} per query, at most ${num(flags, 'max-products') ?? DEFAULTS.maxProducts} products${limit ? `, ${limit} page reads this run` : ''}.`);
  let fatal: unknown;
  const report = await buildCatalog({
    dir,
    provider,
    ctx,
    queries,
    seedSkus: [...seeds],
    ...(num(flags, 'per-query') ? { perQuery: num(flags, 'per-query')! } : {}),
    ...(num(flags, 'max-products') ? { maxProducts: num(flags, 'max-products')! } : {}),
    ...(num(flags, 'texture-max') ? { textureMax: num(flags, 'texture-max')! } : {}),
    ...(num(flags, 'max-age-days') ? { maxAgeDays: num(flags, 'max-age-days')! } : {}),
    ...(limit ? { limit } : {}),
    photos: !flags.has('no-photos'),
    optimize: !flags.has('no-optimize'),
    log,
    shouldStop: () => stopRequested,
  }).catch((e: unknown) => {
    fatal = e;
    return undefined;
  });
  const secs = Math.round((Date.now() - t0) / 1000);
  if (!report) {
    console.error(`\nBuild stopped: ${fatal instanceof Error ? fatal.message : String(fatal)} (progress was saved; run again later to resume)`);
    return 2;
  }
  console.log(`\nDone in ${secs} s${report.stopped ? ` (${report.stopped})` : ''}: ${report.pagesRead} pages, ${report.searches} searches; ${report.added} added, ${report.kept} already fresh, ${report.rejected} rejected.`);
  console.log(`Models: ${report.withModel} with 3D, ${report.withoutModel} without${report.dimsFromModel ? `; ${report.dimsFromModel} missing height(s) taken from the model` : ''}. Normalised ${report.models.count} GLBs: ${(report.models.bytesBefore / MB).toFixed(1)} -> ${(report.models.bytesAfter / MB).toFixed(1)} MB on disk; decoded in the browser ~${(report.models.decodedBefore / MB).toFixed(0)} -> ~${(report.models.decodedAfter / MB).toFixed(0)} MB; ${report.models.quarterTurns} quarter turn(s) baked.`);
  console.log(`Problems the build caught: ${report.problems.length}`);
  for (const p of report.problems.slice(0, 25)) console.log(`  ${p.sku} ${p.kind}: ${p.reason}`);
  console.log('\n' + formatStatus(await statusReport(dir)));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    },
  );
}
