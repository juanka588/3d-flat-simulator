import {
  MeshSource,
  ProductId,
  Relation,
  Sku,
  applyCommand,
  bedDressingOf,
  billOfMaterials,
  GENERATORS,
  checkParametricMesh,
  defaultParametricFor,
  roomCeilingHeight,
  makeEnvelope,
  meshAssetId,
  nearestIds,
  parseProductId,
  solvePlacement,
  validateLayout,
  type Command,
  type Dims,
  type Placement,
  type PlacementRequestInput,
  type Scene,
  type SceneResponse,
  type Violation,
} from '@flat/scene';
import {
  MAX_LOOKALIKE_DISTORTION,
  pickLookalike,
  productSnapshot,
  scaleToDims,
  type ProductRecord,
  type ProviderInfo,
} from '@flat/assets';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { cc0Assets } from '../assetCatalog';
import { apiFailure, commandErrors, toolError, toolOk } from '../errors';
import { READ, fetchScene, obj, parseArgs } from './common';
import { executeCommand, planRender } from './commandTools';
import { splitExtras, withMcpExtras } from './extras';
import type { ToolContext, ToolDef } from './registry';

/**
 * Placement and layout tools (M5.11, D9): `get_placement_options` (dry run of the solver),
 * `validate_layout`, `get_bill_of_materials` and `place_item`, the friendly wrapper over `item_place`.
 *
 * `place_item` NEVER takes a price, a name, a link or dimensions from its arguments: the product facts
 * come from the scene server's own record (`GET /api/products/:id`), and the productId must have been
 * returned by `search_products` / `get_product` in this MCP session (`unknown_product` otherwise).
 */

/** Placements in one `place_item` call (one batch, one undo step). */
export const MAX_PLACEMENTS = 12;

// ---------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------

/** Models sometimes send numbers as strings ("90") and tuples as JSON text ("[5.1, 1.9]"): accept both, the tool schema still says number / [x, y]. */
const asNumber = (v: unknown): unknown => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v);
const lenientNumber = (inner: z.ZodNumber) => z.preprocess(asNumber, inner);
const Vec2 = z.preprocess((v) => {
  let value = v;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return v;
    }
  }
  return Array.isArray(value) ? value.map(asNumber) : v;
}, z.tuple([z.number(), z.number()]));
const RoomId = z.string().min(1).max(64);

/** One thing to place. Strict: a price, a name or dims are rejected as unknown keys. */
const Entry = z
  .strictObject({
    productId: ProductId.optional(),
    /** CONCEPT item (CG4): a generated parametric shape instead of a product. Not purchasable, labelled, kept out of the budget. */
    concept: z.literal(true).optional(),
    generator: z.string().min(1).max(40).optional(),
    params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
    roomId: RoomId,
    relation: Relation.optional(),
    position: Vec2.optional(),
    rotation: lenientNumber(z.number().min(-720).max(720)).optional(),
    elevation: lenientNumber(z.number().min(0).max(10)).optional(),
    /** Hang a product the shop lists as standing on the floor (a wall shelf): only for kinds that can hang. */
    mount: z.enum(['floor', 'wall']).optional(),
    /** A bed frame is drawn with a mattress, duvet and pillows (not bought, not in the bill); false draws it bare. */
    dressing: z.boolean().optional(),
    mesh: MeshSource.optional(),
    variantSku: Sku.optional(),
    acknowledgeHeavyPartition: z.boolean().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.concept) {
      if (e.productId) ctx.addIssue({ code: 'custom', path: ['productId'], message: 'a concept item is not a product: give generator (and params), not productId' });
      if (!e.generator) ctx.addIssue({ code: 'custom', path: ['generator'], message: 'concept:true needs a generator id (suggest_generator in match_reference, or search_assets)' });
      if (e.variantSku || e.mesh) ctx.addIssue({ code: 'custom', path: ['mesh'], message: 'a concept item takes generator + params, not mesh or variantSku' });
    } else {
      if (!e.productId) ctx.addIssue({ code: 'custom', path: ['productId'], message: 'productId is required (real products only; for a generated stand-in pass concept:true with generator)' });
      if (e.generator || e.params) ctx.addIssue({ code: 'custom', path: ['generator'], message: 'generator and params are only for concept:true items' });
    }
    if (e.relation && e.position) ctx.addIssue({ code: 'custom', path: ['position'], message: 'give either relation or position, not both' });
    if (!e.relation && !e.position) ctx.addIssue({ code: 'custom', path: ['relation'], message: 'give a relation (against_wall, in_corner, ...) or a position [x, y]' });
  });
type Entry = z.infer<typeof Entry>;

/** Variant mode: switch a placed item to another variant of its product (price and dims come from the server record). */
const VariantArgs = z.strictObject({ itemId: z.string().min(1).max(64), variantSku: Sku });

const PlaceMany = z.strictObject({ items: z.array(Entry).min(1).max(MAX_PLACEMENTS) });

const OptionsArgs = z.strictObject({ productId: ProductId, roomId: RoomId, relation: Relation, variantSku: Sku.optional() });
const LayoutArgs = z.strictObject({ roomId: RoomId.optional(), budgetEur: z.number().min(0).max(10_000_000).optional() });
const BomArgs = z.strictObject({ roomId: RoomId.optional() });

type Json = Record<string, unknown>;
const jsonSchema = (s: z.ZodType): Json => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Json;
  void _drop;
  return rest;
};
const RELATION_REF = { $ref: '#/$defs/relation' };
const MESH_REF = { $ref: '#/$defs/mesh' };
const DEFS = () => ({ relation: jsonSchema(Relation), mesh: jsonSchema(MeshSource) });

const ENTRY_PROPS: Json = {
  concept: { type: 'boolean', description: 'true = generated CONCEPT shape, no productId: give generator + params. Not purchasable, labelled, 0 in the budget. Only when no real product fits.' },
  generator: { type: 'string', description: 'With concept: generator id (suggestGenerator).' },
  params: { type: 'object', description: 'With concept: generator params.' },
  productId: { type: 'string', description: 'productId returned by search_products or get_product in this session, "<provider>:<sku>".' },
  roomId: { type: 'string', description: 'Room to place in (list_rooms).' },
  relation: { ...RELATION_REF, description: 'Where, in designer terms (against_wall, in_corner, centered_in, facing, next_to, under_window, on). The server finds the exact position and rotation. Use this OR position. In items[], "$0" as the itemId of next_to or on (targetId of facing) means the item entry 0 of the same call places.' },
  position: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Explicit plan position [x, y] of the item centre, metres. Use this OR relation.' },
  rotation: { type: 'number', description: 'With position: degrees counter-clockwise seen from above (front faces plan +y at 0). With relation: an extra turn, usually omitted.' },
  elevation: { type: 'number', minimum: 0, maximum: 10, description: 'Wall or ceiling products only: height of the bottom above the floor, metres. A product named "murale"/"wall" is hung automatically.' },
  mount: { type: 'string', enum: ['floor', 'wall'], description: `Override how the product is fixed. Only "wall" is useful: for a shelf, mirror, lamp or cabinet that the shop lists as floor-standing but that you want to hang (then give elevation). Floor-only furniture (bed, sofa, table...) cannot be hung.` },
  dressing: { type: 'boolean', description: 'Bed frames only. Default true: the picture shows a mattress, duvet and pillows on the frame (a visual dressing: the mattress is NOT part of the product, not in the bill of materials; buy one separately). false draws the bare frame.' },
  mesh: { ...MESH_REF, description: 'Optional shape. Default: the real 3D model when the provider has one, else a lookalike from the CC0 library, else a parametric shape at the exact dims. A parametric shape must match the product dims within 2%.' },
  variantSku: { type: 'string', description: 'A variants[].sku from get_product (another colour or size).' },
  acknowledgeHeavyPartition: { type: 'boolean', description: 'Accept hanging a heavy (over 15 kg) wall product on a non-structural wall.' },
};
const ENTRY_REQUIRED = ['roomId'];

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

const round = (n: number, digits = 3): number => Math.round(n * 10 ** digits) / 10 ** digits;
const dimsOf = (d: Dims) => ({ w: round(d.w), d: round(d.d), h: round(d.h) });
type Loaded<T> = { ok: true; data: T } | { ok: false; result: CallToolResult };

/** The product record of an id this session has seen, from the SERVER (never from tool arguments). */
async function loadSeenProduct(ctx: ToolContext, productId: string): Promise<Loaded<ProductRecord>> {
  if (!parseProductId(productId)) return { ok: false, result: toolError('invalid_command', `invalid productId "${productId}"`, 'Use the productId exactly as search_products returned it, "<provider>:<sku>".') };
  const seen = await ctx.flat.isProductSeen(ctx.session.id, productId);
  if (!seen.ok) return { ok: false, result: apiFailure(seen) };
  if (!seen.data.seen) {
    return { ok: false, result: toolError('unknown_product', `product "${productId}" was not returned by search_products or get_product in this session`, 'Call search_products first and use a productId from its results; products cannot be invented.') };
  }
  const r = await ctx.flat.getProduct(productId);
  if (!r.ok) return { ok: false, result: apiFailure(r) };
  return { ok: true, data: r.data.product };
}

function unknownRoom(scene: Scene, roomId: string): CallToolResult | undefined {
  if (scene.rooms.some((r) => r.id === roomId)) return undefined;
  const ids = scene.rooms.map((r) => r.id);
  return toolError('unknown_room', `no room "${roomId}"`, `Did you mean ${nearestIds(roomId, ids).map((x) => `"${x}"`).join(', ')}? Rooms: ${ids.join(', ')}.`);
}

interface Prepared {
  record: ProductRecord;
  variant?: ProductRecord['variants'][number];
  dims: Dims;
  /** How the item is fixed: the product's, unless the caller hangs a hangable floor product. */
  mount: ProductRecord['mount'];
}

function prepare(record: ProductRecord, variantSku: string | undefined): Loaded<Prepared> {
  if (variantSku === undefined) return { ok: true, data: { record, dims: record.dims, mount: record.mount } };
  const variant = record.variants.find((v) => v.sku === variantSku);
  if (!variant) {
    const skus = record.variants.map((v) => v.sku);
    return { ok: false, result: toolError('invalid_command', `product ${record.provider}:${record.sku} has no variant "${variantSku}"`, skus.length ? `Variants: ${skus.join(', ')} (get_product).` : 'This product has no variants; omit variantSku.', { errors: [{ code: 'invalid_command', path: 'variantSku', message: 'unknown variant' }] }) };
  }
  return { ok: true, data: { record, variant, dims: variant.dims ?? record.dims, mount: record.mount } };
}

function requestFor(p: Prepared, roomId: string, relation: PlacementRequestInput['relation'], extra: { elevation?: number | undefined; rotation?: number | undefined; acknowledge?: boolean | undefined }): PlacementRequestInput {
  return {
    roomId,
    dims: p.dims,
    // standing on another item (a frame the shop hangs, stood on a shelf) is a floor-type pose at that item's height
    mount: relation.kind === 'on' ? 'floor' : p.mount,
    ...(extra.elevation !== undefined && p.mount !== 'floor' && relation.kind !== 'on' ? { elevation: extra.elevation } : {}),
    ...(p.record.weightKg !== undefined ? { weightKg: p.record.weightKg } : {}),
    category: p.record.category,
    relation,
    ...(extra.rotation !== undefined ? { rotation: extra.rotation } : {}),
    ...(extra.acknowledge ? { acknowledgeHeavyPartition: true } : {}),
    maxCandidates: 3,
  };
}

/** Kinds of product that can be hung when the caller says `mount: "wall"` (the shop's own "mount" is a guess from the category). */
const HANGABLE: ReadonlySet<string> = new Set(['shelf', 'mirror', 'lamp', 'wall_cabinet', 'tv_unit', 'decor', 'other', 'drawers', 'sideboard', 'washbasin', 'vanity', 'towel_rail', 'bath_accessory', 'shower_curtain', 'hook']);
/** Kinds hung on an elevation alone (a shelf the shop lists as floor-standing, placed at 1.4 m, is meant to hang). */
const HUNG_BY_ELEVATION: ReadonlySet<string> = new Set(['shelf', 'mirror', 'wall_cabinet', 'tv_unit']);

/** The mount of a placement: the product's, unless a floor product that can hang is asked to (`mount: "wall"`, or an elevation on a shelf, mirror, cabinet). */
function effectiveMount(record: ProductRecord, entry: Pick<Entry, 'mount' | 'elevation' | 'relation'>): { ok: true; mount: ProductRecord['mount'] } | { ok: false; message: string } {
  // a frame the shop hangs, stood on a shelf: it stands (floor mount) on top of that item
  if (entry.relation?.kind === 'on') return { ok: true, mount: 'floor' };
  if (record.mount !== 'floor' || entry.mount === 'floor') return { ok: true, mount: record.mount };
  if (entry.mount === 'wall') return HANGABLE.has(record.category) ? { ok: true, mount: 'wall' } : { ok: false, message: `"${record.name}" is a ${record.category}; it cannot be hung on a wall` };
  return HUNG_BY_ELEVATION.has(record.category) && (entry.elevation ?? 0) > 0 ? { ok: true, mount: 'wall' } : { ok: true, mount: 'floor' };
}

const BACKREF = /^\$(\d{1,2})$/;

/**
 * In items[], "$N" as the itemId of next_to / the targetId of facing stands for the item entry N of the SAME call
 * places (N before this entry). Replaced by that item's real id; anything else is left to the solver.
 */
function resolveBackRefs(e: Entry, placedIds: readonly string[], at: string): { ok: true; entry: Entry } | { ok: false; result: CallToolResult } {
  const rel = e.relation;
  if (!rel || (rel.kind !== 'next_to' && rel.kind !== 'facing' && rel.kind !== 'on')) return { ok: true, entry: e };
  const key = rel.kind === 'facing' ? 'targetId' : 'itemId';
  const value = (rel as unknown as Record<string, string>)[key]!;
  const m = BACKREF.exec(value);
  if (!m) return { ok: true, entry: e };
  const n = Number(m[1]);
  const id = placedIds[n];
  if (id === undefined) {
    return { ok: false, result: toolError('invalid_command', `"${value}" in ${key}${at} must refer to an EARLIER entry of this items[] (0 to ${Math.max(0, placedIds.length - 1)} here)`, 'Put the entry it refers to before this one, or use a real item id.', { errors: [{ code: 'invalid_command', path: `relation/${key}`, message: 'back-reference to an entry that is not placed yet' }] }) };
  }
  return { ok: true, entry: { ...e, relation: { ...rel, [key]: id } as Entry['relation'] } };
}

/** The relation an entry asks for: its `relation`, or `at` for an explicit position. */
function entryRelation(e: Entry): { ok: true; relation: PlacementRequestInput['relation']; rotation: number | undefined } | { ok: false; result: CallToolResult } {
  if (e.relation) return { ok: true, relation: e.relation, rotation: e.rotation };
  return { ok: true, relation: { kind: 'at', position: e.position!, rotation: e.rotation ?? 0, elevation: e.elevation ?? 0 }, rotation: undefined };
}

const candidateOf = (p: Placement, why: string) => ({ position: p.position, rotation: p.rotation, elevation: p.elevation, relation: p.relation, rationale: [why] });

/** One line for an alternative spot found by the solver. */
const altWhy = (c: Placement): string => `alternative: ${c.relation.kind === 'at' ? 'a free spot' : c.relation.kind.replace(/_/g, ' ')} at [${round(c.position[0], 2)}, ${round(c.position[1], 2)}], rotation ${round(c.rotation, 1)}`;

const violationOf = (v: Violation) => ({ code: v.code, message: v.message, entityIds: v.entityIds, hint: v.hint });

/** A refused placement: `placement_invalid` carrying the violations and the alternative spots. */
function placementRefused(name: string, violations: Violation[], candidates: Placement[], index?: number): CallToolResult {
  const first = violations[0];
  const alt = candidates.length ? ` ${candidates.length} alternative spot${candidates.length > 1 ? 's' : ''} below: pass one candidate's relation to place_item.` : ' No alternative spot found in this room; try another room or a smaller product.';
  const base = toolError('placement_invalid', `"${name}" cannot go there: ${first?.message ?? 'placement refused'}${violations.length > 1 ? ` (and ${violations.length - 1} more)` : ''}${index !== undefined ? ` [items/${index}]` : ''}`, `${first?.hint ?? ''}${alt}`.trim());
  const extra = { violations: violations.map(violationOf), candidates: candidates.map((c) => candidateOf(c, altWhy(c))), ...(index !== undefined ? { index } : {}) };
  const body = { ...base.structuredContent, ...extra };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
}

// ---------------------------------------------------------------------------------------------
// Mesh choice (D2): provider -> lookalike -> parametric
// ---------------------------------------------------------------------------------------------

async function providerHas3d(ctx: ToolContext, cache: { list?: ProviderInfo[] }, record: ProductRecord): Promise<boolean> {
  if (record.modelRef === undefined) return false;
  if (!cache.list) {
    const r = await ctx.flat.listProviders();
    cache.list = r.ok ? r.data.providers : [];
  }
  const p = cache.list.find((x) => x.id === record.provider);
  return !!p && p.enabled && p.capabilities.model3d && p.circuit !== 'open';
}

type MeshChoice = { ok: true; mesh: MeshSource | undefined; source: string } | { ok: false; result: CallToolResult };

async function chooseMesh(ctx: ToolContext, cache: { list?: ProviderInfo[] }, p: Prepared, wanted: MeshSource | undefined): Promise<MeshChoice> {
  const { record, dims } = p;
  const has3d = await providerHas3d(ctx, cache, record);
  const productId = `${record.provider}:${record.sku}`;
  if (wanted?.kind === 'provider') {
    return has3d ? { ok: true, mesh: wanted, source: 'provider' } : { ok: false, result: toolError('model_unavailable', `no real 3D model is available for ${productId}`, 'Omit mesh to get a lookalike or parametric shape at the exact dimensions.') };
  }
  if (wanted?.kind === 'lookalike') {
    const asset = cc0Assets().find((a) => a.id === wanted.assetId);
    if (!asset) return { ok: false, result: toolError('invalid_command', `unknown library asset "${wanted.assetId}"`, 'Use an assetId from search_assets.', { errors: [{ code: 'invalid_command', path: 'mesh/assetId', message: 'unknown asset' }] }) };
    const { distortion } = scaleToDims(asset.nativeDims, dims);
    if (!(distortion <= MAX_LOOKALIKE_DISTORTION)) {
      return { ok: false, result: toolError('dims_mismatch', `asset "${asset.id}" would be stretched by ${Math.round(distortion * 100)}% to fit ${dims.w} x ${dims.d} x ${dims.h} m (limit ${MAX_LOOKALIKE_DISTORTION * 100}%)`, 'Pick a library asset with similar proportions (search_assets with maxDims), or omit mesh.') };
    }
    return { ok: true, mesh: wanted, source: 'lookalike' };
  }
  if (wanted?.kind === 'parametric') return parametric(wanted.generator, wanted.params, dims);
  // default chain
  if (has3d) return { ok: true, mesh: { kind: 'provider' }, source: 'provider' };
  const look = pickLookalike({ category: record.category, dims, styleTags: record.styleTags }, cc0Assets());
  if (look) return { ok: true, mesh: { kind: 'lookalike', assetId: look.asset.id }, source: 'lookalike' };
  const def = defaultParametricFor(record.category, dims, record.name, record.colours[0]);
  if (def) {
    const r = parametric(def.generator, def.params, dims);
    if (r.ok) return r;
  }
  return { ok: true, mesh: undefined, source: 'placeholder' };
}

function parametric(generator: string, params: Record<string, number | string | boolean>, dims: Dims): MeshChoice {
  const check = checkParametricMesh({ generator, params }, dims);
  switch (check.status) {
    case 'ok':
      return { ok: true, mesh: { kind: 'parametric', generator, params }, source: 'parametric' };
    case 'unknown_generator':
      return { ok: false, result: toolError('invalid_command', `unknown generator "${generator}"`, 'Use a generator id from search_assets.', { errors: [{ code: 'invalid_command', path: 'mesh/generator', message: 'unknown generator' }] }) };
    case 'invalid_params':
      return { ok: false, result: toolError('invalid_command', `invalid parameters for generator "${generator}": ${check.issues.join('; ')}`, 'See the parameter ranges in search_assets.', { errors: check.issues.map((m) => ({ code: 'invalid_command', path: 'mesh/params', message: m })) }) };
    case 'dims_mismatch':
      return { ok: false, result: toolError('dims_mismatch', `generator "${generator}" with these params makes ${check.expected.w} x ${check.expected.d} x ${check.expected.h} m, but the product is ${check.actual.w} x ${check.actual.d} x ${check.actual.h} m (tolerance 2%)`, `Set the generator's size parameters to the product dimensions (w ${check.actual.w}, d ${check.actual.d}, h ${check.actual.h}), or omit mesh.`) };
  }
}


// ---------------------------------------------------------------------------------------------
// Concept items (CG4): a generated shape instead of a product
// ---------------------------------------------------------------------------------------------

/** Where generated shapes that hang are fixed by default. */
const CONCEPT_MOUNT: Readonly<Record<string, 'wall' | 'ceiling'>> = { mirror: 'wall', curtains: 'wall', tv: 'wall', pendant: 'ceiling' };

/**
 * A concept item: the generator and its params give the exact dims; the solver places it like any item. It carries NO product,
 * so it has no price, no link and cannot be bought; `concept: true` marks it for the UI and the bill of materials.
 */
function conceptItem(working: Scene, entry: Entry, at: string, index: number | undefined): { ok: true; item: Json & { roomId: string; position: [number, number]; rotation: number; elevation: number }; name: string; rationale: string[] } | { ok: false; result: CallToolResult } {
  const g = GENERATORS.get(entry.generator!);
  if (!g) return { ok: false, result: toolError('invalid_command', `unknown generator "${entry.generator}"${at}`, `Generators: ${GENERATORS.list().map((x) => x.id).join(', ')} (search_assets).`, { errors: [{ code: 'invalid_command', path: 'generator', message: 'unknown generator' }] }) };
  const parsed = g.params.safeParse(entry.params ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`);
    return { ok: false, result: toolError('invalid_command', `invalid parameters for generator "${g.id}"${at}: ${issues.join('; ')}`, 'See the parameter ranges in search_assets.', { errors: issues.map((m) => ({ code: 'invalid_command', path: 'params', message: m })) }) };
  }
  const dims = g.describeParams(parsed.data).dims;
  const room = unknownRoom(working, entry.roomId);
  if (room) return { ok: false, result: room };
  const roomObj = working.rooms.find((r) => r.id === entry.roomId)!;
  const ceiling = roomCeilingHeight(working, roomObj);
  const rel = entryRelation(entry);
  if (!rel.ok) return { ok: false, result: rel.result };
  const mount = rel.relation.kind === 'on' ? 'floor' : (entry.mount ?? CONCEPT_MOUNT[g.id] ?? 'floor');
  if (mount === 'floor' && entry.elevation !== undefined && entry.elevation > 0 && rel.relation.kind !== 'on') {
    return { ok: false, result: toolError('invalid_command', `elevation is only for wall or ceiling shapes; the ${g.id} concept stands on the floor${at}`, 'Remove elevation, or pass mount "wall".') };
  }
  const defaultElevation = mount === 'ceiling' ? Math.max(0, ceiling - dims.h) : mount === 'wall' ? (g.id === 'curtains' ? Math.max(0, ceiling - dims.h - 0.05) : 0.9) : 0;
  const elevation = mount === 'floor' ? undefined : (entry.elevation ?? defaultElevation);
  const solved = solvePlacement(working, {
    roomId: entry.roomId,
    dims,
    mount,
    ...(elevation !== undefined ? { elevation } : {}),
    category: g.category,
    relation: rel.relation,
    ...(rel.rotation !== undefined ? { rotation: rel.rotation } : {}),
    maxCandidates: 3,
  });
  const label = `Concept ${g.id} (generated)`;
  if (!solved.ok) return { ok: false, result: placementRefused(label, solved.violations, solved.candidates, index) };
  const { placement } = solved;
  const item = {
    assetId: `param:${g.id}`,
    position: placement.position,
    rotation: placement.rotation,
    elevation: placement.elevation,
    roomId: placement.roomId,
    mount,
    dims: { w: dims.w, d: dims.d, h: dims.h },
    mesh: { kind: 'parametric', generator: g.id, params: entry.params ?? {} },
    concept: true,
    relation: placement.relation,
  };
  return { ok: true, item: item as never, name: label, rationale: [...solved.rationale, 'concept shape: not a product, not purchasable'] };
}

// ---------------------------------------------------------------------------------------------
// get_placement_options
// ---------------------------------------------------------------------------------------------

const getPlacementOptions: ToolDef = {
  name: 'get_placement_options',
  description:
    'Dry run of the placement solver (nothing changes): where could this product go in this room for a relation (against_wall, in_corner, centered_in, facing, next_to, under_window, on, at)? Returns up to 3 candidate spots (position, rotation, elevation, relation to pass to place_item) with reasons, or the violations (outside_room, overlap, door_swing_blocked, ...) with alternatives. The product must come from search_products in this session.',
  inputSchema: { ...obj({ productId: ENTRY_PROPS.productId!, roomId: ENTRY_PROPS.roomId!, relation: { ...RELATION_REF, description: 'The relation to try.' }, variantSku: ENTRY_PROPS.variantSku! }, ['productId', 'roomId', 'relation']), $defs: { relation: jsonSchema(Relation) } },
  annotations: READ,
  group: 'read',
  mutatesScene: false,
  async handler(ctx, args) {
    const a = parseArgs(OptionsArgs, args);
    if (!a.ok) return a.result;
    const loaded = await loadSeenProduct(ctx, a.data.productId);
    if (!loaded.ok) return loaded.result;
    const prep = prepare(loaded.data, a.data.variantSku);
    if (!prep.ok) return prep.result;
    const sc = await fetchScene(ctx);
    if (!sc.ok) return sc.result;
    const room = unknownRoom(sc.data.scene, a.data.roomId);
    if (room) return room;
    const scene = sc.data.scene;
    const rel = a.data.relation;
    const main = solvePlacement(scene, requestFor(prep.data, a.data.roomId, rel, {}));
    const head = { ok: true as const, productId: a.data.productId, name: prep.data.record.name, dims: dimsOf(prep.data.dims), mount: prep.data.record.mount, roomId: a.data.roomId, rev: sc.data.rev };
    if (!main.ok) {
      return toolOk({
        ...head,
        valid: false,
        violations: main.violations.map(violationOf),
        candidates: main.candidates.slice(0, 3).map((c) => candidateOf(c, `${altWhy(c)}; nothing blocks it`)),
      });
    }
    const candidates = [{ ...candidateOf(main.placement, ''), rationale: main.rationale, ...(main.warnings.length ? { warnings: main.warnings.map(violationOf) } : {}) }];
    // Against a wall, the other two alignments are real alternatives (start, centre, end).
    if (rel.kind === 'against_wall') {
      for (const align of ['center', 'start', 'end'] as const) {
        if (candidates.length >= 3) break;
        if (align === rel.align) continue;
        const alt = solvePlacement(scene, requestFor(prep.data, a.data.roomId, { ...rel, align }, {}));
        if (!alt.ok) continue;
        const [x, y] = alt.placement.position;
        if (candidates.some((c) => Math.hypot(c.position[0] - x, c.position[1] - y) < 0.05)) continue;
        candidates.push({ ...candidateOf(alt.placement, ''), rationale: alt.rationale });
      }
    }
    return toolOk({ ...head, valid: true, candidates });
  },
};

// ---------------------------------------------------------------------------------------------
// validate_layout and get_bill_of_materials
// ---------------------------------------------------------------------------------------------

const validateLayoutTool: ToolDef = {
  name: 'validate_layout',
  description:
    'Check the placed furniture of one room (or the whole flat) against the layout rules: inside the room, no overlaps, door swings and landings, window sills, glazing, walkways at least 0.8 m (0.9 m at the entry). Returns violations and warnings with the entities and a hint, the free floor area, the narrowest walkway, and totalEur (TTC, unlocked items only) plus overBudget when budgetEur is given. Call it after placing and before you finish.',
  inputSchema: obj({
    roomId: { type: 'string', description: 'Room to check (list_rooms). Default: every room.' },
    budgetEur: { type: 'number', minimum: 0, description: 'Budget in EUR (TTC prices only). With roomId it is compared with that room\'s items, else with the whole flat.' },
  }),
  annotations: READ,
  group: 'read',
  mutatesScene: false,
  async handler(ctx, args) {
    const a = parseArgs(LayoutArgs, args);
    if (!a.ok) return a.result;
    const sc = await fetchScene(ctx);
    if (!sc.ok) return sc.result;
    const scene = sc.data.scene;
    if (a.data.roomId !== undefined) {
      const room = unknownRoom(scene, a.data.roomId);
      if (room) return room;
    }
    const report = validateLayout(scene, a.data.roomId !== undefined ? { roomId: a.data.roomId } : {});
    const bom = billOfMaterials(scene, { now: ctx.clock.now() });
    const totalEur = a.data.roomId !== undefined ? (bom.byRoom[a.data.roomId]?.totalEur ?? 0) : bom.totalEur;
    const budget = a.data.budgetEur;
    return toolOk({
      ok: report.ok,
      rev: sc.data.rev,
      ...(report.roomId ? { roomId: report.roomId } : {}),
      itemCount: report.itemCount,
      violations: report.violations.map(violationOf),
      warnings: report.warnings.map(violationOf),
      ...(report.freeFloorM2 !== undefined ? { freeFloorM2: report.freeFloorM2 } : {}),
      ...(report.minWalkwayM !== undefined ? { minWalkwayM: report.minWalkwayM } : {}),
      totalEur,
      ...(budget !== undefined ? { budgetEur: budget, overBudget: totalEur > budget, ...(totalEur > budget ? { overByEur: Math.round((totalEur - budget) * 100) / 100 } : {}) } : {}),
      ...(bom.mixedCurrency ? { mixedCurrency: true } : {}),
      ...(bom.missingPrice.length ? { missingPrice: bom.missingPrice } : {}),
    });
  },
};

const getBillOfMaterials: ToolDef = {
  name: 'get_bill_of_materials',
  description:
    'Shopping list of the placed items, grouped by product: productId, name, link, quantity, unit price, what is left to buy (toBuy) and the amount. totalEur is TTC, unlocked items only (locked furniture is listed at 0; no delivery or assembly), byRoom has subtotals, stale lists prices older than 30 days. Prices are indicative.',
  inputSchema: obj({ roomId: { type: 'string', description: 'Only the items of this room (list_rooms). Default: the whole flat.' } }),
  annotations: READ,
  group: 'read',
  mutatesScene: false,
  async handler(ctx, args) {
    const a = parseArgs(BomArgs, args);
    if (!a.ok) return a.result;
    const sc = await fetchScene(ctx);
    if (!sc.ok) return sc.result;
    let scene = sc.data.scene;
    const now = ctx.clock.now();
    if (a.data.roomId !== undefined) {
      const room = unknownRoom(scene, a.data.roomId);
      if (room) return room;
      const mine = new Set(billOfMaterials(scene, { now }).lines.filter((l) => l.roomId === a.data.roomId).map((l) => l.itemId));
      scene = { ...scene, items: scene.items.filter((i) => mine.has(i.id)) };
    }
    const bom = billOfMaterials(scene, { now });
    const nameless = bom.lines.filter((l) => l.productId === undefined && !l.concept);
    return toolOk({
      ok: true,
      rev: sc.data.rev,
      ...(a.data.roomId ? { roomId: a.data.roomId } : {}),
      itemCount: bom.lines.length,
      totalEur: bom.totalEur,
      ...(bom.mixedCurrency ? { mixedCurrency: true, note: 'Some prices are not in EUR; totalEur leaves them out.' } : {}),
      bySku: bom.bySku.map((g) => ({
        productId: g.productId,
        name: g.name,
        ...(g.url ? { url: g.url } : {}),
        quantity: g.quantity,
        toBuy: g.toBuy,
        unitPrice: g.unitPrice,
        currency: g.currency,
        amount: g.amount,
        itemIds: g.itemIds,
        ...(g.stale ? { stale: true } : {}),
      })),
      ...(scene.items.some((i) => bedDressingOf(i)) ? { notes: ['Bed frames are listed without a mattress: the mattress, duvet and pillows in the pictures are a visual dressing, not part of this bill. Add a mattress separately.'] } : {}),
      ...(bom.concept.count ? { concept: { count: bom.concept.count, itemIds: bom.concept.itemIds, byRoom: bom.concept.byRoom, note: 'CONCEPT shapes (generated stand-ins, not products): not purchasable, 0 EUR, not in totalEur or byRoom. Replace them with real products when one fits.' } } : {}),
      ...(nameless.length ? { withoutProduct: nameless.map((l) => ({ itemId: l.itemId, name: l.name, locked: l.locked })) } : {}),
      byRoom: bom.byRoom,
      ...(bom.stale.length ? { stale: bom.stale } : {}),
      ...(bom.missingPrice.length ? { missingPrice: bom.missingPrice } : {}),
    });
  },
};

// ---------------------------------------------------------------------------------------------
// place_item
// ---------------------------------------------------------------------------------------------

const PLACE_DESCRIPTION =
  'Put a real product into a room. The productId must come from search_products or get_product in this session (else unknown_product); name, price, dimensions and link come from the server\'s product record, not from you. ' +
  'Give a relation (against_wall, in_corner, centered_in, facing, next_to, under_window: the server finds a valid position and rotation) or an explicit position + rotation. ' +
  'Decor goes ON furniture with relation {kind:"on", itemId}: a table lamp, vase, plant or frame on a nightstand, table or shelf, a cushion or throw on a sofa or bed (elevation is the top of that item; it must fit). ' +
  'Several products: pass items[] (up to 12, one undo step, placed in order). An invalid spot gives placement_invalid with the violations and alternative candidates. ' +
  'The shape defaults to the real 3D model, else a lookalike, else a parametric shape at the exact dims. ' +
  'To switch a placed item to another colour or size, pass only itemId + variantSku (variants[].sku from get_product); price and dims are rebuilt. ' +
  'A lamp comes with a light (placed[].light, switch or dim it with light_update). Check the result with validate_layout.';

function placeSchema(): Json {
  // Single mode: the fields are references into the placement definition (written once).
  const single = Object.fromEntries(Object.keys(ENTRY_PROPS).map((k) => [k, { $ref: `#/$defs/placement/properties/${k}` }]));
  const base = obj({ ...single, itemId: { type: 'string', description: 'Variant mode: id of a placed item (describe_room) to switch to variantSku. Give only itemId + variantSku.' }, items: { type: 'array', minItems: 1, maxItems: MAX_PLACEMENTS, items: { $ref: '#/$defs/placement' }, description: `Several placements in one call (instead of the single fields), at most ${MAX_PLACEMENTS}.` } });
  return withMcpExtras({ ...base, required: [], $defs: { ...DEFS(), placement: obj(ENTRY_PROPS, ENTRY_REQUIRED) } });
}

interface PlacedInfo {
  name: string;
  /** Absent for a concept item. */
  productId?: string;
  concept?: true;
  price: number;
  currency: string;
  roomId: string;
  position: [number, number];
  rotation: number;
  elevation: number;
  mesh: string;
  rationale: string[];
  /** Lamps: the light that came with the item (its lumens are the product's, or an estimate for the kind of lamp). */
  light?: { id: string; lumens: number; kelvin: number; lumensSource: string };
}

/** Adds `placed` (and the cost of this call) to a successful write result. */
function withPlaced(result: CallToolResult, placed: PlacedInfo[]): CallToolResult {
  const body = result.structuredContent as Json | undefined;
  if (result.isError || !body) return result;
  const changed = (body.changed ?? body.wouldChange) as { items?: string[] } | undefined;
  const ids = changed?.items ?? [];
  const addedEur = Math.round(placed.filter((p) => p.currency === 'EUR').reduce((s, p) => s + p.price, 0) * 100) / 100;
  const next = { ...body, placed: placed.map((p, i) => ({ ...(ids.length === placed.length ? { itemId: ids[i] } : {}), ...p })), addedEur };
  const content = result.content.map((c, i) => (i === 0 && c.type === 'text' ? { type: 'text' as const, text: JSON.stringify(next) } : c));
  return { ...result, content, structuredContent: next };
}

/**
 * Variant mode of `place_item`: the snapshot and dims are rebuilt from the SERVER record of the item's
 * product (which this session must have seen) and dispatched as `item.setVariant`; nothing from the arguments but the SKU.
 */
async function setItemVariant(ctx: ToolContext, rest: Json, extras: { ifRev: number | undefined; preview: boolean }, plan: Parameters<typeof executeCommand>[2]['plan']): Promise<CallToolResult> {
  const parsed = parseArgs(VariantArgs, rest);
  if (!parsed.ok) return parsed.result;
  const { itemId, variantSku } = parsed.data;
  if (ctx.config.readOnly) return toolError('read_only', 'this MCP server is read-only (FLAT_MCP_READONLY)');
  const sc = await fetchScene(ctx);
  if (!sc.ok) return sc.result;
  const found = sc.data.scene.items.find((i) => i.id === itemId);
  if (!found) {
    const ids = sc.data.scene.items.map((i) => i.id);
    return toolError('unknown_entity', `no item "${itemId}"`, `Did you mean ${nearestIds(itemId, ids).map((x) => `"${x}"`).join(', ') || 'none'}? Items: ${ids.join(', ') || '(none)'} (describe_room).`);
  }
  const ref = found.productRef ?? (found.product ? { provider: found.product.provider, sku: found.product.sku } : undefined);
  if (!ref) return toolError('precondition_failed', `item "${itemId}" is not a product (no productRef), it has no variants`, 'Place a real product with place_item instead.');
  const productId = `${ref.provider}:${ref.sku}`;
  const loaded = await loadSeenProduct(ctx, productId);
  if (!loaded.ok) return loaded.result;
  const prep = prepare(loaded.data, variantSku);
  if (!prep.ok) return prep.result;
  const { record, variant, dims } = prep.data;
  if (!record.priceTtc) return toolError('invalid_command', `product ${productId} has a non-TTC price and cannot be placed`, 'Budgets count TTC prices only; pick another product.');
  let snapshot;
  try {
    snapshot = productSnapshot({ ...record, price: variant?.price ?? record.price, dims, url: variant?.url ?? record.url }, record.fetchedAt, variant?.colour);
  } catch (e) {
    return toolError('invalid_command', e instanceof Error ? e.message : String(e));
  }
  const cmd = { type: 'item.setVariant', id: itemId, variant: variantSku, product: snapshot, dims } as unknown as Command;
  const result = await executeCommand(ctx, cmd, { ifRev: extras.ifRev ?? sc.data.rev, preview: extras.preview, plan });
  const body = result.structuredContent as Json | undefined;
  if (result.isError || !body) return result;
  const next = { ...body, variant: { itemId, name: snapshot.name, productId, variantSku, price: snapshot.price, currency: snapshot.currency, dims: dimsOf(dims) } };
  return { ...result, content: result.content.map((c, i) => (i === 0 && c.type === 'text' ? { type: 'text' as const, text: JSON.stringify(next) } : c)), structuredContent: next };
}

async function placeItem(ctx: ToolContext, args: Json): Promise<CallToolResult> {
  if (Buffer.byteLength(JSON.stringify(args)) > ctx.limits.maxArgBytes) return toolError('invalid_command', `arguments exceed ${ctx.limits.maxArgBytes} bytes`);
  const split = splitExtras(args, { labelIsExtra: true });
  if (!split.ok) return split.result;
  const { extras, rest } = split;
  const planned = planRender(extras.render);
  if (!planned.ok) return planned.result;

  if ('itemId' in rest) return setItemVariant(ctx, rest, extras, planned.plan);

  const parsed = 'items' in rest ? parseArgs(PlaceMany, rest) : parseArgs(Entry, rest);
  if (!parsed.ok) return parsed.result;
  const entries: Entry[] = 'items' in parsed.data ? (parsed.data as z.infer<typeof PlaceMany>).items : [parsed.data as Entry];
  if (entries.length > ctx.limits.maxBatch) return toolError('batch_too_large', `${entries.length} placements; the limit is ${ctx.limits.maxBatch}`);
  if (ctx.config.readOnly) return toolError('read_only', 'this MCP server is read-only (FLAT_MCP_READONLY)');

  const sc = await fetchScene(ctx);
  if (!sc.ok) return sc.result;
  const base: SceneResponse = sc.data;
  let working: Scene = base.scene;
  const providers: { list?: ProviderInfo[] } = {};
  const commands: Command[] = [];
  const placed: PlacedInfo[] = [];
  const placedIds: string[] = [];

  for (const [index, raw] of entries.entries()) {
    const at = entries.length > 1 ? ` [items/${index}]` : '';
    const backref = resolveBackRefs(raw, placedIds, at);
    if (!backref.ok) return backref.result;
    const entry = backref.entry;
    if (entry.concept) {
      const made = conceptItem(working, entry, at, entries.length > 1 ? index : undefined);
      if (!made.ok) return made.result;
      const cmd = { type: 'item.place', item: made.item } as unknown as Command;
      commands.push(cmd);
      const step = applyCommand(working, makeEnvelope(cmd, { id: ctx.clock.newId(), ts: ctx.clock.now(), author: ctx.author }), { rev: base.rev });
      if (!step.ok) return commandErrors(step.errors, base.rev);
      working = step.scene;
      placedIds.push(step.changed.items?.[0] ?? working.items.at(-1)?.id ?? '');
      placed.push({ name: made.name, concept: true, price: 0, currency: 'EUR', roomId: made.item.roomId, position: made.item.position, rotation: made.item.rotation, elevation: made.item.elevation, mesh: 'concept (generated, not a product)', rationale: made.rationale });
      continue;
    }
    const productId = entry.productId!;
    const loaded = await loadSeenProduct(ctx, productId);
    if (!loaded.ok) return loaded.result;
    const prep = prepare(loaded.data, entry.variantSku);
    if (!prep.ok) return prep.result;
    const room = unknownRoom(working, entry.roomId);
    if (room) return room;
    const { record, variant, dims } = prep.data;
    if (!record.priceTtc) return toolError('invalid_command', `product ${productId} has a non-TTC price and cannot be placed${at}`, 'Budgets count TTC prices only; pick another product.');
    const mounted = effectiveMount(record, entry);
    if (!mounted.ok) return toolError('invalid_command', `${mounted.message}${at}`, 'Remove mount (and elevation), or pick a product that hangs (shelf, mirror, lamp, wall cabinet).', { errors: [{ code: 'invalid_command', path: 'mount', message: 'cannot be hung' }] });
    prep.data.mount = mounted.mount;
    if (prep.data.mount === 'floor' && entry.elevation !== undefined && entry.elevation > 0) return toolError('invalid_command', `elevation is only for wall or ceiling products; "${record.name}" stands on the floor${at}`, 'Remove elevation, or pass mount "wall" if this shelf, mirror, lamp or cabinet hangs on the wall (the shop lists it as floor-standing).', { errors: [{ code: 'invalid_command', path: 'elevation', message: 'floor product' }] });

    // Argument problems (shape, dims) are reported before the solver runs.
    const mesh = await chooseMesh(ctx, providers, prep.data, entry.mesh);
    if (!mesh.ok) return mesh.result;

    const rel = entryRelation(entry);
    if (!rel.ok) return rel.result;
    const solved = solvePlacement(working, requestFor(prep.data, entry.roomId, rel.relation, { elevation: entry.elevation, rotation: rel.rotation, acknowledge: entry.acknowledgeHeavyPartition }));
    if (!solved.ok) return placementRefused(record.name, solved.violations, solved.candidates, entries.length > 1 ? index : undefined);

    let snapshot;
    try {
      snapshot = productSnapshot({ ...record, price: variant?.price ?? record.price, dims, url: variant?.url ?? record.url }, record.fetchedAt, variant?.colour);
    } catch (e) {
      return toolError('invalid_command', e instanceof Error ? e.message : String(e));
    }
    const { placement } = solved;
    const productRef = { provider: record.provider, sku: record.sku };
    const item = {
      assetId: mesh.mesh ? meshAssetId(mesh.mesh, productRef) : productId,
      position: placement.position,
      rotation: placement.rotation,
      elevation: placement.elevation,
      roomId: placement.roomId,
      productRef,
      product: snapshot,
      mount: prep.data.mount,
      dims,
      ...(entry.dressing === false ? { dressing: false } : {}),
      ...(variant ? { variant: variant.sku } : {}),
      ...(mesh.mesh ? { mesh: mesh.mesh } : {}),
      relation: placement.relation,
    };
    const cmd = { type: 'item.place', item } as unknown as Command;
    commands.push(cmd);
    // Later placements must see this one.
    const step = applyCommand(working, makeEnvelope(cmd, { id: ctx.clock.newId(), ts: ctx.clock.now(), author: ctx.author }), { rev: base.rev });
    if (!step.ok) return commandErrors(step.errors, base.rev);
    working = step.scene;
    placedIds.push(step.changed.items?.[0] ?? working.items.at(-1)?.id ?? '');
    const lamp = working.lights.find((l) => l.id === step.changed.lights[0] && l.itemId !== undefined);
    placed.push({
      name: snapshot.name,
      productId: productId,
      price: snapshot.price,
      currency: snapshot.currency,
      roomId: placement.roomId,
      position: placement.position,
      rotation: placement.rotation,
      elevation: placement.elevation,
      mesh: mesh.source,
      rationale: solved.rationale,
      ...(lamp && lamp.type !== 'grid' ? { light: { id: lamp.id, lumens: Math.round(lamp.lumens), kelvin: lamp.kelvin, lumensSource: lamp.lumensSource ?? 'estimated' } } : {}),
    });
  }

  const roomNames = [...new Set(placed.map((p) => base.scene.rooms.find((r) => r.id === p.roomId)?.name ?? p.roomId))];
  const where = roomNames.length === 1 ? roomNames[0]! : `${roomNames.length} rooms`;
  const what = placed.length === 1 ? placed[0]!.name : `${placed.length} items (${placed.map((p) => p.name).join(', ')})`;
  const label = (extras.label ?? `Placed ${what} in ${where}`).slice(0, 200);
  const batch = { type: 'batch', label, commands } as unknown as Command;
  const result = await executeCommand(ctx, batch, { ifRev: extras.ifRev ?? base.rev, preview: extras.preview, plan: planned.plan });
  return withPlaced(result, placed);
}

const placeItemTool: ToolDef = {
  name: 'place_item',
  title: 'Place a product',
  description: PLACE_DESCRIPTION,
  inputSchema: placeSchema(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  group: 'write',
  mutatesScene: true,
  handler: placeItem,
};

export function placementTools(): ToolDef[] {
  return [getPlacementOptions, validateLayoutTool, getBillOfMaterials, placeItemTool];
}
