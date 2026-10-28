import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE_FILE, designFlatMessages, designFlatTeamMessages, estimateTokens, findStyle, LEAD_ONLY_TOOLS, library, loadRoles, loadStyles, messagesText, parseRoleFile, parseStyleFile, parseYamlSubset, roomSpecialistMessages, STYLES_DIR, StyleError } from './styles';
import { styleResourceUris } from './stylesMcp';
import { allTools } from './tools';
import { connect } from './testing/inproc';

const toolNames = new Set(allTools().map((t) => t.name));
/** Backticked words that are arguments, relations or response fields, not tools. */
const NOT_TOOLS = new Set(['living-kitchen', 'bedroom', 'bathroom-wc', 'office-gaming', 'entry', 'outdoor-balcony', 'lighting', 'preview', 'render', 'label', 'on', 'grid', 'lighting_plan']);
const backticked = (text: string) => [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]!).filter((w) => !NOT_TOOLS.has(w));
const unknownTools = (text: string) => [...new Set(backticked(text))].filter((w) => !toolNames.has(w));

const EXPECTED = ['art-deco', 'boho', 'brutalist', 'french-parisian', 'industrial-loft', 'japandi', 'mediterranean', 'mid-century-modern', 'scandinavian', 'warm-minimal'];
const GOOD = readFileSync(join(STYLES_DIR, 'warm-minimal.md'), 'utf8');
/** A copy of the good file with one text replaced, parsed under the given file name. */
const mutate = (from: string | RegExp, to: string, file = 'warm-minimal.md') => parseStyleFile(file, GOOD.replace(from, to));

describe('style library', () => {
  it('loads the ten starter styles', () => {
    expect(loadStyles().map((s) => s.meta.id)).toEqual(EXPECTED);
  });

  it('every style has a distinct palette and French search terms with accents or French words', () => {
    const styles = loadStyles();
    const hexes = styles.map((s) => s.meta.palette.map((p) => p.hex.toLowerCase()).join());
    expect(new Set(hexes).size).toBe(styles.length);
    for (const s of styles) {
      expect(Object.keys(s.meta.searchTerms).length, s.file).toBeGreaterThanOrEqual(6);
      expect(s.meta.lighting.kelvin, s.file).toBeLessThanOrEqual(3000);
    }
  });

  it('every style body mentions only real tools in backticks', () => {
    for (const s of loadStyles()) expect(unknownTools(s.body), s.file).toEqual([]);
  });

  it('_base.md is under about 1.5k tokens and names only real tools', () => {
    const base = library().base;
    expect(estimateTokens(base)).toBeLessThan(1500);
    expect(unknownTools(base)).toEqual([]);
    for (const tool of ['get_scene_summary', 'describe_room', 'checkpoint', 'room_set_wall_finish', 'room_set_floor_zone', 'light_add', 'search_products', 'get_product', 'place_item', 'validate_layout', 'render_view', 'get_bill_of_materials']) expect(base).toContain(`\`${tool}\``);
    expect(base).toMatch(/never invent/i);
    expect(base).toMatch(/structural/i);
    expect(base).toMatch(/`on` relation/);
    expect(BASE_FILE).toBe('_base.md');
  });
});

describe('frontmatter parser', () => {
  it('reads scalars, inline lists and maps, nested maps and block lists', () => {
    const y = parseYamlSubset(['a: 1', 'b: "x: y, z"', 'c: [one, "two, 2", 3]', 'd:', '  e: true', '  f:', '    - { k: "#aabbcc", r: role }', '    - plain text', "g: 'it''s'"].join('\n'));
    expect(y).toEqual({ a: 1, b: 'x: y, z', c: ['one', 'two, 2', 3], d: { e: true, f: [{ k: '#aabbcc', r: 'role' }, 'plain text'] }, g: "it's" });
  });

  it('reports the line of a syntax error', () => {
    expect(() => parseYamlSubset('a: 1\nb "oops"')).toThrow(/line 2: expected "key: value"/);
    expect(() => parseYamlSubset('a: [1, 2')).toThrow(/line 1: missing "\]"/);
    expect(() => parseYamlSubset('a: 1\na: 2')).toThrow(/line 2: duplicate key "a"/);
    expect(() => parseYamlSubset('a:\n\t- x')).toThrow(/tabs/);
  });
});

describe('bad style files fail with clear messages', () => {
  it('a missing frontmatter block', () => {
    expect(() => parseStyleFile('x.md', '# just text')).toThrow(/x\.md: the file must start with a frontmatter block/);
  });

  it('a missing required field names the field', () => {
    expect(() => mutate(/^summary:.*\n/m, '')).toThrow(/warm-minimal\.md:[\s\S]*summary/);
  });

  it('a bad hex colour names the palette entry', () => {
    expect(() => mutate('"#f1ece3"', '"f1ece3"')).toThrow(/palette\.0\.hex: a hex colour like/);
  });

  it('an out-of-range kelvin', () => {
    expect(() => mutate('kelvin: 2700', 'kelvin: 6500')).toThrow(/lighting\.kelvin/);
  });

  it('an unknown key is refused (typo guard)', () => {
    expect(() => mutate('version: 1', 'version: 1\nsummery: oops')).toThrow(/summery|Unrecognized key/);
  });

  it('an id that differs from the file name', () => {
    expect(() => mutate(/^id: .*$/m, 'id: other-name')).toThrow(/id: "other-name" must equal the file name "warm-minimal"/);
    expect(() => mutate(/^id: .*$/m, 'id: Bad_Id')).toThrow(/kebab-case/);
  });

  it('too few search-term categories', () => {
    const few = GOOD.replace(/searchTerms:[\s\S]*?\n---/, 'searchTerms:\n  sofa: [canapé]\n---');
    expect(() => parseStyleFile('warm-minimal.md', few)).toThrow(/at least 6 categories/);
  });

  it('a missing body section is named', () => {
    expect(() => mutate('## Balcon', '## Terrasse')).toThrow(/body: missing the section "## Balcon"/);
  });

  it('loadStyles reports every bad file together, and duplicate ids', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'styles-'));
    writeFileSync(join(dir, 'a.md'), GOOD.replace(/^id: .*$/m, 'id: a'));
    writeFileSync(join(dir, 'b.md'), 'no frontmatter');
    writeFileSync(join(dir, 'c.md'), GOOD.replace(/^id: .*$/m, 'id: d'));
    expect(() => loadStyles(dir)).toThrow(/invalid style library[\s\S]*b\.md: the file must start[\s\S]*c\.md:[\s\S]*must equal the file name "c"/);
  });
});

describe('roles', () => {
  const roles = loadRoles();
  it('has the lead artist and the room specialists', () => {
    expect(roles.map((r) => r.meta.id).sort()).toEqual(['bathroom-wc', 'bedroom', 'entry', 'lead-artist', 'lighting', 'living-kitchen', 'office-gaming', 'outdoor-balcony']);
    expect(roles.filter((r) => r.meta.type === 'lead')).toHaveLength(1);
  });

  it('every role uses only real tools; specialists never get the lead-only tools', () => {
    for (const r of roles) {
      expect(r.meta.tools.filter((t) => !toolNames.has(t)), r.file).toEqual([]);
      expect(unknownTools(r.body), r.file).toEqual([]);
      if (r.meta.type === 'specialist') {
        for (const t of LEAD_ONLY_TOOLS) expect(r.meta.tools, `${r.file} ${t}`).not.toContain(t);
        expect(r.body, r.file).toMatch(/ONLY in your room/);
        expect(r.body, r.file).toMatch(/ever call `undo`/);
        expect(r.meta.tools, r.file).toContain('describe_room');
      }
    }
    const lead = roles.find((r) => r.meta.type === 'lead')!;
    expect(lead.meta.tools).toContain('checkpoint');
    expect(lead.body).toMatch(/ONE `checkpoint`/);
  });

  it('wet rooms get no floor tool (tiles stay)', () => {
    expect(roles.find((r) => r.meta.id === 'bathroom-wc')!.meta.tools).not.toContain('room_set_floor');
  });

  it('a specialist asking for a lead-only tool is refused', () => {
    const src = readFileSync(join(STYLES_DIR, 'roles', 'entry.md'), 'utf8').replace('  - get_scene_summary', '  - undo\n  - get_scene_summary');
    expect(() => parseRoleFile('entry.md', src)).toThrow(/a specialist may not use "undo"/);
  });

  it('a role missing a section fails', () => {
    const src = readFileSync(join(STYLES_DIR, 'roles', 'entry.md'), 'utf8').replace('## Report', '## Output');
    expect(() => parseRoleFile('entry.md', src)).toThrow(/missing the section "## Report"/);
  });

  it('loadRoles needs exactly one lead', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'roles-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'entry.md'), readFileSync(join(STYLES_DIR, 'roles', 'entry.md'), 'utf8'));
    expect(() => loadRoles(dir)).toThrow(/exactly one role must have type "lead"/);
  });
});

describe('composition', () => {
  it('design_flat_in_style = base + style + request', () => {
    const text = messagesText(designFlatMessages({ styleId: 'scandinavian', rooms: 'sejour, ch1', budgetEur: 3000, notes: 'we have a cat' }));
    expect(text).toContain('How to work with the flat MCP server');
    expect(text).toContain('Style card: Scandinavian');
    expect(text).toContain('## Séjour / cuisine');
    expect(text).toContain('only these rooms (room ids): sejour, ch1');
    expect(text).toContain('about 3000 EUR');
    expect(text).toContain('we have a cat');
    expect(unknownTools(text)).toEqual([]);
  });

  it('defaults to the style budget and the whole flat; every style stays under 3.5k tokens', () => {
    for (const s of loadStyles()) {
      const text = messagesText(designFlatMessages({ styleId: s.meta.id }));
      expect(text).toContain(`about ${s.meta.budgetHint.totalEur} EUR`);
      expect(text).toContain('the whole flat');
      expect(estimateTokens(text), s.meta.id).toBeLessThan(3500);
    }
  });

  it('an unknown style lists the available ones', () => {
    expect(() => findStyle('baroque')).toThrow(StyleError);
    expect(() => findStyle('baroque')).toThrow(/Available: art-deco, boho/);
  });

  it('the team lead prompt lists the specialists; a specialist gets only its style sections', () => {
    const lead = messagesText(designFlatTeamMessages({ styleId: 'japandi', budgetEur: 5000 }));
    for (const id of ['living-kitchen', 'bedroom', 'bathroom-wc', 'office-gaming', 'entry', 'outdoor-balcony']) expect(lead).toContain(`\`${id}\``);
    expect(lead).toContain('Role: lead artist');
    expect(lead).toContain('about 5000 EUR');
    const spec = messagesText(roomSpecialistMessages({ role: 'bathroom-wc', styleId: 'japandi', roomId: 'sdb', brief: 'sand tones' }));
    expect(spec).toContain('## Salle de bain');
    expect(spec).toContain('## WC');
    expect(spec).not.toContain('## Chambres');
    expect(spec).toContain('the room "sdb"');
    expect(spec).toContain('sand tones');
    expect(unknownTools(lead + spec)).toEqual([]);
    expect(() => roomSpecialistMessages({ role: 'lead-artist', styleId: 'japandi' })).toThrow(/lead artist/);
    expect(() => roomSpecialistMessages({ role: 'plumber', styleId: 'japandi' })).toThrow(/unknown role/);
  });
});

describe('MCP exposure', () => {
  it('lists the new prompts; the tool list is untouched', async () => {
    const { client } = await connect();
    const names = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['apply_style', 'furnish_room', 'design_flat_in_style', 'design_flat_team', 'room_specialist', 'list_styles']));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools.some((n) => /style|role|artist/.test(n))).toBe(false);
  });

  it('design_flat_in_style, list_styles and furnish_room with a style', async () => {
    const { client } = await connect();
    const d = await client.getPrompt({ name: 'design_flat_in_style', arguments: { styleId: 'brutalist', budgetEur: '4000', rooms: 'sejour' } });
    const text = messagesText(d.messages as never);
    expect(text).toContain('Style card: Brutalist');
    expect(text).toContain('about 4000 EUR');
    const l = messagesText((await client.getPrompt({ name: 'list_styles', arguments: {} })).messages as never);
    for (const id of EXPECTED) expect(l).toContain(`\`${id}\``);
    const f = messagesText((await client.getPrompt({ name: 'furnish_room', arguments: { roomId: 'sejour', brief: 'cosy', styleId: 'boho' } })).messages as never);
    expect(f).toContain('Design style "Bohemian"');
    expect(f).toContain('1. Read');
    const plain = messagesText((await client.getPrompt({ name: 'furnish_room', arguments: { roomId: 'sejour', brief: 'cosy' } })).messages as never);
    expect(plain).not.toContain('Design style');
    await expect(client.getPrompt({ name: 'design_flat_in_style', arguments: { styleId: 'baroque' } })).rejects.toThrow(/unknown style "baroque"/);
  });

  it('room_specialist and design_flat_team prompts', async () => {
    const { client } = await connect();
    const s = messagesText((await client.getPrompt({ name: 'room_specialist', arguments: { role: 'bedroom', roomId: 'ch1', styleId: 'scandinavian' } })).messages as never);
    expect(s).toContain('the room "ch1"');
    expect(s).toContain('Role: bedroom specialist');
    const t = messagesText((await client.getPrompt({ name: 'design_flat_team', arguments: { styleId: 'scandinavian' } })).messages as never);
    expect(t).toContain('Role: lead artist');
  });

  it('serves styles://list, styles://<id>, styles://roles and role pages', async () => {
    const { client } = await connect();
    const read = async (uri: string) => ((await client.readResource({ uri })).contents[0] as { text: string }).text;
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    for (const u of styleResourceUris()) expect(uris).toContain(u);
    const list = await read('styles://list');
    for (const id of EXPECTED) expect(list).toContain(`\`${id}\``);
    expect(await read('styles://art-deco')).toContain('# Art Deco');
    const roles = JSON.parse(await read('styles://roles')) as { id: string; tools: string[] }[];
    expect(roles.map((r) => r.id)).toContain('lead-artist');
    expect(await read('styles://roles/bedroom')).toContain('Role: bedroom specialist');
  });

  it('prints a sample composed prompt size (informational)', () => {
    const text = messagesText(designFlatMessages({ styleId: 'french-parisian' }));
    expect(estimateTokens(text)).toBeGreaterThan(1500);
  });
});
