import { request } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from './cli';
import { loadConfig } from './config';
import { assertSafeBind, bearerMatches, isLoopbackHost, sessionKeyOf, startHttp, type RunningHttp } from './http';
import { connect, json, realCatalog } from './testing/inproc';
import { MockFlatApi } from './testing/mockFlatApi';

let running: RunningHttp | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function serve(over: Parameters<typeof loadConfig>[1] = {}, flat = new MockFlatApi({ materials: realCatalog }), opts: { host?: string; allowedHosts?: string[] } = {}) {
  const config = loadConfig({}, { log: () => {}, ...over });
  running = await startHttp({ config, flat, port: 0, ...opts });
  return { http: running, flat, base: `http://127.0.0.1:${running.port}` };
}

async function mcpClient(url: string, headers: Record<string, string> = {}, name = 'http-client') {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

/** A raw request with full control of the Host header (fetch will not let you set it). */
function raw(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/healthz', headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

describe('streamable HTTP (M4.2)', () => {
  it('serves GET /healthz', async () => {
    const { base } = await serve();
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, name: 'flat' });
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(405);
  });

  it('lists exactly the tools stdio lists (names, descriptions, annotations, schemas)', async () => {
    const { http } = await serve();
    const over = await mcpClient(http.url);
    const inproc = await connect();
    const strip = (tools: { name: string; description?: string; annotations?: unknown; inputSchema: unknown }[]) => tools.map((t) => ({ name: t.name, description: t.description, annotations: t.annotations, inputSchema: t.inputSchema }));
    expect(strip((await over.listTools()).tools)).toEqual(strip((await inproc.client.listTools()).tools));
    expect((await over.listTools()).tools.length).toBe(41);
    expect((await over.listPrompts()).prompts.map((p) => p.name)).toEqual(['apply_style', 'furnish_room', 'design_flat_in_style', 'design_flat_team', 'room_specialist', 'list_styles']);
    expect((await over.listResources()).resources.filter((r) => !r.uri.startsWith('styles://'))).toHaveLength(5);
    await over.close();
  });

  it('runs tools: reads, a write authored by the client, and a preview', async () => {
    const { http, flat } = await serve();
    const client = await mcpClient(http.url, {}, 'curl-agent');
    expect(json(await client.callTool({ name: 'get_scene_summary', arguments: {} })).counts.rooms).toBe(8);
    const w = json(await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak', label: 'oak' } }));
    expect(w).toMatchObject({ ok: true, committed: true, rev: 1 });
    expect(flat.log[0]!.envelope.author.kind).toBe('llm');
    const p = json(await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-tile', preview: true } }));
    expect(p.committed).toBe(false);
    expect(flat.rev).toBe(1);
    await client.close();
  });

  it('is stateless but the lighting and the limits are shared by the requests of one client (same User-Agent)', async () => {
    const { http } = await serve({ limits: { maxBatch: 50, writesPerMinute: 2, rendersPerMinute: 10, maxArgBytes: 262144, sessionWriteCap: 500, searchesPerMinute: 20, productGetsPerMinute: 60 } });
    const a = await mcpClient(http.url);
    await a.callTool({ name: 'set_sun_time', arguments: { date: '2026-12-21' } });
    await a.close();
    const b = await mcpClient(http.url);
    expect(json(await b.callTool({ name: 'describe_room', arguments: { roomId: 'sejour' } })).daylight.date).toBe('2026-12-21');
    await b.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-tile' } });
    await b.close();
    const c = await mcpClient(http.url);
    await c.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak' } });
    expect(json(await c.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-deck' } })).code).toBe('rate_limited');
    await c.close();
  });

  describe('sessions are per client, not per process', () => {
    const call = (port: number, headers: Record<string, string>, name: string, args: Record<string, unknown>, id = 7) =>
      raw(port, { method: 'POST', path: '/mcp', headers: { ...MCP_HEADERS, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
    const result = (r: { body: string }) => {
      const data = r.body.startsWith('{') ? r.body : r.body.split('\n').find((l) => l.startsWith('data:'))!.slice(5);
      const m = JSON.parse(data).result as { content: { text: string }[] };
      return JSON.parse(m.content[0]!.text);
    };

    it('sessionKeyOf: Mcp-Session-Id, else the User-Agent product, else anonymous', () => {
      const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
      expect(sessionKeyOf(h({ 'mcp-session-id': 'abc', 'user-agent': 'x/1' }))).toBe('id:abc');
      expect(sessionKeyOf(h({ 'user-agent': 'claude-code/2.1 (cli)' }))).toBe('ua:claude-code');
      expect(sessionKeyOf(h({}))).toBe('anonymous');
      expect(sessionKeyOf(undefined)).toBe('anonymous');
    });

    it('two clients do not share lighting, the allowance or the author name', async () => {
      const { http, flat } = await serve({ limits: { maxBatch: 50, writesPerMinute: 1, rendersPerMinute: 10, maxArgBytes: 262144, sessionWriteCap: 500, searchesPerMinute: 20, productGetsPerMinute: 60 } });
      const a = { 'user-agent': 'agent-a/1.0' };
      const b = { 'user-agent': 'agent-b/2.0' };
      await call(http.port, a, 'set_sun_time', { date: '2026-12-21' });
      expect(result(await call(http.port, a, 'describe_room', { roomId: 'sejour' })).daylight.date).toBe('2026-12-21');
      expect(result(await call(http.port, b, 'describe_room', { roomId: 'sejour' })).daylight.date).toBe('2026-06-21'); // B did not inherit A's date

      expect(result(await call(http.port, a, 'room_set_floor', { roomId: 'sejour', materialId: 'floor-oak' })).committed).toBe(true);
      expect(result(await call(http.port, a, 'room_set_floor', { roomId: 'sejour', materialId: 'floor-tile' })).code).toBe('rate_limited');
      // B still has its own allowance, and is named after itself
      expect(result(await call(http.port, b, 'room_set_floor', { roomId: 'sejour', materialId: 'floor-deck' })).committed).toBe(true);
      expect(flat.log.map((e) => e.envelope.author.name)).toEqual(['agent-a', 'agent-b']);
    });

    it('Mcp-Session-Id separates two clients with the same User-Agent', async () => {
      const { http } = await serve();
      const ua = { 'user-agent': 'same/1' };
      await call(http.port, { ...ua, 'mcp-session-id': 's1' }, 'set_sun_time', { date: '2026-12-21' });
      expect(result(await call(http.port, { ...ua, 'mcp-session-id': 's1' }, 'describe_room', { roomId: 'sejour' })).daylight.date).toBe('2026-12-21');
      expect(result(await call(http.port, { ...ua, 'mcp-session-id': 's2' }, 'describe_room', { roomId: 'sejour' })).daylight.date).toBe('2026-06-21');
    });

    it('a request that says nothing about itself is never attributed to the previous client', async () => {
      const { http, flat } = await serve();
      await call(http.port, { 'user-agent': 'agent-a/1.0' }, 'room_set_floor', { roomId: 'sejour', materialId: 'floor-oak' });
      // no User-Agent, no client info
      await call(http.port, {}, 'room_set_floor', { roomId: 'sejour', materialId: 'floor-tile' });
      expect(flat.log.map((e) => e.envelope.author.name)).toEqual(['agent-a', 'unknown']);
    });

    it('the write-cap hint does not tell an HTTP client to "reconnect"', async () => {
      const { http } = await serve({ limits: { maxBatch: 50, writesPerMinute: 30, rendersPerMinute: 10, maxArgBytes: 262144, sessionWriteCap: 1, searchesPerMinute: 20, productGetsPerMinute: 60 } });
      const h = { 'user-agent': 'agent-a/1.0' };
      await call(http.port, h, 'room_set_floor', { roomId: 'sejour', materialId: 'floor-oak' });
      const r = result(await call(http.port, h, 'room_set_floor', { roomId: 'sejour', materialId: 'floor-tile' }));
      expect(r.code).toBe('rate_limited');
      expect(r.hint).toMatch(/restart the MCP server/);
      expect(r.hint).toMatch(/not per connection/);
    });
  });

  it('names the author from the client info when the transport carries it, else the User-Agent', async () => {
    const { http, flat } = await serve();
    const r = await raw(http.port, {
      method: 'POST',
      path: '/mcp',
      headers: { ...MCP_HEADERS, 'user-agent': 'my-agent/3.1 (linux)' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak' } } }),
    });
    expect(r.status).toBe(200);
    expect(flat.log[0]!.envelope.author).toEqual({ kind: 'llm', name: 'my-agent' });
  });

  describe('Host and Origin validation', () => {
    it('403 for a foreign Host header (DNS rebinding)', async () => {
      const { http } = await serve();
      for (const path of ['/mcp', '/healthz']) {
        const r = await raw(http.port, { method: path === '/mcp' ? 'POST' : 'GET', path, headers: { ...MCP_HEADERS, host: 'evil.example.com' }, body: INIT });
        expect(r.status, path).toBe(403);
      }
    });

    it('accepts localhost, 127.0.0.1 and [::1] Host headers, with or without a port', async () => {
      const { http } = await serve();
      for (const host of ['localhost', `localhost:${http.port}`, '127.0.0.1', `127.0.0.1:${http.port}`, `[::1]:${http.port}`]) {
        expect((await raw(http.port, { headers: { host } })).status, host).toBe(200);
      }
    });

    it('403 for a foreign or opaque Origin, pass without one and for a local one', async () => {
      const { http, base } = await serve();
      const post = (origin?: string) => fetch(`${base}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, ...(origin ? { origin } : {}) }, body: INIT });
      expect((await post('http://evil.example.com')).status).toBe(403);
      expect((await post('null')).status).toBe(403);
      expect((await post('https://localhost.evil.com')).status).toBe(403);
      expect((await post('http://localhost:5173')).status).toBe(200);
      expect((await post()).status).toBe(200);
      void http;
    });

    it('extra hostnames can be allowed explicitly', async () => {
      const { http } = await serve({}, undefined, { allowedHosts: ['mcp.internal'] });
      expect((await raw(http.port, { headers: { host: 'mcp.internal:8788' } })).status).toBe(200);
    });
  });

  describe('bearer token', () => {
    const TOKEN = 's3cret-token-value';

    it('401 without, with a wrong, or with a malformed token; the tools are never reached', async () => {
      const { base, flat } = await serve({ token: TOKEN });
      const post = (authorization?: string) => fetch(`${base}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, ...(authorization ? { authorization } : {}) }, body: INIT });
      for (const h of [undefined, 'Bearer nope', `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, TOKEN, `Basic ${TOKEN}`, 'Bearer ']) {
        const r = await post(h);
        expect(r.status, String(h)).toBe(401);
        expect(r.headers.get('www-authenticate')).toContain('Bearer');
      }
      expect(flat.calls).toEqual([]);
    });

    it('passes with the right token (any scheme casing) and healthz stays open', async () => {
      const { http, base } = await serve({ token: TOKEN });
      const client = await mcpClient(http.url, { authorization: `Bearer ${TOKEN}` });
      expect((await client.listTools()).tools.length).toBe(41);
      await client.close();
      expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, authorization: `bearer ${TOKEN}` }, body: INIT })).status).toBe(200);
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
    });

    it('checks Host before the token', async () => {
      const { http } = await serve({ token: TOKEN });
      const r = await raw(http.port, { method: 'POST', path: '/mcp', headers: { ...MCP_HEADERS, host: 'evil.example.com', authorization: `Bearer ${TOKEN}` }, body: INIT });
      expect(r.status).toBe(403);
    });

    it('bearerMatches compares in constant time on equal-length digests (and rejects odd input)', () => {
      expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
      expect(bearerMatches('Bearer a', TOKEN)).toBe(false);
      expect(bearerMatches(undefined, TOKEN)).toBe(false);
      expect(bearerMatches('Bearer', TOKEN)).toBe(false);
      expect(bearerMatches(`Bearer ${'x'.repeat(10_000)}`, TOKEN)).toBe(false);
    });
  });

  describe('binding', () => {
    it('loopback detection', () => {
      for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.1.2.3']) expect(isLoopbackHost(h), h).toBe(true);
      for (const h of ['0.0.0.0', '::', '192.168.1.5', 'example.com', '']) expect(isLoopbackHost(h), h).toBe(false);
    });

    it('refuses to bind a non-loopback host without a token', async () => {
      expect(() => assertSafeBind('0.0.0.0', undefined)).toThrow(/refusing to bind/);
      expect(() => assertSafeBind('192.168.1.5', '')).toThrow(/FLAT_TOKEN/);
      expect(() => assertSafeBind('127.0.0.1', undefined)).not.toThrow();
      expect(() => assertSafeBind('0.0.0.0', 'tok')).not.toThrow();
      const config = loadConfig({}, { log: () => {} });
      await expect(startHttp({ config, flat: new MockFlatApi(), host: '0.0.0.0', port: 0 })).rejects.toThrow(/refusing to bind/);
    });

    it('binds loopback by default', async () => {
      const { http } = await serve();
      expect(http.host).toBe('127.0.0.1');
      expect(http.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    });
  });

  it('parses the command line', () => {
    expect(parseArgs([], {})).toEqual({ http: false, port: 8788, host: '127.0.0.1' });
    expect(parseArgs(['--http'], {})).toEqual({ http: true, port: 8788, host: '127.0.0.1' });
    expect(parseArgs(['--http', '--port', '9000', '--host=localhost'], {})).toEqual({ http: true, port: 9000, host: 'localhost' });
    expect(parseArgs(['--http', '--port=0'], {}).port).toBe(0);
    expect(() => parseArgs(['--port', 'abc'], {})).toThrow(/port/);
    expect(() => parseArgs(['--port', '70000'], {})).toThrow(/port/);
    expect(() => parseArgs(['--wat'], {})).toThrow(/unknown argument/);
  });

  it('answers server_unreachable as a tool error over HTTP too', async () => {
    const { http, flat } = await serve();
    flat.down = true;
    const client = await mcpClient(http.url);
    const r = await client.callTool({ name: 'get_scene_summary', arguments: {} });
    expect(r.isError).toBe(true);
    expect(json(r).code).toBe('server_unreachable');
    await client.close();
  });
});
