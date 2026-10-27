import { z } from 'zod';
import { Relation } from '../placement/types';
import { Dims, EntityId, Sku, Vec2 } from '../primitives';
import { ProductSnapshot } from '../products';
import { ItemBase, checkItemRules } from '../schema';

/**
 * Item command schemas (D8) — CONTRACT ONLY in M5.0. They are exported here but deliberately NOT in
 * `LEAF_COMMAND_SCHEMAS`: registering a leaf adds a command type, a tool and an entry in the committed
 * snapshots (`__snapshots__/command.schema.json`, `tool-schemas.json`, the MCP tools/list snapshot).
 * Lane B (M5.10) registers them: append `ITEM_COMMAND_SCHEMAS` to `LEAF_COMMAND_SCHEMAS`, extend the
 * `LeafCommand` union, add `DESCRIPTIONS` entries in `tools.ts`, a case in `describeCommand`, the reducer
 * cases with exact inverses, remove these types from `RESERVED_COMMAND_TYPES`, and update the snapshots.
 * Until then `parseCommand` answers `not_supported` with the hint "M5 lane B".
 *
 * Authors: an `llm` author may only place products the server has seen in a search of its session, and
 * may never move, rotate or remove a `locked` item (precondition_failed); a `user` may.
 */

const Id = EntityId;
const t = <T extends string>(type: T) => z.literal(type).describe(`Command discriminator, always "${type}".`);
const INDEX_DESC = 'Internal (used by undo): insert position. Do not send.';
const ItemId = Id.describe('Id of the item (items[].id from describe_room or get_scene_summary).');

/** An item as sent to `item.place`: the id is optional and derived (`item-N`) when absent. */
export const ItemDraft = ItemBase.extend({ id: Id.describe('Optional item id; derived as "item-N" when omitted.').optional() }).superRefine(checkItemRules);
export type ItemDraft = z.input<typeof ItemDraft>;

export const ItemPlace = z.strictObject({
  type: t('item.place'),
  item: ItemDraft.describe('The complete item: position, rotation, productRef + product snapshot, dims, mesh source and relation, as resolved by the placement solver.'),
  /** Insert position (used by inverses); defaults to the end. */
  index: z.number().int().nonnegative().describe(INDEX_DESC).optional(),
});

export const ItemMove = z.strictObject({
  type: t('item.move'),
  id: ItemId,
  position: Vec2.describe('New plan position [x, y] of the item origin, in metres.'),
  /** Wall mounts only; floor items stay at 0. */
  elevation: z.number().min(0).describe('New height of the item bottom above the floor, in metres. Optional.').optional(),
  rotation: z.number().describe('New rotation in degrees, counter-clockwise seen from above. Optional.').optional(),
  roomId: Id.nullable().describe('Room the item now belongs to (rooms[].id); null clears it. Optional.').optional(),
  relation: Relation.nullable().describe('The placement intent that produced this position; null clears it. Optional.').optional(),
});

export const ItemRotate = z.strictObject({
  type: t('item.rotate'),
  id: ItemId,
  rotation: z.number().describe('Absolute rotation in degrees, counter-clockwise seen from above (the front faces plan +y at 0).'),
});

export const ItemSetVariant = z.strictObject({
  type: t('item.setVariant'),
  id: ItemId,
  variant: Sku.nullable().describe('Variant SKU of the product (variants[].sku); null clears it.'),
  /** A different variant is usually another article with its own price and dims: the resolved facts come with it. */
  product: ProductSnapshot.describe('Snapshot of the chosen variant (resolved by the server from its record; never invented). Optional.').optional(),
  dims: Dims.describe('Dimensions of the chosen variant when they differ. Optional.').optional(),
});

export const ItemRemove = z.strictObject({ type: t('item.remove'), id: ItemId });

/** Not yet registered in `LEAF_COMMAND_SCHEMAS` (see above). */
export const ITEM_COMMAND_SCHEMAS = [ItemPlace, ItemMove, ItemRotate, ItemSetVariant, ItemRemove] as const;

export type ItemCommand =
  | z.input<typeof ItemPlace>
  | z.input<typeof ItemMove>
  | z.input<typeof ItemRotate>
  | z.input<typeof ItemSetVariant>
  | z.input<typeof ItemRemove>;

