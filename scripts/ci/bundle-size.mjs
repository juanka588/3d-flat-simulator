/* global console, process */
// Bundle-size gate (M3.14): gzip the built JS and CSS in apps/web/dist/assets and compare them with the
// recorded baseline in bundle-baseline.json. The budget is per milestone: it allows `budgetBytes` of growth
// over the CURRENT milestone's recorded size; a milestone that deliberately grows records its new size
// with `--update` (and says why in the baseline's `notes`). Sizes are Node's default-level gzip of each
// file, i.e. what `vite build` prints as "gzip" (1 kB = 1000 B).
//
//   BASE_PATH=/3d-flat-simulator/ pnpm --filter @flat/web build && node scripts/ci/bundle-size.mjs [--update]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
export const baselinePath = join(here, 'bundle-baseline.json');
const defaultDir = resolve(here, '..', '..', 'apps/web/dist/assets');

/** Gzip bytes of all `.js` and of all `.css` files in a directory. */
export function measure(dir) {
  const out = { js: 0, css: 0 };
  for (const name of readdirSync(dir)) {
    const kind = name.endsWith('.js') ? 'js' : name.endsWith('.css') ? 'css' : null;
    if (kind) out[kind] += gzipSync(readFileSync(join(dir, name))).length;
  }
  return out;
}

/** Rows of `{ kind, baseline, current, growth, budget, ok }`. */
export function compare(baseline, current) {
  return ['js', 'css'].map((kind) => {
    const growth = current[kind] - baseline.baseline[kind];
    const budget = baseline.budgetBytes[kind];
    return { kind, baseline: baseline.baseline[kind], current: current[kind], growth, budget, ok: growth <= budget };
  });
}

const kb = (n) => `${(n / 1000).toFixed(2)} kB`;

function main() {
  const dir = process.argv.find((a) => a.startsWith('--dir='))?.slice(6) ?? defaultDir;
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const current = measure(dir);
  if (current.js === 0) {
    console.error(`no .js files in ${dir}: build first (BASE_PATH=/3d-flat-simulator/ pnpm --filter @flat/web build)`);
    process.exit(2);
  }
  if (process.argv.includes('--update')) {
    baseline.baseline = current;
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`bundle baseline for ${baseline.milestone} updated: js ${kb(current.js)}, css ${kb(current.css)}`);
    return;
  }
  let failed = false;
  console.log(`bundle size (gzip) vs ${baseline.milestone} baseline; budget is per milestone`);
  for (const row of compare(baseline, current)) {
    console.log(`  ${row.kind.padEnd(3)} ${kb(row.current)}  (baseline ${kb(row.baseline)}, ${row.growth >= 0 ? '+' : ''}${kb(row.growth)}, budget +${kb(row.budget)})  ${row.ok ? 'ok' : 'OVER BUDGET'}`);
    if (!row.ok) failed = true;
  }
  const prev = baseline.previous;
  if (prev) console.log(`  (${prev.milestone} was ${kb(prev.js)} by Vite's figure; see the notes in bundle-baseline.json)`);
  if (failed) {
    console.error('\\nBundle grew past its budget. Lazy-load the new code, or (if the growth is deliberate) re-record the baseline with `node scripts/ci/bundle-size.mjs --update` and explain it in bundle-baseline.json.');
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
