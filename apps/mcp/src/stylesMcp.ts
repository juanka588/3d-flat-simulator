import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { closeTheGapMessages, referenceReaderMessages, bodySections, designFlatMessages, designFlatTeamMessages, findRole, findStyle, library, rolesJson, rolesListMarkdown, roomSpecialistMessages, styleListMarkdown, styleMarkdown, styleCard } from './styles';

/**
 * Style library exposure: prompts `design_flat_in_style`, `design_flat_team`, `room_specialist`, `list_styles`
 * and resources `styles://list`, `styles://roles`, `styles://<id>`, `styles://roles/<id>`. The content lives in
 * `apps/mcp/styles/*.md` (see styles.ts and docs/styles.md).
 */

const budgetArg = z
  .string()
  .regex(/^\d{1,7}(\.\d{1,2})?$/, 'a number of euros, e.g. 6000')
  .optional()
  .describe('Total furniture budget in EUR, TTC prices (e.g. "6000"). Default: the style\'s budgetHint.');
const styleIdArg = z.string().max(40).describe('Style id, e.g. "french-parisian". Run list_styles or read styles://list for the ids.');
const num = (s: string | undefined) => (s === undefined ? undefined : Number(s));
const text = (t: string) => ({ role: 'user' as const, content: { type: 'text' as const, text: t } });

/** The style card, tone, principles and do/don't of a style, for `furnish_room` with a `styleId`. */
export function styleBriefMessage(styleId: string) {
  const s = findStyle(styleId);
  return text(`Design style "${s.meta.name}": every choice (colours, materials, forms, lamps, decor) must follow it.\n\n${styleCard(s)}\n\n${bodySections(s.body, ['Tone', 'Principles', 'Do', "Don't"])}`);
}

export function registerStylePrompts(server: McpServer): void {
  server.registerPrompt(
    'design_flat_in_style',
    {
      title: 'Design the flat in a style',
      description: 'Redesign the whole flat (or some rooms) as a style\'s artist: the shared MCP workflow, the style brief and your request. Styles: list_styles.',
      argsSchema: z.object({
        styleId: styleIdArg,
        rooms: z.string().max(200).optional().describe('Comma-separated room ids to limit the work to (default: the whole flat).'),
        budgetEur: budgetArg,
        notes: z.string().max(500).optional().describe('Extra wishes from the owner.'),
      }),
    },
    (args) => ({ messages: designFlatMessages({ styleId: args.styleId, rooms: args.rooms, budgetEur: num(args.budgetEur), notes: args.notes }) }),
  );
  server.registerPrompt(
    'design_flat_team',
    {
      title: 'Design the flat with a team of room specialists',
      description: 'The lead artist\'s prompt: sets the concept for a style, delegates room by room to specialists (room_specialist), reviews cohesion and finishes.',
      argsSchema: z.object({ styleId: styleIdArg, budgetEur: budgetArg }),
    },
    (args) => ({ messages: designFlatTeamMessages({ styleId: args.styleId, budgetEur: num(args.budgetEur) }) }),
  );
  server.registerPrompt(
    'room_specialist',
    {
      title: 'Room specialist',
      description: 'One specialist (living-kitchen, bedroom, bathroom-wc, office-gaming, entry, outdoor-balcony, lighting) designs one room in a style and reports back. For subagents of design_flat_team.',
      argsSchema: z.object({
        role: z.string().max(40).describe('Role id: living-kitchen, bedroom, bathroom-wc, office-gaming, entry, outdoor-balcony or lighting.'),
        roomId: z.string().max(64).optional().describe('Room id (default: given in the task).'),
        styleId: styleIdArg,
        brief: z.string().max(500).optional().describe('The lead artist\'s brief for this room.'),
        budgetEur: budgetArg,
      }),
    },
    (args) => ({ messages: roomSpecialistMessages({ role: args.role, roomId: args.roomId, styleId: args.styleId, brief: args.brief, budgetEur: num(args.budgetEur) }) }),
  );
  server.registerPrompt(
    'reference_reader',
    {
      title: 'Read a reference image into a descriptor',
      description: 'Reads one reference image (generate_reference) into the structured descriptor, records it (record_reference), matches real products (match_reference) and writes the gap report (gap_report).',
      argsSchema: z.object({
        jobId: z.string().max(64).optional().describe('jobId of generate_reference.'),
        index: z.string().regex(/^[0-3]$/).optional().describe('Image number in that job, 0-3 (default 0).'),
        roomId: z.string().max(64).optional().describe('Room the image shows.'),
        styleId: z.string().max(40).optional().describe('Style the image was made for.'),
      }),
    },
    (args) => ({ messages: referenceReaderMessages({ jobId: args.jobId, index: num(args.index), roomId: args.roomId, styleId: args.styleId }) }),
  );
  server.registerPrompt(
    'close_the_gap',
    {
      title: 'Close the gap to a generated reference',
      description: 'One room or zone: decide the layout, generate a reference per camera view, read them, furnish with real products, then score our render against all views and fix, keeping the best iteration. Ends with the gap report, the bill of materials and a labelled visualisation.',
      argsSchema: z.object({
        roomId: z.string().max(64).describe('Room id.'),
        styleId: styleIdArg,
        zone: z.string().max(40).optional().describe('Floor zone to work on (living, kitchen); default: all zones.'),
        iterations: z.string().regex(/^[1-6]$/).optional().describe('Most score-and-fix rounds, 1-6 (default 3).'),
        budgetEur: budgetArg,
      }),
    },
    (args) => ({ messages: closeTheGapMessages({ roomId: args.roomId, styleId: args.styleId, zone: args.zone, iterations: num(args.iterations), budgetEur: num(args.budgetEur) }) }),
  );
  server.registerPrompt(
    'list_styles',
    { title: 'List the design styles', description: 'The available styles (id, name, summary) and roles, to choose from for design_flat_in_style.' },
    () => ({ messages: [text(`${styleListMarkdown()}\n\n${rolesListMarkdown()}`)] }),
  );
}

export function registerStyleResources(server: McpServer): void {
  const md = (uri: URL, t: string) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: t }] });
  server.registerResource('styles-list', 'styles://list', { title: 'Design styles', description: 'The style library: id, name and summary of each style.', mimeType: 'text/markdown' }, async (uri) => md(uri, styleListMarkdown()));
  server.registerResource('styles-roles', 'styles://roles', { title: 'Design roles (JSON)', description: 'The lead artist and room specialists: id, summary, rooms and allowed tools (JSON).', mimeType: 'application/json' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(rolesJson()) }],
  }));
  for (const s of library().styles) {
    server.registerResource(`style-${s.meta.id}`, `styles://${s.meta.id}`, { title: s.meta.name, description: s.meta.summary, mimeType: 'text/markdown' }, async (uri) => md(uri, styleMarkdown(s)));
  }
  for (const r of library().roles) {
    server.registerResource(`role-${r.meta.id}`, `styles://roles/${r.meta.id}`, { title: r.meta.name, description: r.meta.summary, mimeType: 'text/markdown' }, async (uri) => md(uri, findRole(r.meta.id).body));
  }
}

export function styleResourceUris(): string[] {
  return ['styles://list', 'styles://roles', ...library().styles.map((s) => `styles://${s.meta.id}`), ...library().roles.map((r) => `styles://roles/${r.meta.id}`)];
}
