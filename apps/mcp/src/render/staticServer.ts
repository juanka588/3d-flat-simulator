import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';

/**
 * A tiny loopback static server for the built web app (`apps/web/dist`), used by the render service.
 * Safe by construction: it binds 127.0.0.1 on an ephemeral port, answers GET/HEAD only, serves regular
 * files below the root (never a directory listing, `..` and encoded separators are refused), and only
 * answers requests whose Host is the loopback address it listens on (DNS rebinding).
 *
 * The built app's asset URLs carry a base path (`/` for `BASE_PATH=/ pnpm --filter @flat/web build`,
 * `/3d-flat-simulator/` for the Pages build). The base is read from `index.html` so either build works.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.bin': 'application/octet-stream',
};

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** The base path the build was made for, from its `index.html` (`/` when it cannot be told). */
export async function detectBase(root: string): Promise<string> {
  try {
    const html = await readFile(join(root, 'index.html'), 'utf8');
    const m = /(?:src|href)="(\/(?:[^"]*\/)?)assets\//.exec(html);
    return m?.[1] ?? '/';
  } catch {
    return '/';
  }
}

/** True when `root` holds a built web app. */
export function hasBuild(root: string): boolean {
  try {
    return statSync(join(root, 'index.html')).isFile();
  } catch {
    return false;
  }
}

export interface StaticServer {
  /** `http://127.0.0.1:<port><base>` */
  url: string;
  port: number;
  base: string;
  close(): Promise<void>;
}

/**
 * Resolves a request path below `root`, or `undefined` when it is outside, malformed, or not a file.
 * Exported for tests.
 */
export function resolveSafe(root: string, base: string, rawPath: string): string | undefined {
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
  if (path.includes('\0') || path.includes('\\')) return undefined;
  if (!path.startsWith(base)) return undefined;
  const rel = path.slice(base.length);
  if (rel.split('/').some((s) => s === '..')) return undefined;
  const target = resolve(root, rel === '' || rel.endsWith('/') ? join(rel, 'index.html') : rel);
  const rootResolved = resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) return undefined;
  if (!existsSync(target)) return undefined;
  try {
    if (!statSync(target).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return target;
}

export async function startStaticServer(root: string): Promise<StaticServer> {
  const base = await detectBase(root);
  let port = 0;
  const server: Server = createServer((req, res) => {
    const fail = (status: number, text: string) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(text);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'method not allowed');
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return fail(403, 'forbidden host');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const file = resolveSafe(root, base, url.pathname);
    if (!file) return fail(404, 'not found');
    readFile(file).then(
      (body) => {
        res.writeHead(200, { 'content-type': mimeOf(file), 'content-length': body.length, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
        res.end(req.method === 'HEAD' ? undefined : body);
      },
      () => fail(404, 'not found'),
    );
  });
  await new Promise<void>((ok, bad) => {
    server.once('error', bad);
    server.listen(0, '127.0.0.1', () => ok());
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}${base}`,
    port,
    base,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
