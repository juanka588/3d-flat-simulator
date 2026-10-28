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
 *   --max-products N     catalogue size cap (default 400)
 *   --max-age-days N     entries younger than this are fresh and skipped (default 30)
 *   --no-photos          do not download photos
 *   --texture-max N      longest texture side kept in the GLBs (default 1024)
 *   --no-optimize        keep textures and geometry as downloaded (fit checks still run)
 *   --out DIR            another catalogue folder
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
import { DEFAULT_QUERIES, SEED_SKUS, parseQueriesFile, skusFromScene } from './queries';
import { formatStatus, statusReport } from './status';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
export const DEFAULT_DIR = here('../../../local-assets/ikea-fr');

interface Args {
  command: string;
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}"`);
    const key = a.slice(2);
    const next = rest[i + 1];
    if (['refresh-prices', 'no-photos', 'no-optimize', 'no-seeds', 'help'].includes(key)) flags.set(key, true);
    else if (next === undefined || next.startsWith('--')) throw new Error(`--${key} needs a value`);
    else {
      flags.set(key, next);
      i++;
    }
  }
  return { command, flags };
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

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const dir = flags.get('out') ? fromUser(String(flags.get('out'))) : DEFAULT_DIR;
  const log = (m: string) => console.log(m);
  if (command === 'status') {
    console.log(formatStatus(await statusReport(dir)));
    return 0;
  }
  if (command !== 'build' || flags.has('help')) {
    console.log(['usage: pnpm catalog:build [--limit N] [--queries file] [--from-scene file] [--refresh-prices] [--per-query N] [--max-products N] [--no-photos] [--no-optimize] [--no-seeds] [--out dir]', '       pnpm catalog:status'].join('\n'));
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
