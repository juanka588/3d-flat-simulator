/**
 * Material ids of built-in item meshes (generators and legacy builtins) and how the viewer should draw
 * them. The viewer (`apps/web/src/viewer/materials.ts`) maps each id to a `MeshStandardMaterial` using
 * `ITEM_MATERIAL_SPECS`; ids it does not know fall back to the wall material.
 */
export const ITEM_MATERIALS = {
  tvBody: 'builtin:tv-body',
  tvScreen: 'builtin:tv-screen',
  placeholder: 'builtin:placeholder',
  /** Painted panels (carcasses, doors, shelves). */
  white: 'builtin:furniture-white',
  /** Oak-like timber (tops, frames, legs). */
  wood: 'builtin:furniture-wood',
  /** Dark lacquer / anthracite accents. */
  dark: 'builtin:furniture-dark',
  /** Upholstery (sofa, chair seat). */
  fabric: 'builtin:furniture-fabric',
  /** Mattress, pillows. */
  bedding: 'builtin:furniture-bedding',
  /** Handles, metal legs. */
  metal: 'builtin:furniture-metal',
  /** Kitchen worktop. */
  worktop: 'builtin:furniture-worktop',
  /** Mirror glass. */
  mirror: 'builtin:furniture-mirror',
  /** Rug pile. */
  rug: 'builtin:furniture-rug',
} as const;

export type ItemMaterialId = (typeof ITEM_MATERIALS)[keyof typeof ITEM_MATERIALS];

export interface ItemMaterialSpec {
  color: string;
  roughness: number;
  metalness: number;
}

/** Suggested look of every item material (`MeshStandardMaterial` colour / roughness / metalness). */
export const ITEM_MATERIAL_SPECS: Readonly<Record<ItemMaterialId, ItemMaterialSpec>> = {
  'builtin:tv-body': { color: '#2b2c2f', roughness: 0.45, metalness: 0.3 },
  'builtin:tv-screen': { color: '#08090b', roughness: 0.08, metalness: 0.2 },
  'builtin:placeholder': { color: '#d048d0', roughness: 0.8, metalness: 0 },
  'builtin:furniture-white': { color: '#f0eee8', roughness: 0.6, metalness: 0 },
  'builtin:furniture-wood': { color: '#b98e5f', roughness: 0.65, metalness: 0 },
  'builtin:furniture-dark': { color: '#3b3a3c', roughness: 0.55, metalness: 0.05 },
  'builtin:furniture-fabric': { color: '#8f9aa3', roughness: 0.95, metalness: 0 },
  'builtin:furniture-bedding': { color: '#e8e4dc', roughness: 0.95, metalness: 0 },
  'builtin:furniture-metal': { color: '#b9bcc0', roughness: 0.35, metalness: 0.8 },
  'builtin:furniture-worktop': { color: '#6e6a66', roughness: 0.5, metalness: 0 },
  'builtin:furniture-mirror': { color: '#cfe3ea', roughness: 0.05, metalness: 0.9 },
  'builtin:furniture-rug': { color: '#a79b8c', roughness: 1, metalness: 0 },
};
