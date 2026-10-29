import { DESCRIPTOR_EXAMPLE } from './reference/descriptor';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Style library: one Markdown file per design style in `apps/mcp/styles/` (data, not code), plus the shared `_base.md`
 * ("how to work with this MCP server"). Each style file is YAML-ish frontmatter (validated by `StyleMetaSchema`) and a
 * Markdown body (the artist's brief). The frontmatter parser below supports the small YAML subset the files use:
 * `key: scalar`, `key: [a, b]`, `key: { a: 1 }`, nested maps by 2-space indentation and `- item` lists.
 */

export const STYLES_DIR = fileURLToPath(new URL('../styles', import.meta.url));
export const BASE_FILE = '_base.md';

export class StyleError extends Error {}

// ---------------------------------------------------------------------------------------------
// Minimal YAML subset
// ---------------------------------------------------------------------------------------------

type Yaml = string | number | boolean | Yaml[] | { [k: string]: Yaml };
type Line = { indent: number; text: string; no: number };

function fail(no: number, message: string): never {
  throw new StyleError(`frontmatter line ${no}: ${message}`);
}

function splitTop(s: string, no: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '[' || ch === '{') {
      depth++;
      cur += ch;
    } else if (ch === ']' || ch === '}') {
      depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (quote) fail(no, `unterminated quote in "${s}"`);
  if (cur.trim() || parts.length) parts.push(cur.trim());
  return parts.filter((p) => p !== '');
}

/** Index of the first `:` outside quotes that ends a key (followed by a space or the end). */
function colonIndex(s: string): number {
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ':' && (i === s.length - 1 || s[i + 1] === ' ')) return i;
  }
  return -1;
}

function parseScalar(raw: string, no: number): Yaml {
  const s = raw.trim();
  if (s.startsWith('[') || s.startsWith('{')) {
    const close = s.startsWith('[') ? ']' : '}';
    if (!s.endsWith(close)) fail(no, `missing "${close}" in "${s}"`);
    const items = splitTop(s.slice(1, -1), no);
    if (close === ']') return items.map((i) => parseScalar(i, no));
    const out: { [k: string]: Yaml } = {};
    for (const item of items) {
      const c = colonIndex(item);
      if (c < 0) fail(no, `expected "key: value" in "${item}"`);
      out[unquoteKey(item.slice(0, c), no)] = parseScalar(item.slice(c + 1), no);
    }
    return out;
  }
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return fail(no, `bad double-quoted string ${s}`);
    }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) fail(no, `bad single-quoted string ${s}`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

function unquoteKey(k: string, no: number): string {
  const s = k.trim();
  return s.startsWith('"') || s.startsWith("'") ? String(parseScalar(s, no)) : s;
}

function parseBlock(lines: Line[], start: number, indent: number): [Yaml, number] {
  const first = lines[start]!;
  if (first.indent !== indent) fail(first.no, `unexpected indentation (${first.indent} spaces, expected ${indent})`);
  let i = start;
  if (first.text.startsWith('- ') || first.text === '-') {
    const list: Yaml[] = [];
    while (i < lines.length && lines[i]!.indent === indent && (lines[i]!.text.startsWith('- ') || lines[i]!.text === '-')) {
      const l = lines[i]!;
      const rest = l.text.slice(1).trim();
      if (!rest) fail(l.no, 'empty list item');
      list.push(parseScalar(rest, l.no));
      i++;
    }
    if (i < lines.length && lines[i]!.indent >= indent) fail(lines[i]!.no, 'unexpected line after a list (mixed list and map?)');
    return [list, i];
  }
  const map: { [k: string]: Yaml } = {};
  while (i < lines.length && lines[i]!.indent >= indent) {
    const l = lines[i]!;
    if (l.indent !== indent) fail(l.no, `unexpected indentation (${l.indent} spaces, expected ${indent})`);
    const c = colonIndex(l.text);
    if (c < 0) fail(l.no, `expected "key: value", got "${l.text}"`);
    const key = unquoteKey(l.text.slice(0, c), l.no);
    if (key in map) fail(l.no, `duplicate key "${key}"`);
    const rest = l.text.slice(c + 1).trim();
    if (rest) {
      map[key] = parseScalar(rest, l.no);
      i++;
    } else {
      const next = lines[i + 1];
      if (!next || next.indent <= indent) {
        map[key] = '';
        i++;
      } else {
        const [value, end] = parseBlock(lines, i + 1, next.indent);
        map[key] = value;
        i = end;
      }
    }
  }
  return [map, i];
}

export function parseYamlSubset(source: string): Record<string, unknown> {
  const lines: Line[] = [];
  source.split(/\r?\n/).forEach((raw, idx) => {
    if (!raw.trim() || raw.trim().startsWith('#')) return;
    if (raw.includes('\t')) fail(idx + 1, 'tabs are not allowed, indent with spaces');
    lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trim(), no: idx + 1 });
  });
  if (!lines.length) return {};
  const [value] = parseBlock(lines, 0, lines[0]!.indent);
  if (typeof value !== 'object' || Array.isArray(value)) throw new StyleError('frontmatter must be a map of keys');
  return value as Record<string, unknown>;
}

/** Splits a file into frontmatter (between the first two `---` lines) and body. */
export function splitFrontmatter(text: string): { front: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!m) throw new StyleError('the file must start with a frontmatter block delimited by "---" lines');
  return { front: m[1]!, body: (m[2] ?? '').trim() };
}

// ---------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------

const text = (max: number) => z.string().trim().min(1).max(max);
const list = (min: number, max: number, item = 120) => z.array(text(item)).min(min).max(max);
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a hex colour like "#c8b49a" (6 digits, quoted)');

/** Room headings the body must contain (`## <heading>`), in this order. */
export const REQUIRED_SECTIONS = ['Tone', 'Principles', 'Séjour / cuisine', 'Chambres', 'Entrée', 'Salle de bain', 'WC', 'Balcon', 'Do', "Don't"] as const;

export const StyleMetaSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'a lowercase kebab-case id like "mid-century-modern"').max(40),
  name: text(60),
  summary: text(240),
  palette: z.array(z.strictObject({ hex: Hex, role: text(60) })).min(4).max(8),
  materials: list(3, 12),
  forms: list(2, 10),
  lighting: z.strictObject({ kelvin: z.number().int().min(2200).max(4000), layers: list(2, 6, 160) }),
  textiles: list(2, 10),
  decor: list(2, 12),
  avoid: list(2, 12),
  budgetHint: z.strictObject({ totalEur: z.number().int().min(500).max(50000), note: text(200).optional() }),
  searchTerms: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/, 'a lowercase category key like "sofa"'), list(1, 6, 60)).refine((r) => Object.keys(r).length >= 6, 'at least 6 categories of French search terms'),
  version: z.number().int().min(1),
});
export type StyleMeta = z.infer<typeof StyleMetaSchema>;

export interface Style {
  meta: StyleMeta;
  body: string;
  file: string;
}

const issuePath = (p: PropertyKey[]) => (p.length ? p.map(String).join('.') : '(frontmatter)');

/** Parses and validates one style file. Throws a `StyleError` whose message names the file and every problem. */
export function parseStyleFile(file: string, source: string): Style {
  const name = basename(file);
  const problems: string[] = [];
  let parts: { front: string; body: string };
  let raw: Record<string, unknown>;
  try {
    parts = splitFrontmatter(source);
    raw = parseYamlSubset(parts.front);
  } catch (e) {
    throw new StyleError(`${name}: ${(e as Error).message}`);
  }
  const parsed = StyleMetaSchema.safeParse(raw);
  if (!parsed.success) for (const issue of parsed.error.issues) problems.push(`${issuePath(issue.path)}: ${issue.message}`);
  const stem = name.replace(/\.md$/, '');
  if (parsed.success && parsed.data.id !== stem) problems.push(`id: "${parsed.data.id}" must equal the file name "${stem}"`);
  const headings = [...parts.body.matchAll(/^## (.+?)\s*$/gm)].map((m) => m[1]!);
  for (const required of REQUIRED_SECTIONS) if (!headings.includes(required)) problems.push(`body: missing the section "## ${required}"`);
  if (parts.body.length < 600) problems.push('body: too short to be a brief (under 600 characters)');
  if (problems.length) throw new StyleError(`${name}:\n  - ${problems.join('\n  - ')}`);
  return { meta: (parsed as { data: StyleMeta }).data, body: parts.body, file: name };
}

/** Loads every style of a folder (not `_base.md`), sorted by id. All problems of all files are reported together. */
export function loadStyles(dir: string = STYLES_DIR): Style[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== BASE_FILE).sort();
  const styles: Style[] = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      styles.push(parseStyleFile(f, readFileSync(join(dir, f), 'utf8')));
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  const seen = new Set<string>();
  for (const s of styles) {
    if (seen.has(s.meta.id)) errors.push(`${s.file}: duplicate style id "${s.meta.id}"`);
    seen.add(s.meta.id);
  }
  if (errors.length) throw new StyleError(`invalid style library (${dir}):\n${errors.join('\n')}`);
  return styles;
}

export function loadBase(dir: string = STYLES_DIR): string {
  return readFileSync(join(dir, BASE_FILE), 'utf8').trim();
}

// ---------------------------------------------------------------------------------------------
// Roles (lead artist and room specialists): `styles/roles/<id>.md`, frontmatter `kind: role`
// ---------------------------------------------------------------------------------------------

export const ROLES_DIR = join(STYLES_DIR, 'roles');
export const ROLE_SECTIONS = ['Scope', 'Workflow', 'Report'] as const;
/** Tools no specialist may call: only the lead artist takes checkpoints, undoes and changes the sun. */
export const LEAD_ONLY_TOOLS = ['undo', 'redo', 'checkpoint', 'restore_checkpoint', 'list_history', 'set_sun_time'] as const;

export const RoleMetaSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'a lowercase kebab-case id like "living-kitchen"').max(40),
  name: text(60),
  kind: z.literal('role'),
  summary: text(240),
  /** `lead` coordinates; `specialist` works inside one room at a time; `reader` (CG4) reads a reference image into a descriptor and never edits the flat. */
  type: z.enum(['lead', 'specialist', 'reader']),
  /** Room ids of the Charme flat this specialist usually handles (the lead may pass others). */
  rooms: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).max(4),
  /** Sections of the style body this role receives (besides Tone, Principles, Do, Don't). */
  styleSections: z.array(z.enum(REQUIRED_SECTIONS)).max(4),
  /** MCP tool names (without prefix) a subagent of this role may call. */
  tools: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(5).max(40),
  version: z.number().int().min(1),
});
export type RoleMeta = z.infer<typeof RoleMetaSchema>;
export interface Role {
  meta: RoleMeta;
  body: string;
  file: string;
}

export function parseRoleFile(file: string, source: string): Role {
  const name = basename(file);
  let parts: { front: string; body: string };
  let raw: Record<string, unknown>;
  try {
    parts = splitFrontmatter(source);
    raw = parseYamlSubset(parts.front);
  } catch (e) {
    throw new StyleError(`${name}: ${(e as Error).message}`);
  }
  const problems: string[] = [];
  const parsed = RoleMetaSchema.safeParse(raw);
  if (!parsed.success) for (const issue of parsed.error.issues) problems.push(`${issuePath(issue.path)}: ${issue.message}`);
  const stem = name.replace(/\.md$/, '');
  if (parsed.success) {
    if (parsed.data.id !== stem) problems.push(`id: "${parsed.data.id}" must equal the file name "${stem}"`);
    if (parsed.data.type !== 'lead') for (const t of parsed.data.tools) if ((LEAD_ONLY_TOOLS as readonly string[]).includes(t)) problems.push(`tools: a non-lead role may not use "${t}" (lead only)`);
  }
  const headings = [...parts.body.matchAll(/^## (.+?)\s*$/gm)].map((m) => m[1]!);
  for (const required of ROLE_SECTIONS) if (!headings.includes(required)) problems.push(`body: missing the section "## ${required}"`);
  if (problems.length) throw new StyleError(`${name}:\n  - ${problems.join('\n  - ')}`);
  return { meta: (parsed as { data: RoleMeta }).data, body: parts.body, file: name };
}

export function loadRoles(dir: string = ROLES_DIR): Role[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  const roles: Role[] = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      roles.push(parseRoleFile(f, readFileSync(join(dir, f), 'utf8')));
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  const leads = roles.filter((r) => r.meta.type === 'lead');
  if (leads.length !== 1) errors.push(`roles: exactly one role must have type "lead" (found ${leads.length})`);
  if (errors.length) throw new StyleError(`invalid role library (${dir}):\n${errors.join('\n')}`);
  return roles;
}

// ---------------------------------------------------------------------------------------------
// Library (cached) and composition
// ---------------------------------------------------------------------------------------------

let cache: { styles: Style[]; base: string; roles: Role[] } | undefined;
export function library(): { styles: Style[]; base: string; roles: Role[] } {
  cache ??= { styles: loadStyles(), base: loadBase(), roles: loadRoles() };
  return cache;
}

export function findRole(id: string): Role {
  const r = library().roles.find((x) => x.meta.id === id);
  if (!r) throw new StyleError(`unknown role "${id}". Available: ${library().roles.map((x) => x.meta.id).join(', ')}`);
  return r;
}

export function findStyle(id: string): Style {
  const s = library().styles.find((x) => x.meta.id === id);
  if (!s) throw new StyleError(`unknown style "${id}". Available: ${library().styles.map((x) => x.meta.id).join(', ')}`);
  return s;
}

/** Compact style card from the frontmatter: what the artist works with. */
export function styleCard(s: Style): string {
  const m = s.meta;
  const terms = Object.entries(m.searchTerms).map(([k, v]) => `${k}: ${v.join(' / ')}`).join('; ');
  return [
    `Style card: ${m.name} (${m.id}, v${m.version}). ${m.summary}`,
    `Palette: ${m.palette.map((p) => `${p.hex} ${p.role}`).join(', ')}.`,
    `Materials: ${m.materials.join('; ')}.`,
    `Forms: ${m.forms.join('; ')}.`,
    `Lighting: ${m.lighting.kelvin} K; ${m.lighting.layers.join('; ')}.`,
    `Textiles: ${m.textiles.join('; ')}.`,
    `Decor: ${m.decor.join('; ')}.`,
    `Avoid: ${m.avoid.join('; ')}.`,
    `Budget hint: about ${m.budgetHint.totalEur} EUR TTC for the whole flat${m.budgetHint.note ? ` (${m.budgetHint.note})` : ''}.`,
    `French search terms: ${terms}.`,
  ].join('\n');
}

export function styleListMarkdown(styles: Style[] = library().styles): string {
  return ['# Styles', '', 'Read one with `styles://<id>`; design a flat with the prompt `design_flat_in_style`.', '', ...styles.map((s) => `- \`${s.meta.id}\` - ${s.meta.name}: ${s.meta.summary}`)].join('\n');
}

export function styleMarkdown(s: Style): string {
  return `# ${s.meta.name}\n\n${styleCard(s)}\n\n${s.body}`;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export interface DesignArgs {
  styleId: string;
  rooms?: string | undefined;
  budgetEur?: number | undefined;
  notes?: string | undefined;
}

const msg = (t: string) => ({ role: 'user' as const, content: { type: 'text' as const, text: t } });

/** `design_flat_in_style`: the shared base, the style (card + brief) and the request. */
export function designFlatMessages(args: DesignArgs) {
  const { base } = library();
  const style = findStyle(args.styleId);
  const budget = args.budgetEur ?? style.meta.budgetHint.totalEur;
  const scope = args.rooms?.trim() ? `only these rooms (room ids): ${oneLine(args.rooms)}` : 'the whole flat: séjour/cuisine, alcôve, both bedrooms, entrée, salle de bain, WC and balcony';
  const notes = args.notes?.trim() ? `\nAdditional notes from the owner: ${oneLine(args.notes)}` : '';
  const request = `Your commission: redesign ${scope} in the style "${style.meta.name}" and act as that style's artist. Follow the workflow above and the brief below. Furniture budget: about ${budget} EUR TTC in total (existing locked furniture counts 0); finish with the bill of materials and a short design brief (palette, per-room choices, price list, total).${notes}`;
  return [msg(base), msg(`${styleCard(style)}\n\n${style.body}`), msg(request)];
}

/** Rough token estimate (about 4 characters per token). */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

// ---------------------------------------------------------------------------------------------
// Team mode: a lead artist delegating to room specialists
// ---------------------------------------------------------------------------------------------

/** The text of the `## <name>` sections of a Markdown body (heading included). */
export function bodySections(body: string, names: readonly string[]): string {
  const chunks = body.split(/^(?=## )/m);
  return names
    .map((n) => chunks.find((c) => c.startsWith(`## ${n}\n`) || c.trim() === `## ${n}`)?.trim())
    .filter((c): c is string => Boolean(c))
    .join('\n\n');
}

export interface TeamArgs {
  styleId: string;
  budgetEur?: number | undefined;
}

export function specialists(): Role[] {
  return library().roles.filter((r) => r.meta.type === 'specialist');
}

/** `reference_reader` (CG4): the reader role, the descriptor shape and the assignment. */
export function referenceReaderMessages(args: { jobId?: string | undefined; index?: number | undefined; roomId?: string | undefined; styleId?: string | undefined }) {
  const role = findRole('reference-reader');
  const style = args.styleId ? findStyle(args.styleId) : undefined;
  const target = args.jobId ? `the reference image ${oneLine(args.jobId)} #${args.index ?? 0}${args.roomId ? ` of room "${oneLine(args.roomId)}"` : ''}` : 'the reference image the user shows you (a generate_reference result)';
  const call = args.jobId ? `record_reference {"jobId":"${oneLine(args.jobId)}","index":${args.index ?? 0},"descriptor":{...}}` : 'record_reference {"jobId":"<jobId>","index":0,"descriptor":{...}}';
  const shape = `The descriptor to record (this is the exact shape; the example is for another room):\n\n${JSON.stringify(DESCRIPTOR_EXAMPLE, null, 1)}\n\nCall: ${call}`;
  const assignment = `Your assignment: read ${target} into a descriptor, record it, match it to real products and write the gap report.${style ? ` The design style is "${style.meta.name}": judge how far the image keeps to it, but describe what you see.` : ''}`;
  return [msg(role.body), msg(shape), msg(assignment)];
}

export function leadRole(): Role {
  return library().roles.find((r) => r.meta.type === 'lead')!;
}

/** `design_flat_team`: the lead artist's prompt (base + lead role + style + roster + request). */
export function designFlatTeamMessages(args: TeamArgs) {
  const { base } = library();
  const style = findStyle(args.styleId);
  const lead = leadRole();
  const budget = args.budgetEur ?? style.meta.budgetHint.totalEur;
  const roster = specialists().map((r) => `- \`${r.meta.id}\` (${r.meta.rooms.length ? `room ids: ${r.meta.rooms.join(', ')}` : 'room given by you'}): ${r.meta.summary}`).join('\n');
  const request = `Your commission: redesign the whole flat in the style "${style.meta.name}" as its lead artist, with a total furniture budget of about ${budget} EUR TTC (existing locked furniture counts 0). Follow your role. Your specialists:\n${roster}\nIf your client has no subagent facility, do the rooms yourself one after the other, following each specialist's scope. End with the bill of materials and a short design brief (palette, per-room choices, price list, total).`;
  return [msg(base), msg(lead.body), msg(`${styleCard(style)}\n\n${style.body}`), msg(request)];
}

export interface SpecialistArgs {
  role: string;
  styleId: string;
  roomId?: string | undefined;
  brief?: string | undefined;
  budgetEur?: number | undefined;
}

/** `room_specialist`: one specialist's prompt, with only the style sections that concern its rooms. */
export function roomSpecialistMessages(args: SpecialistArgs) {
  const { base } = library();
  const style = findStyle(args.styleId);
  const role = findRole(args.role);
  if (role.meta.type !== 'specialist') throw new StyleError(`"${args.role}" is the lead artist: use design_flat_team for it`);
  const sections = bodySections(style.body, ['Tone', 'Principles', ...role.meta.styleSections, 'Do', "Don't"]);
  const room = args.roomId ? `the room "${oneLine(args.roomId)}"` : 'the room id given in the task you receive';
  const brief = args.brief?.trim() ? `\nBrief from the lead artist: ${oneLine(args.brief)}` : '';
  const budget = args.budgetEur !== undefined ? ` Budget for this room: about ${args.budgetEur} EUR TTC.` : '';
  const assignment = `Your assignment: furnish and finish ${room} as the ${role.meta.name} for the style "${style.meta.name}". Stay inside that room (see Scope).${budget}${brief}`;
  return [msg(base), msg(role.body), msg(`${styleCard(style)}\n\n${sections}`), msg(assignment)];
}

export const messagesText = (messages: { content: { text: string } }[]) => messages.map((m) => m.content.text).join('\n\n');

export function rolesListMarkdown(): string {
  return ['# Roles', '', 'Read one with `styles://roles/<id>`; use them with the prompts `design_flat_team` and `room_specialist`.', '', ...library().roles.map((r) => `- \`${r.meta.id}\` (${r.meta.type}) - ${r.meta.name}: ${r.meta.summary}`)].join('\n');
}

/** JSON for runners: id, summary, rooms and allowed tools of every role. */
export function rolesJson() {
  return library().roles.map((r) => ({ id: r.meta.id, name: r.meta.name, type: r.meta.type, summary: r.meta.summary, rooms: r.meta.rooms, tools: r.meta.tools }));
}
