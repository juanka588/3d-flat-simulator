import { z } from 'zod';
import { Relation } from '../placement/types';
import { MeshSource } from '../items/mesh-source';
import { Clearance, Dims, EntityId, ItemMount, Sku, Vec2 } from '../primitives';
import { ProductRef, ProductSnapshot } from '../products';
import { ItemBase, Light, checkItemRules } from '../schema';

/**
 * Item command schemas (D8), registered in `LEAF_COMMAND_SCHEMAS` (M5.10). Reducer rules (see `items.ts`):
 *  - an `llm` or `planner` author may only place items that reference a product (`product` or `productRef`):
 *    otherwise `precondition_failed` with the hint "search_products first";
 *  - a `locked` item (existing furniture) cannot be moved, rotated, re-varianted or removed, nor created, by a
 *    non-user author (`precondition_failed`);
 *  - place / move / rotate / setVariant are refused with `placement_invalid {violation, hint}` when the item would
 *    stand outside its room, overlap a wall or an item, or block a door swing (the walkway raster is NOT run
 *    in the reducer: use `validate_layout`);
 *  - at most `ITEMS_PER_ROOM_SOFT_CAP` items per room (`limit_exceeded`);
 *  - every command has an exact inverse: place <-> remove (remove keeps the list index), move / rotate /
 *    setVariant restore the previous values (absent values come back as `null`).
 * Drag coalescing: send item.move / item.rotate with `coalesceKey` `item:<id>` (see `itemCoalesceKey`).
 */

const Id = EntityId;
const t = <T extends string>(type: T) => z.literal(type).describe(`Command discriminator, always "${type}".`);
const INDEX_DESC = 'Internal (used by undo): insert position. Do not send.';
const ItemId = Id.describe('Id of the item (items[].id from describe_room or get_scene_summary).');

/** The product facts stored next to an item, with a description per field (the tool schema is read by an LLM). */
const ProductSnapshotD = ProductSnapshot.extend({
  provider: ProductSnapshot.shape.provider.describe('Provider id, e.g. "ikea-fr".'),
  sku: ProductSnapshot.shape.sku.describe('Provider article number.'),
  name: ProductSnapshot.shape.name.describe('Product name as listed by the provider.'),
  url: ProductSnapshot.shape.url.describe('Public product page (the buy link).'),
  price: ProductSnapshot.shape.price.describe('Shelf price including VAT (TTC) in `currency`, as returned by the server.'),
  currency: ProductSnapshot.shape.currency.describe('ISO 4217 currency code, e.g. "EUR".'),
  dims: ProductSnapshot.shape.dims.describe('Assembled outer dimensions in metres, as returned by the server.'),
  category: ProductSnapshot.shape.category.describe('Furniture category of the product.'),
  snapshotAt: ProductSnapshot.shape.snapshotAt.describe('When the facts were read from the provider (ISO 8601 date-time).'),
  colour: ProductSnapshot.shape.colour.describe('Chosen colour when the product has several. Optional.'),
  lumens: ProductSnapshot.shape.lumens.describe('Bulb lumens from the server (lamps).'),
});

const ProductRefD = ProductRef.extend({
  provider: ProductRef.shape.provider.describe('Provider id, e.g. "ikea-fr".'),
  sku: ProductRef.shape.sku.describe('Provider article number.'),
});

const ClearanceD = Clearance.extend({
  front: Clearance.shape.front.describe('Free space wanted in front, in metres. Optional.'),
  back: Clearance.shape.back.describe('Free space wanted behind, in metres. Optional.'),
  left: Clearance.shape.left.describe('Free space wanted on the left seen from the front, in metres. Optional.'),
  right: Clearance.shape.right.describe('Free space wanted on the right seen from the front, in metres. Optional.'),
});

const MeshSourceD = z.discriminatedUnion('kind', [
  MeshSource.options[0].extend({ kind: z.literal('provider').describe('Mesh source discriminator, always "provider": the provider\'s real model of productRef, streamed by the local server.') }),
  MeshSource.options[1].extend({
    kind: z.literal('lookalike').describe('Mesh source discriminator, always "lookalike": a library model scaled to the exact dims.'),
    assetId: MeshSource.options[1].shape.assetId.describe('Id of the library asset (search_assets).'),
  }),
  MeshSource.options[2].extend({
    kind: z.literal('parametric').describe('Mesh source discriminator, always "parametric": a generator at the exact dims.'),
    generator: MeshSource.options[2].shape.generator.describe('Generator id (search_assets).'),
    params: MeshSource.options[2].shape.params.describe('Scalar generator parameters; omitted keys use the generator defaults.'),
  }),
]);

/** An item as sent to `item.place`: the id is optional and derived (`item-N`) when absent. */
export const ItemDraft = ItemBase.extend({
  id: Id.describe('Optional item id (1-64 characters, unique across all entities); derived as "item-N" when omitted.').optional(),
  assetId: ItemBase.shape.assetId.describe('Shape id: "product:<provider>", a library asset id or "param:<generator>" (see meshAssetId); legacy "builtin:*" ids still load.'),
  position: Vec2.describe('Plan position [x, y] of the item origin (footprint centre), in metres; plan y grows down.'),
  elevation: ItemBase.shape.elevation.describe('Height of the item bottom above the floor, in metres; must be 0 for floor items. Defaults to 0.'),
  rotation: ItemBase.shape.rotation.describe('Rotation in degrees, counter-clockwise seen from above; the front faces plan +y at 0. Defaults to 0.'),
  roomId: ItemBase.shape.roomId.describe('Room the item stands in (rooms[].id from list_rooms); derived from the position when omitted. Optional.'),
  productRef: ProductRefD.describe('The real product this item stands for. Required for items placed by an LLM or the planner (unless product is given).').optional(),
  product: ProductSnapshotD.describe('Product facts (name, TTC price, link, dims, snapshot date) as returned by the server; never invented.').optional(),
  mount: ItemMount.describe('Where the item is fixed: "floor", "wall" (hung) or "ceiling". Optional; derived from the asset.').optional(),
  dims: Dims.describe('Exact outer dimensions in metres; defaults to the product dimensions. Optional.').optional(),
  variant: ItemBase.shape.variant.describe('Chosen variant SKU or colour name of the product. Optional.'),
  mesh: MeshSourceD.describe('How the 3D shape is obtained (provider model, library lookalike or parametric generator). Optional.').optional(),
  clearance: ClearanceD.describe('Free space wanted around the item, in metres per side. Optional.').optional(),
  dressing: ItemBase.shape.dressing.describe('Bed frames only: false draws the frame bare, without the visual mattress, duvet and pillows (which are not bought). Optional; place_item sets it.'),
  locked: ItemBase.shape.locked.describe('Existing furniture the designer must plan around (only the user may set it). Optional.'),
  concept: ItemBase.shape.concept.describe('A generated concept shape, not a product (no productRef or product; needs a parametric mesh). Set by place_item concept:true.'),
  relation: Relation.describe('The placement intent that put the item here (as returned by place_item). Optional.').optional(),
}).superRefine(checkItemRules);
export type ItemDraft = z.input<typeof ItemDraft>;

export const ItemPlace = z.strictObject({
  type: t('item.place'),
  item: ItemDraft.describe('The complete item: position, rotation, productRef + product snapshot, dims, mesh source and relation, as resolved by the placement solver.'),
  /** Insert position (used by inverses); defaults to the end. */
  index: z.number().int().nonnegative().describe(INDEX_DESC).optional(),
  /** `false` places a lamp without its light. */
  autoLight: z.boolean().describe('Lamps: false places the lamp without its light (default true).').optional(),
  /** The exact linked light to put back (used by the inverse of item.remove). */
  restoreLight: z
    .strictObject({ light: Light, index: z.number().int().nonnegative() })
    .describe('Internal (undo).')
    .optional(),
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
  product: ProductSnapshotD.describe('Snapshot of the chosen variant (resolved by the server from its record; never invented). Optional.').optional(),
  dims: Dims.nullable().describe('Dimensions of the chosen variant when they differ; null clears them back to the product dimensions. Optional.').optional(),
  mesh: MeshSourceD.nullable().describe('Shape source to store with the variant; null clears it. Omitted: a parametric shape follows the new dimensions. Optional.').optional(),
});

export const ItemRemove = z.strictObject({ type: t('item.remove'), id: ItemId });

/** Registered in `LEAF_COMMAND_SCHEMAS` (see above). */
export const ITEM_COMMAND_SCHEMAS = [ItemPlace, ItemMove, ItemRotate, ItemSetVariant, ItemRemove] as const;

export type ItemCommand =
  | z.input<typeof ItemPlace>
  | z.input<typeof ItemMove>
  | z.input<typeof ItemRotate>
  | z.input<typeof ItemSetVariant>
  | z.input<typeof ItemRemove>;


/** Coalescing key of an item drag: consecutive item.move / item.rotate with this key become one undo step. */
export const itemCoalesceKey = (id: string): string => `item:${id}`;
