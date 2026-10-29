import { ALL_SWATCHES, normalizeHex, paintMaterial } from '@flat/scene';
import { materialFromCatalog } from '@flat/assets';
import type { BatchCommand, LeafCommand, Material, Sheen } from '@flat/scene';
import type { CatalogEntry } from '@flat/assets';

/** What a finish applies to. */
export type FinishScope =
  /** One wall side; with `roomId` only that room's stretch of it (a side can be shared by several rooms). */
  | { kind: 'wallSide'; wallId: string; side: 'left' | 'right' | 'both'; roomId?: string }
  /** Both faces of a wall at one spot, each within its adjoining room (`roomId` absent: a face no room sees, painted whole). */
  | { kind: 'wallFaces'; wallId: string; faces: { side: 'left' | 'right'; roomId?: string }[] }
  | { kind: 'roomWalls'; roomId: string }
  | { kind: 'floor'; roomId: string }
  /** One floor zone of a room; `resetTo` is the room's own floor material, what "reset" gives the zone (a zone always has a material). */
  | { kind: 'zone'; roomId: string; zoneId: string; resetTo?: string }
  | { kind: 'ceiling'; roomId: string };

/** Where the material comes from; `reset` clears the override (`materialId: null`). */
export type FinishSource =
  | { kind: 'paint'; hex: string; sheen: Sheen }
  | { kind: 'catalog'; entry: CatalogEntry }
  | { kind: 'reset' };

/** Display names used in labels (ids are used when absent). */
export interface FinishNames {
  /** Name of the room a room-level scope (walls, floor, ceiling) targets. */
  room?: string;
  /** Names of rooms by id, for room-scoped wall scopes. */
  rooms?: Record<string, string>;
  /** Names of floor zones by `<roomId>/<zoneId>`. */
  zones?: Record<string, string>;
}

/** Colour name of a hex: the palette swatch name when it is one, else the normalised hex. */
export function colourName(hex: string): string {
  const h = normalizeHex(hex);
  return ALL_SWATCHES.find((s) => s.hex === h)?.name ?? h;
}

/** Human name of a material: palette name plus sheen for paints of palette colours, else its own name. */
export function materialLabel(material: Pick<Material, 'name' | 'kind' | 'color' | 'id'>): string {
  if (material.kind !== 'paint') return material.name;
  const swatch = ALL_SWATCHES.find((s) => s.hex === material.color.toLowerCase());
  const sheen = /-(matt|satin|gloss)$/.exec(material.id)?.[1];
  return swatch ? `${swatch.name}${sheen ? ` (${sheen})` : ''}` : material.name;
}

export function scopeLabel(scope: FinishScope, names: FinishNames = {}): string {
  const room = (id: string) => names.room ?? id;
  switch (scope.kind) {
    case 'wallSide': {
      const where = scope.roomId ? ` in ${names.rooms?.[scope.roomId] ?? scope.roomId}` : '';
      return scope.side === 'both' ? `wall ${scope.wallId} both sides${where}` : `wall ${scope.wallId} ${scope.side} side${where}`;
    }
    case 'wallFaces': {
      const rooms = scope.faces.flatMap((f) => (f.roomId ? [names.rooms?.[f.roomId] ?? f.roomId] : []));
      return `wall ${scope.wallId} both faces here${rooms.length ? ` (${rooms.join(' / ')})` : ''}`;
    }
    case 'roomWalls':
      return `${room(scope.roomId)} walls`;
    case 'floor':
      return `${room(scope.roomId)} floor`;
    case 'zone':
      return `${names.zones?.[`${scope.roomId}/${scope.zoneId}`] ?? scope.zoneId} zone of ${names.rooms?.[scope.roomId] ?? room(scope.roomId)}`;
    case 'ceiling':
      return `${room(scope.roomId)} ceiling`;
  }
}

function finishCommands(scope: FinishScope, materialId: string | null): LeafCommand[] {
  switch (scope.kind) {
    case 'wallSide':
      return [{ type: 'wall.setFinish', wallId: scope.wallId, side: scope.side, materialId, ...(scope.roomId ? { roomId: scope.roomId } : {}) }];
    case 'wallFaces':
      return scope.faces.map((f) => ({ type: 'wall.setFinish', wallId: scope.wallId, side: f.side, materialId, ...(f.roomId ? { roomId: f.roomId } : {}) }));
    case 'roomWalls':
      return [{ type: 'room.setWallFinish', roomId: scope.roomId, materialId }];
    case 'floor':
      return [{ type: 'room.setFloor', roomId: scope.roomId, materialId }];
    case 'zone': {
      const material = materialId ?? scope.resetTo;
      return material === undefined ? [] : [{ type: 'room.setFloorZoneMaterial', roomId: scope.roomId, zoneId: scope.zoneId, material }];
    }
    case 'ceiling':
      return [{ type: 'room.setCeiling', roomId: scope.roomId, materialId }];
  }
}

/** The material a source defines (`undefined` for a reset). Paint ids are deterministic, so equal choices dedupe. */
export function sourceMaterial(source: FinishSource): Material | undefined {
  if (source.kind === 'paint') return paintMaterial(source.hex, source.sheen);
  if (source.kind === 'catalog') return materialFromCatalog(source.entry);
  return undefined;
}

/**
 * Builds the single undoable command for "apply this material to that scope": a `batch` of
 * `material.define` (idempotent) and the finish command, or just the finish command for a reset.
 */
export function buildFinishCommand(scope: FinishScope, source: FinishSource, names: FinishNames = {}): BatchCommand {
  const where = scopeLabel(scope, names);
  const material = sourceMaterial(source);
  if (!material) {
    return { type: 'batch', label: `Reset ${where} to default`, commands: finishCommands(scope, null) };
  }
  const what = source.kind === 'paint' ? colourName(source.hex) : material.name;
  const verb = source.kind === 'paint' ? 'Paint' : 'Texture';
  return {
    type: 'batch',
    label: `${verb} ${where} ${what}`,
    commands: [{ type: 'material.define', material }, ...finishCommands(scope, material.id)],
  };
}

/** Wall mouldings the finish panel offers; `none` removes them (the wall or room then follows the room / default). */
export type MouldingStyle = 'none' | 'frames' | 'dado' | 'frames+dado';
export const MOULDING_STYLES: readonly { value: MouldingStyle; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'frames', label: 'Frames' },
  { value: 'dado', label: 'Dado rail' },
  { value: 'frames+dado', label: 'Frames and dado rail' },
];
/** Cornice height (mm) the panel sets; the model takes 40-300. */
export const CORNICE_MM = 100;

/** The command setting (or removing) mouldings for a wall or room scope; undefined for scopes that have none. */
export function buildMouldingCommand(scope: FinishScope, style: MouldingStyle, names: FinishNames = {}): BatchCommand | undefined {
  const panelling = style === 'none' ? null : style;
  const what = style === 'none' ? 'Remove mouldings from' : `${MOULDING_STYLES.find((s) => s.value === style)!.label} on`;
  const label = `${what} ${scopeLabel(scope, names)}`;
  switch (scope.kind) {
    case 'wallSide':
      return { type: 'batch', label, commands: [{ type: 'wall.setFinish', wallId: scope.wallId, side: scope.side, panelling }] };
    case 'wallFaces':
      return { type: 'batch', label, commands: scope.faces.map((f) => ({ type: 'wall.setFinish', wallId: scope.wallId, side: f.side, panelling })) };
    case 'roomWalls':
      return { type: 'batch', label, commands: [{ type: 'room.setWallFinish', roomId: scope.roomId, panelling }] };
    default:
      return undefined;
  }
}

/** The command adding (`on`) or removing the ceiling cornice of a room. */
export function buildCorniceCommand(roomId: string, on: boolean, names: FinishNames = {}): BatchCommand {
  const name = names.room ?? roomId;
  return {
    type: 'batch',
    label: on ? `Add a cornice to ${name}` : `Remove the cornice of ${name}`,
    commands: [{ type: 'room.setWallFinish', roomId, corniceMm: on ? CORNICE_MM : null }],
  };
}

/** Parquet layouts the panel offers for floors. */
export type ParquetPattern = 'herringbone' | 'chevron';
export const PARQUET_PATTERNS: readonly { value: ParquetPattern; label: string }[] = [
  { value: 'herringbone', label: 'Herringbone' },
  { value: 'chevron', label: 'Chevron' },
];
export const PARQUET_TONES: readonly { hex: string; name: string }[] = [
  { hex: '#a47a4d', name: 'Honey oak' },
  { hex: '#c9a97a', name: 'Light oak' },
  { hex: '#6b4a32', name: 'Walnut' },
];

/** The parquet material for a pattern and wood tone; the id is deterministic, so equal choices share one material. */
export function parquetMaterial(pattern: ParquetPattern, hex: string): Material {
  const h = normalizeHex(hex);
  const tone = PARQUET_TONES.find((t) => t.hex === h)?.name ?? h;
  const layout = PARQUET_PATTERNS.find((p) => p.value === pattern)!.label;
  return { id: `parquet-${pattern}-${h.slice(1)}`, name: `${layout} parquet, ${tone}`, kind: 'paint', color: h, roughness: 0.55, pattern };
}

/** The command laying a herringbone or chevron floor on a floor or floor-zone scope; undefined for other scopes. */
export function buildParquetCommand(scope: FinishScope, pattern: ParquetPattern, hex: string, names: FinishNames = {}): BatchCommand | undefined {
  if (scope.kind !== 'floor' && scope.kind !== 'zone') return undefined;
  const material = parquetMaterial(pattern, hex);
  return { type: 'batch', label: `${material.name} on ${scopeLabel(scope, names)}`, commands: [{ type: 'material.define', material }, ...finishCommands(scope, material.id)] };
}
