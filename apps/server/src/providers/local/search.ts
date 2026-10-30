import type { ProductCategory } from '@flat/scene';
import type { ProductRecord } from '@flat/assets';
import type { LocalEntry } from './schema';

/**
 * Search of the local catalogue: a few hundred records in memory, ranked in well under a millisecond.
 * Accent- and case-insensitive; French and English words are interchangeable ("canapé" = "sofa"); bed sizes are
 * understood ("queen size bed" -> 160x200). Every query word must match somewhere (name, product type, category, the
 * curated queries that found the product, colours) unless the query is long, in which case one word may be missing.
 */

export const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const STOPWORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'un', 'une', 'a', 'au', 'aux', 'pour', 'the', 'of', 'and', 'with', 'avec', 'en', 'et', 'for', 'in', 'on', 'size', 'taille', 'cm', 'sur', 'd', 'l']);

/** Interchangeable words (folded). Each row is one concept; every word of a row finds the others. */
const SYNONYMS: string[][] = [
  ['bed', 'lit', 'lits', 'bedstead'],
  ['sofa', 'canape', 'canapes', 'couch', 'banquette', 'loveseat'],
  ['armchair', 'fauteuil', 'fauteuils'],
  ['chair', 'chaise', 'chaises'],
  ['stool', 'tabouret', 'tabourets'],
  ['bench', 'banc', 'bancs'],
  ['table', 'tables'],
  ['desk', 'bureau', 'bureaux'],
  ['wardrobe', 'armoire', 'armoires', 'penderie', 'garde-robe', 'dressing', 'pax', 'closet'],
  ['bedside', 'chevet', 'nightstand', 'night', 'nuit'],
  ['drawers', 'commode', 'commodes', 'tiroirs', 'dresser', 'chest'],
  ['shelf', 'shelves', 'shelving', 'etagere', 'etageres', 'bibliotheque', 'bookcase', 'bookshelf', 'kallax'],
  ['sideboard', 'buffet', 'bahut', 'console', 'vaisselier'],
  ['tv', 'television', 'tele'],
  ['rug', 'tapis', 'carpet'],
  ['lamp', 'lampe', 'luminaire', 'lumiere', 'light', 'lampadaire', 'liseuse'],
  ['pendant', 'suspension', 'suspendu'],
  ['mirror', 'miroir', 'miroirs', 'glace'],
  ['curtain', 'curtains', 'rideau', 'rideaux', 'voilage', 'voilages'],
  ['plant', 'plants', 'plante', 'plantes', 'fleur', 'fleurs'],
  ['vase', 'vases'],
  ['frame', 'frames', 'cadre', 'cadres'],
  ['cushion', 'cushions', 'coussin', 'coussins'],
  ['throw', 'plaid', 'plaids', 'blanket', 'couverture'],
  ['kitchen', 'cuisine', 'cuisines'],
  ['island', 'ilot'],
  ['wall', 'mural', 'murale', 'muraux', 'murales'],
  ['shoe', 'shoes', 'chaussures', 'chaussure'],
  ['garden', 'jardin', 'outdoor', 'exterieur'],
  ['white', 'blanc', 'blanche'],
  ['black', 'noir', 'noire'],
  ['grey', 'gray', 'gris', 'grise'],
  ['oak', 'chene'],
  ['wood', 'bois'],
  ['beige', 'creme'],
  ['green', 'vert', 'verte'],
  ['blue', 'bleu', 'bleue'],
  ['brown', 'brun', 'marron'],
  ['small', 'petit', 'petite'],
  ['large', 'big', 'grand', 'grande'],
  ['storage', 'rangement'],
  ['coffee', 'basse'],
  ['dining', 'repas', 'manger'],
  ['bar', 'bars'],
  ['seat', 'seats', 'seater', 'place', 'places'],
];
const SYN = new Map<string, string[]>();
for (const row of SYNONYMS) for (const w of row) SYN.set(w, row.filter((x) => x !== w));

/** Bed-size words: soft hints (a product naming the number ranks higher; nobody is dropped for lacking it). */
const SIZE_WORDS: Record<string, string[]> = {
  queen: ['160', '200'],
  king: ['180', '200'],
  double: ['140', '200'],
  twin: ['90', '200'],
  single: ['90', '200'],
  simple: ['90', '200'],
};

/** Folded words that say a record's category (so "canapé" finds a sofa whose name only says "KIVIK"). */
const CATEGORY_WORDS: Record<ProductCategory, string[]> = {
  bed: ['bed', 'lit'],
  wardrobe: ['wardrobe', 'armoire', 'penderie', 'dressing'],
  bedside: ['bedside', 'chevet', 'nightstand'],
  drawers: ['drawers', 'commode', 'tiroirs', 'dresser'],
  shelf: ['shelf', 'shelves', 'etagere', 'bibliotheque', 'bookcase'],
  sideboard: ['sideboard', 'buffet', 'console'],
  tv_unit: ['tv', 'television'],
  table: ['table'],
  desk: ['desk', 'bureau'],
  chair: ['chair', 'chaise', 'stool', 'tabouret', 'bench', 'banc'],
  armchair: ['armchair', 'fauteuil'],
  sofa: ['sofa', 'canape', 'couch'],
  rug: ['rug', 'tapis', 'carpet'],
  lamp: ['lamp', 'lampe', 'luminaire', 'light', 'pendant', 'suspension'],
  mirror: ['mirror', 'miroir'],
  curtain: ['curtain', 'rideau', 'rideaux'],
  plant: ['plant', 'plante'],
  vase: ['vase'],
  frame: ['frame', 'cadre'],
  cushion: ['cushion', 'coussin'],
  throw: ['throw', 'plaid', 'blanket'],
  wall_cabinet: ['cabinet', 'mural', 'wall'],
  kitchen: ['kitchen', 'cuisine'],
  appliance: ['appliance'],
  decor: ['decor', 'decoration'],
  other: [],
  washbasin: ['washbasin', 'basin', 'sink', 'vasque', 'lavabo'],
  vanity: ['vanity', 'lavabo', 'sous-lavabo', 'washbasin'],
  towel_rail: ['towel', 'serviette', 'serviettes', 'rail'],
  radiator: ['radiator', 'radiateur', 'chauffage', 'heater'],
  bath_accessory: ['bathroom', 'bain', 'douche', 'shower', 'accessory'],
  shower_curtain: ['shower', 'douche', 'curtain', 'rideau'],
  kitchen_island: ['island', 'ilot', 'kitchen', 'cuisine'],
  tall_cabinet: ['tall', 'colonne', 'column', 'cabinet'],
  appliance_housing: ['oven', 'four', 'microwave', 'micro-ondes', 'housing', 'cabinet'],
  hook: ['hook', 'patere', 'crochet'],
  storage: ['storage', 'basket', 'panier', 'rangement', 'bin'],
};

export interface Query {
  /** Groups of interchangeable folded words, all required (but one when there are many). */
  required: string[][];
  /** Soft hints (bed sizes): add score, never exclude. */
  soft: string[];
  /** Numbers the query names (cm). */
  numbers: number[];
}

export function parseQuery(q: string): Query {
  let text = fold(q).replace(/×/g, 'x');
  const numbers: number[] = [];
  // "160x200", "160 x 200" -> two numbers
  text = text.replace(/(\d{2,3})\s*x\s*(\d{2,3})(?:\s*x\s*(\d{2,3}))?/g, (_m, a: string, b: string, c?: string) => {
    numbers.push(Number(a), Number(b));
    if (c) numbers.push(Number(c));
    return ' ';
  });
  const required: string[][] = [];
  const soft: string[] = [];
  for (const raw of text.split(/[^a-z0-9-]+/).filter(Boolean)) {
    const t = raw.replace(/^-+|-+$/g, '');
    if (!t) continue;
    if (/^\d+$/.test(t)) {
      numbers.push(Number(t));
      continue;
    }
    if (STOPWORDS.has(t)) continue;
    const size = SIZE_WORDS[t];
    if (size) {
      soft.push(...size);
      continue;
    }
    required.push([t, ...(SYN.get(t) ?? [])]);
  }
  return { required, soft, numbers };
}

interface Indexed {
  entry: LocalEntry;
  rec: ProductRecord;
  nameWords: string[];
  typeWords: string[];
  otherWords: string[];
  queryWords: string[];
  categoryWords: string[];
  nameNumbers: Set<number>;
  dimsCm: number[];
}

const words = (s: string): string[] => fold(s).split(/[^a-z0-9]+/).filter(Boolean);

export function indexEntry(entry: LocalEntry): Indexed {
  const rec = entry.record;
  const nameNumbers = new Set<number>();
  for (const m of fold(`${rec.name} ${entry.typeName}`).matchAll(/\d{1,4}/g)) nameNumbers.add(Number(m[0]));
  return {
    entry,
    rec,
    nameWords: words(rec.name),
    typeWords: words(entry.typeName),
    otherWords: words([...rec.colours, ...rec.styleTags, rec.sku].join(' ')),
    queryWords: entry.queries.flatMap(words),
    categoryWords: CATEGORY_WORDS[rec.category] ?? [],
    nameNumbers,
    dimsCm: [rec.dims.w, rec.dims.d, rec.dims.h].map((m) => Math.round(m * 100)),
  };
}

const eq = (ws: string[], a: string) => ws.includes(a);
const pre = (ws: string[], a: string) => a.length >= 3 && ws.some((w) => w.startsWith(a));

/** Score of one group of alternatives against one record (0 = no match). */
function groupScore(ix: Indexed, group: string[]): number {
  let best = 0;
  for (const a of group) {
    let s = 0;
    if (eq(ix.nameWords, a)) s = 4;
    else if (eq(ix.typeWords, a)) s = 4;
    else if (pre(ix.nameWords, a) || pre(ix.typeWords, a)) s = 3;
    else if (eq(ix.categoryWords, a)) s = 3;
    else if (eq(ix.queryWords, a)) s = 1.5;
    else if (eq(ix.otherWords, a) || pre(ix.otherWords, a)) s = 1.5;
    else if (pre(ix.queryWords, a)) s = 1;
    // The user's own word beats a translation of it.
    if (s > 0 && a !== group[0]) s -= 0.5;
    best = Math.max(best, s);
  }
  return best;
}

function numberScore(ix: Indexed, n: number): number {
  if (ix.nameNumbers.has(n)) return 3;
  if (n >= 10 && ix.dimsCm.some((d) => Math.abs(d - n) <= 1)) return 2;
  return 0;
}

export interface SearchFilter {
  limit: number;
  category?: ProductCategory | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  maxDims?: { w?: number | undefined; d?: number | undefined; h?: number | undefined } | undefined;
}

export interface Ranked {
  entry: LocalEntry;
  score: number;
}

/** Ranks `index` for `query`; best first, at most `filter.limit`. */
export function rank(index: readonly Indexed[], query: string, filter: SearchFilter): Ranked[] {
  const q = parseQuery(query);
  const out: Ranked[] = [];
  const need = q.required.length >= 4 ? q.required.length - 1 : q.required.length;
  for (const ix of index) {
    const r = ix.rec;
    if (ix.entry.availability === 'discontinued') continue;
    if (filter.category !== undefined && r.category !== filter.category) continue;
    if (filter.minPrice !== undefined && r.price < filter.minPrice) continue;
    if (filter.maxPrice !== undefined && r.price > filter.maxPrice) continue;
    const m = filter.maxDims;
    if (m && ((m.w !== undefined && r.dims.w > m.w) || (m.d !== undefined && r.dims.d > m.d) || (m.h !== undefined && r.dims.h > m.h))) continue;
    let score = 0;
    let matched = 0;
    for (const g of q.required) {
      const s = groupScore(ix, g);
      if (s > 0) {
        matched++;
        score += s;
      }
    }
    if (matched < need) continue;
    for (const n of q.numbers) score += numberScore(ix, n);
    for (const t of q.soft) score += numberScore(ix, Number(t)) * 0.6;
    // Products with a model are what the simulator can draw best.
    if (ix.entry.has3d) score += 0.25;
    if (q.required.length === 0 && q.numbers.length === 0 && q.soft.length === 0) score = ix.entry.has3d ? 0.25 : 0;
    out.push({ entry: ix.entry, score });
  }
  out.sort((a, b) => b.score - a.score || a.entry.record.price - b.entry.record.price || (a.entry.record.sku < b.entry.record.sku ? -1 : 1));
  return out.slice(0, filter.limit);
}
