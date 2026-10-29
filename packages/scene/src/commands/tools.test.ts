import { describe, expect, it } from 'vitest';
import { COMMAND_TYPES } from './schema';
import { parseCommand } from './parse';
import { commandToolSchemas, toolCallToCommand, toolNameOf } from './tools';

type Json = Record<string, unknown>;
const tools = commandToolSchemas();
const base = { v: 1, id: 'e1', ts: 1, author: { kind: 'llm' } };

/** Every schema node that is a property, at any depth, with its path. */
function* properties(node: unknown, path: string): Generator<[string, Json]> {
  if (Array.isArray(node)) {
    for (const [i, n] of node.entries()) yield* properties(n, `${path}[${i}]`);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const o = node as Json;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'properties' && typeof v === 'object' && v !== null) {
      for (const [pk, pv] of Object.entries(v as Json)) {
        yield [`${path}.${pk}`, pv as Json];
        yield* properties(pv, `${path}.${pk}`);
      }
    } else if (k === 'properties' || k === 'enum' || k === 'const' || k === 'default' || k === 'required') continue;
    else yield* properties(v, `${path}/${k}`);
  }
}

function* allKeys(node: unknown, path = ''): Generator<[string, string]> {
  if (Array.isArray(node)) {
    for (const [i, n] of node.entries()) yield* allKeys(n, `${path}[${i}]`);
  } else if (typeof node === 'object' && node !== null) {
    for (const [k, v] of Object.entries(node)) {
      yield [k, path];
      if (k !== 'enum' && k !== 'const' && k !== 'default') yield* allKeys(v, `${path}.${k}`);
    }
  }
}

describe('commandToolSchemas', () => {
  it('has one tool per leaf command plus batch, with MCP-style names', () => {
    expect(tools.map((t) => t.commandType)).toStrictEqual([...COMMAND_TYPES]);
    expect(tools.map((t) => t.name)).toContain('wall_set_finish');
    expect(tools.at(-1)!.name).toBe('batch');
    for (const t of tools) expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(toolNameOf('scene.setDefaults')).toBe('scene_set_defaults');
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });

  it('every tool has an object root with closed properties', () => {
    for (const t of tools) {
      const s = t.inputSchema as Json;
      expect(s.type, t.name).toBe('object');
      expect(s.additionalProperties, t.name).toBe(false);
      expect(typeof s.properties, t.name).toBe('object');
      expect(Array.isArray(s.required), t.name).toBe(true);
      expect(t.description.length, t.name).toBeGreaterThan(20);
      for (const key of ['oneOf', 'anyOf', 'allOf', 'not', 'enum', '$ref', 'prefixItems']) expect(s, `${t.name} root ${key}`).not.toHaveProperty(key);
      for (const r of s.required as string[]) expect(Object.keys(s.properties as Json), t.name).toContain(r);
    }
  });

  it('every property, recursively, has a non-empty description', () => {
    for (const t of tools) {
      let n = 0;
      for (const [path, prop] of properties(t.inputSchema, t.name)) {
        n++;
        expect(typeof prop.description === 'string' && prop.description.trim().length > 0, `${path} lacks a description`).toBe(true);
      }
      expect(n, t.name).toBeGreaterThan(0);
    }
  });

  it('uses the portable subset: no oneOf, no prefixItems, nullable as a type array, [x, y] as a plain array', () => {
    for (const t of tools) {
      for (const [k, path] of allKeys(t.inputSchema)) {
        expect(k, `${t.name}${path}`).not.toBe('oneOf');
        expect(k, `${t.name}${path}`).not.toBe('prefixItems');
        expect(k, `${t.name}${path}`).not.toBe('index');
      }
    }
    const finish = tools.find((x) => x.name === 'wall_set_finish')!.inputSchema as { properties: Record<string, Json> };
    expect(finish.properties.materialId!.type).toStrictEqual(['string', 'null']);
    expect(finish.properties.materialId).not.toHaveProperty('anyOf');
    const light = JSON.stringify(tools.find((x) => x.name === 'light_add')!.inputSchema);
    expect(light).toContain('"minItems":2');
    expect(light).toContain('"maxItems":2');
  });

  it('hides the internal index fields', () => {
    for (const name of ['material_define', 'light_add']) {
      const props = (tools.find((x) => x.name === name)!.inputSchema as { properties: Json }).properties;
      expect(props).not.toHaveProperty('index');
    }
    expect(JSON.stringify(tools.find((x) => x.name === 'batch')!.inputSchema)).not.toContain('"index"');
  });

  it('leaf tools omit the type discriminator; batch items reference the leaf commands', () => {
    for (const t of tools.filter((x) => x.name !== 'batch')) {
      expect((t.inputSchema as { properties: Json }).properties).not.toHaveProperty('type');
      expect(t.inputSchema.required as string[]).not.toContain('type');
    }
    const batch = tools.at(-1)!.inputSchema as { properties: { commands: { items: { anyOf: { $ref: string }[] } } }; $defs: Record<string, { properties: Json }> };
    const refs = batch.properties.commands.items.anyOf.map((r) => r.$ref);
    expect(refs).toContain('#/$defs/wall_set_finish');
    expect(refs).toHaveLength(tools.length - 1);
    for (const ref of refs) {
      const def = batch.$defs[ref.replace('#/$defs/', '')]!;
      expect(def.properties).toHaveProperty('type');
    }
  });

  it('documents wall_set_finish roomId, sides and null', () => {
    const props = (tools.find((x) => x.name === 'wall_set_finish')!.inputSchema as { properties: Record<string, { description: string }> }).properties;
    expect(props.roomId!.description).toContain('list_rooms');
    expect(props.side!.description).toContain('describe_room');
    expect(props.materialId!.description).toContain('null');
    expect(props.materialId!.description).toContain('library[].slug from list_materials');
  });

  it('an example payload per tool validates against the zod command schema', () => {
    for (const t of tools) {
      const cmd = toolCallToCommand(t.name, t.example);
      expect(cmd, t.name).toBeDefined();
      const r = parseCommand({ ...base, cmd });
      expect(r.ok, `${t.name}: ${JSON.stringify(!r.ok && r.errors)}`).toBe(true);
    }
    expect(toolCallToCommand('nope', {})).toBeUndefined();
    expect(toolCallToCommand('wall_set_finish', null)).toBeUndefined();
  });

  it('returns independent copies', () => {
    const a = commandToolSchemas();
    (a[0]!.inputSchema as Json).mutated = true;
    expect(commandToolSchemas()[0]!.inputSchema).not.toHaveProperty('mutated');
  });

  it('matches the committed tool-schema snapshot', async () => {
    await expect(JSON.stringify(commandToolSchemas(), null, 2) + '\n').toMatchFileSnapshot('./__snapshots__/tool-schemas.json');
  });

  // `vitest -u` rewrites the snapshot above, so the contract is also pinned here in code.
  it('pins the structure of the contract independently of the snapshot', () => {
    const shape = (name: string) => {
      const t = tools.find((x) => x.name === name)!.inputSchema as { properties: Record<string, Json>; required: string[] };
      return { props: Object.keys(t.properties), required: t.required };
    };
    expect(shape('wall_set_finish')).toStrictEqual({ props: ['wallId', 'side', 'materialId', 'panelling', 'panelColour', 'roomId'], required: ['wallId', 'side'] });
    expect(shape('wall_set_structural')).toStrictEqual({ props: ['wallId', 'structural'], required: ['wallId', 'structural'] });
    expect(shape('room_set_wall_finish')).toStrictEqual({ props: ['roomId', 'materialId', 'panelling', 'panelColour', 'corniceMm'], required: ['roomId'] });
    expect(shape('room_set_floor')).toStrictEqual({ props: ['roomId', 'materialId'], required: ['roomId', 'materialId'] });
    expect(shape('room_set_ceiling')).toStrictEqual({ props: ['roomId', 'materialId'], required: ['roomId', 'materialId'] });
    expect(shape('scene_set_defaults')).toStrictEqual({ props: ['wall', 'floor', 'ceiling'], required: [] });
    expect(shape('site_set')).toStrictEqual({ props: ['site'], required: ['site'] });
    expect(shape('material_define')).toStrictEqual({ props: ['material'], required: ['material'] });
    expect(shape('material_remove')).toStrictEqual({ props: ['id'], required: ['id'] });
    expect(shape('light_add')).toStrictEqual({ props: ['light'], required: ['light'] });
    expect(shape('light_update')).toStrictEqual({ props: ['id', 'patch'], required: ['id', 'patch'] });
    expect(shape('light_remove')).toStrictEqual({ props: ['id'], required: ['id'] });
    expect(shape('batch')).toStrictEqual({ props: ['label', 'commands'], required: ['label', 'commands'] });
    const side = (tools[2]!.inputSchema as { properties: Record<string, Json> }).properties.side!;
    expect(side.enum).toStrictEqual(['left', 'right', 'both']);
    const mat = (tools.find((x) => x.name === 'material_define')!.inputSchema as { properties: { material: { properties: Record<string, Json> } } }).properties.material.properties;
    expect(Object.keys(mat)).toStrictEqual(['id', 'name', 'kind', 'color', 'roughness', 'textureUrl', 'textureScale', 'pattern', 'plankWidthMm']);
  });
});
