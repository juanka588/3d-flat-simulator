import { LLM_HIDDEN_TOOLS } from './tools/commandTools';
import { commandToolSchemas, diffScenes, makeEnvelope, type Command, type Scene } from '@flat/scene';
import { afterEach, describe, expect, it } from 'vitest';
import { withMcpExtras } from './tools';
import { loadConfig } from './config';
import { HttpFlatApi } from './flatApi';
import { startRealServer, type RealServer } from './testing/harness';
import { connect, json } from './testing/inproc';
import { MockFlatApi, charmeScene } from './testing/mockFlatApi';

const toolSchemas = commandToolSchemas().filter((t) => !LLM_HIDDEN_TOOLS.has(t.name));

describe('withMcpExtras (pure)', () => {
  it('adds preview, render and label without touching the input', () => {
    const input = { type: 'object', properties: { roomId: { type: 'string' } }, required: ['roomId'], additionalProperties: false };
    const frozen = structuredClone(input);
    const out = withMcpExtras(input);
    expect(input).toEqual(frozen);
    expect(Object.keys(out.properties)).toEqual(['roomId', 'preview', 'render', 'ifRev', 'label']);
    expect(out.required).toEqual(['roomId']);
    expect(out.additionalProperties).toBe(false);
  });

  it('leaves the required label of batch alone and never adds a second one', () => {
    const batch = toolSchemas.find((t) => t.name === 'batch')!.inputSchema as { properties: Record<string, unknown>; required: string[]; $defs: unknown };
    const out = withMcpExtras(batch);
    expect(out.properties.label).toEqual(batch.properties.label);
    expect(out.required).toEqual(batch.required);
    expect(out.$defs).toBe(batch.$defs);
    expect(Object.keys(out.properties)).toEqual(expect.arrayContaining(['preview', 'render']));
  });

  it('refuses a schema that already has preview or render', () => {
    expect(() => withMcpExtras({ type: 'object', properties: { preview: {} } })).toThrow(/preview/);
    expect(() => withMcpExtras({ type: 'object', properties: { render: {} } })).toThrow(/render/);
  });

  it('every write tool advertises the extras over MCP', async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    for (const t of toolSchemas) {
      const props = (tools.find((x) => x.name === t.name)!.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(props, t.name).toHaveProperty('preview');
      expect(props, t.name).toHaveProperty('render');
      expect(props, t.name).toHaveProperty('label');
    }
  });
});

/** Arguments that are valid on the Charme fixture (after `seed`), one per write tool. */
const CASES: Record<string, Record<string, unknown>> = {
  material_define: { material: { id: 'paint-new', name: 'New', kind: 'paint', color: '#336699', roughness: 0.8 } },
  material_remove: { id: 'paint-spare' },
  wall_set_finish: { wallId: 'w-west', side: 'right', materialId: 'paint-sage', roomId: 'sejour' },
  wall_set_structural: { wallId: 'w-sejour-ch2', structural: true },
  room_set_wall_finish: { roomId: 'sejour', materialId: 'paint-sage' },
  room_set_floor: { roomId: 'sejour', materialId: 'floor-oak' },
  room_set_ceiling: { roomId: 'ch1', materialId: 'paint-sage' },
  scene_set_defaults: { wall: 'paint-sage', floor: null },
  site_set: { site: { northAngle: 35, timezone: 'Europe/Paris' } },
  light_add: { light: { type: 'point', position: [2.5, 1.8], elevation: 2.4, lumens: 800, kelvin: 2700, on: true } },
  light_update: { id: 'l-sejour', patch: { on: false, lumens: 600 } },
  light_remove: { id: 'l-wc' },
  item_move: { id: 'tv-sejour', position: [2.2, 2.295] },
  item_rotate: { id: 'tv-sejour', rotation: 180 },
  item_remove: { id: 'tv-sejour' },
  batch: {
    label: 'Paint the sejour sage',
    commands: [
      { type: 'material.define', material: { id: 'paint-sage2', name: 'Sage 2', kind: 'paint', color: '#9caf88', roughness: 0.9 } },
      { type: 'room.setWallFinish', roomId: 'sejour', materialId: 'paint-sage2' },
      { type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-oak' },
    ],
  },
};

/** The same starting flat for both sides of the equivalence property. */
async function seededMock(): Promise<MockFlatApi> {
  const flat = new MockFlatApi();
  const seed: Command[] = [
    { type: 'material.define', material: { id: 'paint-sage', name: 'Sage', kind: 'paint', color: '#9caf88', roughness: 0.9 } },
    { type: 'material.define', material: { id: 'paint-spare', name: 'Spare', kind: 'paint', color: '#aaaaaa', roughness: 0.9 } },
  ];
  for (const [i, cmd] of seed.entries()) {
    const r = await flat.postCommand(makeEnvelope(cmd, { id: `seed-${i}`, ts: 1, author: { kind: 'user' } }));
    if (!r.ok) throw new Error('seed failed');
  }
  return flat;
}

describe('preview (M4.6)', () => {
  it('covers every write tool', () => {
    expect(Object.keys(CASES).sort()).toEqual(toolSchemas.map((t) => t.name).sort());
  });

  for (const tool of Object.keys(CASES)) {
    it(`${tool}: the preview diff equals the diff of the real apply, and nothing is committed`, async () => {
      const a = await seededMock();
      const b = await seededMock();
      const before: Scene = a.scene;
      const logLen = a.log.length;

      const pa = await connect({}, a);
      const preview = await pa.client.callTool({ name: tool, arguments: { ...CASES[tool], preview: true } });
      expect(preview.isError, JSON.stringify(preview.content)).toBeFalsy();
      const p = json(preview);
      expect(p).toMatchObject({ ok: true, committed: false, preview: true });
      expect(a.calls.filter((c) => c === 'postCommand')).toHaveLength(2); // the two seeds, nothing from the preview
      expect(a.log.length).toBe(logLen);
      expect(a.scene).toBe(before);

      const pb = await connect({}, b);
      const real = await pb.client.callTool({ name: tool, arguments: { ...CASES[tool] } });
      expect(real.isError, JSON.stringify(real.content)).toBeFalsy();
      const r = json(real);
      expect(r.committed).toBe(true);

      expect(p.diff).toEqual(diffScenes(before, b.scene));
      expect(p.wouldChange).toEqual(r.changed);
      expect(p.warnings).toEqual(r.warnings);
      expect(p.diff.changes.length).toBeGreaterThan(0);
      expect(p.baseRev).toBe(2);
    });
  }

  describe('against the real apps/server (in process)', () => {
    let real: RealServer | undefined;
    afterEach(async () => {
      await real?.close();
      real = undefined;
    });

    it('every write tool: the preview diff equals the diff the real server commits, and the preview commits nothing', async () => {
      real = await startRealServer();
      const config = loadConfig({}, { serverUrl: real.url, log: () => {}, requestTimeoutMs: 10_000 });
      const flat = new HttpFlatApi(config);
      for (const [i, cmd] of [
        { type: 'material.define', material: { id: 'paint-sage', name: 'Sage', kind: 'paint', color: '#9caf88', roughness: 0.9 } },
        { type: 'material.define', material: { id: 'paint-spare', name: 'Spare', kind: 'paint', color: '#aaaaaa', roughness: 0.9 } },
      ].entries()) {
        expect((await flat.postCommand(makeEnvelope(cmd as Command, { id: `seed-${i}`, ts: 1, author: { kind: 'user' } }))).ok).toBe(true);
      }
      const { client } = await connect({ serverUrl: real.url }, flat as unknown as MockFlatApi);
      const sceneOf = async () => {
        const r = await flat.getScene();
        if (!r.ok) throw new Error('getScene failed');
        return r.data;
      };

      for (const tool of Object.keys(CASES)) {
        const before = await sceneOf();
        const preview = await client.callTool({ name: tool, arguments: { ...CASES[tool], preview: true } });
        expect(preview.isError, `${tool}: ${JSON.stringify(preview.content)}`).toBeFalsy();
        const p = json(preview);
        expect(p, tool).toMatchObject({ committed: false, baseRev: before.rev });
        const untouched = await sceneOf();
        expect(untouched.rev, `${tool}: the preview committed something`).toBe(before.rev);
        expect(untouched.scene).toEqual(before.scene);

        const committed = json(await client.callTool({ name: tool, arguments: { ...CASES[tool], ifRev: p.baseRev } }));
        expect(committed, tool).toMatchObject({ ok: true, committed: true, rev: before.rev + 1 });
        const after = await sceneOf();
        expect(p.diff, tool).toEqual(diffScenes(before.scene, after.scene));
        expect(p.wouldChange, tool).toEqual(committed.changed);
        expect(p.warnings, tool).toEqual(committed.warnings);
      }
    }, 60_000);

    it('baseRev of a preview guards the real commit: a change in between is stale_scene and applies nothing', async () => {
      real = await startRealServer();
      const flat = new HttpFlatApi(loadConfig({}, { serverUrl: real.url, log: () => {} }));
      const { client } = await connect({ serverUrl: real.url }, flat as unknown as MockFlatApi);
      const args = { roomId: 'sejour', materialId: 'floor-oak' };
      const preview = json(await client.callTool({ name: 'room_set_floor', arguments: { ...args, preview: true } }));
      await flat.postCommand(makeEnvelope({ type: 'site.set', site: { northAngle: 12 } }, { id: 'user-edit', ts: 5, author: { kind: 'user' } }));
      const stale = await client.callTool({ name: 'room_set_floor', arguments: { ...args, ifRev: preview.baseRev } });
      expect(json(stale)).toMatchObject({ code: 'stale_scene', rev: 1 });
      const scene = (await flat.getScene()) as { data: { scene: { rooms: { id: string; floorMaterial?: string }[] } } };
      expect(scene.data.scene.rooms.find((r) => r.id === 'sejour')!.floorMaterial).not.toBe('floor-oak');
    });
  });

  it('posts nothing at all (no postCommand reached the FlatApi)', async () => {
    const flat = await seededMock();
    const { client } = await connect({}, flat);
    const before = flat.calls.filter((c) => c === 'postCommand').length;
    await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak', preview: true } });
    expect(flat.calls.filter((c) => c === 'postCommand').length).toBe(before);
    expect(flat.calls.at(-1)).toBe('getScene');
  });

  it('is computed on a freshly fetched scene (sees a change made by someone else)', async () => {
    const flat = await seededMock();
    const { client } = await connect({}, flat);
    const first = json(await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak', preview: true } }));
    expect(first.diff.summary.modified).toBe(1);
    await flat.postCommand(makeEnvelope({ type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-oak' }, { id: 'user-edit-1', ts: 1, author: { kind: 'user' } }));
    const second = json(await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak', preview: true } }));
    expect(second.noop).toBe(true);
    expect(second.diff.changes).toEqual([]);
    expect(second.baseRev).toBe(3);
  });

  it('reports reducer errors like a real call would, without committing', async () => {
    const { client, flat } = await connect();
    const r = await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejoure', materialId: 'floor-oak', preview: true } });
    expect(r.isError).toBe(true);
    expect(json(r).code).toBe('unknown_entity');
    expect(flat.rev).toBe(0);
  });

  it('applies the structural rules to previews (an LLM cannot mark a structural wall removable)', async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: 'wall_set_structural', arguments: { wallId: 'w-north', structural: false, preview: true } });
    expect(r.isError).toBe(true);
    expect(json(r).code).toBe('precondition_failed');
  });

  it('a malformed preview flag is invalid_command', async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak', preview: 'yes' } });
    expect(json(r)).toMatchObject({ code: 'invalid_command' });
    expect(json(r).errors[0].path).toBe('preview');
  });

  it('does not use up the write allowance', async () => {
    const { client } = await connect({ limits: { maxBatch: 50, writesPerMinute: 2, rendersPerMinute: 10, maxArgBytes: 262144, sessionWriteCap: 500, searchesPerMinute: 20, productGetsPerMinute: 60 } });
    for (let i = 0; i < 5; i++) {
      const r = await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak', preview: true } });
      expect(r.isError).toBeFalsy();
    }
  });
});

describe('label', () => {
  it('becomes the history entry label of a single-command tool (and the command is unchanged)', async () => {
    const { client, flat } = await connect();
    const r = await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak', label: '  Oak floor in the sejour ' } });
    expect(r.isError).toBeFalsy();
    expect(flat.scene.rooms.find((x) => x.id === 'sejour')!.floorMaterial).toBe('floor-oak');
    const h = await flat.history();
    expect(h.ok && h.data.past.at(-1)!.label).toBe('Oak floor in the sejour');
    expect(flat.log[0]!.envelope.cmd).toMatchObject({ type: 'batch', label: 'Oak floor in the sejour' });
  });

  it('is the batch label for batch', async () => {
    const { client, flat } = await connect();
    await client.callTool({ name: 'batch', arguments: CASES.batch });
    const h = await flat.history();
    expect(h.ok && h.data.past.at(-1)!.label).toBe('Paint the sejour sage');
  });

  it('without a label the entry gets a descriptive label', async () => {
    const { client, flat } = await connect();
    await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak' } });
    const h = await flat.history();
    expect(h.ok && h.data.past.at(-1)!.label).toBe('Floor of Séjour → Oak parquet (satin)');
  });

  it('must be a non-empty string of at most 200 characters', async () => {
    const { client } = await connect();
    for (const label of ['', '   ', 'x'.repeat(201), 5]) {
      const r = await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak', label } });
      expect(json(r).code, String(label).slice(0, 5)).toBe('invalid_command');
    }
  });
});

describe('rate limits and session cap (M4.6)', () => {
  const limits = (over: Record<string, number>) => ({ limits: { maxBatch: 50, writesPerMinute: 30, rendersPerMinute: 10, maxArgBytes: 262144, sessionWriteCap: 500, searchesPerMinute: 20, productGetsPerMinute: 60, ...over } });
  const write = (client: Awaited<ReturnType<typeof connect>>['client'], materialId = 'floor-oak') => client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId } });

  it('allows 30 writes in a burst, then answers rate_limited with retryAfterMs, and recovers with time', async () => {
    const { client, clock, flat } = await connect();
    for (let i = 0; i < 30; i++) expect((await write(client, i % 2 ? 'floor-oak' : 'floor-tile')).isError, `call ${i}`).toBeFalsy();
    const blocked = await write(client);
    expect(blocked.isError).toBe(true);
    const e = json(blocked);
    expect(e.code).toBe('rate_limited');
    expect(e.retryAfterMs).toBeGreaterThan(0);
    expect(e.retryAfterMs).toBeLessThanOrEqual(2000);
    expect(flat.rev).toBe(30);
    clock.advance(e.retryAfterMs);
    expect((await write(client, 'floor-deck')).isError).toBeFalsy();
  });

  it('is configurable', async () => {
    const { client } = await connect(limits({ writesPerMinute: 2 }));
    expect((await write(client, 'floor-tile')).isError).toBeFalsy();
    expect((await write(client, 'floor-oak')).isError).toBeFalsy();
    expect(json(await write(client, 'floor-deck')).code).toBe('rate_limited');
  });

  it('refills continuously (one token per 60/n seconds)', async () => {
    const { client, clock } = await connect(limits({ writesPerMinute: 6 }));
    for (let i = 0; i < 6; i++) await write(client, i % 2 ? 'floor-oak' : 'floor-tile');
    expect(json(await write(client)).code).toBe('rate_limited');
    clock.advance(10_000);
    expect((await write(client, 'floor-deck')).isError).toBeFalsy();
    expect(json(await write(client, 'floor-tile')).code).toBe('rate_limited');
  });

  it('invalid calls cost no allowance', async () => {
    const { client } = await connect(limits({ writesPerMinute: 1 }));
    for (let i = 0; i < 5; i++) await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour' } });
    expect((await write(client)).isError).toBeFalsy();
  });

  it('counts undo, redo and restore_checkpoint as writes too', async () => {
    const { client } = await connect(limits({ writesPerMinute: 2 }));
    await write(client);
    expect((await client.callTool({ name: 'undo', arguments: {} })).isError).toBeFalsy();
    expect(json(await client.callTool({ name: 'redo', arguments: {} })).code).toBe('rate_limited');
  });

  it('stops at the session write cap', async () => {
    const { client, clock } = await connect(limits({ sessionWriteCap: 2, searchesPerMinute: 20, productGetsPerMinute: 60 }));
    await write(client, 'floor-tile');
    await write(client, 'floor-oak');
    clock.advance(120_000);
    const r = await write(client, 'floor-deck');
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ code: 'rate_limited', message: expect.stringContaining('write cap') });
    expect(json(r).retryAfterMs).toBeUndefined();
  });

  it('a read-only server refuses writes that slip past the tool list', async () => {
    const { client } = await connect({ readOnly: true });
    expect((await client.listTools()).tools.some((t) => t.name === 'room_set_floor')).toBe(false);
  });
});

describe('ifRev (optimistic concurrency)', () => {
  const floorArgs = { roomId: 'sejour', materialId: 'floor-oak' };

  it('baseRev of a preview applies only if nothing changed; otherwise stale_scene and nothing is applied', async () => {
    const { client, flat } = await connect();
    const preview = json(await client.callTool({ name: 'room_set_floor', arguments: { ...floorArgs, preview: true } }));
    const ok = json(await client.callTool({ name: 'room_set_floor', arguments: { ...floorArgs, ifRev: preview.baseRev } }));
    expect(ok).toMatchObject({ ok: true, committed: true, rev: 1 });

    const stale = await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-tile', ifRev: preview.baseRev } });
    expect(stale.isError).toBe(true);
    expect(json(stale)).toMatchObject({ code: 'stale_scene', rev: 1 });
    expect(flat.rev).toBe(1);
  });

  it('applies to batches too, to previews, and a bad value is invalid_command', async () => {
    const { client, flat } = await connect();
    await client.callTool({ name: 'room_set_floor', arguments: floorArgs });
    const batch = await client.callTool({ name: 'batch', arguments: { label: 'x', ifRev: 0, commands: [{ type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-tile' }] } });
    expect(json(batch).code).toBe('stale_scene');
    const prev = await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-tile', ifRev: 0, preview: true } });
    expect(json(prev).code).toBe('stale_scene');
    const bad = await client.callTool({ name: 'room_set_floor', arguments: { ...floorArgs, ifRev: -1 } });
    expect(json(bad)).toMatchObject({ code: 'invalid_command', errors: [{ path: 'ifRev' }] });
    expect(flat.rev).toBe(1);
  });

  it('is documented on every write tool', async () => {
    const { client } = await connect();
    for (const t of (await client.listTools()).tools.filter((x) => toolSchemas.some((s) => s.name === x.name))) {
      const p = (t.inputSchema as { properties: Record<string, { description?: string }> }).properties.ifRev;
      expect(p?.description, t.name).toContain('baseRev');
    }
  });
});

describe('render argument', () => {
  it('is accepted; the change still applies and the result says render_unavailable (no renderer wired)', async () => {
    const { client, flat } = await connect();
    const r = await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak', render: true } });
    expect(r.isError).toBeFalsy();
    const body = json(r);
    expect(body.committed).toBe(true);
    expect(body.render).toMatchObject({ ok: false, code: 'render_unavailable' });
    expect(body.render.message).toContain('not wired');
    expect(flat.rev).toBe(1);
  });

  it('works with preview too, and an object is accepted', async () => {
    const { client, flat } = await connect();
    const r = json(await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak', preview: true, render: { view: 'room', roomId: 'sejour' } } }));
    expect(r.committed).toBe(false);
    expect(r.render.code).toBe('render_unavailable');
    expect(flat.rev).toBe(0);
  });

  it('false is a no-op and a bad value is invalid_command', async () => {
    const { client } = await connect();
    const ok = json(await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak', render: false } }));
    expect(ok.render).toBeUndefined();
    const bad = await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-tile', render: 'yes' } });
    expect(json(bad).code).toBe('invalid_command');
  });

  const fakeRenderer = (calls: unknown[] = []) => ({
    async render(spec: unknown, opts?: { scene?: { rev: number } }) {
      calls.push({ spec, opts });
      return { image: 'AAAA', mimeType: 'image/png' as const, meta: { rev: opts?.scene?.rev ?? -1 } as never };
    },
  });

  it('uses the renderer of lane E when one is installed: committed render targets the changed room', async () => {
    const calls: unknown[] = [];
    const { client } = await connect({}, undefined, { renderer: fakeRenderer(calls) });
    const r = await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak', render: true } });
    expect((r.content as { type: string }[]).map((c) => c.type)).toEqual(['text', 'image']);
    expect(json(r).render).toMatchObject({ ok: true });
    expect(calls).toEqual([{ spec: { view: 'room', roomId: 'sejour' }, opts: { session: expect.objectContaining({ clientName: 'unit-client' }) } }]);
    // one render charged once
    expect((calls[0] as { opts: { session: { renders: { tokens: number } } } }).opts.session.renders.tokens).toBe(9);
  });

  it('a preview render gets the uncommitted scene, and an explicit spec is passed through', async () => {
    const calls: { spec: unknown; opts?: { scene?: { rev: number; scene: { rooms: { id: string; floorMaterial?: string }[] } } } }[] = [];
    const { client, flat } = await connect({}, undefined, { renderer: fakeRenderer(calls) });
    await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak', preview: true, render: { view: 'top' } } });
    expect(calls[0]!.spec).toEqual({ view: 'top' });
    expect(calls[0]!.opts!.scene!.scene.rooms.find((x) => x.id === 'sejour')!.floorMaterial).toBe('floor-oak');
    expect(flat.rev).toBe(0);
  });

  it('a failing renderer is reported next to the result; the write stays applied; renders are rate limited', async () => {
    const boom = { async render() { throw Object.assign(new Error('browser crashed'), { code: 'render_timeout' }); } };
    const { client, flat } = await connect({ limits: { maxBatch: 50, writesPerMinute: 30, rendersPerMinute: 1, maxArgBytes: 262144, sessionWriteCap: 500, searchesPerMinute: 20, productGetsPerMinute: 60 } }, undefined, { renderer: boom });
    const r = json(await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak', render: true } }));
    expect(r.committed).toBe(true);
    expect(r.render).toMatchObject({ ok: false, code: 'render_timeout', message: 'browser crashed' });
    expect(flat.rev).toBe(1);
    const second = json(await client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-tile', render: true } }));
    expect(second.render).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(second.render.retryAfterMs).toBeGreaterThan(0);
  });
});

describe('render argument validation (same schema as render_view)', () => {
  const fake = (calls: unknown[] = []) => ({
    async render(spec: unknown) {
      calls.push(spec);
      return { image: 'AAAA', mimeType: 'image/png' as const, meta: { rev: 0 } as never };
    },
  });
  const write = (client: Awaited<ReturnType<typeof connect>>['client'], render: unknown, extra: Record<string, unknown> = {}) =>
    client.callTool({ name: 'room_set_floor', arguments: { roomId: 'sejour', materialId: 'floor-oak', render, ...extra } });

  it('a bad render object fails BEFORE the write and before any token is spent', async () => {
    const calls: unknown[] = [];
    const { client, flat } = await connect({}, undefined, { renderer: fake(calls) });
    for (const bad of [{ view: 'sideways' }, { size: { width: 10, height: 10 } }, { bogus: 1 }, { exposureEV: 99 }]) {
      const r = await write(client, bad);
      expect(r.isError, JSON.stringify(bad)).toBe(true);
      expect(json(r)).toMatchObject({ code: 'invalid_command', errors: [{ path: expect.stringMatching(/^render\//) }] });
    }
    expect(flat.rev).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('rejects a model-supplied previewOf (server-set only)', async () => {
    const { client, flat } = await connect({}, undefined, { renderer: fake() });
    const r = await write(client, { view: 'top', previewOf: 3 });
    expect(json(r)).toMatchObject({ code: 'invalid_command', errors: [{ path: 'render/previewOf' }] });
    expect(flat.rev).toBe(0);
  });

  it('render: true is the first changed room overview, else an orbit view; objects without a view follow it', async () => {
    const calls: unknown[] = [];
    const { client } = await connect({}, undefined, { renderer: fake(calls) });
    await write(client, true);
    await client.callTool({ name: 'scene_set_defaults', arguments: { floor: null, render: true } });
    await write(client, { preset: 'evening' }, { materialId: 'floor-tile' });
    await client.callTool({ name: 'site_set', arguments: { site: { northAngle: 10 }, render: { preset: 'night' } } });
    await write(client, { view: 'walk', facing: 'N' }, { materialId: 'floor-deck' });
    expect(calls).toEqual([
      { view: 'room', roomId: 'sejour' },
      { view: 'orbit' }, // scene_set_defaults changes no room
      { preset: 'evening', view: 'room', roomId: 'sejour' },
      { preset: 'night', view: 'orbit' },
      { view: 'walk', facing: 'N', roomId: 'sejour' },
    ]);
  });

  it('flat is orbit, and jpeg is passed on', async () => {
    const seen: { spec: unknown; opts: unknown }[] = [];
    const renderer = {
      async render(spec: unknown, opts: unknown) {
        seen.push({ spec, opts });
        return { image: 'AAAA', mimeType: 'image/jpeg' as const, meta: { rev: 0 } as never };
      },
    };
    const { client } = await connect({}, undefined, { renderer });
    await write(client, { view: 'flat', format: 'jpeg' });
    expect(seen[0]!.spec).toEqual({ view: 'orbit' });
    expect(seen[0]!.opts).toMatchObject({ format: 'jpeg' });
  });
});

describe('existing guarantees still hold', () => {
  it('batch_too_large and the argument size limit', async () => {
    const { client } = await connect();
    const cmd = { type: 'room.setFloor', roomId: 'sejour', materialId: 'floor-oak' };
    const r = await client.callTool({ name: 'batch', arguments: { label: 'x', commands: Array.from({ length: 51 }, () => cmd) } });
    expect(json(r).code).toBe('batch_too_large');
  });

  it('charmeScene is the starting point', () => {
    expect(charmeScene().rooms).toHaveLength(8);
  });
});
