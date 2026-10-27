/**
 * Live probe: `pnpm providers:probe ikea-fr [query]`. Makes a FEW polite real requests (robots.txt of each
 * host, one search, one product page, one model GET) and prints what the parser found. Not run in CI.
 * Stops on 403/429 (the circuit opens and the probe exits with code 2).
 */
import { MemoryCache } from './cache';
import { createNetwork } from './http';
import { createIkeaFrProvider, parseSearchResponse } from './ikea-fr';
import { ProviderError, type ProviderContext } from './types';

const SEARCH = 'https://sik.search.blue.cdtapps.com/fr/fr/search-result-page';

async function probeIkea(query: string) {
  const clock = { now: () => Date.now() };
  const net = createNetwork({ clock, log: (l, m) => console.error(`  [${l}] ${m}`) }).forProvider('ikea-fr');
  const cache = new MemoryCache({ clock });
  const scoped = cache.scope('ikea-fr');
  const ctx: ProviderContext = { fetch: net.fetch, cache: scoped, clock, log: (l, m) => console.error(`  [${l}] ${m}`) };
  const provider = createIkeaFrProvider();

  console.log(`1. search "${query}"`);
  const res = await ctx.fetch(`${SEARCH}?${new URLSearchParams({ q: query, size: '3', types: 'PRODUCT' })}`, { headers: { accept: 'application/json' } });
  console.log(`   HTTP ${res.status}`);
  const hits = parseSearchResponse(await res.json());
  for (const h of hits) console.log(`   ${h.sku}  ${h.name} ${h.typeName}  ${h.price} ${h.currency}  measure "${h.measureText}"  variants ${h.variants.length}`);
  const first = hits[0];
  if (!first) throw new Error('search returned no product');
  scoped.set(`hit:${first.sku}`, first, 600_000);

  console.log(`2. product page ${first.sku}`);
  const rec = await provider.get(first.sku, ctx);
  console.log(`   name   ${rec.name}`);
  console.log(`   price  ${rec.price} ${rec.currency} (TTC ${rec.priceTtc})`);
  console.log(`   dims   w ${rec.dims.w} d ${rec.dims.d} h ${rec.dims.h} m  (${rec.dimsSource})`);
  console.log(`   weight ${rec.weightKg ?? '-'} kg (${rec.weightKind ?? '-'})  category ${rec.category}  colours ${rec.colours.join(',') || '-'}`);
  console.log(`   model  ${rec.modelRef ?? 'none'}`);

  console.log('3. model GET');
  const m = await provider.fetchModel!(first.sku, ctx);
  const reader = m.stream.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const magic = new TextDecoder().decode((value ?? new Uint8Array()).slice(0, 4));
  console.log(`   ${m.contentType}, size ${m.size ?? 'unknown'} bytes, first bytes "${magic}"`);
  if (magic !== 'glTF') throw new Error('model does not start with glTF');
  console.log(`circuit: ${net.circuit().state}\nOK`);
}

const [target, ...rest] = process.argv.slice(2);
if (target !== 'ikea-fr') {
  console.error('usage: pnpm providers:probe ikea-fr [query]');
  process.exit(64);
}
probeIkea(rest.join(' ') || 'kallax').catch((e: unknown) => {
  if (e instanceof ProviderError) {
    console.error(`FAILED ${e.code}: ${e.message}\n  hint: ${e.hint}`);
    process.exit(e.code === 'provider_blocked' ? 2 : 1);
  }
  console.error(e);
  process.exit(1);
});
