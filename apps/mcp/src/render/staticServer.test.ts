import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectBase, hasBuild, mimeOf, resolveSafe, startStaticServer, type StaticServer } from './staticServer';

describe('static server for apps/web/dist', () => {
  let root: string;
  let outside: string;
  let srv: StaticServer;

  beforeAll(async () => {
    const parent = mkdtempSync(join(tmpdir(), 'flat-static-'));
    root = join(parent, 'dist');
    outside = join(parent, 'secret.txt');
    mkdirSync(join(root, 'assets'), { recursive: true });
    mkdirSync(join(root, 'empty'));
    writeFileSync(outside, 'top secret');
    writeFileSync(join(root, 'index.html'), '<script type="module" src="/assets/app.js"></script>');
    writeFileSync(join(root, 'assets', 'app.js'), 'export {}');
    writeFileSync(join(root, 'assets', 'style.css'), 'a{}');
    writeFileSync(join(root, 'assets', 'tex.ktx2'), 'x');
    srv = await startStaticServer(root);
  });
  afterAll(async () => {
    await srv.close();
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  it('listens on loopback with an ephemeral port and the base path /', () => {
    expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(srv.base).toBe('/');
  });

  it('serves files with the right MIME types', async () => {
    const get = (p: string) => fetch(srv.url + p);
    expect((await get('')).headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect((await get('assets/app.js')).headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect((await get('assets/style.css')).headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect((await get('assets/tex.ktx2')).headers.get('content-type')).toBe('image/ktx2');
    expect(await (await get('assets/app.js')).text()).toBe('export {}');
  });

  it('has no directory listing and refuses traversal, encoded or not', async () => {
    const status = async (path: string) => (await fetch(srv.url.replace(/\/$/, '') + path)).status;
    expect(await status('/empty/')).toBe(404);
    expect(await status('/assets/')).toBe(404);
    expect(await status('/../secret.txt')).toBe(404);
    expect(await status('/assets/%2e%2e/%2e%2e/secret.txt')).toBe(404);
    expect(await status('/assets/..%2f..%2fsecret.txt')).toBe(404);
    expect(await status('/assets/%00')).toBe(404);
    expect(await status('/%5c..%5csecret.txt')).toBe(404);
    expect(await status('/nope.js')).toBe(404);
  });

  it('answers GET and HEAD only, and only for its own Host', async () => {
    expect((await fetch(srv.url, { method: 'POST', body: 'x' })).status).toBe(405);
    expect((await fetch(srv.url, { method: 'HEAD' })).status).toBe(200);
    const evil = await new Promise<number>((ok, bad) => {
      import('node:http').then(({ request }) => {
        const r = request({ host: '127.0.0.1', port: srv.port, path: '/', headers: { host: 'evil.example' } }, (res) => ok(res.statusCode ?? 0));
        r.on('error', bad);
        r.end();
      }, bad);
    });
    expect(evil).toBe(403);
  });

  it('resolveSafe stays below the root', () => {
    expect(resolveSafe(root, '/', '/assets/app.js')).toBe(join(root, 'assets', 'app.js'));
    expect(resolveSafe(root, '/', '/../secret.txt')).toBeUndefined();
    expect(resolveSafe(root, '/', '/assets/../../secret.txt')).toBeUndefined();
    expect(resolveSafe(root, '/', '/assets')).toBeUndefined();
  });

  it('reads a Pages base path from index.html and serves under it', async () => {
    const pages = mkdtempSync(join(tmpdir(), 'flat-pages-'));
    mkdirSync(join(pages, 'assets'));
    writeFileSync(join(pages, 'index.html'), '<script src="/3d-flat-simulator/assets/a.js"></script>');
    writeFileSync(join(pages, 'assets', 'a.js'), '1');
    try {
      expect(await detectBase(pages)).toBe('/3d-flat-simulator/');
      const s = await startStaticServer(pages);
      try {
        expect(s.url).toMatch(/\/3d-flat-simulator\/$/);
        expect((await fetch(s.url)).status).toBe(200);
        expect((await fetch(`${s.url}assets/a.js`)).status).toBe(200);
        expect((await fetch(`http://127.0.0.1:${s.port}/assets/a.js`)).status).toBe(404);
      } finally {
        await s.close();
      }
    } finally {
      rmSync(pages, { recursive: true, force: true });
    }
  });

  it('knows a build when it sees one', () => {
    expect(hasBuild(root)).toBe(true);
    expect(hasBuild(join(root, 'nope'))).toBe(false);
    expect(mimeOf('x.unknown')).toBe('application/octet-stream');
  });
});
