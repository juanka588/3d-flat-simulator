import { COLOUR_HEX, COLOUR_NAMES, type ColourName } from '@flat/assets';

/**
 * Words for the matcher: the shop is French and the model describes images in English, so colours, materials, shapes and
 * a few furniture nouns are folded onto one English vocabulary before they are compared.
 */

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** French (accent-folded) and English variants onto one canonical English word. */
const CANON: Readonly<Record<string, string>> = {
  // colours
  blanc: 'white', blanche: 'white', blancs: 'white', noir: 'black', noire: 'black', gris: 'grey', grise: 'grey', gray: 'grey', bleu: 'blue', bleue: 'blue', vert: 'green', verte: 'green', rouge: 'red',
  rose: 'pink', jaune: 'yellow', marron: 'brown', brun: 'brown', orange: 'orange', creme: 'cream', ecru: 'cream', ivoire: 'cream', ivory: 'cream', anthracite: 'charcoal', sable: 'sand', sauge: 'sage',
  moutarde: 'mustard', marine: 'navy', kaki: 'green', cuivre: 'copper', dore: 'gold', doree: 'gold', argent: 'silver', argente: 'silver', taupe: 'beige', naturel: 'natural', naturelle: 'natural',
  // materials
  bois: 'wood', wooden: 'wood', chene: 'oak', noyer: 'walnut', bambou: 'bamboo', rotin: 'rattan', osier: 'wicker', cane: 'rattan', metal: 'metal', metallique: 'metal', acier: 'steel', laiton: 'brass', verre: 'glass',
  ceramique: 'ceramic', porcelaine: 'ceramic', faience: 'ceramic', emaille: 'enamel', marbre: 'marble', pierre: 'stone', beton: 'concrete', tissu: 'fabric', lin: 'linen', coton: 'cotton', velours: 'velvet',
  cuir: 'leather', laine: 'wool', paille: 'straw', plastique: 'plastic', rayure: 'stripe', rayures: 'stripe', raye: 'stripe', striped: 'stripe', stripes: 'stripe', carreaux: 'check', checkered: 'check', checked: 'check', checker: 'check',
  // shapes
  rond: 'round', ronde: 'round', circulaire: 'round', circular: 'round', ovale: 'oval', elliptic: 'oval', elliptical: 'oval', rectangulaire: 'rect', rectangular: 'rect', rectangle: 'rect', carre: 'square', carree: 'square',
  // nouns
  baignoire: 'bathtub', bathtub: 'bathtub', bath: 'bathtub', tub: 'bathtub', lavabo: 'washbasin', vasque: 'basin', basin: 'basin', washbasin: 'washbasin', sink: 'washbasin', evier: 'washbasin', vanity: 'vanity',
  miroir: 'mirror', suspension: 'pendant', pendant: 'pendant', lustre: 'pendant', chandelier: 'pendant', canape: 'sofa', sofa: 'sofa', couch: 'sofa', fauteuil: 'armchair', armchair: 'armchair', lit: 'bed', bed: 'bed',
  tapis: 'rug', rug: 'rug', carpet: 'rug', rideau: 'curtain', rideaux: 'curtain', curtain: 'curtain', curtains: 'curtain', voilage: 'sheer', voile: 'sheer', sheer: 'sheer', table: 'table', chaise: 'chair', chair: 'chair',
  tabouret: 'stool', stool: 'stool', etagere: 'shelf', shelf: 'shelf', shelves: 'shelf', commode: 'drawers', buffet: 'sideboard', sideboard: 'sideboard', armoire: 'wardrobe', wardrobe: 'wardrobe', plante: 'plant', plant: 'plant',
  robinet: 'tap', tap: 'tap', faucet: 'tap', serviette: 'towel', towel: 'towel', douche: 'shower', shower: 'shower', toilettes: 'toilet', toilet: 'toilet', wc: 'toilet', pied: 'foot', pieds: 'foot', feet: 'foot', foot: 'foot',
  freestanding: 'freestanding', ilot: 'freestanding', encastre: 'integrated', integrated: 'integrated', integre: 'integrated',
};

const STOP = new Set(['the', 'and', 'with', 'for', 'avec', 'pour', 'sans', 'une', 'des', 'les', 'du', 'de', 'la', 'le', 'en', 'sur', 'un', 'a', 'of', 'in', 'on', 'to', 'cm', 'mm']);

/** The canonical English tokens of a text (accents folded, French folded onto English, stop words and 1-2 letter words dropped; "tv" and "wc" stay). */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of fold(text).split(/[^a-z0-9]+/)) {
    if (!raw || STOP.has(raw)) continue;
    const t = CANON[raw] ?? raw.replace(/s$/, '');
    if (t.length < 3 && t !== 'tv') continue;
    out.push(CANON[t] ?? t);
  }
  return out;
}

export const tokenSet = (text: string): Set<string> => new Set(tokens(text));

const COLOUR_WORDS = new Set<string>([...COLOUR_NAMES, 'red', 'yellow', 'orange', 'gold', 'silver', 'copper', 'natural']);
const MATERIAL_WORDS = new Set(['wood', 'oak', 'walnut', 'bamboo', 'rattan', 'wicker', 'metal', 'steel', 'brass', 'chrome', 'glass', 'ceramic', 'enamel', 'marble', 'stone', 'concrete', 'fabric', 'linen', 'cotton', 'velvet', 'leather', 'wool', 'straw', 'plastic', 'boucle', 'copper', 'gold', 'silver']);

export const colourTokens = (text: string): string[] => [...new Set(tokens(text).filter((t) => COLOUR_WORDS.has(t)))];
export const materialTokens = (text: string): string[] => [...new Set(tokens(text).filter((t) => MATERIAL_WORDS.has(t)))];

const NEAREST_WORD: Readonly<Record<string, ColourName>> = { red: 'rust', yellow: 'mustard', orange: 'terracotta', gold: 'mustard', silver: 'grey', copper: 'terracotta', natural: 'beige' };

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** The palette name closest to a hex colour (weighted RGB distance). */
export function nearestColourOfHex(hex: string): ColourName {
  const c = rgb(hex);
  let best: ColourName = 'grey';
  let bestD = Infinity;
  for (const n of COLOUR_NAMES) {
    const p = rgb(COLOUR_HEX[n]);
    const rMean = (c[0] + p[0]) / 2;
    const d = (2 + rMean / 256) * (c[0] - p[0]) ** 2 + 4 * (c[1] - p[1]) ** 2 + (2 + (255 - rMean) / 256) * (c[2] - p[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/** A descriptor colour ("sage green", "#a3b18a", "matt black") as one of the palette names generators accept; `undefined` when it names none. */
export function nearestColourName(text: string): ColourName | undefined {
  const hex = /#[0-9a-fA-F]{6}/.exec(text);
  if (hex) return nearestColourOfHex(hex[0]);
  const words = tokens(text);
  // the later word of "sage green" or "dark blue" is the base colour, but a palette name beats a plain one
  const named = words.filter((w) => (COLOUR_NAMES as readonly string[]).includes(w));
  if (named.length) return (named.length > 1 && named.includes('sage') ? 'sage' : named[0]) as ColourName;
  for (const w of words) if (NEAREST_WORD[w]) return NEAREST_WORD[w];
  return undefined;
}

/** French catalogue search phrase for a descriptor item: the model's own French terms first, else a translation of the words we know. */
const FRENCH: Readonly<Record<string, string>> = {
  bathtub: 'baignoire', washbasin: 'lavabo', basin: 'vasque', vanity: 'meuble sous vasque', mirror: 'miroir', pendant: 'suspension', sofa: 'canapé', armchair: 'fauteuil', bed: 'lit', rug: 'tapis', curtain: 'rideau',
  table: 'table', chair: 'chaise', stool: 'tabouret', shelf: 'étagère', drawers: 'commode', sideboard: 'buffet', wardrobe: 'armoire', plant: 'plante', tap: 'robinet', towel: 'serviette', shower: 'douche', toilet: 'WC',
  white: 'blanc', black: 'noir', grey: 'gris', beige: 'beige', blue: 'bleu', green: 'vert', red: 'rouge', pink: 'rose', brown: 'marron', cream: 'crème', sand: 'sable', wood: 'bois', oak: 'chêne', metal: 'métal', glass: 'verre',
  ceramic: 'céramique', marble: 'marbre', linen: 'lin', velvet: 'velours', leather: 'cuir', rattan: 'rotin', round: 'rond', oval: 'ovale', freestanding: 'îlot',
};

export const toFrench = (words: readonly string[]): string[] => words.map((w) => FRENCH[w] ?? w);

/** Adjectives that follow the noun in French ("baignoire îlot ovale"): `searchPhrases` puts nouns first. */
export const FRENCH_ADJECTIVES = new Set(['round', 'oval', 'freestanding', 'rect', 'square']);
