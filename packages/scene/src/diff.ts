import { DIFF_MAX_ENTRIES, type EntityDiff, type FieldChange, type SceneDiff } from './mcp-types';
import type { Scene } from './schema';

/**
 * Structural diff of two scenes (M4.3, lane A), used for `preview` results, write summaries and
 * `compare`. Deterministic (entities sorted by kind in the order material, wall, opening, room,
 * item, light, site, defaults, then by id; fields sorted by path), `diffScenes(a, a)` has no
 * changes, and applying a command to `a` to get `b` yields the same diff whether `b` came from a
 * preview or from the committed scene. Covers materials, walls (incl. finish / roomFinishes /
 * structural), openings, rooms, items, lights, site and defaults. At most `DIFF_MAX_ENTRIES`
 * entries are listed (`truncated: true` when more changed); `summary` always counts them all.
 * Field paths are dotted (`finish.left`, `roomFinishes.sejour.right`); arrays are compared as
 * whole values (`polygon`). Added/removed entities carry no `fields`.
 */
export function diffScenes(before: Scene, after: Scene): SceneDiff {
  const all: EntityDiff[] = [];
  const collections = [
    ['material', before.materials, after.materials],
    ['wall', before.walls, after.walls],
    ['opening', before.openings, after.openings],
    ['room', before.rooms, after.rooms],
    ['item', before.items, after.items],
    ['light', before.lights, after.lights],
  ] as const;
  for (const [kind, a, b] of collections) {
    const A = new Map<string, Entity>((a as readonly Entity[]).map((e) => [e.id, e]));
    const B = new Map<string, Entity>((b as readonly Entity[]).map((e) => [e.id, e]));
    for (const id of [...new Set([...A.keys(), ...B.keys()])].sort(cmp)) {
      const x = A.get(id);
      const y = B.get(id);
      const label = labelOf(y ?? x);
      if (!x) all.push({ kind, id, change: 'added', fields: [], ...label });
      else if (!y) all.push({ kind, id, change: 'removed', fields: [], ...label });
      else if (x !== y) {
        const fields = diffFields(x, y);
        if (fields.length) all.push({ kind, id, change: 'modified', fields, ...label });
      }
    }
  }
  for (const [kind, a, b] of [
    ['site', before.site, after.site],
    ['defaults', before.defaults, after.defaults],
  ] as const) {
    const fields = diffFields(a, b);
    if (fields.length) all.push({ kind, id: kind, change: 'modified', fields });
  }

  const summary = { added: 0, removed: 0, modified: 0 };
  for (const c of all) summary[c.change]++;
  const changes = all.slice(0, DIFF_MAX_ENTRIES);
  return {
    changes,
    ...(all.length > changes.length ? { truncated: true } : {}),
    summary,
    text: describe(all, all.length - changes.length),
  };
}

type Entity = { id: string; name?: string };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const labelOf = (e: Entity | undefined) => (e?.name ? { label: e.name } : {});

type Json = unknown;

function flatten(value: Json, path: string, out: Map<string, Json>): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, Json>)) {
      if (v !== undefined) flatten(v, path ? `${path}.${k}` : k, out);
    }
  } else if (value !== undefined) {
    out.set(path, value);
  }
}

function sameJson(a: Json, b: Json): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function diffFields(a: object, b: object): FieldChange[] {
  const fa = new Map<string, Json>();
  const fb = new Map<string, Json>();
  flatten(a, '', fa);
  flatten(b, '', fb);
  const out: FieldChange[] = [];
  for (const field of [...new Set([...fa.keys(), ...fb.keys()])].sort(cmp)) {
    const x = fa.get(field);
    const y = fb.get(field);
    if (sameJson(x, y)) continue;
    out.push({ field, ...(x !== undefined ? { before: x } : {}), ...(y !== undefined ? { after: y } : {}) });
  }
  return out;
}

const PLURAL: Record<EntityDiff['kind'], string> = {
  material: 'materials',
  wall: 'walls',
  opening: 'openings',
  room: 'rooms',
  item: 'items',
  light: 'lights',
  site: 'site',
  defaults: 'defaults',
};

function describe(all: EntityDiff[], omitted: number): string {
  if (all.length === 0) return 'no changes';
  const groups = new Map<string, EntityDiff[]>();
  for (const c of all) {
    const key = `${c.kind}|${c.change}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const parts: string[] = [];
  for (const list of groups.values()) {
    const first = list[0]!;
    const noun = list.length === 1 || first.kind === 'site' || first.kind === 'defaults' ? first.kind : PLURAL[first.kind];
    const names = list.slice(0, 3).map((c) => c.label ?? c.id);
    const more = list.length > 3 ? `, +${list.length - 3}` : '';
    const who = first.kind === 'site' || first.kind === 'defaults' ? '' : ` (${names.join(', ')}${more})`;
    parts.push(`${first.kind === 'site' || first.kind === 'defaults' ? '' : `${list.length} `}${noun} ${first.change}${who}`);
  }
  return parts.join('; ') + (omitted > 0 ? `; ${omitted} more not listed` : '');
}
