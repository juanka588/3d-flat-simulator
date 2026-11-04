import type { RoomType } from '@flat/scene';
import type { StyleMeta } from '../styles';

/**
 * Room-type-aware prompts for the reference images (CG0 finding: a style's `forms` list is sofa-centred, so a bathroom
 * prompt built from it produced a living room and a bedroom showed a sofa). The room type decides WHAT is in the picture;
 * the style decides HOW it looks (palette, materials, lighting, textiles, decor). Style `forms` are only used where they
 * make sense, and furniture words that do not belong in the room are dropped and named in the negative prompt.
 */

export interface RoomTemplate {
  /** The room in one phrase. */
  subject: string;
  /** What must be in the picture. The control image fixes the architecture; this fills it. */
  furnishings: string;
  /** Keep style `forms` entries for this room? Entries matching `dropForms` are always removed. */
  useForms: boolean;
  /** Style textiles that belong here (matched against the style's textiles list); empty: none of them. */
  textiles: RegExp | null;
  /** Words that must not show up. */
  avoid: string;
}

const SEATING = /sofa|couch|armchair|settee|loveseat/i;

export const ROOM_TEMPLATES: Record<RoomType, RoomTemplate> = {
  living: {
    subject: 'a living room',
    furnishings: 'a sofa, a coffee table, a rug, a sideboard or media unit, a floor lamp, curtains at the windows, a few plants and books',
    useForms: true,
    textiles: /curtain|rug|cushion|throw|linen|wool|velvet/i,
    avoid: 'bed, bathtub, toilet, kitchen counter',
  },
  dining: {
    subject: 'a dining area',
    furnishings: 'a dining table with chairs, a pendant lamp above the table, a sideboard, a rug under the table',
    useForms: true,
    textiles: /curtain|rug|linen|table/i,
    avoid: 'bed, bathtub, toilet, sofa',
  },
  kitchen: {
    subject: 'a kitchen',
    furnishings: 'fitted kitchen cabinets, a worktop with a sink and hob, a cooker hood, a few stools or a small table, small appliances and a plant',
    useForms: false,
    textiles: /tea towel|curtain|runner/i,
    avoid: 'sofa, bed, bathtub, toilet, wardrobe',
  },
  bedroom: {
    subject: 'a bedroom',
    furnishings: 'a double bed with a headboard, bedding, two bedside tables with lamps, a wardrobe, a rug beside the bed, curtains',
    useForms: true,
    textiles: /bed|linen|curtain|rug|throw|cushion|duvet|blanket/i,
    avoid: 'sofa, couch, living room, bathtub, kitchen counter, toilet',
  },
  bathroom: {
    subject: 'a bathroom',
    furnishings: 'a bathtub or a walk-in shower, a vanity with a basin and a mirror, a toilet, a towel rail with folded towels, wall and floor tiles, a plant',
    useForms: false,
    textiles: /towel|bath|mat/i,
    avoid: 'sofa, couch, bed, armchair, living room, kitchen counter, television',
  },
  hallway: {
    subject: 'an entrance hall',
    furnishings: 'a coat rack or wall hooks, a bench or console table, a shoe cabinet, a mirror, a runner rug, a ceiling light',
    useForms: false,
    textiles: /rug|runner|jute|wool/i,
    avoid: 'sofa, bed, bathtub, toilet, kitchen counter',
  },
  office: {
    subject: 'a home office',
    furnishings: 'a desk with a chair, a laptop and a desk lamp, a bookshelf, a rug, a plant',
    useForms: true,
    textiles: /rug|curtain|wool|linen/i,
    avoid: 'bed, bathtub, toilet, kitchen counter',
  },
  storage: {
    subject: 'a storage room',
    furnishings: 'built-in shelving, storage boxes, a hanging rail, a ceiling light',
    useForms: false,
    textiles: null,
    avoid: 'sofa, bed, bathtub, toilet',
  },
  balcony: {
    subject: 'a small balcony',
    furnishings: 'a bistro table with two chairs, planters with greenery, an outdoor rug, string lights, a railing',
    useForms: false,
    textiles: /rug|cushion|outdoor/i,
    avoid: 'indoor sofa, bed, bathtub, kitchen counter, ceiling',
  },
  other: {
    subject: 'a room',
    furnishings: 'a few pieces of furniture suited to the architecture, a rug, a lamp, a plant',
    useForms: false,
    textiles: /rug|curtain/i,
    avoid: 'clutter',
  },
};

const BASE_NEGATIVE = 'text, watermark, logo, people, distorted perspective, blurry, low quality, cartoon, 3d render, sketch, painting';

const lc = (s: string) => s.replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase());
const clip = (xs: readonly string[], n: number) => xs.slice(0, n).map(lc).join(', ');
const tone = (kelvin: number) => (kelvin <= 3200 ? `warm ${kelvin} K evening light` : kelvin <= 4000 ? 'soft neutral daylight' : 'bright daylight');

/** Palette roles read like "walls (rice paper white)"; keep the text, drop the hex. */
const paletteWords = (meta: StyleMeta) => meta.palette.slice(0, 5).map((p) => lc(p.role));

export interface BuiltPrompt {
  prompt: string;
  negativePrompt: string;
  roomType: RoomType;
}

// -- prompt v2 rules (restyle spike) -----------------------------------------------------------------------------------------------

/**
 * The model reads "Haussmann" as a Haussmann room: 3.5 m ceilings, tall windows, a cornice, three windows on the facade. Our flat is a
 * modern 2010s building with a 2.5 m ceiling, so the word never reaches the image prompt, nor a cornice or a ceiling rose.
 */
export function plain(s: string): string {
  return s
    .replace(/\s*\([^)]*paint material[^)]*\)/gi, '')
    .replace(/\s*\(Haussmann(ian)?\)/gi, '')
    .replace(/Haussmann(ian)?/gi, 'Parisian')
    .replace(/,?\s*(and )?(a |an )?(ceiling )?(cornice|crown moulding|crown molding|ceiling rose|medallion)s?( [a-z ,-]+)?(?=[,.;]|$)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;])/g, '$1')
    .trim();
}
/** A style's name as it reads in an image prompt. */
export const plainName = (meta: StyleMeta): string => plain(meta.name);

const BUILDING =
  'The building is a modern 2010s French residential block: a flat white ceiling exactly 2.5 m high (only about a quarter taller than a standard 2.04 m door) without cornice, moulding or ceiling rose, standard-height white double-glazed windows and doors, smooth walls; do not make the room taller, wider or longer, do not zoom out.';
/** The same without the word "window": a model told about windows in a picture that has none draws one. */
const BUILDING_CLOSED =
  'The building is a modern 2010s French residential block: a flat white ceiling exactly 2.5 m high (only about a quarter taller than a standard 2.04 m door) without cornice, moulding or ceiling rose, standard white interior doors, smooth plain walls; do not make the room taller, wider or longer, do not zoom out.';
const OUTDOOR_BUILDING = 'A balcony of a modern 2010s French residential block seen in daylight: a railing, a facade with standard-height white double-glazed french doors, no cornice.';
const WINDOWLESS_VIEW = 'There is no window, no skylight and no extra door in this picture (the windows of the room are out of frame): the walls in view are solid, plain and closed; do not add a window or a door.';
const WINDOWLESS = 'There is no window, no skylight and no extra door anywhere in this picture: every wall is solid, plain and closed, lit only by artificial light (ceiling spots, wall lights, mirror light).';
/** Always in the negative prompt of an indoor reference. */
const BUILDING_NEGATIVE = 'Haussmann, cornice, ceiling rose, ceiling moulding, high ceiling, tall windows, extra windows, extra doors, changed room proportions';
const WINDOWLESS_NEGATIVE = 'window, skylight, extra door, daylight from a window, glass door, balcony, curtains, blinds, light through a window';
const FIXED_ONLY_BATHROOM =
  'only its fixed fittings (listed below), with towels, a bath mat, a small plant, a framed print and a small mirror as decor; no other sanitary ware, no extra vanity, no shower, no large mirror, the room keeps its small size';

/** What a multi-view reference adds to the prompt (see `reference/views.ts`). */
export interface ReferenceExtras {
  /** What the camera sees, read from the scene (`reference/facts.ts`): the openings and the fixed fittings of the picture. */
  facts?: { openingsText: string; fittingsText: string; windowless: boolean; roomWindowless?: boolean } | undefined;
  /** A bathroom or WC seen with its fittings: the picture holds those and decor, nothing else. */
  fixedOnly?: boolean | undefined;
  /** `kitchen`: the kitchen zone of a larger room, drawn with the kitchen template. */
  zone?: 'kitchen' | undefined;
  /** The open kitchen is in the picture of a living view: do not forbid it. */
  kitchenVisible?: boolean | undefined;
  /** What the camera looks at (words only). */
  viewHint?: string | undefined;
  /** The layout decided from the room, in plain words: the picture shows it, the camera does not decide it. */
  layout?: string | undefined;
}

/** Text-to-image prompt for the control-guided reference. */
export function buildReferencePrompt(meta: StyleMeta, roomType: RoomType, extra: ReferenceExtras = {}): BuiltPrompt {
  const kitchenZone = extra.zone === 'kitchen';
  const t = ROOM_TEMPLATES[kitchenZone ? 'kitchen' : roomType] ?? ROOM_TEMPLATES.other;
  const forms = t.useForms ? meta.forms.filter((f) => !(roomType === 'bedroom' || roomType === 'office' ? SEATING.test(f) : false)).map(plain) : [];
  const outdoor = roomType === 'balcony';
  const windowless = Boolean(extra.facts?.windowless) && !outdoor;
  const artificial = windowless && Boolean(extra.facts?.roomWindowless);
  const textiles = t.textiles ? meta.textiles.filter((x) => t.textiles!.test(x) && !(windowless && /curtain/i.test(x))).map(plain) : [];
  const furnishings = windowless ? t.furnishings.replace(/,?\s*(and )?curtains at the windows/, '') : t.furnishings;
  const fixedOnly = extra.fixedOnly && roomType === 'bathroom' && !kitchenZone;
  const parts: [string, string][] = [
    ['subject', `Professional interior design photograph of ${kitchenZone ? 'the open kitchen of a flat' : t.subject}${extra.kitchenVisible && !kitchenZone ? ' with an open kitchen in the background' : ''}, ${plainName(meta)} style: ${plain(lc(meta.summary)).replace(/\.$/, '')}.`],
    ['building', outdoor ? OUTDOOR_BUILDING : windowless ? BUILDING_CLOSED : BUILDING],
    ['contains', `It contains ${fixedOnly ? FIXED_ONLY_BATHROOM : furnishings}.`],
    ['openings', extra.facts?.openingsText ?? ''],
    ['fittings', extra.facts?.fittingsText ?? ''],
    ['windowless', windowless ? (artificial ? WINDOWLESS : WINDOWLESS_VIEW) : ''],
    ['hint', extra.viewHint ?? ''],
    ['layout', extra.layout ?? ''],
    ['palette', `Palette: ${paletteWords(meta).map(plain).join(', ')}.`],
    ['materials', `Materials: ${clip(meta.materials.map(plain).filter(Boolean), 4)}.`],
    ['shapes', forms.length ? `Shapes: ${clip(forms, 3)}.` : ''],
    ['textiles', textiles.length ? `Textiles: ${clip(textiles, 3)}.` : ''],
    ['decor', meta.decor.length ? `Decor: ${clip(meta.decor.map(plain), 2)}.` : ''],
    ['lighting', `Lighting: ${artificial ? 'warm artificial light, no daylight' : tone(meta.lighting.kelvin)}, ${clip(meta.lighting.layers.map(plain), 2)}.`],
    ['closing', windowless ? 'Photorealistic, natural materials, sharp focus, shot on a 24 mm lens, architectural magazine quality. The room keeps exactly the layout, walls and doors of the line drawing; do not add, remove or move any door or opening.' : 'Photorealistic, natural materials, sharp focus, shot on a 24 mm lens, architectural magazine quality. The room keeps exactly the layout, walls, windows and doors of the line drawing; do not add, remove, move, widen or heighten any window or door.'],
  ];
  // The image service takes at most 2000 characters: drop the least useful style detail first, never the geometry (openings, fittings, layout).
  const MAX_CHARS = 1900;
  const keep = new Map(parts.filter(([, text]) => text));
  for (const k of ['decor', 'textiles', 'shapes', 'materials', 'hint', 'lighting', 'palette']) {
    if ([...keep.values()].join(' ').length <= MAX_CHARS) break;
    keep.delete(k);
  }
  const avoidBase = extra.kitchenVisible && !kitchenZone ? t.avoid.replace(/,?\s*kitchen counter/, '') : t.avoid;
  const avoid = [avoidBase, ...meta.avoid.slice(0, 3).map(lc), ...(outdoor ? [] : [BUILDING_NEGATIVE]), ...(windowless ? [WINDOWLESS_NEGATIVE] : []), ...(fixedOnly ? ['vanity, shower, large mirror, extra sink'] : [])].filter(Boolean).join(', ');
  return { prompt: [...keep.values()].join(' '), negativePrompt: `${BASE_NEGATIVE}, ${avoid}`.slice(0, MAX_CHARS), roomType };
}

/** Prompt of the klein edit that turns our clean render into a photograph ("visualisation"). */
export function buildVisualisationPrompt(meta: StyleMeta, roomType: RoomType): BuiltPrompt {
  const t = ROOM_TEMPLATES[roomType] ?? ROOM_TEMPLATES.other;
  const prompt =
    `Turn this 3D render of ${t.subject} into a realistic interior photograph, ${plainName(meta)} style, ${tone(meta.lighting.kelvin)}. ` +
    `Keep the room layout, camera, walls, windows, doors and every piece of furniture where they are; ${clip(meta.materials, 3)}; palette: ${paletteWords(meta).slice(0, 3).join(', ')}. ` +
    'Realistic materials, soft shadows, no new objects.';
  return { prompt, negativePrompt: BASE_NEGATIVE, roomType };
}
