import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { MAX_SCENE_BYTES, loadSceneText, type ErrorResponse } from '@flat/scene';
import type { ServerConfig } from './config';
import type { Outcome, SceneStore } from './store';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

type Env = { Bindings: { incoming?: { socket?: { remoteAddress?: string } } } };

export const err = (code: string, message: string, path = ''): ErrorResponse => ({ ok: false, errors: [{ code, path, message }] });

/** `Host` must be a loopback name: stops DNS-rebinding pages from reaching the API. */
export function hostAllowed(host: string | undefined): boolean {
  if (!host) return true; // HTTP/1.0 or in-process requests
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
  return LOCAL_HOSTS.has(name.toLowerCase());
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

export function createApp(store: SceneStore, config: ServerConfig) {
  const app = new Hono<Env>();
  const allow = rateLimiter(config.rateLimitPerSec);

  app.use('*', async (c, next) => {
    if (!hostAllowed(c.req.header('host'))) return c.json(err('forbidden', 'host not allowed'), 403);
    await next();
  });
  app.use(
    '/api/*',
    cors({
      origin: (origin) => (config.allowedOrigins.includes(origin) ? origin : null),
      allowHeaders: ['Content-Type', 'Authorization'],
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
  app.get('/api/materials', async (c) => {
    try {
      return c.body(await readFile(config.materialsFile, 'utf8'), 200, { 'Content-Type': 'application/json; charset=utf-8' });
    } catch {
      return c.json(err('not_found', 'material catalog not available'), 404);
    }
  });

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

  app.notFound((c) => c.json(err('not_found', 'no such route'), 404));
  app.onError((e, c) => {
    config.log('error', e.stack ?? String(e));
    return c.json(err('internal_error', 'internal error'), 500);
  });
  return app;
}
