import { DEFAULT_CEILING_HEIGHT, DEFAULT_WALL_MOUNT_ELEVATION_M, itemCoalesceKey, meshAssetId, productSnapshot } from '@flat/scene';
import type { Command, Dims, Item, ItemMount, MeshSource, ProductRecord, ProductSnapshot, Relation, Vec2 } from '@flat/scene';
import { generatorTitle } from './generator-titles';
import type { GhostPose, GhostSubject } from './ghost';

/** What a drag carries: everything `item.place` needs except the pose. */
export interface PlaceSource {
  /** Shown on the card, the ghost tip and history labels. */
  label: string;
  assetId: string;
  dims: Dims;
  mount: ItemMount;
  /** Default height of the bottom for wall and ceiling mounts. */
  elevation: number;
  weightKg?: number;
  mesh?: MeshSource;
  productRef?: { provider: string; sku: string };
  /** Present for product sources; built from the server record at drop time (see `withSnapshot`). */
  product?: ProductSnapshot;
  /** Library item without a product (users only): flagged "no product" in the properties. */
  noProduct?: boolean;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Default elevation of the item bottom for a mount: 0 on the floor, the usual wall-mount height on a wall, and
 * hanging from the ceiling (`ceilingHeight - h`) for a ceiling mount (the drag then uses the room's own ceiling).
 */
export function defaultElevation(mount: ItemMount, h = 0, ceilingHeight: number = DEFAULT_CEILING_HEIGHT): number {
  if (mount === 'wall') return DEFAULT_WALL_MOUNT_ELEVATION_M;
  if (mount === 'ceiling') return Math.max(0, round3(ceilingHeight - h));
  return 0;
}

/** A source for a product from its search summary or full record (the snapshot is added from the record at drop). */
export function productSource(p: { provider: string; sku?: string; productId?: string; name: string; dims: Dims; mount: ItemMount; weightKg?: number; has3d?: boolean; modelRef?: string }): PlaceSource {
  const sku = p.sku ?? p.productId?.slice(p.provider.length + 1) ?? '';
  const has3d = p.has3d ?? p.modelRef !== undefined;
  const mesh: MeshSource | undefined = has3d ? { kind: 'provider' } : undefined;
  return {
    label: p.name,
    assetId: meshAssetId({ kind: 'provider' }, { provider: p.provider }),
    dims: p.dims,
    mount: p.mount,
    elevation: defaultElevation(p.mount, p.dims.h),
    ...(p.weightKg !== undefined ? { weightKg: p.weightKg } : {}),
    ...(mesh ? { mesh } : {}),
    productRef: { provider: p.provider, sku },
  };
}

/** A source for a parametric generator at the dims it promises. */
export function generatorSource(g: { id: string; label?: string }, params: Record<string, number | string | boolean>, dims: Dims, mount: ItemMount = 'floor'): PlaceSource {
  const mesh: MeshSource = { kind: 'parametric', generator: g.id, params };
  return { label: generatorTitle(g), assetId: meshAssetId(mesh), dims: { w: round3(dims.w), d: round3(dims.d), h: round3(dims.h) }, mount, elevation: defaultElevation(mount, dims.h), mesh, noProduct: true };
}

/** Where a library model hangs, from its style tags: `pendant` / `ceiling` -> ceiling, `wall mounted` -> wall, else floor. */
export function libraryMount(styleTags: readonly string[]): ItemMount {
  const tags = styleTags.map((t) => t.toLowerCase());
  if (tags.includes('pendant') || tags.includes('ceiling')) return 'ceiling';
  if (tags.includes('wall mounted')) return 'wall';
  return 'floor';
}

/** A source for a library (CC0 / CC-BY) model at its native dims. */
export function libraryModelSource(a: { id: string; name: string; nativeDims: Dims }, mount: ItemMount = 'floor'): PlaceSource {
  const mesh: MeshSource = { kind: 'lookalike', assetId: a.id };
  const d = a.nativeDims;
  return { label: a.name, assetId: meshAssetId(mesh), dims: { w: round3(d.w), d: round3(d.d), h: round3(d.h) }, mount, elevation: defaultElevation(mount, d.h), mesh, noProduct: true };
}

export const subjectOf = (s: PlaceSource, id?: string): GhostSubject => ({ ...(id !== undefined ? { id } : {}), dims: s.dims, mount: s.mount, ...(s.weightKg !== undefined ? { weightKg: s.weightKg } : {}) });

/**
 * The snapshot stored with a placed product: from the server record, TTC only. It is stamped with the record's
 * own `fetchedAt` (when the price was actually read), NOT the placement time, so a record that sat in a cache
 * does not pass for fresh and the stale flag can fire. Throws `RangeError` for a non-TTC price.
 */
export function snapshotOf(record: ProductRecord, colour?: string): ProductSnapshot {
  return productSnapshot(record, record.fetchedAt, colour);
}

/** The `item.place` command for a drop. `roomId` is the room under the pointer. */
export function placeCommand(source: PlaceSource, pose: GhostPose, roomId: string | undefined, snapshot?: ProductSnapshot, relation?: Relation): Command {
  const item: Record<string, unknown> = {
    assetId: source.assetId,
    position: pose.position,
    elevation: source.mount === 'floor' ? 0 : pose.elevation,
    rotation: pose.rotation,
    ...(roomId !== undefined ? { roomId } : {}),
    mount: source.mount,
    dims: source.dims,
    ...(source.mesh ? { mesh: source.mesh } : {}),
    ...(source.productRef ? { productRef: source.productRef } : {}),
    ...(snapshot ? { product: snapshot } : {}),
    ...(relation ? { relation } : {}),
  };
  return { type: 'item.place', item } as Command;
}

/** `item.move` for a drag step: always the same patch keys, so consecutive steps coalesce into one history entry. */
export function moveCommand(id: string, pose: GhostPose, withElevation: boolean): Command {
  return { type: 'item.move', id, position: pose.position, rotation: pose.rotation, ...(withElevation ? { elevation: pose.elevation } : {}) } as Command;
}

export { itemCoalesceKey };

export function labelPlace(source: PlaceSource): string {
  return `Place ${source.label}`;
}

export const nudged = (position: Vec2, dx: number, dy: number): Vec2 => [Math.round((position[0] + dx) * 1e4) / 1e4, Math.round((position[1] + dy) * 1e4) / 1e4];

export type ItemKeyAction = { kind: 'rotate'; deltaDeg: number } | { kind: 'remove' } | { kind: 'nudge'; dx: number; dy: number };

/** Maps a key press to an action on the selected item: R rotates 90, Del removes, arrows nudge 1 cm (Shift: 5 cm). */
export function itemKeyAction(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): ItemKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const step = e.shiftKey ? 0.05 : 0.01;
  switch (e.key) {
    case 'r':
    case 'R':
      return { kind: 'rotate', deltaDeg: e.shiftKey ? -90 : 90 };
    case 'Delete':
    case 'Backspace':
      return { kind: 'remove' };
    case 'ArrowLeft':
      return { kind: 'nudge', dx: -step, dy: 0 };
    case 'ArrowRight':
      return { kind: 'nudge', dx: step, dy: 0 };
    case 'ArrowUp':
      return { kind: 'nudge', dx: 0, dy: -step };
    case 'ArrowDown':
      return { kind: 'nudge', dx: 0, dy: step };
    default:
      return null;
  }
}

/** The command a key action means for `item`, or null (nothing to do). */
export function commandForKey(item: Pick<Item, 'id' | 'position' | 'rotation'>, action: ItemKeyAction): { cmd: Command; coalesce: boolean } | null {
  switch (action.kind) {
    case 'remove':
      return { cmd: { type: 'item.remove', id: item.id }, coalesce: false };
    case 'rotate':
      return { cmd: { type: 'item.rotate', id: item.id, rotation: (((item.rotation + action.deltaDeg) % 360) + 360) % 360 }, coalesce: false };
    case 'nudge':
      return { cmd: { type: 'item.move', id: item.id, position: nudged(item.position, action.dx, action.dy) }, coalesce: true };
  }
}
