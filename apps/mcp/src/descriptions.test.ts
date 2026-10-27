import { COMMAND_TYPES } from '@flat/scene';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from './config';
import { connect } from './testing/inproc';

type Tool = Awaited<ReturnType<Awaited<ReturnType<typeof connect>>['client']['listTools']>>['tools'][number];

/** Every `description` string of a JSON schema, with its location. The `$defs` of batch (full commands) are skipped: they speak in command types. */
function descriptions(node: unknown, path = '', out: { path: string; text: string }[] = []): { path: string; text: string }[] {
  if (Array.isArray(node)) node.forEach((n, i) => descriptions(n, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$defs') continue;
      if (k === 'description' && typeof v === 'string') out.push({ path, text: v });
      else descriptions(v, `${path}/${k}`, out);
    }
  }
  return out;
}

const toolTexts = (t: Tool) => [{ path: `${t.name}`, text: t.description ?? '' }, ...descriptions(t.inputSchema, t.name)];

describe('tool descriptions agree with the server', () => {
  it('the batch limit comes from the MCP config, not from the reducer (500)', async () => {
    const dflt = (await (await connect()).client.listTools()).tools.find((t) => t.name === 'batch')!;
    const custom = (await (await connect({ limits: { ...DEFAULT_LIMITS, maxBatch: 7 } })).client.listTools()).tools.find((t) => t.name === 'batch')!;
    const commands = (t: Tool) => (t.inputSchema as unknown as { properties: { commands: { maxItems: number; description: string } } }).properties.commands;
    expect(DEFAULT_LIMITS.maxBatch).toBe(50);
    expect(commands(dflt).maxItems).toBe(50);
    expect(commands(dflt).description).toContain('At most 50');
    expect(dflt.description).toContain('At most 50 commands');
    expect(commands(custom).maxItems).toBe(7);
    expect(commands(custom).description).toContain('At most 7');
    expect(custom.description).toContain('At most 7 commands');
    for (const t of [dflt, custom]) expect(JSON.stringify(toolTexts(t))).not.toMatch(/\b500\b/);
  });

  it('tool-facing text names tools, never command types (material.define -> material_define)', async () => {
    const { client } = await connect();
    const commandTypes = COMMAND_TYPES.filter((c) => c !== 'batch');
    for (const t of (await client.listTools()).tools) {
      if (t.name === 'batch') continue; // its items are commands: it explains the type <-> tool mapping
      for (const { path, text } of toolTexts(t)) {
        for (const c of commandTypes) expect(text, `${path}: "${c}"`).not.toContain(c);
      }
    }
  });

  it('every tool name a description mentions is a real tool', async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const names = new Set(tools.map((t) => t.name));
    const known = /\b(get_scene_summary|list_rooms|describe_room|list_materials|list_history|render_view|set_sun_time|material_define|material_remove|wall_set_\w+|room_set_\w+|scene_set_\w+|site_set|light_\w+|undo|redo|checkpoint|restore_checkpoint|batch)\b/g;
    const sloppy = /\b(get_\w+|list_\w+|describe_\w+|set_\w+|\w+_set_\w+|\w+_define)\b/g;
    for (const t of tools) {
      for (const { path, text } of toolTexts(t)) {
        for (const m of text.match(sloppy) ?? []) if (/^[a-z]+(_[a-z]+)+$/.test(m)) expect(names.has(m), `${path}: unknown tool "${m}"`).toBe(true);
        for (const m of text.match(known) ?? []) expect(names.has(m), `${path}: unknown tool "${m}"`).toBe(true);
      }
    }
  });

  it('every id source a description names ("<path> from <tool>") is a field that tool really returns', async () => {
    const { client } = await connect();
    const outputs: Record<string, unknown> = {};
    const call = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })).structuredContent as unknown);
    outputs.get_scene_summary = await call('get_scene_summary', {});
    outputs['get_scene_summary full'] = await call('get_scene_summary', { detail: 'full' });
    outputs.list_rooms = await call('list_rooms', {});
    outputs.describe_room = await call('describe_room', { roomId: 'sejour' });
    outputs.list_materials = await call('list_materials', {});
    outputs.list_history = await call('list_history', {});

    const has = (node: unknown, segs: string[]): boolean => {
      if (segs.length === 0) return true;
      const [head, ...rest] = segs;
      const isArr = head!.endsWith('[]');
      const key = isArr ? head!.slice(0, -2) : head!;
      if (!node || typeof node !== 'object') return false;
      const v = (node as Record<string, unknown>)[key];
      if (v === undefined) return false;
      if (!isArr) return has(v, rest);
      return Array.isArray(v) && v.length > 0 && v.some((el) => has(el, rest));
    };

    const mention = /([A-Za-z]+(?:\[\])?(?:\.[A-Za-z]+(?:\[\])?)*) (?:from|in) (get_scene_summary|describe_room|list_rooms|list_materials|list_history)( with detail "full")?/g;
    const tools = (await client.listTools()).tools;
    const found: string[] = [];
    // also inside batch's $defs: the leaf schemas carry the same id descriptions
    const texts = tools.flatMap((t) => [...toolTexts(t), ...descriptions((t.inputSchema as { $defs?: unknown }).$defs, `${t.name}/$defs`)]);
    for (const { path, text } of texts) {
      for (const m of text.matchAll(mention)) {
        const [, field, tool, full] = m;
        const out = outputs[full ? `${tool} full` : tool!];
        expect(out, `${path}: ${m[0]}`).toBeDefined();
        expect(has(out, field!.split('.')), `${path}: "${m[0]}" - no such field in the output of ${tool}`).toBe(true);
        found.push(m[0]);
      }
    }
    // the convention is actually used where ids are taken
    expect(found.join('\n')).toMatch(/walls\[\]\.wallId from describe_room/);
    expect(found.join('\n')).toMatch(/sceneMaterials\[\]\.id from list_materials/);
    expect(found.join('\n')).toMatch(/lights\[\]\.id from describe_room/);
    expect(found.join('\n')).toMatch(/materials\[\]\.id from get_scene_summary with detail "full"/);
    expect(found.join('\n')).not.toMatch(/walls\[\]\.id from get_scene_summary/);
  });
});
