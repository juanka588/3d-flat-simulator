# Product providers (authoring guide)

A provider turns one source of real products (a retailer's site, a feed, a fixture file) into `ProductRecord`s for the flat simulator. Providers live here, in `apps/server`, and nowhere else: the web app, the Pages build and the MCP server never import this folder. Everything a provider returns stays on the user's machine.

Why it is strict: the assistant may only place products that exist (D9 of `docs/backlog/m5.md`), the retailer must not be hammered, and retailer data and 3D models are for the user's private use (see "Products and personal-use providers" in the root README).

## The interface (`types.ts`)

```ts
interface ProductProvider {
  readonly id: string;                      // slug used in product ids: "ikea-fr" -> productId "ikea-fr:80275887"
  readonly label: string;
  readonly capabilities: ProviderCapabilities; // { search, model3d, dims: 'structured' | 'text' | 'none', resolveUrl }
  readonly personalUseOnly: boolean;        // true = terms restrict use to private local viewing (banner, caption)
  readonly note?: string;                   // shown in list_providers and the UI
  search(query, opts: SearchOptions, ctx): Promise<ProductRecord[]>;   // best first, at most opts.limit
  get(sku, ctx): Promise<ProductRecord>;                               // throws product_not_found
  resolveUrl?(url, ctx): Promise<ProductRecord>;                       // only when capabilities.resolveUrl
  fetchModel?(sku, ctx): Promise<ModelStream>;                         // only when capabilities.model3d; GLB bytes via GET
}
```

Rules for the records you return (they are validated by the `ProductRecord` schema, and a provider that returns an invalid record is a bug):

- `price` is the **TTC** (tax included) shelf price in the product currency, `priceTtc: true`. Never invent a price: no price means the product is not returned.
- `dims` are the **assembled** outer dimensions in metres (w = item x, d = item z, h), not the package. Say where they came from in `dimsSource` (`structured` = a field of the page, `text` = parsed from a description such as "77x147 cm"). If a pasted page has no usable size, throw `product_dims_missing` with `details: { knownDims }` so the UI can ask the user for the rest.
- `category` comes from `category.ts` (shared mapping of retailer type names to our categories); `mount` is `floor`, `wall` or `ceiling`.
- `weightKg` is optional; set `weightKind: 'package' | 'item'` when you know it (wall mounts over 15 kg need a structural wall).
- `modelRef` is whatever `fetchModel` needs to find the GLB; it never leaves the server (the model facts the assistant sees are only `has3d`).
- No photo is ever stored in a scene. `photoUrl` is only for the local UI card.

Failures are `ProviderError(code, message, { hint?, retryAt?, details? })` with a code of `PROVIDER_ERROR_CODES` (`packages/scene/src/products.ts`): `product_not_found`, `provider_parse_failed` (the page changed), `provider_blocked` (403, bot protection), `provider_rate_limited`, `provider_unavailable`, `model_unavailable`, `url_not_allowed`, `robots_disallowed`, `product_dims_missing`. The framework maps them to HTTP statuses and MCP errors, and each has a default hint for the model (`PROVIDER_ERROR_HINTS`).

## Politeness: use `ctx.fetch`, nothing else

`ProviderContext.fetch` is the only way to reach the network. It is wrapped by `http.ts` (`createNetwork`), which gives you, for free and without a way around them:

- an honest `User-Agent` (`3d-flat-simulator/0.1 (personal local design tool; one user, GET only, no bulk)`);
- GET only (some CDNs block HEAD, so models are fetched with GET too);
- one request at a time per host and a **1.5 s gap** between two requests to it (two providers on one host share the budget);
- `robots.txt` honoured (cached 24 h, RFC 9309 matcher in `robots.ts`; a disallowed path is `robots_disallowed`);
- a 10 s timeout per request, at most 3 redirects, 2 retries with jittered backoff on 5xx and network errors;
- a **circuit breaker**: three consecutive failures, or one 403/429, opens the circuit (1 min for failures, 5 min for 429, 30 min for a block). While it is open every call fails fast with `provider_unavailable`/`provider_blocked` and `retryAt`. `scope: 'provider'` pauses the whole provider (IKEA), `'host'` only the offending site (pasted-url, which can be pointed at many sites).

Consequences for your code: keep the number of requests per user action small (a search that reads one product page per hit is slow: a live IKEA search of 5 results takes about 10 s, which is why the MCP gives provider calls 45 s), never loop over a catalogue, and do not add a second HTTP client. Credentials (feed URLs, tokens) come from `process.env` / `apps/server/.env.local` through `secrets.ts`, never from code, and the logger redacts them.

URLs that come from users or from pages must be checked with `ssrf.ts` (public IPv4/IPv6 only, every DNS answer checked) before they are fetched; `pasted-url` shows how.

## Cache

`ctx.cache` is a memory-only LRU + TTL cache scoped to your provider (`cache.ts`; nothing is written to disk): search results 10 min, products 1 h, GLBs 1 h; 200 MB in total, 20 MB per entry (a bigger model is streamed but not kept). The registry caches `get`, `search` and `fetchModel` results for you; use `ctx.cache` for things of your own (for example the search hit that a later `get` needs: `cache.set('hit:<sku>', hit, TTL)`). `MemoryCache.flight(key, ttlMs, load)` is single-flight, so concurrent callers share one upstream request. The clock is injected (`ctx.clock`), never `Date.now()`, so tests do not sleep.

## Wiring a provider in

1. `apps/server/src/providers/<id>.ts` exporting `create<Name>Provider(): ProductProvider`.
2. `catalog.ts`: add its `ProviderMeta` (id, label, capabilities, personalUseOnly, note). It is static data so a disabled provider can be listed and explained without loading its code; a test checks it equals what the loaded provider declares.
3. `registry.ts`: add a lazy loader `'<id>': async () => (await import('./<id>')).create<Name>Provider()`. Never import a provider module statically: `registry.test.ts` fails if you do, and with `FLAT_PROVIDERS` empty no provider code is loaded.
4. `HOST_SCOPED` in `registry.ts` if the circuit should be per site.
5. Document the id next to `FLAT_PROVIDERS` in the README, and add any retailer host to `scripts/ci/retailer-hosts.json` so the CI guard keeps it out of the Pages build and the repository (the provider source, its tests and the docs are in `allowPaths`; examples elsewhere must not carry a retailer URL).

## Fixtures and tests (no network, no real time)

The fast tier never touches a retailer. Record the responses once, commit them under `__fixtures__/<id>/` (search JSON, a product page HTML, a challenge page for the blocked case), and test against them:

```ts
import { fakeClock, fakeFetch, fixture, json, text, testContext, tinyGlb } from './testkit';
// routes are matched in order: an exact URL, a "prefix*", or a RegExp. Unmatched URLs answer 599 and are listed in `unmatched`.
const { ctx, clock, fetch: net, logs } = testContext([[SEARCH, json(searchJson)], [/\/p\//, text(PAGE)]], { id: 'my-provider' });
const rec = await createMyProvider().get('80275887', ctx);   // net.calls: every request with its URL, headers and fake time
```

`testkit.ts` has the fake clock (its `sleep` advances time, so the 1.5 s gaps cost nothing), `fakeFetch` with canned routes and a call log (assert the User-Agent, the gap between calls, GET only), `tinyGlb()` (a valid minimal GLB for model streaming) and helpers `json`, `text`, `status`, `hang`, `collect`. Follow `ikea-fr.test.ts`: parse functions are tested on the recorded fixtures (`ProductRecord.safeParse(rec).success`, assembled dims not package dims, TTC price), then the provider end to end with the fake network, then the failure modes (403 opens the circuit, a changed page is `provider_parse_failed`, a missing model is `model_unavailable`, robots disallow). `framework.test.ts` covers the shared layer (gap, backoff, breaker, cache caps, robots) so a provider test does not have to.

Prefer small recorded fixtures with the fields you parse over full pages (a page can be 500 kB), and scrub anything personal (cookies, session ids) before committing. Do not commit retailer photos or models; the fixtures hold text and numbers only.

## The live probe

`npx pnpm@10 providers:probe ikea-fr "lit 160"` (`probe.ts`) is the only place that talks to the real site. It makes a handful of polite requests through the same network layer (robots.txt, one search, one product page, one model GET), prints what the parser found (name, TTC price, assembled dims, weight, model reference, the size and first bytes of the GLB) and stops with exit code 2 when the circuit opens (403/429). Run it by hand after a parser change and nightly in CI (it is not part of `pnpm check`); when it fails, re-record the fixtures from the new response, fix the parser, and keep the old fixture as a regression case if the old format may come back. Add a `probe<Name>` function and a branch in `probe.ts` for a new provider.

## Local-only checklist

- [ ] No import of the provider from `apps/web`, `packages/scene` or `apps/mcp` (the MCP server talks to the scene server's REST API, never to a provider).
- [ ] Records carry text and numbers only; no photo or model bytes in a scene, a log or a fixture.
- [ ] `personalUseOnly: true` when the terms restrict use; `note` says so in a sentence.
- [ ] Nothing is cached on disk and nothing is served from Pages.
- [ ] `node scripts/ci/check-no-retailer.mjs --worktree` is clean.
