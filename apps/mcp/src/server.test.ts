import { commandToolSchemas } from '@flat/scene';
import { describe, expect, it } from 'vitest';
import { connect, json } from './testing/inproc';
import { withMcpExtras } from './tools';
import { DESCRIPTION_NOTES, LLM_HIDDEN_TOOLS } from './tools/commandTools';

describe('SDK spike: schemas are advertised unchanged (a)', () => {
  it('every commandToolSchemas() inputSchema reaches the client byte-for-byte', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const t of commandToolSchemas()) {
      const listed = tools.find((x) => x.name === t.name);
      if (LLM_HIDDEN_TOOLS.has(t.name)) {
        expect(listed, t.name).toBeUndefined(); // item_place / item_set_variant: product facts only via place_item
        continue;
      }
      expect(listed, t.name).toBeDefined();
      if (t.name === 'batch') continue; // the MCP layer states ITS command limit (config) on batch: see below
      expect(listed!.inputSchema).toEqual(withMcpExtras(t.inputSchema));
      expect(listed!.description).toBe(t.description + (DESCRIPTION_NOTES[t.name] ?? '')); // the MCP layer may append pointers to the M5.11 tools
    }
    // batch: identical except for the command limit, which is the server's (50), not the reducer's (500)
    const rawBatch = commandToolSchemas().find((t) => t.name === 'batch')!;
    const listedBatch = tools.find((t) => t.name === 'batch')!;
    // ... and without the two hidden commands, and without the field descriptions the tools already carry
    const normalize = (schema: unknown) => {
      const c = structuredClone(schema) as { properties: { commands: { maxItems?: number; description?: string; items: { anyOf: { $ref: string }[] } } }; $defs: Record<string, unknown> };
      delete c.properties.commands.maxItems;
      delete c.properties.commands.description;
      c.properties.commands.items.anyOf = c.properties.commands.items.anyOf.filter((r) => ![...LLM_HIDDEN_TOOLS].some((n) => r.$ref.endsWith(`/${n}`)));
      c.$defs = Object.fromEntries(Object.entries(c.$defs).filter(([n]) => !LLM_HIDDEN_TOOLS.has(n)).map(([n, d]) => [n, JSON.parse(JSON.stringify(d, (k, v) => (k === 'description' && typeof v === 'string' ? undefined : v)))]));
      return c;
    };
    expect(normalize(listedBatch.inputSchema)).toEqual(normalize(withMcpExtras(rawBatch.inputSchema)));
    expect(JSON.stringify(listedBatch.inputSchema)).not.toMatch(/item_place|item_set_variant|item\.place|item\.setVariant/);
    expect((listedBatch.inputSchema as unknown as { properties: { commands: { maxItems: number } } }).properties.commands.maxItems).toBe(50);
    const batch = tools.find((t) => t.name === 'batch')!.inputSchema as unknown as { $defs: Record<string, unknown> };
    expect(Object.keys(batch.$defs)).toContain('wall_set_finish');
    const setFinish = commandToolSchemas().find((t) => t.name === 'wall_set_finish')!.inputSchema as { properties: Record<string, { type?: unknown }> };
    expect(JSON.stringify(tools.find((t) => t.name === 'wall_set_finish')!.inputSchema)).toContain('"type":["string","null"]');
    expect(setFinish.properties.materialId).toBeDefined();
  });
});

describe('SDK spike: validation errors come from our parser only (b)', () => {
  it('a schema-invalid call is not rejected by the SDK; parseCommand answers with a path', async () => {
    const { client, flat } = await connect();
    const r = await client.callTool({ name: 'wall_set_finish', arguments: { wallId: 'w-north', side: 'middle', materialId: 'paint-white' } });
    expect(r.isError).toBe(true);
    const body = json(r);
    expect(body).toMatchObject({ ok: false, code: 'invalid_command' });
    expect(body.errors[0].path).toBe('cmd/side');
    expect(r.structuredContent).toEqual(body);
    expect(flat.calls).not.toContain('postCommand');
  });

  it('an unknown id reaches the reducer and returns nearest-id hints', async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejoure', materialId: 'floor-oak' } });
    expect(r.isError).toBe(true);
    const body = json(r);
    expect(body.code).toBe('unknown_entity');
    expect(body.hint).toContain('sejour');
  });

  it('extra and missing arguments are reported by parseCommand', async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', bogus: 1 } });
    const body = json(r);
    expect(body.code).toBe('invalid_command');
    expect(JSON.stringify(body.errors)).toContain('bogus');
  });
});

describe('write tools through the mock FlatApi', () => {
  it('room_set_floor applies as an llm-authored envelope with the client name', async () => {
    const { client, flat } = await connect();
    const r = await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak' } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ ok: true, rev: 1, changed: { rooms: ['sejour'] } });
    expect(flat.log[0]!.envelope.author).toEqual({ kind: 'llm', name: 'unit-client' });
    expect(flat.log[0]!.envelope.id).toMatch(/^01TEST/);
  });

  it('batch is atomic and the failing command path is reported', async () => {
    const { client, flat } = await connect();
    const r = await client.callTool({
      name: 'batch',
      arguments: { label: 'x', commands: [{ type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-oak' }, { type: 'room.setFloor', roomId: 'nope', materialId: 'floor-oak' }] },
    });
    expect(r.isError).toBe(true);
    expect(json(r).errors[0].path).toMatch(/commands\/1/);
    expect(flat.rev).toBe(0);
  });

  it('batch_too_large is enforced by the MCP limit', async () => {
    const { client } = await connect({ limits: { maxBatch: 2, writesPerMinute: 30, rendersPerMinute: 10, maxArgBytes: 262144, sessionWriteCap: 500, searchesPerMinute: 20, productGetsPerMinute: 60 } });
    const cmd = { type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-oak' };
    const r = await client.callTool({ name: 'batch', arguments: { label: 'x', commands: [cmd, cmd, cmd] } });
    expect(json(r).code).toBe('batch_too_large');
  });

  it('server_unreachable is a tool error, not a protocol error, and the session survives', async () => {
    const { client, flat } = await connect();
    flat.down = true;
    const r = await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak' } });
    expect(r.isError).toBe(true);
    expect(json(r).code).toBe('server_unreachable');
    flat.down = false;
    const again = await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak' } });
    expect(again.isError).toBeFalsy();
  });

  it('a stale ifRev maps to stale_scene', async () => {
    const { client, flat } = await connect();
    flat.failNext({ ok: false, kind: 'http', status: 409, rev: 7, errors: [{ code: 'precondition_failed', path: 'ifRev', message: 'scene is at revision 7, command expected 3' }] });
    const r = await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak' } });
    expect(json(r)).toMatchObject({ code: 'stale_scene', rev: 7 });
  });
});

describe('stubs and modes', () => {
  it('render_view goes through the installed renderer and returns an image', async () => {
    const calls: unknown[] = [];
    const renderer = {
      render: async (spec: unknown, opts: unknown) => {
        calls.push([spec, opts]);
        return { image: 'AAAA', mimeType: 'image/png' as const, meta: { mimeType: 'image/png' as const, width: 8, height: 8, epoch: 'e', rev: 0, view: 'orbit' as const, renderMs: 1, warm: true, lampsLit: [], sun: { available: false }, warnings: [] } };
      },
    };
    const { client } = await connect({}, undefined, { renderer: renderer as never });
    const r = await client.callTool({ name: 'render_view', arguments: { view: 'orbit' } });
    expect(r.isError).toBeFalsy();
    expect((r.content as { type: string }[]).map((c) => c.type)).toContain('image');
    expect(calls).toHaveLength(1);
  });

  it('FLAT_MCP_READONLY hides the scene-mutating tools', async () => {
    const { client } = await connect({ readOnly: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('render_view');
    expect(names).not.toContain('batch');
    expect(names).not.toContain('undo');
  });

  it('FLAT_MCP_TOOLS restricts the list', async () => {
    const { client } = await connect({ toolAllowList: ['batch', 'list_rooms'] });
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['batch', 'list_rooms']);
  });
});

describe('tools/list token budget', () => {
  it('stays under about 22.8k tokens (chars / 4); item_place and item_set_variant are not listed', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    // 21.0k before grid lights (M5 lighting) and floor zones; those add ~1.1k tokens of unavoidable schema (4 light variants repeated in light_add / light_update / batch).
    // CG2 generate_reference: ~0.43k tokens, so the limit went from 22k to 22.5k (the list was at 21.9k). CG1 render_passes will need its own bump. CG3 match_crop plus thumbs/photo flags: ~0.4k tokens, limit 22.8k.
    const chars = JSON.stringify(tools).length;
    expect(Math.round(chars / 4), `tools/list is ${chars} chars`).toBeLessThan(22_800);
  });
});

describe('snapshots (the contract)', () => {
  it('tools/list', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => ({ name: t.name, description: t.description, annotations: t.annotations, inputSchema: t.inputSchema }))).toMatchSnapshot();
  });

  it('prompts/list', async () => {
    const { client } = await connect();
    expect((await client.listPrompts()).prompts).toMatchSnapshot();
  });

  it('server instructions', async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toMatchSnapshot();
    expect(client.getInstructions()!.split(/\s+/).length).toBeLessThan(220);
  });
});
