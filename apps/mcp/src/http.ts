import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { McpConfig } from './config';
import type { FlatApi } from './flatApi';
import { SERVER_NAME, SERVER_VERSION, createFlatMcpServer } from './server';
import { newSession, systemClock, type Clock, type McpSession, type Renderer } from './tools';

/**
 * Streamable HTTP transport (M4.2): `POST /mcp` (stateless: a fresh MCP server per request, serving
 * 2025-era and 2026-07-28 clients), `GET /healthz`. Guards, in order: Host header (DNS rebinding),
 * Origin header, then the bearer token when `FLAT_TOKEN` is set. Violations answer 403 / 401 and never
 * reach the tools. The process refuses to bind to a non-loopback host without a token.
 *
 * Statelessness and sessions: the transport keeps no connection state, but tool state that must
 * outlive one request (the `set_sun_time` lighting and lamp mode, rate limits, the write cap, the
 * author name) lives in a session keyed by CLIENT: the `Mcp-Session-Id` header when the client sends
 * one, else the product token of its `User-Agent` (`claude-code/2.1` -> `claude-code`), else one
 * shared `anonymous` session. So two different assistants on one endpoint do not share lighting,
 * allowance or author, and a request without client info is never attributed to the previous
 * client. Two clients with the same User-Agent and no session id still share a session: give them
 * `Mcp-Session-Id`s, or run one `--http` process each. A session lives as long as the process (at
 * most `MAX_SESSIONS` are kept, least recently used first), so the write cap does not reset on
 * reconnect: restart `--http` or raise FLAT_MCP_SESSION_WRITES.
 */

export const DEFAULT_HTTP_PORT = 8788;
const MAX_SESSIONS = 64;

/** The key a request's session is filed under (see the file comment). Pure; exported for tests. */
export function sessionKeyOf(headers: { get(name: string): string | null } | undefined): string {
  const id = headers?.get('mcp-session-id')?.trim();
  if (id) return `id:${id.slice(0, 128)}`;
  const product = /^[\w.-]{1,60}/.exec(headers?.get('user-agent') ?? '')?.[0];
  return product ? `ua:${product}` : 'anonymous';
}
export const DEFAULT_HTTP_HOST = '127.0.0.1';
const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];

/** True for `localhost`, `127.x.x.x` and `::1`. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Throws unless the host is loopback or a token protects the endpoint. */
export function assertSafeBind(host: string, token: string | undefined): void {
  if (!isLoopbackHost(host) && !token) {
    throw new Error(`refusing to bind the MCP HTTP server to non-loopback host "${host}" without a token; set FLAT_TOKEN or use 127.0.0.1`);
  }
}

/** Constant-time comparison of the presented bearer token with the expected one. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  const digest = (s: string) => createHash('sha256').update(s).digest();
  const given = digest(m?.[1]?.trim() ?? '');
  return timingSafeEqual(given, digest(token)) && m !== null;
}

export interface HttpOptions {
  config: McpConfig;
  flat: FlatApi;
  host?: string;
  /** 0 picks a free port (tests). */
  port?: number;
  clock?: Clock;
  renderer?: Renderer;
  /** Extra Host / Origin hostnames to accept besides loopback (needed behind a proxy or on a LAN address). */
  allowedHosts?: string[];
}

export interface RunningHttp {
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export async function startHttp(opts: HttpOptions): Promise<RunningHttp> {
  const { config, flat } = opts;
  const host = opts.host ?? DEFAULT_HTTP_HOST;
  assertSafeBind(host, config.token);
  const clock = opts.clock ?? systemClock();
  const sessions = new Map<string, McpSession>();
  const sessionFor = (headers: { get(name: string): string | null } | undefined): McpSession => {
    const key = sessionKeyOf(headers);
    let s = sessions.get(key);
    if (s) sessions.delete(key); // re-insert: most recently used last
    else {
      s = newSession(config.limits, clock, 'http');
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    }
    sessions.set(key, s);
    return s;
  };
  const bound = ['0.0.0.0', '::', ''].includes(host) ? [] : [host.includes(':') && !host.startsWith('[') ? `[${host}]` : host];
  const allowed = [...new Set([...LOOPBACK_NAMES, ...bound, ...(opts.allowedHosts ?? [])])];
  const checkHost = hostHeaderValidation(allowed);
  const checkOrigin = originValidation(allowed);

  const handler = createMcpHandler((rc) => createFlatMcpServer({ config, flat, clock, session: sessionFor(rc?.requestInfo?.headers), stickyClientName: false, ...(opts.renderer ? { renderer: opts.renderer } : {}) }), {
    legacy: 'stateless',
    responseMode: 'json',
    onerror: (e) => config.log('error', `http: ${e.message}`),
  });
  const node = toNodeHandler(handler, { onerror: (e) => config.log('error', `http adapter: ${e.message}`) });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        if (!checkHost(req, res)) return;
        if (!checkOrigin(req, res)) return;
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (path === '/healthz') {
          if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { ok: false, message: 'GET only' }, { allow: 'GET, HEAD' });
          return send(res, 200, { ok: true, name: SERVER_NAME, version: SERVER_VERSION, readOnly: config.readOnly });
        }
        if (path !== '/mcp') return send(res, 404, { ok: false, message: 'not found; the MCP endpoint is /mcp' });
        if (config.token && !bearerMatches(req.headers.authorization, config.token)) {
          return send(res, 401, { ok: false, message: 'missing or invalid bearer token (FLAT_TOKEN)' }, { 'www-authenticate': 'Bearer realm="flat-mcp"' });
        }
        await node(req, res);
      } catch (e) {
        config.log('error', `http request failed: ${e instanceof Error ? e.message : String(e)}`);
        if (!res.headersSent) send(res, 500, { ok: false, message: 'internal error' });
        else res.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? DEFAULT_HTTP_PORT, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return {
    url: `http://${urlHost}:${addr.port}/mcp`,
    host,
    port: addr.port,
    async close() {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
