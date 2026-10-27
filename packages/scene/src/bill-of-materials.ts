import type { Scene } from './schema';

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

export interface BillOfMaterials {
  /** One line per item, in scene order. */
  lines: BomLine[];
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

/**
 * Computes the bill of materials of a scene. Pure: `now` (ms since epoch) is passed in; the default
 * is the latest `snapshotAt` in the scene so the result is deterministic. STUB until M5.16: throws.
 */
export function billOfMaterials(scene: Scene, options: { now?: number } = {}): BillOfMaterials {
  void scene;
  void options;
  throw new Error('not implemented: M5.16 (bill of materials)');
}
