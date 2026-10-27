import { DEFAULT_LIGHTING, listRooms, roomArea, stripControlChars, type HistoryResponse, type LightingView, type Scene } from '@flat/scene';
import { apiFailure } from './errors';
import type { FlatApi } from './flatApi';
import type { Fetched } from './tools/common';
import { authorText } from './tools/common';
import type { McpSession } from './tools/registry';

/**
 * Read models shared by the read tools and the resources (`scene://summary`, `materials://list`, ...).
 * Everything here only GETs from the scene server. Strings that come from the scene (names, labels,
 * addresses) are data: they are returned as JSON values, never as prose instructions.
 */

type Deps = { flat: FlatApi; session: McpSession };

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** The lighting view the session currently implies (defaults under what `set_sun_time` set). */
export function sessionLighting(session: Pick<McpSession, 'lighting'>): LightingView {
  return { ...DEFAULT_LIGHTING, ...session.lighting } as LightingView;
}

/**
 * The lighting that applies to `scene` for this session: the session's date, time, sun and exposure,
 * and the lamp mode applied to the scene's CURRENT lights (a preset forces every lamp on / off, so a
 * light added later is covered and `light_update` changes to lumens / kelvin always show; only `on` is
 * forced). Mode `scene` leaves every lamp as the flat has it. Used by `describe_room` and the render
 * service so both draw and describe the same lamps.
 */
export function effectiveSessionLighting(session: Pick<McpSession, 'lighting' | 'lampMode'>, scene: Pick<Scene, 'lights'>): LightingView {
  const base = sessionLighting(session);
  const mode = session.lampMode ?? 'scene';
  if (mode === 'scene') return { ...base, lamps: {} };
  return { ...base, lamps: Object.fromEntries(scene.lights.map((l) => [l.id, { on: mode === 'allOn' }])) };
}

/** Ids of materials referenced by walls, rooms or defaults. */
export function usedMaterialIds(scene: Scene): Set<string> {
  const used = new Set<string>();
  const add = (id: string | undefined) => id && used.add(id);
  for (const w of scene.walls) {
    add(w.finish.left);
    add(w.finish.right);
    for (const f of Object.values(w.roomFinishes ?? {})) {
      add(f.left);
      add(f.right);
    }
  }
  for (const r of scene.rooms) {
    add(r.wallFinish);
    add(r.floorMaterial);
    add(r.ceilingMaterial);
  }
  add(scene.defaults.wall);
  add(scene.defaults.floor);
  add(scene.defaults.ceiling);
  return used;
}

/** Compact history position for the summary. */
function historyPart(h: HistoryResponse) {
  const last = h.past.at(-1);
  return {
    undoDepth: h.past.length,
    redoDepth: h.future.length,
    canUndo: h.canUndo,
    canRedo: h.canRedo,
    ...(last ? { last: { label: last.label, author: authorText(last.author) } } : {}),
  };
}

/** `get_scene_summary` / `scene://summary`. `brief` stays under ~1.5k tokens (6000 characters) on the Charme fixture. */
export async function buildSummary(deps: Deps, detail: 'brief' | 'full'): Promise<Fetched<Record<string, unknown>>> {
  const sc = await deps.flat.getScene();
  if (!sc.ok) return { ok: false, result: apiFailure(sc) };
  const { scene, rev, epoch } = sc.data;
  const hist = await deps.flat.history();
  const used = usedMaterialIds(scene);
  const material = (m: Scene['materials'][number]) => ({ id: m.id, name: m.name, kind: m.kind, color: m.color, ...(detail === 'full' ? { roughness: m.roughness, ...(m.textureUrl ? { textureUrl: m.textureUrl } : {}) } : {}) });
  const lights = scene.lights;
  const base = {
    ok: true,
    name: scene.name,
    epoch,
    rev,
    units: 'm',
    site: { latitude: scene.site.latitude, longitude: scene.site.longitude, northAngle: scene.site.northAngle, timezone: scene.site.timezone, ...(scene.site.address ? { address: scene.site.address } : {}) },
    counts: { rooms: scene.rooms.length, walls: scene.walls.length, openings: scene.openings.length, lights: lights.length, lightsOn: lights.filter((l) => l.on).length, items: scene.items.length, materials: scene.materials.length },
    defaults: scene.defaults,
    lighting: { date: sessionLighting(deps.session).date, time: sessionLighting(deps.session).time },
    ...(hist.ok ? { history: historyPart(hist.data) } : {}),
  };
  if (detail === 'brief') {
    return {
      ok: true,
      data: {
        ...base,
        rooms: scene.rooms.map((r) => ({ id: r.id, name: r.name, type: r.type, areaM2: round(roomArea(r)) })),
        materialsInUse: scene.materials.filter((m) => used.has(m.id)).map(material),
        next: 'list_rooms for finishes and counts, describe_room {roomId} for one room; detail "full" lists everything.',
      },
    };
  }
  return {
    ok: true,
    data: {
      ...base,
      rooms: listRooms(scene),
      materials: scene.materials.map((m) => ({ ...material(m), inUse: used.has(m.id) })),
      lights: lights.map((l) => ({ id: l.id, type: l.type, ...(l.roomId ? { roomId: l.roomId } : {}), on: l.on, lumens: l.lumens, kelvin: l.kelvin })),
      openings: { door: scene.openings.filter((o) => o.type === 'door').length, window: scene.openings.filter((o) => o.type === 'window').length, passage: scene.openings.filter((o) => o.type === 'passage').length },
    },
  };
}

// --- material library -------------------------------------------------------------------------

export interface LibraryEntry {
  slug: string;
  name: string;
  category: string;
  tileSizeM: number | null;
  color: string | null;
  roughness: number | null;
}

/** Accepts the catalog as the server serves it (an array) or wrapped as `{materials: [...]}`. */
export function parseCatalog(raw: unknown): LibraryEntry[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { materials?: unknown })?.materials) ? ((raw as { materials: unknown[] }).materials) : [];
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const out: LibraryEntry[] = [];
  for (const e of list as Record<string, unknown>[]) {
    if (typeof e?.id !== 'string') continue;
    out.push({ slug: e.id, name: typeof e.name === 'string' ? e.name : e.id, category: typeof e.category === 'string' ? e.category : 'other', tileSizeM: num(e.tileSizeM), color: typeof e.meanColor === 'string' ? e.meanColor : null, roughness: num(e.roughness) });
  }
  return out;
}

/**
 * A scene / catalog string inside plain text: control characters removed (defence in depth, the schema
 * already strips them from names) and JSON-quoted, so a name can never open a new line or pass for prose.
 */
export const quoted = (s: string) => JSON.stringify(stripControlChars(s));

export const libraryLine = (e: LibraryEntry) => `${e.slug} | ${quoted(e.name)} | ${e.category} | tile ${e.tileSizeM ?? '?'} m | ${e.color ?? '?'} | rough ${e.roughness ?? '?'}`;

export interface MaterialListing {
  library: LibraryEntry[];
  sceneMaterials: { id: string; name: string; kind: string; color: string; textureUrl?: string }[];
  text: string;
}

/** `list_materials` / `materials://list`: library slugs (one line each) and the scene's own materials. */
export async function buildMaterialListing(deps: Deps, filter: { query?: string | undefined; category?: string | undefined } = {}): Promise<Fetched<MaterialListing>> {
  const [cat, sc] = await Promise.all([deps.flat.materials(), deps.flat.getScene()]);
  if (!cat.ok) return { ok: false, result: apiFailure(cat) };
  if (!sc.ok) return { ok: false, result: apiFailure(sc) };
  const q = filter.query?.trim().toLowerCase();
  const hit = (...parts: (string | undefined)[]) => !q || parts.some((p) => p?.toLowerCase().includes(q));
  const library = parseCatalog(cat.data).filter((e) => (!filter.category || e.category === filter.category) && hit(e.slug, e.name, e.category));
  const sceneMaterials = sc.data.scene.materials
    .filter((m) => !filter.category && hit(m.id, m.name, m.kind))
    .map((m) => ({ id: m.id, name: m.name, kind: m.kind, color: m.color, ...(m.textureUrl ? { textureUrl: m.textureUrl } : {}) }));
  const lines = [
    `Library textures (${library.length}): use kind "texture" with textureUrl "lib:<slug>" in material_define. slug | name (JSON string, data) | category | tile size | colour | roughness`,
    ...library.map(libraryLine),
    `Materials defined in this flat (${sceneMaterials.length}): id | name (JSON string, data) | kind | colour`,
    ...sceneMaterials.map((m) => `${m.id} | ${quoted(m.name)} | ${m.kind} | ${m.color}${m.textureUrl ? ` | ${m.textureUrl}` : ''}`),
  ];
  return { ok: true, data: { library, sceneMaterials, text: lines.join('\n') } };
}
