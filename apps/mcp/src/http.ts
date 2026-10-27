import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { McpConfig } from './config';
import type { FlatApi } from './flatApi';
import { SERVER_NAME, SERVER_VERSION, createFlatMcpServer } from './server';
import { newSession, systemClock, type Clock, type Renderer } from './tools';

/**
 * Streamable HTTP transport (M4.2): `POST /mcp` (stateless: a fresh MCP server per request, serving
 * 2025-era and 2026-07-28 clients), `GET /healthz`. Guards, in order: Host header (DNS rebinding),
 * Origin header, then the bearer token when `FLAT_TOKEN` is set. Violations answer 403 / 401 and never
 * reach the tools. The process refuses to bind to a non-loopback host without a token.
 *
 * Statelessness and the session: tool state that must outlive one request (the `set_sun_time`
 * lighting, rate limits, the write cap) lives in ONE session shared by every request of the process,
 * so it is the state of "the connected assistant" rather than of one HTTP call. Run one `--http`
 * process per assistant if you need them separated.
 */

export const DEFAULT_HTTP_PORT = 8788;
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
  const session = newSession(config.limits, clock);
  const bound = ['0.0.0.0', '::', ''].includes(host) ? [] : [host.includes(':') && !host.startsWith('[') ? `[${host}]` : host];
  const allowed = [...new Set([...LOOPBACK_NAMES, ...bound, ...(opts.allowedHosts ?? [])])];
  const checkHost = hostHeaderValidation(allowed);
  const checkOrigin = originValidation(allowed);

  const handler = createMcpHandler(() => createFlatMcpServer({ config, flat, clock, session, ...(opts.renderer ? { renderer: opts.renderer } : {}) }), {
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
