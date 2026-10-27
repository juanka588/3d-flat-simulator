import { MeshBuilder, emptyMesh } from '../geometry/builder';
import type { Vec3 } from '../geometry/builder';
import type { MeshData } from '../geometry/types';
import type { Item, Scene, Vec2 } from '../schema';
import { BUILTIN_ASSETS } from './builtin-assets';
import { GENERATORS } from './catalog';
import { bedDressingOf, buildBedDressing } from './dressing';
import { Kit } from './generators/kit';
import { tv } from './generators/misc';
import { ITEM_MATERIALS } from './item-materials';
import './generators'; // registers every generator in GENERATORS (side effect)

/**
 * Minimal built-in assets: a precursor of the M5 furniture catalog, used to give the flat a
 * sense of scale (a 55" TV) without any asset loading.
 *
 * ITEM-LOCAL FRAME (right-handed, metres), matching the world mapping of the scene format:
 * - origin: centre of the item's footprint, at its lowest point (`dims.h` is measured up from it);
 * - +x: the item's right as seen from the front (width `w` spans x in [-w/2, w/2]);
 * - +y: up (height `h` spans y in [0, h]); the item's bottom sits at `Item.elevation`;
 * - +z: the FRONT. The front face is at z = +d/2 and the back (the wall side of a wall-mounted
 *   item) at z = -d/2 (depth `d` spans z in [-d/2, d/2]).
 *
 * Placement: `Item.position` is the plan `[x, y]` of the origin, `Item.rotation` turns the item
 * about the vertical axis, degrees counter-clockwise seen from above (= three.js `rotation.y`).
 * With world X = plan x and Z = plan y, local +z maps to the plan direction
 * `[sin(rotation), cos(rotation)]`, so at rotation 0 the front faces plan +y ("down the page",
 * south on the blueprint), at 90 it faces plan +x, at 180 plan -y and at 270 plan -x.
 * Example: a TV hung on the south face (y = f) of a partition at rotation 0 has
 * `position.y = f + d/2`.
 *
 * COLLISION: items are not walking obstacles yet. When they become so, a wall-mounted item
 * whose bottom is above `WALK_CLEARANCE_M` does not block walking (see `itemBlocksWalking`).
 */

export { BUILTIN_ASSETS, isBuiltinAsset } from './builtin-assets';
export type { AssetCategory, AssetMount, BuiltinAsset } from './builtin-assets';
export { ITEM_MATERIALS, ITEM_MATERIAL_SPECS } from './item-materials';
export type { ItemMaterialId, ItemMaterialSpec } from './item-materials';
export { TV_55_DIAGONAL_M } from './generators/misc';

/** Edge length of the placeholder box drawn for unknown assets, in metres. */
export const PLACEHOLDER_SIZE_M = 0.3;
/** Items whose bottom is above this height (m) and that hang on a wall do not block walking. */
export const WALK_CLEARANCE_M = 0.6;

/** Plan direction (unit vector `[x, y]`) the front of the item faces; see the frame above. */
export function itemFrontDirection(item: Pick<Item, 'rotation'>): Vec2 {
  const r = (item.rotation * Math.PI) / 180;
  return [Math.sin(r), Math.cos(r)];
}

/** Whether an item is an obstacle when walking (reserved for when items join the collision set). */
export function itemBlocksWalking(item: Pick<Item, 'assetId' | 'elevation'>): boolean {
  const asset = BUILTIN_ASSETS[item.assetId];
  if (asset?.mount === 'wall' && item.elevation > WALK_CLEARANCE_M) return false;
  return true;
}

/** Human-readable label such as `TV 55″ – 1.23 × 0.71 m` (width x height). */
export function itemLabel(item: Pick<Item, 'assetId'>): string {
  const asset = BUILTIN_ASSETS[item.assetId];
  if (!asset) return `Unknown asset (${item.assetId})`;
  return `${asset.name} – ${asset.dims.w.toFixed(2)} × ${asset.dims.h.toFixed(2)} m`;
}

/** Item dims for geometry: `dims`, else the product's, else the builtin's, else `undefined`. */
function itemDims(item: Item): { w: number; d: number; h: number } | undefined {
  return item.dims ?? item.product?.dims ?? (Object.hasOwn(BUILTIN_ASSETS, item.assetId) ? BUILTIN_ASSETS[item.assetId]!.dims : undefined);
}

/** Labelled (magenta wireframe) box at exact dims, the 0.3 m cube when no dims are known. */
function placeholderBox(dims: { w: number; d: number; h: number } | undefined): MeshData {
  const kit = new Kit();
  const { w, d, h } = dims ?? { w: PLACEHOLDER_SIZE_M, d: PLACEHOLDER_SIZE_M, h: PLACEHOLDER_SIZE_M };
  kit.box(ITEM_MATERIALS.placeholder, -w / 2, 0, -d / 2, w / 2, h, d / 2);
  return kit.build();
}

/**
 * The shape of one item in the item-local frame (see the top of this file): its generator, the legacy TV,
 * or a placeholder box. `provider` and `lookalike` meshes are exact-dims placeholder boxes here: the viewer
 * swaps in the real GLB. Parametric meshes are generated from their params and, when the item declares dims,
 * stretched to them (the scene check allows 2% slack, the footprint stays exact).
 */
function localMesh(item: Item, cache: Map<string, MeshData>): MeshData {
  const dims = itemDims(item);
  const mesh = item.mesh;
  if (mesh?.kind === 'parametric') {
    const g = GENERATORS.get(mesh.generator);
    const parsed = g?.params.safeParse(mesh.params);
    if (g && parsed?.success) {
      const key = `${g.id}\u0000${JSON.stringify(parsed.data)}`;
      let local = cache.get(key);
      if (!local) {
        local = g.generate(parsed.data);
        cache.set(key, local);
      }
      const natural = g.describeParams(parsed.data).dims;
      return dims ? scaleMesh(local, [dims.w / natural.w, dims.h / natural.h, dims.d / natural.d]) : local;
    }
    return placeholderBox(dims);
  }
  if (mesh) return placeholderBox(dims);
  if (item.assetId === 'builtin:tv-55') return tv.generate({ diagonal: 55 });
  return placeholderBox(dims);
}

function scaleMesh(mesh: MeshData, s: Vec3): MeshData {
  if (Math.abs(s[0] - 1) < 1e-9 && Math.abs(s[1] - 1) < 1e-9 && Math.abs(s[2] - 1) < 1e-9) return mesh;
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = mesh.positions[i]! * s[0];
    positions[i + 1] = mesh.positions[i + 1]! * s[1];
    positions[i + 2] = mesh.positions[i + 2]! * s[2];
  }
  return { ...mesh, positions };
}

/** Appends an item-local mesh to `b` at the item's position, elevation and rotation, owned by the item. */
function appendItemMesh(b: MeshBuilder, item: Item, local: MeshData): void {
  const r = (item.rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const owner = { kind: 'item' as const, entityId: item.id };
  const mapped = new Map<number, number>();
  const vertex = (i: number): number => {
    let n = mapped.get(i);
    if (n === undefined) {
      const p = local.positions;
      const q = local.normals;
      const x = p[i * 3]!;
      const y = p[i * 3 + 1]!;
      const z = p[i * 3 + 2]!;
      const nx = q[i * 3]!;
      const nz = q[i * 3 + 2]!;
      // three.js rotation.y: x' = x cos + z sin, z' = -x sin + z cos.
      n = b.vertex(
        [item.position[0] + x * cos + z * sin, item.elevation + y, item.position[1] - x * sin + z * cos],
        [nx * cos + nz * sin, q[i * 3 + 1]!, -nx * sin + nz * cos],
        [local.uvs[i * 2]!, local.uvs[i * 2 + 1]!],
      );
      mapped.set(i, n);
    }
    return n;
  };
  for (const g of local.groups) {
    for (let k = g.start; k < g.start + g.count; k += 3) {
      b.triangle(vertex(local.indices[k]!), vertex(local.indices[k + 1]!), vertex(local.indices[k + 2]!), g.materialId, owner);
    }
  }
}

/**
 * Geometry for every item, in world space, owned by `{kind: 'item', entityId: item.id}`:
 *  - `mesh.kind === 'parametric'`: the registered generator at the item's exact dims;
 *  - `mesh.kind === 'provider' | 'lookalike'`: an exact-dims placeholder box (the viewer swaps in the GLB);
 *  - no mesh: `builtin:tv-55` gets its dedicated model, any other asset a placeholder box in
 *    `builtin:placeholder` (at its dims when known, else 0.3 m) and `validateScene` warns.
 * `options.dressed` (default: the items) are the items that get their visual dressing (a mattress, duvet and
 * pillows on a bed frame; see `dressing.ts`), also when the item itself is drawn from a model by the viewer.
 */
export function buildItems(scene: Pick<Scene, 'items'>, options: { dressed?: readonly Item[] } = {}): MeshData {
  const dressed = options.dressed ?? scene.items;
  if (scene.items.length === 0 && dressed.length === 0) return emptyMesh();
  const b = new MeshBuilder();
  const cache = new Map<string, MeshData>();
  for (const item of scene.items) appendItemMesh(b, item, localMesh(item, cache));
  // Visual dressing (a mattress on a bed frame): drawn whatever draws the item itself (its model, a generator, a box).
  for (const item of dressed) {
    const spec = bedDressingOf(item);
    if (spec) appendItemMesh(b, item, buildBedDressing(spec));
  }
  return b.build();
}
