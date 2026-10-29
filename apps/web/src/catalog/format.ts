import { BUILTIN_ASSETS, STALE_PRICE_DAYS } from '@flat/scene';
import { generatorTitleById } from './generator-titles';
import type { BillOfMaterials, Dims, Item, Scene } from '@flat/scene';

const DAY_MS = 86_400_000;

/** Display names of library (CC0) assets by id, registered when the library catalog loads. */
const libraryNames = new Map<string, string>();
export function registerLibraryNames(assets: readonly { id: string; name: string }[]): void {
  for (const a of assets) libraryNames.set(a.id, a.name);
}

/** Ids made by the app (`item-14`, or a ULID); anything else was written by hand and tells more than a generic title. */
const isGeneratedId = (id: string): boolean => /^item-\d+$/.test(id) || /^[0-9A-Z]{26}$/.test(id);

/** What to call an item: its product name, else its generator / library / built-in name, else its id. */
export function itemName(item: Pick<Item, 'id' | 'assetId' | 'product' | 'mesh'> & { concept?: boolean | undefined }): string {
  if (item.product) return item.product.name;
  if (item.concept && item.mesh?.kind === 'parametric') return `Concept ${generatorTitleById(item.mesh.generator).toLowerCase()}`;
  if (item.mesh?.kind === 'parametric') {
    const title = generatorTitleById(item.mesh.generator);
    // A hand-written id (a fixture's "kitchen-cooktop-cui") says more than the generic title; generated ULIDs say nothing.
    return isGeneratedId(item.id) ? title : `${title} · ${item.id}`;
  }
  if (item.mesh?.kind === 'lookalike') return libraryNames.get(item.mesh.assetId) ?? item.mesh.assetId.split(':').pop()!.replace(/[_-]+/g, ' ');
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

/** True when a snapshot (or an unreadable date) is more than `STALE_PRICE_DAYS` old at `now`. */
export function isStale(snapshotAt: string, now: number = Date.now()): boolean {
  const t = Date.parse(snapshotAt);
  return !(now - t <= STALE_PRICE_DAYS * DAY_MS); // an unparseable date is stale too
}

export interface RoomTotal {
  roomId: string;
  name: string;
  itemCount: number;
  totalEur: number;
  lines: { itemId: string; name: string; price: string; locked: boolean; existing: boolean; stale: boolean; noProduct: boolean; concept: boolean }[];
}

export interface BomView {
  rooms: RoomTotal[];
  totalEur: number;
  itemCount: number;
  mixedCurrency: boolean;
  missingPrice: number;
  stale: number;
  /** Generated concept shapes (not products): listed apart, never priced, never in the total. */
  concept: number;
}

/** The room item list with its price totals (TTC; existing furniture counts 0, a locked product keeps its price), from the pure bill of materials. */
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
      itemCount: lines.filter((l) => !l.concept).length,
      totalEur: bom.byRoom[id]?.totalEur ?? 0,
      lines: lines.map((l) => ({
        itemId: l.itemId,
        name: itemNames.get(l.itemId) ?? l.name,
        price: l.concept ? 'concept' : l.existing ? formatPrice(0, 'EUR') : l.unitPrice !== undefined ? formatPrice(l.unitPrice, l.currency) : '–',
        locked: l.locked,
        existing: l.existing,
        stale: l.stale,
        noProduct: l.productId === undefined && !l.concept,
        concept: l.concept,
      })),
    });
  }
  return { rooms, totalEur: bom.totalEur, itemCount: bom.lines.length, mixedCurrency: bom.mixedCurrency, missingPrice: bom.missingPrice.length, stale: bom.stale.length, concept: bom.concept.count };
}
