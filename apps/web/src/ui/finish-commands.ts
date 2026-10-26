import { ALL_SWATCHES, materialFromCatalog, normalizeHex, paintMaterial } from '@flat/scene';
import type { BatchCommand, CatalogEntry, LeafCommand, Material, Sheen } from '@flat/scene';

/** What a finish applies to. */
export type FinishScope =
  | { kind: 'wallSide'; wallId: string; side: 'left' | 'right' | 'both' }
  | { kind: 'roomWalls'; roomId: string }
  | { kind: 'floor'; roomId: string }
  | { kind: 'ceiling'; roomId: string };

/** Where the material comes from; `reset` clears the override (`materialId: null`). */
export type FinishSource =
  | { kind: 'paint'; hex: string; sheen: Sheen }
  | { kind: 'catalog'; entry: CatalogEntry }
  | { kind: 'reset' };

/** Display names used in labels (ids are used when absent). */
export interface FinishNames {
  room?: string;
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
    case 'wallSide':
      return scope.side === 'both' ? `wall ${scope.wallId} both sides` : `wall ${scope.wallId} ${scope.side} side`;
    case 'roomWalls':
      return `${room(scope.roomId)} walls`;
    case 'floor':
      return `${room(scope.roomId)} floor`;
    case 'ceiling':
      return `${room(scope.roomId)} ceiling`;
  }
}

function finishCommand(scope: FinishScope, materialId: string | null): LeafCommand {
  switch (scope.kind) {
    case 'wallSide':
      return { type: 'wall.setFinish', wallId: scope.wallId, side: scope.side, materialId };
    case 'roomWalls':
      return { type: 'room.setWallFinish', roomId: scope.roomId, materialId };
    case 'floor':
      return { type: 'room.setFloor', roomId: scope.roomId, materialId };
    case 'ceiling':
      return { type: 'room.setCeiling', roomId: scope.roomId, materialId };
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
    return { type: 'batch', label: `Reset ${where} to default`, commands: [finishCommand(scope, null)] };
  }
  const what = source.kind === 'paint' ? colourName(source.hex) : material.name;
  const verb = source.kind === 'paint' ? 'Paint' : 'Texture';
  return {
    type: 'batch',
    label: `${verb} ${where} ${what}`,
    commands: [{ type: 'material.define', material }, finishCommand(scope, material.id)],
  };
}
