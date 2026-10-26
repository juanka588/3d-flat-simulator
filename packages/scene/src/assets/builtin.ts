import { MeshBuilder, emptyMesh } from '../geometry/builder';
import type { Vec3 } from '../geometry/builder';
import type { MeshData } from '../geometry/types';
import type { Item, Scene, Vec2 } from '../schema';

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

export type AssetCategory = 'electronics';
export type AssetMount = 'floor' | 'wall';

export interface BuiltinAsset {
  name: string;
  category: AssetCategory;
  /** Width (local x), depth (local z) and height (local y) in metres. */
  dims: { w: number; d: number; h: number };
  mount: AssetMount;
}

/** Diagonal of a 55 inch screen: 55 x 0.0254 m. */
export const TV_55_DIAGONAL_M = 55 * 0.0254;
/** Visible panel of a 55" 16:9 screen (1.397 * 16 / sqrt(16^2 + 9^2) and 1.397 * 9 / sqrt(...)). */
const TV_SCREEN_W = (TV_55_DIAGONAL_M * 16) / Math.hypot(16, 9);
const TV_SCREEN_H = (TV_55_DIAGONAL_M * 9) / Math.hypot(16, 9);
/** Thin bezel: 6 mm at the sides, 12.5 mm above and below the panel. */
const TV_BEZEL_SIDE = 0.006;
const TV_BEZEL_VERTICAL = 0.0125;
const TV_W = round3(TV_SCREEN_W + 2 * TV_BEZEL_SIDE); // 1.23
const TV_H = round3(TV_SCREEN_H + 2 * TV_BEZEL_VERTICAL); // 0.71
const TV_D = 0.05;

export const BUILTIN_ASSETS: Record<string, BuiltinAsset> = {
  'builtin:tv-55': {
    name: 'TV 55″',
    category: 'electronics',
    dims: { w: TV_W, d: TV_D, h: TV_H },
    mount: 'wall',
  },
};

/** Material ids of built-in item meshes. */
export const ITEM_MATERIALS = {
  tvBody: 'builtin:tv-body',
  tvScreen: 'builtin:tv-screen',
  placeholder: 'builtin:placeholder',
} as const;

/** Edge length of the placeholder box drawn for unknown assets, in metres. */
export const PLACEHOLDER_SIZE_M = 0.3;
/** Items whose bottom is above this height (m) and that hang on a wall do not block walking. */
export const WALK_CLEARANCE_M = 0.6;

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export function isBuiltinAsset(assetId: string): boolean {
  return Object.hasOwn(BUILTIN_ASSETS, assetId);
}

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

type Owner = { kind: 'item'; entityId: string };

/** Adds an axis-aligned (item-local) box to the builder, transformed to world space. */
function addBox(
  b: MeshBuilder,
  item: Item,
  owner: Owner,
  materialId: string,
  min: Vec3,
  max: Vec3,
  skip: ReadonlySet<string> = new Set(),
): void {
  const r = (item.rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  // three.js rotation.y: x' = x cos + z sin, z' = -x sin + z cos.
  const world = (p: Vec3): Vec3 => [
    item.position[0] + p[0] * cos + p[2] * sin,
    item.elevation + p[1],
    item.position[1] - p[0] * sin + p[2] * cos,
  ];
  const dir = (n: Vec3): Vec3 => [n[0] * cos + n[2] * sin, n[1], -n[0] * sin + n[2] * cos];
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  // Each face: outward local normal and 4 corners counter-clockwise seen from outside.
  const faces: { name: string; n: Vec3; c: [Vec3, Vec3, Vec3, Vec3]; uv: [number, number][] }[] = [
    { name: 'front', n: [0, 0, 1], c: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], uv: [[0, 0], [x1 - x0, 0], [x1 - x0, y1 - y0], [0, y1 - y0]] },
    { name: 'back', n: [0, 0, -1], c: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], uv: [[0, 0], [x1 - x0, 0], [x1 - x0, y1 - y0], [0, y1 - y0]] },
    { name: 'right', n: [1, 0, 0], c: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], uv: [[0, 0], [z1 - z0, 0], [z1 - z0, y1 - y0], [0, y1 - y0]] },
    { name: 'left', n: [-1, 0, 0], c: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], uv: [[0, 0], [z1 - z0, 0], [z1 - z0, y1 - y0], [0, y1 - y0]] },
    { name: 'top', n: [0, 1, 0], c: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], uv: [[0, 0], [x1 - x0, 0], [x1 - x0, z1 - z0], [0, z1 - z0]] },
    { name: 'bottom', n: [0, -1, 0], c: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], uv: [[0, 0], [x1 - x0, 0], [x1 - x0, z1 - z0], [0, z1 - z0]] },
  ];
  for (const f of faces) {
    if (skip.has(f.name)) continue;
    b.quad(
      f.c.map(world) as [Vec3, Vec3, Vec3, Vec3],
      dir(f.n),
      f.uv as [[number, number], [number, number], [number, number], [number, number]],
      materialId,
      owner,
    );
  }
}

function addTv(b: MeshBuilder, item: Item, asset: BuiltinAsset): void {
  const { w, d, h } = asset.dims;
  const owner: Owner = { kind: 'item', entityId: item.id };
  const back = -d / 2;
  // Layers along local z: bracket plate (back 1.5 cm), body (3 cm), screen proud of the body (5 mm).
  const bracketFront = back + 0.015;
  const bodyFront = d / 2 - 0.005;
  addBox(b, item, owner, ITEM_MATERIALS.tvBody, [-0.1, h / 2 - 0.1, back], [0.1, h / 2 + 0.1, bracketFront]);
  addBox(b, item, owner, ITEM_MATERIALS.tvBody, [-w / 2, 0, bracketFront], [w / 2, h, bodyFront]);
  const sw = TV_SCREEN_W;
  const sh = TV_SCREEN_H;
  addBox(
    b,
    item,
    owner,
    ITEM_MATERIALS.tvScreen,
    [-sw / 2, (h - sh) / 2, bodyFront],
    [sw / 2, (h + sh) / 2, d / 2],
    new Set(['back', 'bottom']),
  );
}

function addPlaceholder(b: MeshBuilder, item: Item): void {
  const s = PLACEHOLDER_SIZE_M;
  addBox(b, item, { kind: 'item', entityId: item.id }, ITEM_MATERIALS.placeholder, [-s / 2, 0, -s / 2], [s / 2, s, s / 2]);
}

/**
 * Simple box geometry for every item. Known built-in assets get their dedicated model; any other
 * `assetId` gets a 0.3 m placeholder box in `builtin:placeholder` (and `validateScene` warns).
 * Owners are `{kind: 'item', entityId: item.id}`.
 */
export function buildItems(scene: Pick<Scene, 'items'>): MeshData {
  if (scene.items.length === 0) return emptyMesh();
  const b = new MeshBuilder();
  for (const item of scene.items) {
    const asset = Object.hasOwn(BUILTIN_ASSETS, item.assetId) ? BUILTIN_ASSETS[item.assetId] : undefined;
    if (asset && item.assetId === 'builtin:tv-55') addTv(b, item, asset);
    else addPlaceholder(b, item);
  }
  return b.build();
}
