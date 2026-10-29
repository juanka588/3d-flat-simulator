/**
 * Material ids of built-in item meshes (generators and legacy builtins) and how the viewer should draw
 * them. The viewer (`packages/viewer/src/materials.ts`) maps each id to a `MeshStandardMaterial` using
 * `ITEM_MATERIAL_SPECS`: a tuned PBR paint (colour / roughness / metalness) or a CC0 library texture from
 * `apps/web/public/materials` (`texture.slug`) whose average colour is steered to `color`.
 *
 * Generators speak in semantic slots (see `ITEM_SLOTS`): the carcass, the fronts, the worktop, fabric, metal,
 * ceramic, glass, wood. The ids below are what a slot resolves to; the `finish` param of a cabinet generator
 * (`FINISHES` in generators/kit.ts) picks the id of the carcass and the fronts.
 */
export const ITEM_MATERIALS = {
  tvBody: 'builtin:tv-body',
  tvScreen: 'builtin:tv-screen',
  placeholder: 'builtin:placeholder',
  /** Painted panels (carcasses, doors, shelves): satin white lacquer. */
  white: 'builtin:furniture-white',
  /** Warm timber veneer (tops, frames, legs). */
  wood: 'builtin:furniture-wood',
  /** Dark lacquer accents (gloss). */
  dark: 'builtin:furniture-dark',
  /** Upholstery (sofa, chair seat): woven fabric with a normal map. */
  fabric: 'builtin:furniture-fabric',
  /** Mattress, pillows: soft linen. */
  bedding: 'builtin:furniture-bedding',
  /** Handles, metal legs, kick plates: brushed steel. */
  metal: 'builtin:furniture-metal',
  /** Kitchen worktop: polished quartz / terrazzo. */
  worktop: 'builtin:furniture-worktop',
  /** Mirror glass. */
  mirror: 'builtin:furniture-mirror',
  /** Rug pile. */
  rug: 'builtin:furniture-rug',
  /** Natural oak veneer. */
  oak: 'builtin:furniture-oak',
  /** Walnut veneer. */
  walnut: 'builtin:furniture-walnut',
  /** Matt white lacquer (no sheen). */
  whiteMatte: 'builtin:furniture-white-matte',
  /** Matt anthracite paint. */
  anthracite: 'builtin:furniture-anthracite',
  /** Glazed ceramic (basin, bath, toilet): high gloss white. */
  ceramic: 'builtin:furniture-ceramic',
  /** Appliance glass (oven window, hob plate): dark and glossy. */
  glass: 'builtin:furniture-glass',
  /** Enamelled appliance body (fridge, oven): satin white, slightly glossier than the lacquer. */
  enamel: 'builtin:furniture-enamel',
} as const;

/**
 * Named colours of the descriptor-driven finishes (CG4). A closed palette keeps meshes deterministic and the material ids a
 * finite set the viewer, the thumbnails and the tests all know; a descriptor colour is mapped to the nearest name
 * (`nearestColourName`, in apps/mcp).
 */
export const COLOUR_HEX = {
  white: '#f1efe9',
  cream: '#e8dfc9',
  beige: '#cdbb9f',
  sand: '#c2a97f',
  grey: '#8a949b',
  charcoal: '#45484d',
  black: '#1f2023',
  blue: '#5f84a8',
  navy: '#27374f',
  green: '#587a56',
  sage: '#9aab8a',
  terracotta: '#b9684a',
  rust: '#9a4f33',
  pink: '#d4a3a0',
  mustard: '#c9a13a',
  brown: '#6d4c37',
} as const;
export type ColourName = keyof typeof COLOUR_HEX;
export const COLOUR_NAMES = Object.keys(COLOUR_HEX) as [ColourName, ...ColourName[]];

/** Upholstery looks: a woven fabric (library weave texture), a plain velvet and a leather. */
export const FABRIC_KINDS = ['weave', 'velvet', 'leather'] as const;
export type FabricKind = (typeof FABRIC_KINDS)[number];

export type FabricMaterialId = `builtin:furniture-${FabricKind}-${ColourName}`;
export type CeramicMaterialId = `builtin:furniture-ceramic-${ColourName}`;

/** Material id of a coloured upholstery: `fabricMaterial('velvet', 'green')`. */
export const fabricMaterial = (kind: FabricKind, colour: ColourName): FabricMaterialId => `builtin:furniture-${kind}-${colour}`;
/** Material id of coloured glazed ceramic (bath, basin). */
export const ceramicMaterial = (colour: ColourName): CeramicMaterialId => `builtin:furniture-ceramic-${colour}`;
/** A translucent curtain fabric. */
export const SHEER_MATERIAL = 'builtin:furniture-sheer' as const;

export type ItemMaterialId = (typeof ITEM_MATERIALS)[keyof typeof ITEM_MATERIALS] | FabricMaterialId | CeramicMaterialId | typeof SHEER_MATERIAL;

/** The semantic slots of a generator part and the material each uses by default. */
export const ITEM_SLOTS = {
  carcass: ITEM_MATERIALS.white,
  front: ITEM_MATERIALS.white,
  worktop: ITEM_MATERIALS.worktop,
  fabric: ITEM_MATERIALS.fabric,
  metal: ITEM_MATERIALS.metal,
  ceramic: ITEM_MATERIALS.ceramic,
  glass: ITEM_MATERIALS.glass,
  wood: ITEM_MATERIALS.wood,
} as const;

export interface ItemMaterialTexture {
  /** Library material (`apps/web/public/materials/<slug>`). */
  slug: string;
  /** Edge length of one texture repeat, in metres; omitted = the library's own `tileSizeM`. */
  scale?: number;
}

export interface ItemMaterialSpec {
  /** Albedo. For a textured material this is the average colour the texture is steered to (and the colour shown until it has loaded). */
  color: string;
  roughness: number;
  metalness: number;
  /** Below 1: drawn see-through (sheer curtains). */
  opacity?: number;
  /** A CC0 library texture (colour, normal and roughness maps) laid on the part; UVs are in metres, so `scale` is a real-world size. */
  texture?: ItemMaterialTexture;
}

/** Suggested look of every item material (`MeshStandardMaterial` colour / roughness / metalness, optional texture). */
const BASE_SPECS: Readonly<Record<(typeof ITEM_MATERIALS)[keyof typeof ITEM_MATERIALS], ItemMaterialSpec>> = {
  'builtin:tv-body': { color: '#2b2c2f', roughness: 0.45, metalness: 0.3 },
  'builtin:tv-screen': { color: '#08090b', roughness: 0.06, metalness: 0.2 },
  'builtin:placeholder': { color: '#d048d0', roughness: 0.8, metalness: 0 },
  'builtin:furniture-white': { color: '#efede7', roughness: 0.38, metalness: 0 },
  'builtin:furniture-wood': { color: '#b98a5c', roughness: 0.55, metalness: 0, texture: { slug: 'oak-veneer' } },
  'builtin:furniture-dark': { color: '#303034', roughness: 0.3, metalness: 0.05 },
  'builtin:furniture-fabric': { color: '#8a949b', roughness: 0.92, metalness: 0, texture: { slug: 'fabric-weave-grey', scale: 0.5 } },
  'builtin:furniture-bedding': { color: '#e6e1d8', roughness: 0.9, metalness: 0, texture: { slug: 'fabric-cream', scale: 0.4 } },
  'builtin:furniture-metal': { color: '#bfc2c6', roughness: 0.32, metalness: 0.9, texture: { slug: 'brushed-steel', scale: 0.4 } },
  'builtin:furniture-worktop': { color: '#a9a59e', roughness: 0.3, metalness: 0, texture: { slug: 'quartz-light', scale: 0.9 } },
  'builtin:furniture-mirror': { color: '#d4e4ea', roughness: 0.03, metalness: 1 },
  'builtin:furniture-rug': { color: '#a79b8c', roughness: 1, metalness: 0, texture: { slug: 'fabric-weave-grey', scale: 0.7 } },
  'builtin:furniture-oak': { color: '#cfa978', roughness: 0.5, metalness: 0, texture: { slug: 'oak-veneer' } },
  'builtin:furniture-walnut': { color: '#7a5a42', roughness: 0.5, metalness: 0, texture: { slug: 'wood-walnut' } },
  'builtin:furniture-white-matte': { color: '#ecebe6', roughness: 0.8, metalness: 0 },
  'builtin:furniture-anthracite': { color: '#3a3b3f', roughness: 0.72, metalness: 0.05 },
  'builtin:furniture-ceramic': { color: '#f4f4f2', roughness: 0.1, metalness: 0 },
  'builtin:furniture-glass': { color: '#0b0c0f', roughness: 0.04, metalness: 0.3 },
  'builtin:furniture-enamel': { color: '#f1f1ee', roughness: 0.28, metalness: 0 },
};

/** The coloured upholstery, ceramic and sheer variants, generated from the palette (colour steers the shared library texture). */
function colourSpecs(): Record<string, ItemMaterialSpec> {
  const out: Record<string, ItemMaterialSpec> = {};
  for (const c of COLOUR_NAMES) {
    const color = COLOUR_HEX[c];
    out[fabricMaterial('weave', c)] = { color, roughness: 0.92, metalness: 0, texture: { slug: 'fabric-weave-grey', scale: 0.5 } };
    out[fabricMaterial('velvet', c)] = { color, roughness: 0.62, metalness: 0 };
    out[fabricMaterial('leather', c)] = { color, roughness: 0.42, metalness: 0 };
    out[ceramicMaterial(c)] = { color, roughness: 0.1, metalness: 0 };
  }
  out[SHEER_MATERIAL] = { color: '#f4f0e6', roughness: 1, metalness: 0, opacity: 0.45 };
  return out;
}

export const ITEM_MATERIAL_SPECS: Readonly<Record<ItemMaterialId, ItemMaterialSpec>> = { ...BASE_SPECS, ...colourSpecs() } as Record<ItemMaterialId, ItemMaterialSpec>;
