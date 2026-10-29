// Colour words of product names/colours (French and English) -> the closed palette of the generators. Pure and deterministic.

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Palette names (the keys of `COLOUR_HEX` in @flat/assets) with the words that mean them. The longest matching phrase
 * wins ("vert clair" is sage, not green); among equal lengths the earliest in the text.
 */
const WORDS: readonly (readonly [string, readonly string[]])[] = [
  ['charcoal', ['gris fonce', 'gris anthracite', 'anthracite', 'dark grey', 'dark gray', 'charcoal']],
  ['navy', ['bleu fonce', 'bleu marine', 'bleu nuit', 'marine', 'navy', 'dark blue']],
  ['sage', ['vert clair', 'vert sauge', 'vert menthe', 'vert pale', 'sauge', 'sage', 'light green', 'mint']],
  ['cream', ['blanc casse', 'off-white', 'off white', 'ivoire', 'ivory', 'creme', 'cream', 'ecru']],
  ['sand', ['sable', 'sand', 'camel', 'taupe']],
  ['white', ['blanc', 'white']],
  ['black', ['noir', 'black']],
  ['grey', ['gris', 'grey', 'gray', 'argent', 'silver', 'aluminium']],
  ['blue', ['bleu', 'blue', 'turquoise', 'denim']],
  ['green', ['vert', 'green', 'olive', 'kaki', 'khaki']],
  ['terracotta', ['terracotta', 'terre cuite', 'orange', 'brique', 'corail', 'coral']],
  ['rust', ['rouille', 'rust', 'rouge', 'red', 'bordeaux', 'burgundy']],
  ['pink', ['rose', 'pink', 'fuchsia', 'saumon']],
  ['mustard', ['moutarde', 'mustard', 'jaune', 'yellow', 'dore', 'laiton', 'brass', 'gold']],
  ['brown', ['marron', 'brun', 'brown', 'chocolat', 'chocolate', 'noyer', 'walnut', 'teck', 'teak', 'chene fonce', 'wenge']],
  ['beige', ['beige', 'naturel', 'natural', 'lin', 'linen', 'jute', 'rotin', 'rattan', 'bambou', 'bamboo', 'carex', 'osier', 'pin', 'pine', 'bouleau', 'birch', 'chene', 'oak', 'frene', 'ash', 'bois', 'wood', 'hetre', 'beech']],
];

/** Palette colour names the words map to. */
export type ColourWord = (typeof WORDS)[number][0];

/** The part of a product name that names the colour: IKEA names read "NAME Type - colour 40x40 cm". */
function colourPart(name: string): string {
  const i = name.indexOf(' - ');
  const tail = i >= 0 ? name.slice(i + 3) : name;
  return tail.replace(/\d+([.,]\d+)?\s*(x\s*\d+([.,]\d+)?\s*)*(cm|mm|m|l|w)\b/gi, ' ');
}

/**
 * The palette colour that best names a product: `colour` (the chosen variant colour) first, then the colour part of the
 * `name`. `undefined` when no colour word is found.
 */
export function colourFromWords(name: string | undefined, colour?: string): ColourWord | undefined {
  for (const text of [colour, name !== undefined ? colourPart(name) : undefined]) {
    if (!text) continue;
    const t = ` ${fold(text).replace(/[/,;()]/g, ' ')} `;
    let best: { name: ColourWord; len: number; at: number } | undefined;
    for (const [palette, words] of WORDS) {
      for (const w of words) {
        const key = ` ${w}`;
        const at = t.indexOf(key);
        if (at < 0) continue;
        const after = t[at + key.length];
        if (after !== ' ' && after !== 's') continue; // whole words (a plural s is allowed)
        if (!best || w.length > best.len || (w.length === best.len && at < best.at)) best = { name: palette as ColourWord, len: w.length, at };
      }
    }
    if (best) return best.name;
  }
  return undefined;
}
