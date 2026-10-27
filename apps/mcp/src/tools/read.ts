import { LightingView, describeRoom, listRooms, nearestIds } from '@flat/scene';
import { z } from 'zod';
import { toolError, toolOk } from '../errors';
import { buildMaterialListing, buildSummary, sessionLighting } from '../readModel';
import { READ, fetchScene, obj, parseArgs } from './common';
import type { ToolDef } from './registry';

/**
 * Read tools (M4.4). They only GET from the scene server (never POST) and are annotated read-only.
 * The pure parts (`listRooms`, `describeRoom`) live in `@flat/scene` (lane A).
 */

const MATERIAL_CATEGORIES = ['floor-wood', 'floor-tile', 'wall-plaster', 'wall-paper', 'stone', 'outdoor'] as const;

/** `YYYY-MM-DD` that is a real calendar date. */
export const RealDate = LightingView.shape.date.refine((d) => {
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}, 'not a real calendar date');

const SummaryArgs = z.strictObject({ detail: z.enum(['brief', 'full']).optional() });
const DescribeArgs = z.strictObject({ roomId: z.string().min(1).max(64), date: RealDate.optional() });
const MaterialsArgs = z.strictObject({ query: z.string().max(80).optional(), category: z.enum(MATERIAL_CATEGORIES).optional() });

export function readTools(): ToolDef[] {
  return [
    {
      name: 'get_scene_summary',
      description:
        'Overview of the flat: name, revision, site, counts, rooms (id, name, type, area), materials in use, defaults, session lighting date, history position. Start here. detail "full" adds finishes per room, all materials, lights and opening counts.',
      inputSchema: obj({ detail: { type: 'string', enum: ['brief', 'full'], description: 'brief (default, about 1.5k tokens) or full.' } }),
      annotations: READ,
      group: 'read',
      mutatesScene: false,
      async handler(ctx, args) {
        const a = parseArgs(SummaryArgs, args);
        if (!a.ok) return a.result;
        const s = await buildSummary(ctx, a.data.detail ?? 'brief');
        return s.ok ? toolOk(s.data) : s.result;
      },
    },
    {
      name: 'list_rooms',
      description: 'List the rooms: id, name, type, area, wall/floor/ceiling material ids, counts of windows, doors and lights.',
      inputSchema: obj({}),
      annotations: READ,
      group: 'read',
      mutatesScene: false,
      async handler(ctx, args) {
        const a = parseArgs(z.strictObject({}), args);
        if (!a.ok) return a.result;
        const sc = await fetchScene(ctx);
        if (!sc.ok) return sc.result;
        return toolOk({ ok: true, rev: sc.data.rev, rooms: listRooms(sc.data.scene) });
      },
    },
    {
      name: 'describe_room',
      description:
        'Describe one room: area, ceiling height, the wall faces that border it (structural flag, finish and where it comes from, compass facing, left/right side), openings with compass direction, lights, daylight factor and hours of direct sun for a date (default: the session date, see set_sun_time).',
      inputSchema: obj(
        {
          roomId: { type: 'string', description: 'Room id (see list_rooms).' },
          date: { type: 'string', description: 'Local date YYYY-MM-DD at the flat; default: the session lighting date.' },
        },
        ['roomId'],
      ),
      annotations: READ,
      group: 'read',
      mutatesScene: false,
      async handler(ctx, args) {
        const a = parseArgs(DescribeArgs, args);
        if (!a.ok) return a.result;
        const sc = await fetchScene(ctx);
        if (!sc.ok) return sc.result;
        const { scene, rev } = sc.data;
        const lighting = sessionLighting(ctx.session);
        const d = describeRoom(scene, a.data.roomId, a.data.date ? { ...lighting, date: a.data.date } : lighting);
        if (!d) {
          const ids = scene.rooms.map((r) => r.id);
          const near = nearestIds(a.data.roomId, ids);
          return toolError('unknown_room', `no room "${a.data.roomId}"`, `Did you mean ${near.map((x) => `"${x}"`).join(', ')}? Rooms: ${ids.join(', ')}.`);
        }
        return toolOk({ ok: true, ...d, rev });
      },
    },
    {
      name: 'list_materials',
      description:
        'List materials, one line per entry: the library textures you can use with material_define (kind "texture", textureUrl "lib:<slug>") and the materials already defined in this flat. Filter by text and/or library category.',
      inputSchema: obj({
        query: { type: 'string', maxLength: 80, description: 'Case-insensitive text to look for in slug, name or category.' },
        category: { type: 'string', enum: [...MATERIAL_CATEGORIES], description: 'Library category.' },
      }),
      annotations: READ,
      group: 'read',
      mutatesScene: false,
      async handler(ctx, args) {
        const a = parseArgs(MaterialsArgs, args);
        if (!a.ok) return a.result;
        const m = await buildMaterialListing(ctx, a.data);
        if (!m.ok) return m.result;
        const data = { ok: true as const, library: m.data.library, sceneMaterials: m.data.sceneMaterials };
        return { content: [{ type: 'text', text: m.data.text }], structuredContent: data };
      },
    },
  ];
}
