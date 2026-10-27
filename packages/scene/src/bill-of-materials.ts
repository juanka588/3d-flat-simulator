import type { Scene } from './schema';
import { pointInPolygon } from './validate';

/**
 * Bill of materials (M5.0 contract; implemented in M5.16, consumed by the M9 budget).
 *
 * Budget semantics (user decision): ONLY the TTC (tax-included) price of each item's product snapshot
 * counts; delivery, assembly and discounts are excluded until M9. A LOCKED item (existing furniture
 * such as the built-in placards) is listed but counts EUR 0. Items without a product (legacy
 * `builtin:*`) are listed with no price and counted in `missingPrice` unless locked.
 */

/** A price snapshot older than this many days is reported as stale. */
export const STALE_PRICE_DAYS = 7;

export interface BomLine {
  itemId: string;
  /** Room of the item (`Item.roomId`, else the room containing it); `null` when outside every room. */
  roomId: string | null;
  /** `"<provider>:<sku>"` when the item has a product. */
  productId?: string;
  name: string;
  url?: string;
  /** Snapshot price (TTC) in `currency`, absent without a product. */
  unitPrice?: number;
  currency?: string;
  /** Existing item that costs nothing. */
  locked: boolean;
  /** What this line adds to the totals, in its own currency: `unitPrice`, or 0 for locked / unpriced items. */
  amount: number;
  snapshotAt?: string;
  /** `snapshotAt` is more than `STALE_PRICE_DAYS` before `now`. */
  stale: boolean;
}

/** All items of one product, grouped for a shopping list. */
export interface BomSkuGroup {
  /** `"<provider>:<sku>"`. */
  productId: string;
  name: string;
  url?: string;
  currency: string;
  /** Number of items of this product (locked ones included). */
  quantity: number;
  /** Snapshot price of one unit (TTC) in `currency`. */
  unitPrice: number;
  /** Quantity of UNLOCKED items: what has to be bought. */
  toBuy: number;
  /** `unitPrice * toBuy`. */
  amount: number;
  itemIds: string[];
  /** Some item of this group has a stale snapshot. */
  stale: boolean;
}

export interface BillOfMaterials {
  /** One line per item, in scene order. */
  lines: BomLine[];
  /** Products with quantities, in order of first appearance (items without a product are not grouped). */
  bySku: BomSkuGroup[];
  /** Sum of `amount` over the EUR lines (other currencies are never converted; see `mixedCurrency`). */
  totalEur: number;
  /** EUR subtotal and item count per room id; items outside every room under the key `"_none"`. */
  byRoom: Record<string, { totalEur: number; itemCount: number }>;
  /** Ids of items whose snapshot is stale. */
  stale: string[];
  /** Ids of unlocked items with no priced product. */
  missingPrice: string[];
  /** Some line is not in EUR: `totalEur` leaves it out. */
  mixedCurrency: boolean;
}

const DAY_MS = 86_400_000;
const EUR = 'EUR';
/** Key of `byRoom` for items outside every room. */
export const BOM_NO_ROOM = '_none';

/**
 * Computes the bill of materials of a scene. Pure: `now` (ms since epoch) is passed in; the default
 * is the latest `snapshotAt` in the scene (nothing is stale then, unless there are no snapshots at all) so the
 * result is deterministic. Prices are the TTC snapshot prices; locked items count 0; an item without a
 * product is `missingPrice` unless locked. A stale snapshot is reported, never silently refreshed.
 */
export function billOfMaterials(scene: Scene, options: { now?: number } = {}): BillOfMaterials {
  const stamps = scene.items.flatMap((i) => (i.product ? [Date.parse(i.product.snapshotAt)] : [])).filter(Number.isFinite);
  const now = options.now ?? (stamps.length ? Math.max(...stamps) : 0);

  const lines: BomLine[] = [];
  const stale: string[] = [];
  const missingPrice: string[] = [];
  const byRoom: BillOfMaterials['byRoom'] = {};
  const groups = new Map<string, BomSkuGroup>();
  let totalEur = 0;
  let mixedCurrency = false;

  for (const item of scene.items) {
    const roomId = item.roomId ?? scene.rooms.find((r) => pointInPolygon(item.position, r.polygon, 1e-6))?.id ?? null;
    const locked = item.locked === true;
    const p = item.product;
    const age = p ? now - Date.parse(p.snapshotAt) : 0;
    const isStale = !locked && p !== undefined && age > STALE_PRICE_DAYS * DAY_MS;
    const amount = locked || !p ? 0 : p.price;

    lines.push({
      itemId: item.id,
      roomId,
      ...(p ? { productId: `${p.provider}:${p.sku}`, url: p.url, unitPrice: p.price, currency: p.currency, snapshotAt: p.snapshotAt } : {}),
      name: p?.name ?? item.id,
      locked,
      amount,
      stale: isStale,
    });
    if (isStale) stale.push(item.id);
    if (!p && !locked) missingPrice.push(item.id);
    if (p && p.currency !== EUR) mixedCurrency = true;

    const room = (byRoom[roomId ?? BOM_NO_ROOM] ??= { totalEur: 0, itemCount: 0 });
    room.itemCount += 1;
    if (p && p.currency === EUR) {
      room.totalEur = round2(room.totalEur + amount);
      totalEur = round2(totalEur + amount);
    }

    if (p) {
      const productId = `${p.provider}:${p.sku}`;
      let g = groups.get(productId);
      if (!g) {
        g = { productId, name: p.name, url: p.url, currency: p.currency, quantity: 0, unitPrice: p.price, toBuy: 0, amount: 0, itemIds: [], stale: false };
        groups.set(productId, g);
      }
      g.quantity += 1;
      g.itemIds.push(item.id);
      if (!locked) {
        g.toBuy += 1;
        g.amount = round2(g.amount + p.price);
      }
      if (isStale) g.stale = true;
    }
  }
  return { lines, bySku: [...groups.values()], totalEur, byRoom, stale, missingPrice, mixedCurrency };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
