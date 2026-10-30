import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { ProductRecord } from '@flat/assets';
import { ProductCategory } from '@flat/scene';
import sharp from 'sharp';
import { categoryOf, reclassify } from '../category';
import { asArray, asPrice, extractJsonLd, hasType, isObj, str, type Json } from '../jsonld';
import { parseLength, parseMeasureText } from '../units';
import { loadCatalogFile, saveCatalogFile, writeAtomic } from './build';
import { LOCAL_SKU, LocalEntry } from './schema';

/**
 * `pnpm catalog:import-page <file.html>`: turns a product page that the USER saved from their own browser ("Web page,
 * complete", Cmd+S) into a manually entered record of the LOCAL catalogue (personal use). Fully offline: nothing is fetched
 * and no cookie or session is involved; the page is just a file on disk. Generic: it reads schema.org JSON-LD, Open Graph
 * and the "characteristics" table / definition list of any shop, never a specific site.
 *
 * The entry has no 3D model (`has3d: false`): the viewer draws the category's parametric stand-in at the exact listed size
 * (a kitchen island with a swivel top for a "table-island"), and it is priced and counted in the bill of materials.
 */

const PHOTO_PX = 320;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

// ---------------------------------------------------------------------------------------------
// Small HTML helpers (regular expressions: the pages are untrusted text, nothing is executed or fetched)
// ---------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', deg: '°', times: '×', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ecirc: 'ê', ocirc: 'ô', icirc: 'î', ucirc: 'û' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export const textOf = (html: string): string => decodeEntities(html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

/** `<meta property|name="key" content="...">` (first one). */
function meta(html: string, key: string): string | undefined {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if ((a['property'] === key || a['name'] === key || a['itemprop'] === key) && a['content']?.trim()) return a['content'].trim();
  }
  return undefined;
}

/** The address the browser saved the page from: `<link rel=canonical>`, `og:url`, or the "saved from url=" comment of Chrome / Firefox. */
function pageUrlOf(html: string): string | undefined {
  const ok = (u: string | undefined): string | undefined => {
    if (!u) return undefined;
    try {
      const p = new URL(u.trim());
      return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : undefined;
    } catch {
      return undefined;
    }
  };
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (a['rel']?.toLowerCase().split(/\s+/).includes('canonical') && ok(a['href'])) return ok(a['href']);
  }
  return ok(meta(html, 'og:url')) ?? ok(/<!--\s*saved from url=\(\d+\)\s*(\S+?)\s*-->/i.exec(html)?.[1]);
}

// ---------------------------------------------------------------------------------------------
// Characteristics: label / value pairs from tables, definition lists and "Label : value" lines
// ---------------------------------------------------------------------------------------------

export function specPairs(html: string): [string, string][] {
  const clean = html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const out: [string, string][] = [];
  const add = (label: string, value: string) => {
    const l = textOf(label).replace(/\s*:\s*$/, '');
    const v = textOf(value);
    if (l && v && l.length <= 80 && v.length <= 300) out.push([l, v]);
  };
  for (const row of clean.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const cells = [...row[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi)].map((c) => c[1]!);
    if (cells.length >= 2) add(cells[0]!, cells[1]!);
  }
  for (const m of clean.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt\s*>\s*<dd\b[^>]*>([\s\S]*?)<\/dd\s*>/gi)) add(m[1]!, m[2]!);
  // "<li>Largeur : 126 cm</li>" and "<li><span>Largeur</span><span>126 cm</span></li>" style lines
  for (const m of clean.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
    const t = textOf(m[1]!);
    const kv = /^([^:]{2,40}?)\s*:\s*(.{1,200})$/.exec(t);
    if (kv) out.push([kv[1]!, kv[2]!]);
  }
  return out;
}

type DimKey = 'w' | 'd' | 'h';
const LABEL_RULES: [RegExp, 'width' | 'length' | 'depth' | 'height' | 'dimensions' | 'colour' | 'material' | 'ref' | 'type'][] = [
  [/^(largeur|width|breite)\b/, 'width'],
  [/^(longueur|length|laenge)\b/, 'length'],
  [/^(profondeur|depth|tiefe)\b/, 'depth'],
  [/^(hauteur|height|hoehe)\b/, 'height'],
  [/^(dimensions?|taille|size|mesures?)\b/, 'dimensions'],
  [/^(couleur|coloris|colou?r|teinte)\b/, 'colour'],
  [/^(matiere|materiau|materiaux|material|matiere principale)\b/, 'material'],
  [/^(ref|reference|sku|code article|article)\b/, 'ref'],
  [/^(type de produit|type|categorie|product type)\b/, 'type'],
];

/** A length written in a cell ("126 cm", "1,26 m", "1260 mm", "126"); a bare number is centimetres (the usual unit of the shops). */
export function lengthCell(value: string): number | undefined {
  const m = /(\d+(?:[.,]\d+)?)\s*(mm|cm|m)?\b(?!\s*[x×])/i.exec(value);
  if (!m) return undefined;
  return parseLength(`${m[1]}${m[2] ? ` ${m[2]}` : ' cm'}`);
}

/** "L 140 x P 60 x H 90 cm", "140 x 60 x 90 cm" (width, depth, height in that order) -> metres. */
export function dimensionsCell(value: string): Partial<Record<DimKey, number>> | undefined {
  const unit = /\b(mm|cm|m)\b/i.exec(value)?.[1]?.toLowerCase() ?? 'cm';
  const tagged: Partial<Record<DimKey, number>> = {};
  const key = (t: string): DimKey | undefined => {
    const f = fold(t);
    if (/^(l|w|lg|larg\w*|long\w*|width|length)$/.test(f)) return 'w';
    if (/^(p|d|prof\w*|depth)$/.test(f)) return 'd';
    if (/^(h|ht|haut\w*|height)$/.test(f)) return 'h';
    return undefined;
  };
  for (const m of value.matchAll(/([A-Za-zéÉ]{1,10})\.?\s*:?\s*(\d+(?:[.,]\d+)?)/g)) {
    const k = key(m[1]!);
    const n = parseLength(`${m[2]} ${unit}`);
    if (k && n && tagged[k] === undefined) tagged[k] = n;
  }
  if (Object.keys(tagged).length >= 2) return tagged;
  const plain = parseMeasureText(value.replace(/[^\d.,x×a-z\s]/gi, ' ').replace(/\s*(mm|cm|m)\b.*$/i, ''), unit);
  if (plain.length === 3) return { w: plain[0]!, d: plain[1]!, h: plain[2]! };
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

export interface PageOverrides {
  url?: string;
  name?: string;
  price?: number;
  currency?: string;
  /** Width, depth, height in metres. */
  dims?: { w: number; d: number; h: number };
  sku?: string;
}

export interface ParsedPage {
  name: string;
  url: string | undefined;
  sku: string | undefined;
  price: number | undefined;
  currency: string | undefined;
  priceTtc: boolean;
  brand: string | undefined;
  typeName: string;
  imageRefs: string[];
  dims: Partial<Record<DimKey, number>>;
  dimsSource: 'structured' | 'text' | 'user';
  colours: string[];
  materials: string[];
  flags: string[];
}

const productNode = (nodes: Json[]): Json | undefined => nodes.find((n) => hasType(n, 'Product')) ?? nodes.find((n) => hasType(n, 'ProductGroup'));

function offerOf(product: Json | undefined): { price?: number; currency?: string; ttc: boolean } {
  const out: { price?: number; currency?: string; ttc: boolean } = { ttc: true };
  if (!product) return out;
  for (const offer of asArray(product['offers'] as unknown[])) {
    if (!isObj(offer)) continue;
    for (const s of [offer, ...asArray(offer['priceSpecification'] as unknown[]).filter(isObj)]) {
      out.price ??= asPrice(s['price']) ?? asPrice(s['lowPrice']);
      out.currency ??= str(s['priceCurrency']);
      if (s['valueAddedTaxIncluded'] === false) out.ttc = false;
    }
    if (out.price !== undefined) break;
  }
  return out;
}

export function parseSavedPage(html: string, over: PageOverrides = {}): ParsedPage {
  if (html.length > MAX_HTML_BYTES) throw new Error(`the page is larger than ${MAX_HTML_BYTES / 1024 / 1024} MB; is it really a product page?`);
  const flags: string[] = [];
  const { nodes } = extractJsonLd(html);
  const product = productNode(nodes);
  const pairs = specPairs(html);
  const find = (kind: (typeof LABEL_RULES)[number][1]) => pairs.filter(([l]) => LABEL_RULES.find(([re]) => re.test(fold(l)))?.[1] === kind).map(([, v]) => v);

  // name
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1];
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  const name = over.name ?? str(product?.['name']) ?? meta(html, 'og:title') ?? (h1 ? textOf(h1) : undefined) ?? (title ? textOf(title) : undefined) ?? '';

  // price
  const offer = offerOf(product);
  const metaPrice = asPrice(meta(html, 'product:price:amount') ?? meta(html, 'og:price:amount'));
  const price = over.price ?? offer.price ?? metaPrice;
  let currency = over.currency ?? offer.currency ?? meta(html, 'product:price:currency') ?? meta(html, 'og:price:currency');
  if (price !== undefined && !currency) {
    currency = 'EUR';
    flags.push('currency assumed EUR (the page does not state one)');
  }

  // images: JSON-LD, og:image, twitter:image
  const imageRefs: string[] = [];
  for (const img of asArray(product?.['image'] as unknown[])) {
    const u = typeof img === 'string' ? img : isObj(img) ? (str(img['contentUrl']) ?? str(img['url'])) : undefined;
    if (u) imageRefs.push(u);
  }
  for (const k of ['og:image', 'og:image:url', 'twitter:image']) {
    const u = meta(html, k);
    if (u) imageRefs.push(u);
  }

  // sizes: schema.org first, then the characteristics table, then a combined "Dimensions" cell
  let dims: Partial<Record<DimKey, number>> = {};
  let dimsSource: ParsedPage['dimsSource'] = 'structured';
  if (product) {
    for (const [field, k] of [['width', 'w'], ['depth', 'd'], ['height', 'h']] as const) {
      const raw = product[field];
      const v = typeof raw === 'string' ? lengthCell(raw) : isObj(raw) && (typeof raw['value'] === 'number' || typeof raw['value'] === 'string') ? lengthCell(`${raw['value']} ${str(raw['unitText']) ?? (str(raw['unitCode'])?.toUpperCase() === 'MMT' ? 'mm' : str(raw['unitCode'])?.toUpperCase() === 'MTR' ? 'm' : 'cm')}`) : undefined;
      if (v) dims[k] = v;
    }
  }
  if (dims.w === undefined || dims.d === undefined || dims.h === undefined) {
    const num = (kind: 'width' | 'length' | 'depth' | 'height') => find(kind).map(lengthCell).find((v) => v !== undefined);
    const width = num('width');
    const length = num('length');
    const depth = num('depth');
    const height = num('height');
    const fromTable: Partial<Record<DimKey, number>> = {};
    // shops that give a length and a width (no depth) mean width = the long side, depth = the short side
    if (depth === undefined && length !== undefined && width !== undefined) {
      fromTable.w = Math.max(length, width);
      fromTable.d = Math.min(length, width);
    } else {
      const w = width ?? length;
      if (w !== undefined) fromTable.w = w;
      if (depth !== undefined) fromTable.d = depth;
    }
    if (height !== undefined) fromTable.h = height;
    for (const cell of find('dimensions')) {
      const c = dimensionsCell(cell);
      if (c) for (const k of ['w', 'd', 'h'] as const) fromTable[k] ??= c[k];
    }
    const before = Object.keys(dims).length;
    dims = { ...fromTable, ...dims };
    if (Object.keys(dims).length > before) dimsSource = before === 0 ? 'text' : 'structured';
  }
  if (over.dims) {
    dims = { ...over.dims };
    dimsSource = 'user';
  }

  // colour, material, type, sku
  const colours = [...new Set([str(product?.['color']), ...find('colour')].filter((c): c is string => !!c).map((c) => c.slice(0, 40)))].slice(0, 4);
  const materials = [...new Set([str(product?.['material']), ...find('material')].filter((c): c is string => !!c))].slice(0, 3);
  const categoryPath = str(product?.['category']);
  const typeName = (find('type')[0] ?? categoryPath ?? '').slice(0, 120);
  const rawSku = over.sku ?? str(product?.['sku']) ?? str(product?.['productID']) ?? str(product?.['mpn']) ?? find('ref')[0];
  const brandNode = product?.['brand'];
  const brand = typeof brandNode === 'string' ? brandNode : isObj(brandNode) ? str(brandNode['name']) : undefined;
  return { name: name.slice(0, 200), url: over.url ?? pageUrlOf(html), sku: rawSku, price, currency: currency?.toUpperCase(), priceTtc: offer.ttc, brand, typeName, imageRefs, dims, dimsSource, colours, materials, flags };
}

// ---------------------------------------------------------------------------------------------
// Catalogue entry
// ---------------------------------------------------------------------------------------------

/** 8 digits for the catalogue: the page's own reference when it has exactly eight, the last eight-digit run of the URL, else a stable hash. */
export function manualSku(raw: string | undefined, url: string): string {
  const digits = (s: string | undefined) => s && /^\d{8}$/.test(s.replace(/\D/g, '')) && s.replace(/\D/g, '').length === s.replace(/[\s.-]/g, '').length ? s.replace(/\D/g, '') : undefined;
  const fromRef = digits(raw?.trim());
  if (fromRef) return fromRef;
  const runs = [...url.matchAll(/(?<!\d)(\d{8})(?!\d)/g)];
  if (runs.length > 0) return runs[runs.length - 1]![1]!;
  const h = parseInt(createHash('sha256').update(url).digest('hex').slice(0, 8), 16) % 10_000_000;
  return `9${String(h).padStart(7, '0')}`;
}

export interface ImportOptions {
  dir: string;
  file: string;
  /** Folder of the saved page's files ("Page_files"); default: `<file without extension>_files` next to the page. */
  photosDir?: string;
  overrides?: PageOverrides;
  category?: string;
  /** Replace an existing entry with the same sku that did not come from a manual import. */
  force?: boolean;
  dryRun?: boolean;
  now?: () => number;
  log?: (message: string) => void;
}

export interface ImportResult {
  sku: string;
  productId: string;
  entry: LocalEntry;
  replaced: boolean;
  photo: string | undefined;
  written: boolean;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, depth: number) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory() && depth < 2) await walk(join(d, e.name), depth + 1);
      else if (e.isFile() && IMAGE_EXT.has(extname(e.name).toLowerCase())) out.push(join(d, e.name));
    }
  };
  await walk(dir, 0);
  return out;
}

/** The product photo among the saved files: the one the page names (og:image / JSON-LD), else the largest picture that is not tiny. */
async function pickPhoto(files: string[], refs: string[], html: string): Promise<{ path: string; bytes: Buffer } | undefined> {
  const stem = (p: string) => decodeURIComponent(basename(p.split(/[?#]/)[0]!)).replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  const wanted = new Set(refs.map(stem).filter((s) => s.length >= 4));
  const named = files.filter((f) => wanted.has(stem(f)));
  // the <img> the browser rewrote to the local folder, in page order, also point at the main picture
  const inPage = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => attrs(m[0])['src']).filter((s): s is string => !!s && !/^(https?:|data:)/i.test(s));
  const ordered = [...named, ...inPage.map((s) => files.find((f) => f.endsWith(decodeURIComponent(s.split(/[?#]/)[0]!).replace(/^\.\//, '')))).filter((f): f is string => !!f)];
  const candidates: { path: string; bytes: Buffer; px: number }[] = [];
  for (const f of [...new Set([...ordered, ...files])]) {
    const s = await stat(f).catch(() => undefined);
    if (!s || s.size < 2000 || s.size > 30 * 1024 * 1024) continue;
    const bytes = await readFile(f);
    const m = await sharp(bytes).metadata().catch(() => undefined);
    if (!m?.width || !m.height || Math.min(m.width, m.height) < 200) continue;
    candidates.push({ path: f, bytes, px: m.width * m.height });
    if (f === ordered[0]) return { path: f, bytes };
  }
  if (ordered.length > 0) {
    const first = candidates.find((c) => ordered.includes(c.path));
    if (first) return first;
  }
  candidates.sort((a, b) => b.px - a.px);
  return candidates[0];
}

export async function importSavedPage(o: ImportOptions): Promise<ImportResult> {
  const log = o.log ?? (() => undefined);
  const now = new Date((o.now ?? Date.now)()).toISOString();
  const html = await readFile(o.file, 'utf8');
  const page = parseSavedPage(html, o.overrides);
  const missing: string[] = [];
  if (!page.name) missing.push('the product name (--name "...")');
  if (!page.url) missing.push('the page address (--url https://...)');
  if (page.price === undefined) missing.push('the price (--price 123.45)');
  for (const [k, label] of [['w', 'width'], ['d', 'depth'], ['h', 'height']] as const) if (page.dims[k] === undefined) missing.push(`the ${label}`);
  if (missing.length > 0) {
    const known = Object.entries(page.dims).map(([k, v]) => `${k}=${Math.round(v * 1000) / 10} cm`).join(', ');
    throw new Error(`could not read from this page: ${missing.join(', ')}${known ? ` (sizes found: ${known})` : ''}. Give them by hand${page.dims.w === undefined || page.dims.d === undefined || page.dims.h === undefined ? ' (--dims "width,depth,height" in cm)' : ''} and run again.`);
  }
  const dims = { w: page.dims.w!, d: page.dims.d!, h: page.dims.h! };
  const url = page.url!;
  const sku = manualSku(page.sku, url);
  if (!LOCAL_SKU.test(sku)) throw new Error(`"${sku}" is not an 8-digit reference; pass --sku 12345678`);

  let category = reclassify(page.typeName, page.name).category;
  // An island is named as one ("îlot central"); a shop type such as "Table à manger" must not turn it into a table.
  if (categoryOf(page.name) === 'kitchen_island') category = 'kitchen_island';
  if (o.category) {
    const c = ProductCategory.safeParse(o.category);
    if (!c.success) throw new Error(`unknown category "${o.category}" (one of ${ProductCategory.options.join(', ')})`);
    category = c.data;
  }
  const { mount } = reclassify(page.typeName, page.name, category);

  // photo
  const photosDir = resolve(o.photosDir ?? join(dirname(o.file), `${basename(o.file, extname(o.file))}_files`));
  const files = await listFiles(photosDir);
  const picked = files.length > 0 ? await pickPhoto(files, page.imageRefs, html) : undefined;
  if (files.length === 0) log(`no saved pictures in ${photosDir} (use --photos-dir); the entry gets no photo`);
  const httpsImage = page.imageRefs.find((r) => /^https?:\/\//i.test(r) && r.length <= 2048);
  let photo: LocalEntry['photo'];
  let small: Buffer | undefined;
  if (picked) {
    small = await sharp(picked.bytes).resize({ width: PHOTO_PX, height: PHOTO_PX, fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
    photo = { file: `photos/${sku}.webp`, bytes: small.byteLength };
  }

  const record = ProductRecord.parse({
    provider: 'ikea-fr', // the catalogue's id space (`ikea-fr:<sku>`); `source: "manual"` below tells these entries apart
    sku,
    name: page.name,
    url,
    price: page.price,
    currency: page.currency,
    priceTtc: page.priceTtc,
    dims,
    dimsSource: page.dimsSource,
    category,
    mount,
    styleTags: [...(page.brand ? [page.brand] : []), ...page.materials].map((t) => t.toLowerCase().slice(0, 32)).slice(0, 6),
    colours: page.colours,
    variants: [],
    ...(photo ? { photoUrl: httpsImage ?? url } : {}),
    fetchedAt: now,
    personalUseOnly: true,
  });
  const entry = LocalEntry.parse({
    record,
    typeName: page.typeName,
    queries: ['manual import'],
    has3d: false,
    noModelReason: 'entered by hand from a saved page; the viewer draws a parametric stand-in at the listed size',
    ...(photo ? { photo } : {}),
    availability: 'unknown',
    source: 'manual',
    flags: page.flags.slice(0, 12),
    incomplete: [],
    checkedAt: now,
  });

  const file = await loadCatalogFile(o.dir, now);
  const at = file.entries.findIndex((e) => e.record.sku === sku);
  if (at >= 0 && file.entries[at]!.source !== 'manual' && !o.force) {
    throw new Error(`the catalogue already has a shop product with the reference ${sku} (${file.entries[at]!.record.name.slice(0, 60)}); pass --sku <other 8 digits> or --force to replace it`);
  }
  const replaced = at >= 0;
  if (!o.dryRun) {
    if (replaced) file.entries[at] = entry;
    else file.entries.push(entry);
    file.builtAt = now;
    if (small) {
      await mkdir(join(o.dir, 'photos'), { recursive: true });
      await writeAtomic(join(o.dir, 'photos', `${sku}.webp`), small);
    }
    await saveCatalogFile(o.dir, file);
  }
  return { sku, productId: `ikea-fr:${sku}`, entry, replaced, photo: photo?.file, written: !o.dryRun };
}
