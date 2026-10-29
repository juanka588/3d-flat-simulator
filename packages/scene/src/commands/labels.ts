import type { CompassPoint } from '../mcp-types';
import { planDirectionToCompass } from '../describe';
import type { Light, Material, Room, Scene, Vec2, Wall } from '../schema';
import { wallLeftNormal } from '../schema';
import { BUILTIN_ASSETS } from '../items/builtin-assets';
import { pointInPolygon } from '../validate';
import type { Command, LeafCommand } from './schema';

/**
 * Human-readable one-line label for a command, e.g. "Paint Séjour walls Sage (matt)" or
 * "Set latitude to 48.79". Pure: names come from `scene`, which should be the scene the command is
 * applied to (so removed things can still be named). Unknown ids fall back to the id itself; the
 * label never throws and is never empty.
 */
export function describeCommand(cmd: Command, scene: Scene): string {
  try {
    const text = cmd.type === 'batch' ? describeBatch(cmd, scene) : describeLeaf(cmd, scene);
    return text.trim() || cmd.type;
  } catch {
    return cmd.type;
  }
}

const MAX_LABEL = 200;
const clip = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s);

function describeBatch(cmd: Extract<Command, { type: 'batch' }>, scene: Scene): string {
  const label = cmd.label.trim();
  if (label) return label;
  if (cmd.commands.length === 0) return 'No changes';
  if (cmd.commands.length === 1) return describeLeaf(cmd.commands[0]!, scene);
  const parts = cmd.commands.slice(0, 3).map((c) => describeLeaf(c, scene));
  return clip(`${cmd.commands.length} changes: ${parts.join('; ')}${cmd.commands.length > 3 ? '; …' : ''}`);
}

const num = (n: number) => String(Math.round(n * 10000) / 10000);

function materialName(scene: Scene, id: string | null | undefined): string {
  if (id === null || id === undefined) return 'default';
  const m = scene.materials.find((x) => x.id === id);
  return m ? paintName(m) : id;
}

/** "Sage (matt)": paints carry their sheen, textures just their name. */
function paintName(m: Material): string {
  if (m.kind !== 'paint') return m.name;
  const r = m.roughness ?? 0.9;
  return `${m.name} (${r >= 0.8 ? 'matt' : r >= 0.4 ? 'satin' : 'gloss'})`;
}

/** "Séjour / Cuisine" -> "Séjour": the first name of a combined room keeps labels short. */
const shortName = (name: string) => name.split(' / ')[0]!.trim() || name;

function roomName(scene: Scene, id: string): string {
  const r = scene.rooms.find((x) => x.id === id);
  return r ? shortName(r.name) : id;
}

function lightName(scene: Scene, id: string): string {
  const l = scene.lights.find((x) => x.id === id);
  return l ? lightTitle(scene, l) : id;
}

function lightTitle(scene: Scene, l: Pick<Light, 'id' | 'name' | 'roomId' | 'type'> & { rows?: number; cols?: number }): string {
  if (l.name) return l.name;
  const kind = l.type === 'grid' && l.rows !== undefined && l.cols !== undefined ? `${l.rows}×${l.cols} downlight grid` : `${l.type} light`;
  return l.roomId ? `${roomName(scene, l.roomId)} ${kind}` : `${kind} ${l.id}`;
}

const COMPASS_WORD: Record<CompassPoint, string> = {
  N: 'north',
  NE: 'north-east',
  E: 'east',
  SE: 'south-east',
  S: 'south',
  SW: 'south-west',
  W: 'west',
  NW: 'north-west',
};

/** The room on one face of a wall (probed just beyond the face at the wall's middle). */
function roomOnFace(scene: Scene, wall: Wall, side: 'left' | 'right'): Room | undefined {
  const n = wallLeftNormal(wall);
  const sign = side === 'left' ? 1 : -1;
  const d = wall.thickness / 2 + 0.05;
  const p: Vec2 = [(wall.start[0] + wall.end[0]) / 2 + sign * n[0] * d, (wall.start[1] + wall.end[1]) / 2 + sign * n[1] * d];
  return scene.rooms.find((r) => pointInPolygon(p, r.polygon, 1e-6));
}

/** "west wall (Séjour side)": the wall as seen from the room it borders; falls back to the wall id. */
function wallTitle(scene: Scene, wallId: string, side: 'left' | 'right' | 'both' | null, roomId?: string): string {
  const wall = scene.walls.find((w) => w.id === wallId);
  if (!wall) return `wall ${wallId}`;
  const n = wallLeftNormal(wall);
  let face: 'left' | 'right' | null = side === 'left' || side === 'right' ? side : null;
  let room: Room | undefined = roomId ? scene.rooms.find((r) => r.id === roomId) : undefined;
  if (room) {
    // The face on which that room lies (when it lies on both, e.g. a thin sliver, keep the stated side).
    const left = roomOnFace(scene, wall, 'left')?.id === room.id;
    const right = roomOnFace(scene, wall, 'right')?.id === room.id;
    if (left !== right) face = left ? 'left' : 'right';
  } else if (face) {
    room = roomOnFace(scene, wall, face);
  }
  if (!face) return room ? `wall ${wallId} (${shortName(room.name)} side)` : `wall ${wallId}`;
  // Direction from the room across the wall: against the face normal.
  const outward: Vec2 = face === 'left' ? [-n[0], -n[1]] : n;
  const dir = COMPASS_WORD[planDirectionToCompass(outward, scene.site.northAngle)];
  return room ? `${dir} wall (${shortName(room.name)} side)` : `${dir} wall ${wallId}`;
}

/** Name of an item: its product name, else the builtin asset's, else its id. */
function itemTitle(item: { id: string; assetId?: string; product?: { name: string } } | undefined, fallback: string): string {
  if (!item) return fallback;
  if (item.product) return item.product.name;
  const builtin = item.assetId ? BUILTIN_ASSETS[item.assetId] : undefined;
  return builtin ? builtin.name : item.id;
}

function itemName(scene: Scene, id: string): string {
  return itemTitle(scene.items.find((i) => i.id === id), id);
}

function zoneName(scene: Scene, roomId: string, zoneId: string): string {
  const zone = scene.rooms.find((r) => r.id === roomId)?.floorZones?.find((z) => z.id === zoneId);
  return zone?.name ?? zoneId;
}

function roomOfPosition(scene: Scene, roomId: string | undefined, position: Vec2): string | undefined {
  if (roomId) return roomName(scene, roomId);
  const r = scene.rooms.find((x) => pointInPolygon(position, x.polygon, 1e-6));
  return r ? shortName(r.name) : undefined;
}

const REF_VERB = (scene: Scene, id: string | null | undefined) => {
  const m = id ? scene.materials.find((x) => x.id === id) : undefined;
  return m?.kind === 'paint' ? 'Paint' : 'Finish';
};

function describeLeaf(c: LeafCommand, scene: Scene): string {
  switch (c.type) {
    case 'material.define': {
      const exists = scene.materials.some((m) => m.id === c.material.id);
      return `${exists ? 'Update' : 'Define'} material ${paintName(c.material as Material)}`;
    }
    case 'material.remove': {
      const m = scene.materials.find((x) => x.id === c.id);
      return `Remove material ${m ? m.name : c.id}`;
    }
    case 'wall.setFinish': {
      const wall = wallTitle(scene, c.wallId, c.side, c.roomId);
      if (c.materialId === undefined) return clip(c.panelling ? `Panelling ${c.panelling} on ${wall}` : c.panelling === null ? `Remove panelling from ${wall}` : `Panelling colour of ${wall}`);
      const mat = materialName(scene, c.materialId);
      if (c.materialId === null) return `Clear finish of ${wall}`;
      return `${REF_VERB(scene, c.materialId)} ${wall} ${mat}`;
    }
    case 'wall.setStructural': {
      const wall = c.wallId;
      if (c.structural === true) return `Mark ${wall} as structural`;
      if (c.structural === false) return `Mark ${wall} as removable`;
      return `Reset ${wall} to its default structural status`;
    }
    case 'room.setWallFinish':
      if (c.materialId === undefined) {
        const parts = [c.panelling === undefined ? (c.panelColour === undefined ? '' : 'panelling colour') : c.panelling ? `panelling ${c.panelling}` : 'no panelling', c.corniceMm === undefined ? '' : c.corniceMm ? 'cornice' : 'no cornice'].filter(Boolean);
        return clip(`${roomName(scene, c.roomId)} walls: ${parts.join(', ')}`);
      }
      return c.materialId === null
        ? `Clear ${roomName(scene, c.roomId)} wall finish`
        : `${REF_VERB(scene, c.materialId)} ${roomName(scene, c.roomId)} walls ${materialName(scene, c.materialId)}`;
    case 'room.setFloor':
      return `Floor of ${roomName(scene, c.roomId)} → ${materialName(scene, c.materialId)}`;
    case 'room.setCeiling':
      return `Ceiling of ${roomName(scene, c.roomId)} → ${materialName(scene, c.materialId)}`;
    case 'room.setFloorZone': {
      const exists = scene.rooms.find((r) => r.id === c.roomId)?.floorZones?.some((z) => z.id === c.zone.id);
      return clip(`${exists ? 'Update' : 'Add'} floor zone ${c.zone.name ?? c.zone.id} in ${roomName(scene, c.roomId)} → ${materialName(scene, c.zone.material)}`);
    }
    case 'room.removeFloorZone':
      return clip(`Remove floor zone ${zoneName(scene, c.roomId, c.zoneId)} from ${roomName(scene, c.roomId)}`);
    case 'room.setFloorZoneMaterial':
      return clip(`Floor zone ${zoneName(scene, c.roomId, c.zoneId)} of ${roomName(scene, c.roomId)} → ${materialName(scene, c.material)}`);
    case 'scene.setDefaults': {
      const parts = (['wall', 'floor', 'ceiling'] as const).filter((k) => c[k] !== undefined).map((k) => `${k} → ${materialName(scene, c[k])}`);
      return parts.length ? `Default ${parts.join(', ')}` : 'Set defaults';
    }
    case 'site.set': {
      const s = c.site;
      const parts: string[] = [];
      if (s.latitude !== undefined) parts.push(`latitude to ${num(s.latitude)}`);
      if (s.longitude !== undefined) parts.push(`longitude to ${num(s.longitude)}`);
      if (s.northAngle !== undefined) parts.push(`north angle to ${num(s.northAngle)}°`);
      if (s.timezone !== undefined) parts.push(`time zone to ${s.timezone}`);
      if (s.floorElevation !== undefined) parts.push(`floor elevation to ${num(s.floorElevation)} m`);
      if (s.address === null) parts.push('address cleared');
      else if (s.address !== undefined) parts.push(`address to ${s.address}`);
      return parts.length ? clip(`Set ${parts.join(', ')}`) : 'Set site';
    }
    case 'light.add': {
      const l = c.light;
      if (l.type === 'grid') return clip(`Add ${l.name ?? `${l.rows}×${l.cols} downlight grid`}${l.roomId ? ` in ${roomName(scene, l.roomId)}` : ''} (${num(l.rows * l.cols * l.lumensEach)} lm)`);
      return `Add ${l.name ?? `${l.type} light`}${l.roomId ? ` in ${roomName(scene, l.roomId)}` : ''}`;
    }
    case 'light.remove':
      return `Remove ${lightName(scene, c.id)}`;
    case 'light.update':
      return describeLightUpdate(c, scene);
    case 'item.place': {
      const where = roomOfPosition(scene, c.item.roomId, c.item.position);
      return clip(`Placed ${itemTitle({ id: c.item.id ?? 'item', assetId: c.item.assetId, ...(c.item.product ? { product: c.item.product } : {}) }, 'item')}${where ? ` in ${where}` : ''}`);
    }
    case 'item.move': {
      const item = scene.items.find((i) => i.id === c.id);
      const where = item ? roomOfPosition(scene, c.roomId === null ? undefined : (c.roomId ?? item.roomId), c.position) : undefined;
      return clip(`Moved ${itemName(scene, c.id)}${where ? ` in ${where}` : ''}`);
    }
    case 'item.rotate':
      return clip(`Rotated ${itemName(scene, c.id)} to ${num(c.rotation)}°`);
    case 'item.setVariant':
      return clip(c.variant === null ? `Reset the variant of ${itemName(scene, c.id)}` : `Changed ${itemName(scene, c.id)} to variant ${c.variant}`);
    case 'item.remove': {
      const item = scene.items.find((i) => i.id === c.id);
      const where = item ? roomOfPosition(scene, item.roomId, item.position) : undefined;
      return clip(`Removed ${itemName(scene, c.id)}${where ? ` from ${where}` : ''}`);
    }
    default:
      return (c as { type: string }).type;
  }
}

function describeLightUpdate(c: Extract<LeafCommand, { type: 'light.update' }>, scene: Scene): string {
  const p = c.patch;
  const name = lightName(scene, c.id);
  const bits: string[] = [];
  if (p.on !== undefined && Object.keys(p).filter((k) => (p as Record<string, unknown>)[k] !== undefined).length === 1) {
    return `Turn ${p.on ? 'on' : 'off'} ${name}`;
  }
  if (p.on !== undefined) bits.push(p.on ? 'on' : 'off');
  if (p.kelvin !== undefined) bits.push(`${num(p.kelvin)} K`);
  if (p.rows !== undefined || p.cols !== undefined) {
    const g = scene.lights.find((x) => x.id === c.id);
    const rows = p.rows ?? (g?.type === 'grid' ? g.rows : undefined);
    const cols = p.cols ?? (g?.type === 'grid' ? g.cols : undefined);
    bits.push(rows !== undefined && cols !== undefined ? `${rows}×${cols} fixtures` : 'resized grid');
  }
  if (p.lumensEach !== undefined) bits.push(`${num(p.lumensEach)} lm each`);
  if (p.fitToRoom === true) bits.push('fitted to its room');
  if (p.lumens !== undefined) bits.push(`${num(p.lumens)} lm`);
  if (p.elevation !== undefined) bits.push(`at ${num(p.elevation)} m`);
  if (p.position !== undefined) bits.push('moved');
  if (p.angle !== undefined) bits.push(`${num(p.angle)}° cone`);
  if (p.width !== undefined || p.depth !== undefined) bits.push('resized');
  if (p.rotation !== undefined) bits.push(`rotated ${num(p.rotation)}°`);
  if (p.roomId !== undefined) bits.push(p.roomId === null ? 'unassigned from its room' : `in ${roomName(scene, p.roomId)}`);
  if (p.name !== undefined) bits.push(p.name === null ? 'name cleared' : `renamed ${p.name}`);
  return bits.length ? `${name} ${bits.join(', ')}` : `Update ${name}`;
}
