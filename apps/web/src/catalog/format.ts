import { BUILTIN_ASSETS, GENERATORS, STALE_PRICE_DAYS } from '@flat/scene';
import type { BillOfMaterials, Dims, Item, Scene } from '@flat/scene';

const DAY_MS = 86_400_000;

/** What to call an item: its product name, else its generator / library / built-in name, else its id. */
export function itemName(item: Pick<Item, 'id' | 'assetId' | 'product' | 'mesh'>): string {
  if (item.product) return item.product.name;
  if (item.mesh?.kind === 'parametric') return GENERATORS.get(item.mesh.generator)?.label ?? item.mesh.generator;
  if (item.mesh?.kind === 'lookalike') return item.mesh.assetId.split(':').pop()!.replace(/[_-]+/g, ' ');
  return Object.hasOwn(BUILTIN_ASSETS, item.assetId) ? BUILTIN_ASSETS[item.assetId]!.name : item.id;
}

/** A locked item that stands for existing furniture rather than a product (the built-in wardrobes). */
export const isBuiltIn = (item: Pick<Item, 'locked' | 'product' | 'productRef'>): boolean => item.locked === true && !item.product && !item.productRef;

/** "299,00 €" style, in the currency of the product. */
export function formatPrice(amount: number, currency = 'EUR'): string {
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** "160 × 200 × 90 cm" (width x depth x height). */
export function formatDims(d: Dims): string {
  const cm = (v: number) => String(Math.round(v * 1000) / 10);
  return `${cm(d.w)} × ${cm(d.d)} × ${cm(d.h)} cm`;
}

/** "27 Oct 2026" (the date of an ISO instant, in UTC so it reads the same everywhere). */
export function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** True when a snapshot is more than `STALE_PRICE_DAYS` old at `now`. */
export function isStale(snapshotAt: string, now: number = Date.now()): boolean {
  const t = Date.parse(snapshotAt);
  return Number.isFinite(t) && now - t > STALE_PRICE_DAYS * DAY_MS;
}

export interface RoomTotal {
  roomId: string;
  name: string;
  itemCount: number;
  totalEur: number;
  lines: { itemId: string; name: string; price: string; locked: boolean; stale: boolean; noProduct: boolean }[];
}

export interface BomView {
  rooms: RoomTotal[];
  totalEur: number;
  itemCount: number;
  mixedCurrency: boolean;
  missingPrice: number;
  stale: number;
}

/** The room item list with its price totals (TTC; locked items count 0), from the pure bill of materials. */
export function bomView(scene: Scene, bom: BillOfMaterials): BomView {
  const names = new Map(scene.rooms.map((r) => [r.id, r.name]));
  const itemNames = new Map(scene.items.map((i) => [i.id, itemName(i)]));
  const order = [...scene.rooms.map((r) => r.id), '_none'];
  const rooms: RoomTotal[] = [];
  for (const id of order) {
    const lines = bom.lines.filter((l) => (l.roomId ?? '_none') === id);
    if (lines.length === 0) continue;
    rooms.push({
      roomId: id,
      name: names.get(id) ?? 'Outside rooms',
      itemCount: lines.length,
      totalEur: bom.byRoom[id]?.totalEur ?? 0,
      lines: lines.map((l) => ({
        itemId: l.itemId,
        name: itemNames.get(l.itemId) ?? l.name,
        price: l.locked ? formatPrice(0, 'EUR') : l.unitPrice !== undefined ? formatPrice(l.unitPrice, l.currency) : '–',
        locked: l.locked,
        stale: l.stale,
        noProduct: l.productId === undefined,
      })),
    });
  }
  return { rooms, totalEur: bom.totalEur, itemCount: bom.lines.length, mixedCurrency: bom.mixedCurrency, missingPrice: bom.missingPrice.length, stale: bom.stale.length };
}
