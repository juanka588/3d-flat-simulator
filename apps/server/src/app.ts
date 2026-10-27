import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import {
  MAX_SCENE_BYTES,
  MarkSeenBody,
  PostCheckpointBody,
  PostViewBody,
  ProductId,
  ProductSearchParams,
  UndoToBody,
  loadSceneText,
  summarizeProduct,
  type ErrorResponse,
  type ProviderErrorCode,
} from '@flat/scene';
import type { ServerConfig } from './config';
import { localModelId, readLocalCatalog, readLocalModel } from './local-assets';
import { createDisabledRegistry } from './providers/registry';
import { ProviderError, type ProviderRegistry } from './providers/types';
import type { Outcome, SceneStore } from './store';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

type Env = { Bindings: { incoming?: { socket?: { remoteAddress?: string } } } };

export const err = (code: string, message: string, path = ''): ErrorResponse => ({ ok: false, errors: [{ code, path, message }] });

/** `Host` must be a loopback name or listed in `ALLOWED_HOSTS`: stops DNS-rebinding pages from reaching the API. */
export function hostAllowed(host: string | undefined, extra: readonly string[] = []): boolean {
  if (!host) return true; // HTTP/1.0 or in-process requests
  const name = (host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!).toLowerCase();
  return LOCAL_HOSTS.has(name) || extra.some((h) => h.toLowerCase() === name);
}

/** Browsers always send `Origin` on cross-site writes and WebSocket upgrades; absent = not a browser. */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  return origin === undefined || allowed.includes(origin);
}

function tokenOk(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Fixed one-second window per client. */
function rateLimiter(perSec: number) {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.windowStart >= 1000) {
      if (hits.size > 1000) hits.clear();
      hits.set(key, { windowStart: now, count: 1 });
      return true;
    }
    return ++h.count <= perSec;
  };
}

/** HTTP status of each provider failure. */
const PROVIDER_STATUS: Record<ProviderErrorCode, ContentfulStatusCode> = {
  unknown_provider: 404,
  provider_disabled: 409,
  provider_unavailable: 503,
  provider_blocked: 502,
  provider_rate_limited: 429,
  provider_parse_failed: 502,
  product_not_found: 404,
  product_not_seen: 409,
  product_dims_missing: 422,
  model_unavailable: 404,
  url_not_allowed: 422,
  robots_disallowed: 422,
};

/** Routes that reach retailers or serve their data: read access also needs an allowed `Origin` (not only writes). */
const PRODUCT_PATH = /^\/api\/(providers|products|assets\/products|assets\/meshes)(\/|$)/;

export interface AppOptions {
  /** Applied to everything the server logs and to provider error messages (credential redaction). */
  redact?: (text: string) => string;
}

/** `Sec-Fetch-Site` values of a request the user's own browser made by navigating or typing (no page of another origin involved). */
const FIRST_PARTY_FETCH_SITE = new Set(['same-origin', 'none']);

/**
 * Product / asset routes are not for other web pages, including pages on other localhost ports (`same-site`):
 * a request that carries `Origin` must come from an allowed one; one without `Origin` (a navigation, an `<img>`,
 * curl, the MCP) must not be flagged by the browser as cross-site or same-site. Fetch with CORS from an allowed origin.
 */
export function foreignProductRequest(origin: string | undefined, fetchSite: string | undefined, allowed: readonly string[]): boolean {
  if (origin !== undefined) return !originAllowed(origin, allowed);
  return fetchSite !== undefined && !FIRST_PARTY_FETCH_SITE.has(fetchSite);
}

export function createApp(store: SceneStore, config: ServerConfig, providers: ProviderRegistry = createDisabledRegistry(), options: AppOptions = {}) {
  const app = new Hono<Env>();
  const redact = options.redact ?? ((t: string) => t);
  const allow = rateLimiter(config.rateLimitPerSec);
  const allowView = rateLimiter(config.viewRatePerSec);

  app.use('*', async (c, next) => {
    if (!hostAllowed(c.req.header('host'), config.allowedHosts)) return c.json(err('forbidden', 'host not allowed'), 403);
    await next();
  });
  app.use(
    '/api/*',
    cors({
      origin: (origin) => (config.allowedOrigins.includes(origin) ? origin : null),
      allowHeaders: ['Content-Type', 'Authorization', 'X-Flat-Client'],
      allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
      maxAge: 600,
    }),
  );
  app.use('/api/*', async (c, next) => {
    if (!WRITE_METHODS.has(c.req.method)) return next();
    if (!originAllowed(c.req.header('origin'), config.allowedOrigins)) return c.json(err('forbidden', 'origin not allowed'), 403);
    if (config.token && !tokenOk(c.req.header('authorization'), config.token)) {
      return c.json(err('unauthorized', 'missing or invalid bearer token'), 401);
    }
    const client = `${c.env?.incoming?.socket?.remoteAddress ?? 'local'}|${c.req.header('origin') ?? ''}`;
    if (!allow(client)) return c.json(err('rate_limited', 'too many requests'), 429);
    return next();
  });
  // Provider routes (reads too): retailer traffic and retailer data must not be triggerable or readable by a foreign page.
  app.use('/api/*', async (c, next) => {
    if (!PRODUCT_PATH.test(c.req.path)) return next();
    if (foreignProductRequest(c.req.header('origin'), c.req.header('sec-fetch-site'), config.allowedOrigins)) return c.json(err('forbidden', 'origin not allowed'), 403);
    await next();
    c.header('Cache-Control', 'no-store');
  });
  const limit = (maxSize: number) =>
    bodyLimit({ maxSize, onError: (c) => c.json(err('payload_too_large', `body exceeds ${maxSize} bytes`), 413) });

  /** Reads the body as JSON; `undefined` = malformed (caller answers 400). */
  async function readJson(c: Context<Env>, emptyOk = false): Promise<unknown | undefined> {
    const text = await c.req.text();
    if (emptyOk && text.trim() === '') return {};
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  const send = (c: Context<Env>, o: Outcome) => c.json(o.body, o.status);
  const malformed = (c: Context<Env>) => c.json(err('malformed_json', 'request body is not valid JSON'), 400);

  app.get('/healthz', (c) => c.json({ ok: true, epoch: store.epoch, rev: store.rev }));
  app.get('/api/scene', (c) => c.json(store.sceneResponse()));
  app.get('/api/history', (c) => c.json(store.historyView()));
  app.get('/api/log', (c) => {
    const raw = c.req.query('since') ?? '0';
    const since = Number(raw);
    if (!Number.isInteger(since) || since < 0) return c.json(err('invalid_command', 'since must be a non-negative integer', 'since'), 400);
    return c.json(store.logSince(since));
  });
  app.get('/api/checkpoints', (c) => c.json(store.checkpointsView()));
  app.get('/api/materials', async (c) => {
    try {
      return c.body(await readFile(config.materialsFile, 'utf8'), 200, { 'Content-Type': 'application/json; charset=utf-8' });
    } catch {
      return c.json(err('not_found', 'material catalog not available'), 404);
    }
  });

  // `author.kind` (user / llm / planner) is taken from the body: it selects the guards (locked items, structural
  // walls, "LLM items must reference a product"). That is a convention between cooperating clients, not
  // authentication. With FLAT_TOKEN set EVERY write (user or not) needs the bearer token, so a non-user author
  // cannot be claimed or dropped without it; with FLAT_TOKEN unset (loopback default) any local process may
  // claim any kind, which is accepted for a single-user local tool (documented in apps/server/README.md).
  app.post('/api/commands', limit(config.bodyLimit), async (c) => {
    const body = await readJson(c);
    if (body === undefined) return malformed(c);
    return send(c, await store.applyEnvelope(body));
  });

  for (const kind of ['undo', 'redo'] as const) {
    app.post(`/api/${kind}`, limit(config.bodyLimit), async (c) => {
      const body = await readJson(c, true);
      if (body === undefined) return malformed(c);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return c.json(err('invalid_command', 'body must be an object'), 422);
      const b = body as { id?: unknown; author?: unknown; ifRev?: unknown };
      const author = b.author as { kind?: string } | undefined;
      const authorOk = author === undefined || (typeof author === 'object' && ['user', 'llm', 'planner'].includes(author.kind ?? ''));
      if ((b.id !== undefined && (typeof b.id !== 'string' || b.id.length < 1 || b.id.length > 64)) || !authorOk || (b.ifRev !== undefined && !Number.isInteger(b.ifRev))) {
        return c.json(err('invalid_command', 'expected { id?: string, author?: { kind, name? }, ifRev?: integer }'), 422);
      }
      return send(c, await store[kind](b as Parameters<typeof store.undo>[0]));
    });
  }

  const invalid = (c: Context<Env>, e: { issues: { path: PropertyKey[]; message: string }[] }) =>
    c.json({ ok: false, errors: e.issues.map((i) => ({ code: 'invalid_command', path: i.path.join('.'), message: i.message })) } satisfies ErrorResponse, 422);

  app.post('/api/checkpoints', limit(config.bodyLimit), async (c) => {
    const raw = await readJson(c);
    if (raw === undefined) return malformed(c);
    const body = PostCheckpointBody.safeParse(raw);
    if (!body.success) return invalid(c, body.error);
    return send(c, await store.createCheckpoint(body.data));
  });

  app.post('/api/undo-to', limit(config.bodyLimit), async (c) => {
    const raw = await readJson(c);
    if (raw === undefined) return malformed(c);
    const body = UndoToBody.safeParse(raw);
    if (!body.success) return invalid(c, body.error);
    return send(c, await store.undoTo(body.data));
  });

  app.post('/api/view', limit(config.bodyLimit), async (c) => {
    const client = `${c.env?.incoming?.socket?.remoteAddress ?? 'local'}|${c.req.header('origin') ?? ''}`;
    if (!allowView(client)) return c.json(err('rate_limited', 'too many view updates'), 429);
    const raw = await readJson(c);
    if (raw === undefined) return malformed(c);
    const body = PostViewBody.safeParse(raw);
    if (!body.success) return invalid(c, body.error);
    // Zod fills LightingView defaults for absent keys even under .partial(): relay only the keys the
    // caller sent, otherwise a time-only update would reset the tab's lamps, exposure and sun toggle.
    const sent = (raw as { lighting?: Record<string, unknown> }).lighting;
    const view =
      body.data.lighting && sent
        ? {
            ...body.data,
            lighting: Object.fromEntries(Object.entries(body.data.lighting).filter(([k]) => Object.hasOwn(sent, k))),
          }
        : body.data;
    return c.json({ ok: true as const, delivered: store.relayView(view, c.req.header('x-flat-client') || undefined) });
  });

  app.put('/api/scene', limit(MAX_SCENE_BYTES), async (c) => {
    const text = await c.req.text();
    let syntaxOk = true;
    try {
      JSON.parse(text);
    } catch {
      syntaxOk = false;
    }
    const loaded = loadSceneText(text);
    if (!loaded.ok) {
      const errors = loaded.errors.map((message) => {
        const m = /^([\w.[\]/-]+): (.*)$/s.exec(message);
        return { code: syntaxOk ? 'scene_invalid' : 'malformed_json', path: m?.[1] ?? '', message: m?.[2] ?? message };
      });
      return c.json({ ok: false, errors } satisfies ErrorResponse, syntaxOk ? 422 : 400);
    }
    const { epoch, rev } = await store.importScene(loaded.scene);
    return c.json({ ok: true, epoch, rev, warnings: loaded.warnings });
  });


  // ---- M5 products (providers live in this server; nothing is persisted, nothing is served from Pages) ----
  const providerFailure = (c: Context<Env>, e: unknown) => {
    if (!(e instanceof ProviderError)) throw e;
    config.log('warn', redact(`provider error ${e.code}: ${e.message}`));
    const status = PROVIDER_STATUS[e.code];
    if (e.retryAt !== undefined) c.header('Retry-After', String(Math.max(1, Math.ceil((e.retryAt - Date.now()) / 1000))));
    return c.json(
      {
        ok: false as const,
        errors: [{ code: e.code, path: '', message: redact(e.message), hint: redact(e.hint), ...(e.details ? { details: e.details } : {}), ...(e.retryAt !== undefined ? { retryAt: e.retryAt } : {}) }],
      },
      status,
    );
  };

  app.get('/api/providers', (c) => c.json({ providers: providers.info() }));

  app.get('/api/products/search', async (c) => {
    const parsed = ProductSearchParams.safeParse(c.req.query());
    if (!parsed.success) return invalid(c, parsed.error);
    const q = parsed.data;
    const maxDims = { ...(q.maxW !== undefined ? { w: q.maxW } : {}), ...(q.maxD !== undefined ? { d: q.maxD } : {}), ...(q.maxH !== undefined ? { h: q.maxH } : {}) };
    try {
      const r = await providers.search(q.q, {
        limit: q.limit,
        ...(q.provider !== undefined ? { providerId: q.provider } : {}),
        ...(q.category !== undefined ? { category: q.category } : {}),
        ...(q.minPrice !== undefined ? { minPrice: q.minPrice } : {}),
        ...(q.maxPrice !== undefined ? { maxPrice: q.maxPrice } : {}),
        ...(Object.keys(maxDims).length > 0 ? { maxDims } : {}),
      });
      return c.json({
        results: r.records.map(summarizeProduct),
        providers: r.statuses.map((s) => ({ provider: s.provider, ok: s.ok, ...(s.code ? { code: s.code } : {}), ...(s.message ? { message: s.message } : {}) })),
        truncated: r.truncated,
      });
    } catch (e) {
      return providerFailure(c, e);
    }
  });

  app.get('/api/products/seen', (c) => {
    const session = c.req.query('session') ?? '';
    const id = ProductId.safeParse(c.req.query('id'));
    if (session.length < 1 || session.length > 64 || !id.success) return c.json(err('invalid_command', 'expected ?session=<1-64 chars>&id=<provider:sku>'), 422);
    return c.json({ seen: providers.isSeen(session, id.data) });
  });

  app.post('/api/products/seen', limit(config.bodyLimit), async (c) => {
    const raw = await readJson(c);
    if (raw === undefined) return malformed(c);
    const body = MarkSeenBody.safeParse(raw);
    if (!body.success) return invalid(c, body.error);
    return c.json({ ok: true as const, seen: providers.markSeen(body.data.session, body.data.productIds) });
  });

  app.post('/api/products/resolve', limit(config.bodyLimit), async (c) => {
    const raw = await readJson(c);
    if (raw === undefined) return malformed(c);
    const url = (raw as { url?: unknown } | null)?.url;
    if (typeof url !== 'string' || url.length < 1 || url.length > 2048) return c.json(err('invalid_command', 'expected { url: string (at most 2048 characters) }', 'url'), 422);
    try {
      return c.json({ product: await providers.resolveUrl(url) });
    } catch (e) {
      return providerFailure(c, e);
    }
  });

  app.get('/api/products/:id', async (c) => {
    try {
      return c.json({ product: await providers.getProduct(c.req.param('id')) });
    } catch (e) {
      return providerFailure(c, e);
    }
  });

  app.get('/api/assets/products/:provider/:file{[^/]+\\.glb}', async (c) => {
    const file = c.req.param('file');
    try {
      const model = await providers.fetchModel(`${c.req.param('provider')}:${file.slice(0, -'.glb'.length)}`);
      return c.body(model.stream, 200, {
        'Content-Type': model.contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(model.size !== undefined ? { 'Content-Length': String(model.size) } : {}),
      });
    } catch (e) {
      return providerFailure(c, e);
    }
  });

  // Product photo proxy: the web never hotlinks a retailer image (that would send the retailer the user's IP,
  // Referer and browsing). Memory-cached 1 h, 2 MB cap, raster images only (sniffed, never SVG), polite fetch.
  // Reach it with fetch() from an allowed Origin (an <img src> from another localhost port is refused).
  app.get('/api/products/:id/photo', async (c) => {
    try {
      const photo = await providers.fetchPhoto(c.req.param('id'));
      return c.body(photo.data as Uint8Array<ArrayBuffer>, 200, {
        'Content-Type': photo.contentType,
        'Content-Length': String(photo.data.byteLength),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
    } catch (e) {
      return providerFailure(c, e);
    }
  });

  // Local 3D-FUTURE pack (research licence, this machine only). Catalog first so `catalog.json` is never read as an asset id.
  app.get('/api/assets/meshes/catalog.json', async (c) => c.json(await readLocalCatalog(config.localAssetsDir)));
  app.get('/api/assets/meshes/:file{[^/]+\\.glb}', async (c) => {
    const assetId = c.req.param('file').slice(0, -'.glb'.length);
    if (localModelId(assetId) === undefined) return c.json(err('not_found', 'no such mesh'), 404);
    const bytes = await readLocalModel(config.localAssetsDir, assetId);
    if (!bytes) return c.json(err('not_found', 'no such mesh'), 404);
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'model/gltf-binary',
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  app.notFound((c) => c.json(err('not_found', 'no such route'), 404));
  app.onError((e, c) => {
    config.log('error', redact(e.stack ?? String(e)));
    return c.json(err('internal_error', 'internal error'), 500);
  });
  return app;
}
