import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { commandToolSchemas } from '@flat/scene';
import { DEAD_URL, MCP_DIR, connectStdio, startRealServer, type RealServer, type StdioHarness } from './testing/harness';

/** Real child process over real stdio: the SDK's StdioClientTransport (spike point c). */
const open: StdioHarness[] = [];
let real: RealServer | undefined;
afterEach(async () => {
  for (const h of open.splice(0)) await h.close().catch(() => {});
  await real?.close();
  real = undefined;
});
const connect = async (env: Record<string, string>, name?: string) => {
  const h = await connectStdio(env, name);
  open.push(h);
  return h;
};
const json = (r: { content: unknown }) => JSON.parse((r.content as { text: string }[])[0]!.text);

describe('stdio server', () => {
  it('lists the 13 write tools plus the stubs', async () => {
    const { client } = await connect({ FLAT_SERVER_URL: DEAD_URL });
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of commandToolSchemas()) expect(names).toContain(t.name);
    expect(names).toHaveLength(13 + 11);
    expect(client.getServerVersion()?.name).toBe('flat');
    expect(client.getInstructions()).toContain('plan');
  });

  it('stdout carries only JSON-RPC messages', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: MCP_DIR, env: { ...process.env, FLAT_SERVER_URL: DEAD_URL }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak' } } });
    send({ jsonrpc: '2.0', id: 4, method: 'prompts/list' });
    send({ jsonrpc: '2.0', id: 5, method: 'nope/unknown' });
    const deadline = Date.now() + 15_000;
    while (!/"id":5/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    child.stdin.end();
    await new Promise((r) => child.once('exit', r));
    const lines = out.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const line of lines) {
      const msg = JSON.parse(line);
      expect(msg.jsonrpc).toBe('2.0');
      expect(msg.id !== undefined || typeof msg.method === 'string').toBe(true);
    }
  });

  it('server down: server_unreachable and the process stays alive', async () => {
    const h = await connect({ FLAT_SERVER_URL: DEAD_URL });
    const args = { roomId: 'sejour', materialId: 'floor-oak' };
    const r1 = await h.client.callTool({ name: 'room_set_floor', arguments: args });
    expect(r1.isError).toBe(true);
    expect(json(r1)).toMatchObject({ ok: false, code: 'server_unreachable' });
    expect(json(r1).hint).toMatch(/pnpm server|dev:all/);
    const r2 = await h.client.callTool({ name: 'room_set_floor', arguments: args });
    expect(json(r2).code).toBe('server_unreachable');
    expect((await h.client.listTools()).tools.length).toBeGreaterThan(0);
    expect(h.transport.pid).not.toBeNull();
  });

  it('happy path against the real scene server: room_set_floor applies and is authored by the llm', async () => {
    real = await startRealServer();
    const h = await connect({ FLAT_SERVER_URL: real.url }, 'claude-code-test');
    const r = await h.client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak' } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ ok: true, rev: 1, changed: { rooms: ['sejour'] } });

    const scene = await (await fetch(`${real.url}/api/scene`)).json();
    expect(scene.rev).toBe(1);
    expect(scene.scene.rooms.find((x: { id: string }) => x.id === 'sejour').floorMaterial).toBe('floor-oak');

    const hist = await (await fetch(`${real.url}/api/history`)).json();
    expect(hist.past).toHaveLength(1);
    expect(hist.past[0].author).toEqual({ kind: 'llm', name: 'claude-code-test' });
    expect(hist.past[0].id).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('an invalid call returns the parseCommand error with nearest-id hints', async () => {
    real = await startRealServer();
    const h = await connect({ FLAT_SERVER_URL: real.url });
    const bad = await h.client.callTool({ name: 'wall_set_finish', arguments: { wallId: 'w-nort', side: 'left', materialId: 'paint-white' } });
    expect(bad.isError).toBe(true);
    const body = json(bad);
    expect(body.code).toBe('unknown_entity');
    expect(body.hint).toContain('w-north');
    expect(body.errors[0].path).toBe('wallId');

    const malformed = await h.client.callTool({ name: 'wall_set_finish', arguments: { wallId: 'w-north', side: 'up' } });
    expect(json(malformed).code).toBe('invalid_command');
    expect(json(malformed).errors.some((e: { path: string }) => e.path === 'cmd/side')).toBe(true);
    expect(((await (await fetch(`${real.url}/api/scene`)).json()) as { rev: number }).rev).toBe(0);
  });

  it('structural walls cannot be made removable by the llm (end to end)', async () => {
    real = await startRealServer();
    const h = await connect({ FLAT_SERVER_URL: real.url });
    const r = await h.client.callTool({ name: 'wall_set_structural', arguments: { wallId: 'w-north', structural: false } });
    expect(r.isError).toBe(true);
    expect(json(r).code).toBe('precondition_failed');
  });
});
