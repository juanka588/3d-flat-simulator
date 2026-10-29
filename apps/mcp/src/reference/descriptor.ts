import { PRODUCT_CATEGORIES } from '@flat/scene';
import { z } from 'zod';

/**
 * `ReferenceDescriptor` (CG4): what the model SEES in a reference image, as plain data. It is the M7 `DesignDescriptor`
 * (style, palette, materials, lighting, items, decor) made precise enough to search with: every item has a pixel `box`, an
 * approximate size and a placement hint, so the matcher can compare it with products and the gap report can say what is missing.
 *
 * Why it lives in `apps/mcp` and not in `@flat/assets` or `@flat/scene`: it is MCP-workflow data (a transcript of the model's
 * reading of one generated image, kept for the session), not part of the scene, the product model or the generators. The
 * generators take plain scalar params and never see a descriptor; `suggest.ts` maps one to the other here, validated against the
 * generator registry. Putting it in `scene` would make the scene package know about image pixels and CLIP; in `assets` it
 * would pull the MCP concerns (jobs, boxes in pixels) into the asset layer.
 */

const Text = (max: number) => z.string().trim().min(1).max(max);

export const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour like "#a3b18a"');

/** Where in the room an item stands, in the words the placement solver uses (plus the hung / free ones it handles with an elevation). */
export const PLACEMENT_RELATIONS = ['against_wall', 'in_corner', 'centered_in', 'facing', 'next_to', 'under_window', 'on', 'wall_mounted', 'ceiling_hung', 'free'] as const;

export const PaletteEntry = z.strictObject({
  hex: Hex,
  /** What the colour is used for, e.g. "walls", "floor", "sofa", "accent". */
  role: Text(24),
  /** Share of the image this colour covers, 0 to 100. */
  areaPct: z.number().min(0).max(100),
});

export const DescriptorItem = z.strictObject({
  /** Your own short id for the item ("tub", "vanity", "mirror-1"); unique in the descriptor. */
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, 'a short lowercase id like "tub" or "mirror-1"'),
  /** Product category (the catalogue's); "other" for sanitary ware and anything without one. */
  category: z.enum(PRODUCT_CATEGORIES),
  /** What it is, in a few words: "freestanding bathtub", "wall-hung vanity with vessel basin". */
  subtype: Text(80),
  /** Its form: "oval, rolled edge", "round globe", "3 seats, rolled arms, wooden legs". */
  shape: Text(120),
  /** Main colour, a name ("sage green") or a hex. */
  colour: Text(40),
  /** Main material or finish: "oak veneer", "matte black metal", "linen", "ceramic". */
  material: Text(60),
  /** Estimated real size in metres: width (left to right), depth (front to back), height. */
  approxDims: z.strictObject({ w: z.number().positive().max(10), d: z.number().positive().max(10), h: z.number().positive().max(10) }),
  /** Pixels of the item in the reference image: [x0, y0, x1, y1] (top-left origin, x right, y down). */
  box: z.tuple([z.number().min(0).max(8192), z.number().min(0).max(8192), z.number().min(0).max(8192), z.number().min(0).max(8192)]),
  placementHint: z.strictObject({
    relation: z.enum(PLACEMENT_RELATIONS),
    /** The wall it is against, as seen from the camera ("back", "left", "right") or a wall id. */
    wall: Text(24).optional(),
    /** Another item of this descriptor it stands near, on or faces. */
    nearItemId: Text(40).optional(),
  }),
  /** 1 (minor accessory) to 5 (the focal point of the room). */
  importance: z.number().int().min(1).max(5),
  /** Optional: catalogue search phrases, French first ("baignoire îlot ovale"). The shop is French; use it for the text search. */
  searchTerms: z.array(Text(60)).max(4).optional(),
});
export type DescriptorItem = z.infer<typeof DescriptorItem>;

export const ReferenceDescriptor = z
  .strictObject({
    /** The style in a few words ("french parisian, warm", "japandi bathroom"). */
    style: Text(80),
    palette: z.array(PaletteEntry).min(1).max(8),
    materials: z.strictObject({
      floor: Text(60),
      walls: Text(60),
      /** Other notable materials: brass fittings, rattan, marble splashback... */
      accents: z.array(Text(60)).max(8),
    }),
    lighting: z.strictObject({
      /** "bright daylight", "warm evening", "moody"... */
      mood: Text(60),
      /** Colour temperature of the dominant light, 1000 to 12000. */
      kelvin: z.number().min(1000).max(12000),
      /** The light fittings you see: "pendant globe over the vanity", "wall sconces". */
      fixtures: z.array(Text(80)).max(10),
    }),
    items: z.array(DescriptorItem).min(1).max(30),
    /** Decor and small things that are not worth a box: "dried pampas in a vase", "folded towels". */
    decor: z.array(Text(80)).max(20),
  })
  .superRefine((d, ctx) => {
    const seen = new Set<string>();
    d.items.forEach((it, i) => {
      if (seen.has(it.id)) ctx.addIssue({ code: 'custom', path: ['items', i, 'id'], message: `duplicate item id "${it.id}"` });
      seen.add(it.id);
      if (!(it.box[2] > it.box[0] && it.box[3] > it.box[1])) ctx.addIssue({ code: 'custom', path: ['items', i, 'box'], message: 'box must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0' });
    });
    d.items.forEach((it, i) => {
      const near = it.placementHint.nearItemId;
      if (near !== undefined && !seen.has(near)) ctx.addIssue({ code: 'custom', path: ['items', i, 'placementHint', 'nearItemId'], message: `no item "${near}" in this descriptor` });
      if (near === it.id) ctx.addIssue({ code: 'custom', path: ['items', i, 'placementHint', 'nearItemId'], message: 'an item cannot be near itself' });
    });
    const area = d.palette.reduce((s, p) => s + p.areaPct, 0);
    if (area > 105) ctx.addIssue({ code: 'custom', path: ['palette'], message: `palette areas add up to ${Math.round(area)}%, at most 100` });
  });
export type ReferenceDescriptor = z.infer<typeof ReferenceDescriptor>;

/** A filled-in skeleton for the `reference_reader` prompt: shows the model the exact shape. */
export const DESCRIPTOR_EXAMPLE: ReferenceDescriptor = {
  style: 'french parisian bathroom, warm and bright',
  palette: [
    { hex: '#efe9df', role: 'walls', areaPct: 45 },
    { hex: '#b8a58c', role: 'floor', areaPct: 20 },
    { hex: '#2b2b2b', role: 'fittings', areaPct: 5 },
  ],
  materials: { floor: 'honeycomb ceramic tile', walls: 'painted plaster with zellige splashback', accents: ['brass taps', 'oak vanity'] },
  lighting: { mood: 'soft daylight', kelvin: 3500, fixtures: ['pendant globe over the vanity', 'brass wall sconce'] },
  items: [
    {
      id: 'tub',
      category: 'other',
      subtype: 'freestanding bathtub',
      shape: 'oval, slipper profile, on small feet',
      colour: 'white',
      material: 'glossy ceramic',
      approxDims: { w: 1.7, d: 0.75, h: 0.6 },
      box: [60, 420, 520, 640],
      placementHint: { relation: 'against_wall', wall: 'left' },
      importance: 5,
      searchTerms: ['baignoire îlot', 'baignoire ovale'],
    },
  ],
  decor: ['folded towels on a stool', 'dried flowers in a vase'],
};

/** The item as a short phrase for logs, searches and reports: "freestanding bathtub (white, glossy ceramic)". */
export function itemPhrase(it: DescriptorItem): string {
  return `${it.subtype} (${it.colour}, ${it.material})`;
}
