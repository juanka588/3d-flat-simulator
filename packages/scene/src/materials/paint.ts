import { Material } from '../schema';

export type Sheen = 'matt' | 'satin' | 'gloss';
export const SHEENS: readonly Sheen[] = ['matt', 'satin', 'gloss'];
export const SHEEN_ROUGHNESS: Record<Sheen, number> = { matt: 0.95, satin: 0.6, gloss: 0.3 };

/** Normalises `#abc`, `abc`, `#aabbcc` or `AABBCC` to lowercase `#aabbcc`; throws on anything else. */
export function normalizeHex(input: string): string {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(typeof input === 'string' ? input.trim() : '');
  if (!m) throw new Error(`Invalid hex colour ${JSON.stringify(input)}: expected #abc, #aabbcc or AABBCC`);
  let h = (m[1] ?? '').toLowerCase();
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return `#${h}`;
}

/** Deterministic paint material (`paint-<hex6>-<sheen>`), so identical choices dedupe to one scene material. */
export function paintMaterial(hex: string, sheen: Sheen = 'matt'): Material {
  if (!SHEENS.includes(sheen)) throw new Error(`Invalid sheen ${JSON.stringify(sheen)}: expected matt, satin or gloss`);
  const color = normalizeHex(hex);
  return Material.parse({
    id: `paint-${color.slice(1)}-${sheen}`,
    name: `Paint ${color} (${sheen})`,
    kind: 'paint',
    color,
    roughness: SHEEN_ROUGHNESS[sheen],
  });
}

export interface Swatch {
  name: string;
  hex: string;
}
export interface SwatchGroup {
  group: 'whites-neutrals' | 'warm-earthy' | 'cool-greens-blues' | 'deep-accents';
  label: string;
  swatches: Swatch[];
}

/** Generic-named swatches tuned to a warm French apartment (no trademarked paint names). */
export const PALETTE: readonly SwatchGroup[] = [
  {
    group: 'whites-neutrals',
    label: 'Whites & neutrals',
    swatches: [
      { name: 'Chalk white', hex: '#f2eee6' },
      { name: 'Warm white', hex: '#ebe4d6' },
      { name: 'Linen', hex: '#d9cfbd' },
      { name: 'Pearl grey', hex: '#cfcbc4' },
      { name: 'Stone grey', hex: '#a9a59d' },
      { name: 'Charcoal', hex: '#3b3b3c' },
    ],
  },
  {
    group: 'warm-earthy',
    label: 'Warm earthy',
    swatches: [
      { name: 'Sand', hex: '#d2b48c' },
      { name: 'Ochre', hex: '#c79a3b' },
      { name: 'Terracotta', hex: '#b8613f' },
      { name: 'Clay pink', hex: '#d3a08c' },
      { name: 'Caramel', hex: '#a8703c' },
      { name: 'Cocoa', hex: '#6a4a3a' },
    ],
  },
  {
    group: 'cool-greens-blues',
    label: 'Cool greens & blues',
    swatches: [
      { name: 'Sage', hex: '#a3ae93' },
      { name: 'Olive', hex: '#7c7f4f' },
      { name: 'Eucalyptus', hex: '#8fa59a' },
      { name: 'Duck egg', hex: '#b4cdca' },
      { name: 'Dusty blue', hex: '#7f9cb0' },
      { name: 'Forest', hex: '#3e5646' },
    ],
  },
  {
    group: 'deep-accents',
    label: 'Deep accents',
    swatches: [
      { name: 'Navy', hex: '#26354f' },
      { name: 'Petrol', hex: '#2b5560' },
      { name: 'Aubergine', hex: '#4b2c3e' },
      { name: 'Burgundy', hex: '#6b2a33' },
      { name: 'Bottle green', hex: '#1f3d33' },
      { name: 'Soft black', hex: '#34312f' },
    ],
  },
];

export const ALL_SWATCHES: readonly Swatch[] = PALETTE.flatMap((g) => g.swatches);

/** Physically plausible interior paint reflectance (relative luminance, 0..1). */
export const ALBEDO_RANGE = { min: 0.03, max: 0.95 } as const;

const toLinear = (c8: number): number => {
  const s = c8 / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const toSrgb8 = (l: number): number => {
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(s * 255)));
};

function parse(hex: string): [number, number, number] {
  const h = normalizeHex(hex).slice(1);
  return [0, 2, 4].map((i) => toLinear(parseInt(h.slice(i, i + 2), 16))) as [number, number, number];
}

/** Relative luminance (Rec. 709, linear light) of a hex colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parse(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Scales a colour in linear light so its luminance lies within `ALBEDO_RANGE` (pure black and
 * pure white do not exist as paint), keeping its hue. In-range colours come back normalised but unchanged.
 */
export function clampAlbedo(hex: string): string {
  const color = normalizeHex(hex);
  const lum = relativeLuminance(color);
  if (lum >= ALBEDO_RANGE.min && lum <= ALBEDO_RANGE.max) return color;
  const lin = parse(color);
  let out: number[];
  if (lum === 0) out = [ALBEDO_RANGE.min, ALBEDO_RANGE.min, ALBEDO_RANGE.min];
  else {
    const k = (lum < ALBEDO_RANGE.min ? ALBEDO_RANGE.min : ALBEDO_RANGE.max) / lum;
    out = lin.map((c) => Math.min(1, c * k));
  }
  return '#' + out.map((c) => toSrgb8(c).toString(16).padStart(2, '0')).join('');
}
