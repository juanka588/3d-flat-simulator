import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LOCAL_STALE_DAYS, ProductRecord } from '@flat/assets';
import sharp from 'sharp';
import { categoryOf } from '../category';
import { availabilityOf, fetchProductPage, fetchSearchHits, parseProductPage, safePageUrl, type IkeaHit } from '../ikea-fr';
import { readTextCapped } from '../http';
import { ProviderError, type ProductProvider, type ProviderContext } from '../types';
import { measureDocument, normaliseGlb, readGlb } from './normalise';
import type { QuerySpec } from './queries';
import { LOCAL_SKU, LocalCatalogFile, LocalEntry, emptyCatalog, type Availability } from './schema';

/**
 * `pnpm catalog:build`: fills the local catalogue from a CURATED query list, politely. Everything goes through the normal
 * provider network layer (honest User-Agent, one request at a time per host, 1.5 s gap, robots.txt, circuit breaker), so a full
 * build of ~400 products takes one to two hours. The build is resumable (kept entries are skipped while fresh, a stop or a
 * crash loses at most the product being processed) and incremental (`--refresh-prices` re-reads only price and availability).
 *
 * Every record is validated (schema, plausible dims, category, mount) and every GLB is parsed, measured against the listed
 * size and normalised (`normalise.ts`); a product with a missing, broken or mismatched model is kept with `has3d: false` and
 * the reason, so nothing 404s at run time.
 */

const DAY = 86_400_000;
export const DEFAULTS = { perQuery: 12, maxProducts: 400, maxAgeDays: LOCAL_STALE_DAYS, round: 4 } as const;
const PHOTO_PX = 320;
const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const SAVE_EVERY = 5;
const QUERY_SIZE = 48;

export interface BuildOptions {
  dir: string;
  provider: ProductProvider;
  ctx: ProviderContext;
  queries: readonly QuerySpec[];
  /** Article numbers fetched before the queries (products of the design sessions). */
  seedSkus?: readonly string[];
  /** Results kept per query (default 12). */
  perQuery?: number;
  /** Stop when the catalogue holds this many products (default 400). */
  maxProducts?: number;
  /** Product pages to read in this run at most (a sample run), default unlimited. */
  limit?: number;
  /** An entry younger than this is fresh and skipped (default 30 days). */
  maxAgeDays?: number;
  photos?: boolean;
  /** Shrink textures / Meshopt (default true). */
  optimize?: boolean;
  /** Longest texture side kept (default 1024; 512 halves the browser memory again). */
  textureMax?: number;
  now?: () => Date;
  log?: (message: string) => void;
  /** Polled between products: true = finish cleanly now (Ctrl-C). */
  shouldStop?: () => boolean;
}

export interface Problem {
  sku: string;
  kind: 'page' | 'model' | 'photo';
  reason: string;
}

export interface BuildReport {
  pagesRead: number;
  searches: number;
  added: number;
  kept: number;
  rejected: number;
  withModel: number;
  withoutModel: number;
  /** Products whose page lacked one dimension (usually the height of a sofa) and got it from the 3D model. */
  dimsFromModel: number;
  /** Everything the build had to catch: unreadable pages, missing sizes, missing / broken / mismatched models. */
  problems: Problem[];
  models: { count: number; bytesBefore: number; bytesAfter: number; decodedBefore: number; decodedAfter: number; quarterTurns: number };
  stopped?: string;
}

export const isFresh = (iso: string, maxAgeDays: number, now: number): boolean => now - Date.parse(iso) <= maxAgeDays * DAY;

export async function loadCatalogFile(dir: string, now: string): Promise<LocalCatalogFile> {
  let text: string;
  try {
    text = await readFile(join(dir, 'catalog.json'), 'utf8');
  } catch {
    return emptyCatalog(now);
  }
  const parsed = LocalCatalogFile.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${join(dir, 'catalog.json')} is not a valid local catalogue (${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}). Fix or delete it.`);
  return parsed.data;
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export const saveCatalogFile = (dir: string, file: LocalCatalogFile): Promise<void> => writeAtomic(join(dir, 'catalog.json'), JSON.stringify(file, null, 1));

/** Why a record cannot be kept (undefined = fine). Dims are metres, assembled. */
export function recordProblem(rec: ProductRecord): string | undefined {
  const { w, d, h } = rec.dims;
  for (const [k, v] of [['width', w], ['depth', d], ['height', h]] as const) {
    if (!(v >= 0.005 && v <= 8)) return `implausible ${k} ${v} m`;
  }
  if (Math.max(w, d, h) < 0.03) return 'implausibly small product';
  if (!(rec.price > 0 && rec.price < 100_000)) return `implausible price ${rec.price}`;
  if (!rec.priceTtc) return 'price is not TTC';
  if (rec.mount !== 'floor' && rec.mount !== 'wall') return `unexpected mount ${rec.mount}`;
  return undefined;
}

async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderError('model_unavailable', `file is larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/** Errors that mean "stop now, the shop does not want us": the build saves what it has and ends. */
const FATAL = new Set(['provider_blocked', 'provider_rate_limited', 'robots_disallowed']);

class Stop extends Error {}

export async function buildCatalog(o: BuildOptions): Promise<BuildReport> {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? (() => undefined);
  const perQuery = o.perQuery ?? DEFAULTS.perQuery;
  const maxProducts = o.maxProducts ?? DEFAULTS.maxProducts;
  const maxAge = o.maxAgeDays ?? DEFAULTS.maxAgeDays;
  const optimize = o.optimize !== false;
  const withPhotos = o.photos !== false;
  const file = await loadCatalogFile(o.dir, now().toISOString());
  const bySku = new Map(file.entries.map((e) => [e.record.sku, e]));
  const report: BuildReport = {
    pagesRead: 0,
    searches: 0,
    added: 0,
    kept: 0,
    rejected: 0,
    withModel: 0,
    withoutModel: 0,
    dimsFromModel: 0,
    problems: [],
    models: { count: 0, bytesBefore: 0, bytesAfter: 0, decodedBefore: 0, decodedAfter: 0, quarterTurns: 0 },
  };
  let unsaved = 0;
  let consecutiveFailures = 0;
  let rescueWhy = '';
  const hitsByQuery = new Map<string, IkeaHit[]>();

  const save = async () => {
    file.builtAt = now().toISOString();
    file.entries = [...bySku.values()];
    await saveCatalogFile(o.dir, file);
    unsaved = 0;
  };
  const budgetLeft = () => (o.limit === undefined ? Infinity : o.limit - report.pagesRead);
  const checkStop = () => {
    if (o.shouldStop?.()) throw new Stop('interrupted');
    if (budgetLeft() <= 0) throw new Stop(`--limit ${o.limit} reached`);
    if (bySku.size >= maxProducts) throw new Stop(`${maxProducts} products reached`);
  };
  const problem = (sku: string, kind: Problem['kind'], reason: string) => {
    report.problems.push({ sku, kind, reason });
    log(`  ! ${sku} ${kind}: ${reason}`);
  };

  /** Model (and photo) of a record; returns the parts for the entry. */
  async function attachParts(rec: ProductRecord, prev?: LocalEntry, downloaded?: Uint8Array): Promise<Pick<LocalEntry, 'has3d' | 'noModelReason' | 'model' | 'photo' | 'flags' | 'incomplete'>> {
    const flags: string[] = [];
    const incomplete: ('model' | 'photo')[] = [];
    const sku = rec.sku;
    let has3d = false;
    let noModelReason: string | undefined;
    let model: LocalEntry['model'];
    const needModel = !prev || prev.incomplete.includes('model');
    if (!needModel && prev) {
      ({ has3d, noModelReason, model } = prev);
      flags.push(...prev.flags);
    } else if (!rec.modelRef) {
      noModelReason = 'the product page lists no 3D model';
    } else {
      try {
        const bytes = downloaded ?? (await readCapped((await o.provider.fetchModel!(sku, o.ctx)).stream, 20 * 1024 * 1024));
        const r = await normaliseGlb(bytes, rec.dims, { optimize, ...(o.textureMax ? { textureMax: o.textureMax } : {}) });
        if (r.ok) {
          const file = `models/${sku}.glb` as const;
          await writeAtomic(join(o.dir, file), r.bytes);
          has3d = true;
          model = {
            file,
            bytes: r.bytes.byteLength,
            sha256: r.sha256,
            triangles: r.after.triangles,
            fit: { quarterTurn: r.fit.quarterTurn, distortion: Math.round(r.fit.distortion * 1000) / 1000, size: r.after.size.map((v) => Math.round(v * 1000) / 1000) as [number, number, number] },
            decodedBytesBefore: r.before.decodedBytes,
            decodedBytesAfter: r.after.decodedBytes,
            bytesBefore: r.bytesBefore,
          };
          flags.push(...r.flags);
          report.models.count++;
          report.models.bytesBefore += r.bytesBefore;
          report.models.bytesAfter += r.bytes.byteLength;
          report.models.decodedBefore += r.before.decodedBytes;
          report.models.decodedAfter += r.after.decodedBytes;
          if (r.fit.quarterTurn) {
            report.models.quarterTurns++;
            problem(sku, 'model', 'axis mapping: the model ran along the other axis than the listed width/depth; quarter turn baked in');
          }
        } else {
          noModelReason = r.reason;
          problem(sku, 'model', r.reason);
        }
      } catch (e) {
        if (e instanceof ProviderError && FATAL.has(e.code)) throw e;
        if (e instanceof ProviderError && e.code === 'model_unavailable') {
          noModelReason = `no model could be downloaded: ${e.message}`.slice(0, 280);
          problem(sku, 'model', noModelReason);
        } else {
          // Network trouble is not a verdict on the model: try again next run.
          incomplete.push('model');
          noModelReason = `model download failed (${e instanceof Error ? e.message : String(e)}); retried on the next build`.slice(0, 280);
          problem(sku, 'model', noModelReason);
        }
      }
    }
    let photo = prev?.photo;
    if (withPhotos && !photo && rec.photoUrl && (!prev || prev.incomplete.includes('photo') || prev.photo === undefined)) {
      try {
        const bytes = await readCapped((await o.provider.fetchPhoto!(rec, o.ctx)).stream, PHOTO_MAX_BYTES);
        const small = await sharp(bytes).resize({ width: PHOTO_PX, height: PHOTO_PX, fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
        await writeAtomic(join(o.dir, `photos/${sku}.webp`), small);
        photo = { file: `photos/${sku}.webp`, bytes: small.byteLength };
      } catch (e) {
        if (e instanceof ProviderError && FATAL.has(e.code)) throw e;
        incomplete.push('photo');
        problem(sku, 'photo', e instanceof Error ? e.message : String(e));
      }
    }
    return { has3d, ...(noModelReason ? { noModelReason } : {}), ...(model ? { model } : {}), ...(photo ? { photo } : {}), flags: flags.slice(0, 12), incomplete };
  }

  /** `product_dims_missing` with exactly one dimension unknown: derive it from the model's proportions, scaled to the two known sizes. */
  async function rescueDims(e: ProviderError, html: string, base: Parameters<typeof parseProductPage>[1]): Promise<{ rec: ProductRecord; bytes: Uint8Array } | undefined> {
    const known = (e.details?.['knownDims'] ?? {}) as Partial<Record<'w' | 'd' | 'h', number>>;
    const keys = (['w', 'd', 'h'] as const).filter((k) => typeof known[k] === 'number');
    rescueWhy = '';
    if (keys.length !== 2) return undefined;
    const placeholder = { w: known.w ?? 1, d: known.d ?? 1, h: known.h ?? 1 };
    let temp: ProductRecord;
    try {
      temp = parseProductPage(html, { ...base, forceDims: placeholder });
    } catch {
      return undefined;
    }
    if (!temp.modelRef) {
      rescueWhy = 'no 3D model to take it from';
      return undefined;
    }
    o.ctx.cache.set(`product:${base.sku}`, temp, 600_000, 4096);
    let bytes: Uint8Array;
    let size: readonly [number, number, number];
    try {
      bytes = await readCapped((await o.provider.fetchModel!(base.sku, o.ctx)).stream, 20 * 1024 * 1024);
      size = measureDocument(await readGlb(bytes)).size;
    } catch (err) {
      if (err instanceof ProviderError && FATAL.has(err.code)) throw err;
      rescueWhy = `the model could not be read (${err instanceof Error ? err.message : String(err)})`.slice(0, 120);
      return undefined;
    }
    let best: { spread: number; dims: { w: number; d: number; h: number } } | undefined;
    for (const axes of [{ w: size[0], h: size[1], d: size[2] }, { w: size[2], h: size[1], d: size[0] }]) {
      const scales = keys.map((k) => known[k]! / axes[k]);
      const mean = (scales[0]! + scales[1]!) / 2;
      const spread = Math.abs(scales[0]! - scales[1]!) / mean;
      const dims = { w: known.w ?? axes.w * mean, d: known.d ?? axes.d * mean, h: known.h ?? axes.h * mean };
      if (Number.isFinite(spread) && (!best || spread < best.spread)) best = { spread, dims };
    }
    if (!best || best.spread > 0.12) {
      rescueWhy = `model proportions do not match the two listed sizes (${best ? Math.round(best.spread * 100) : '?'}% apart)`;
      return undefined;
    }
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const dims = { w: r3(best.dims.w), d: r3(best.dims.d), h: r3(best.dims.h) };
    try {
      return { rec: parseProductPage(html, { ...base, forceDims: dims }), bytes };
    } catch {
      return undefined;
    }
  }

  /** Reads one product: page, model, photo. Returns the outcome. */
  async function addProduct(sku: string, hit: IkeaHit | undefined, queryLabel: string | undefined): Promise<'added' | 'kept' | 'rejected' | 'full'> {
    if (!LOCAL_SKU.test(sku)) return 'rejected';
    const existing = bySku.get(sku);
    if (existing) {
      if (queryLabel && !existing.queries.includes(queryLabel) && existing.queries.length < 12) {
        existing.queries.push(queryLabel);
        unsaved++;
      }
      if (isFresh(existing.checkedAt, maxAge, now().getTime()) && existing.incomplete.length === 0) {
        report.kept++;
        return 'kept';
      }
      if (existing.incomplete.length > 0) {
        checkStop();
        // Retry the missing parts from the stored record (no page read).
        o.ctx.cache.set(`product:${sku}`, existing.record, 600_000, 4096);
        const parts = await attachParts(existing.record, existing);
        bySku.set(sku, { ...existing, ...stripParts(parts, existing) });
        unsaved++;
        return 'kept';
      }
      report.kept++;
      return 'kept'; // stale entries are re-read by --refresh-prices, not by a query run
    }
    const rej = file.rejected[sku];
    if (rej && isFresh(rej.at, maxAge, now().getTime())) return 'rejected';
    checkStop();
    if (bySku.size >= maxProducts) return 'full';
    if (hit) o.ctx.cache.set(`hit:${sku}`, hit, 600_000, 1024);
    let rec: ProductRecord;
    let downloaded: Uint8Array | undefined;
    report.pagesRead++;
    try {
      const { html, pageUrl } = await fetchProductPage(sku, o.ctx);
      const base = { sku, pageUrl, fetchedAt: now().toISOString(), ...(hit ? { hit } : {}) };
      consecutiveFailures = 0;
      try {
        rec = parseProductPage(html, base);
      } catch (e) {
        // Sofas and beds often list width and depth but no total height: the 3D model knows it.
        const rescued = e instanceof ProviderError && e.code === 'product_dims_missing' ? await rescueDims(e, html, base) : undefined;
        if (!rescued) throw e;
        ({ rec, bytes: downloaded } = rescued);
        report.dimsFromModel++;
        log(`  ~ ${sku} height taken from the 3D model (the page lists only ${Object.keys((e as ProviderError).details?.['knownDims'] ?? {}).join(' and ')})`);
      }
      o.ctx.cache.set(`product:${sku}`, rec, 600_000, 4096);
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      if (FATAL.has(e.code)) throw e;
      if (e.code === 'provider_unavailable' && ++consecutiveFailures >= 5) throw new Stop(`5 failures in a row (${e.message}); is the shop reachable?`);
      if (e.code === 'provider_unavailable') {
        problem(sku, 'page', `${e.message} (will be retried on the next build)`);
        return 'rejected';
      }
      const reason = `${e.code}: ${e.message}${e.code === 'product_dims_missing' && rescueWhy ? `; not recoverable from the 3D model: ${rescueWhy}` : ''}`.slice(0, 280);
      file.rejected[sku] = { at: now().toISOString(), reason };
      report.rejected++;
      problem(sku, 'page', reason);
      unsaved++;
      return 'rejected';
    }
    const bad = recordProblem(rec);
    if (bad) {
      file.rejected[sku] = { at: now().toISOString(), reason: bad };
      report.rejected++;
      problem(sku, 'page', bad);
      unsaved++;
      return 'rejected';
    }
    const parts = await attachParts(rec, undefined, downloaded);
    const flags = [...parts.flags];
    if (rec.dimsSource === 'model') flags.push('a dimension missing on the page was derived from the 3D model');
    if (rec.category === 'other') flags.push('category other: the shop type was not recognised');
    const iso = now().toISOString();
    const entry: LocalEntry = LocalEntry.parse({
      record: rec,
      typeName: (hit?.typeName ?? '').slice(0, 120),
      queries: queryLabel ? [queryLabel] : [],
      ...parts,
      flags: flags.slice(0, 12),
      availability: 'unknown',
      checkedAt: iso,
    });
    bySku.set(sku, entry);
    report.added++;
    log(`  + ${sku} ${rec.name.slice(0, 60)}  ${rec.price} EUR  ${rec.category}  ${entry.has3d ? '3D' : 'no 3D'}`);
    if (++unsaved >= SAVE_EVERY) await save();
    return 'added';
  }

  const stripParts = (parts: Awaited<ReturnType<typeof attachParts>>, prev: LocalEntry): Partial<LocalEntry> => ({
    has3d: parts.has3d,
    noModelReason: parts.noModelReason,
    model: parts.model ?? prev.model,
    photo: parts.photo ?? prev.photo,
    flags: parts.flags,
    incomplete: parts.incomplete,
  });

  async function hitsFor(spec: QuerySpec): Promise<IkeaHit[]> {
    const have = hitsByQuery.get(spec.q);
    if (have) return have;
    const logged = file.queryLog[spec.q];
    // A query whose results are all settled (kept or rejected) and still fresh is not searched again.
    if (logged && isFresh(logged.at, maxAge, now().getTime()) && logged.skus.every((s) => bySku.has(s) || file.rejected[s])) {
      const settled: IkeaHit[] = [];
      hitsByQuery.set(spec.q, settled);
      for (const s of logged.skus) if (bySku.has(s)) settled.push({ sku: s } as IkeaHit);
      return settled;
    }
    checkStop();
    log(`search "${spec.q}"`);
    const { hits, skipped } = await fetchSearchHits(spec.q, QUERY_SIZE, o.ctx);
    report.searches++;
    if (skipped.length) log(`  (${skipped.length} malformed hit(s) skipped)`);
    const wanted = hits.filter((h) => !spec.category || categoryOf(h.typeName, h.categoryPath) === spec.category);
    hitsByQuery.set(spec.q, wanted);
    file.queryLog[spec.q] = { at: now().toISOString(), skus: wanted.slice(0, perQuery).map((h) => h.sku) };
    unsaved++;
    return wanted;
  }

  try {
    // 1. products of the design sessions
    for (const sku of o.seedSkus ?? []) {
      if ((await addProduct(sku, undefined, 'design sessions')) === 'full') break;
    }
    // 2. the curated queries, breadth first: a few results of every query per round
    const step = Math.max(1, Math.min(DEFAULTS.round, perQuery));
    for (let from = 0; from < perQuery; from += step) {
      for (const spec of o.queries) {
        checkStop();
        const hits = (await hitsFor(spec)).slice(from, Math.min(from + step, perQuery));
        for (const h of hits) {
          if ((await addProduct(h.sku, h.name ? h : undefined, spec.q)) === 'full') throw new Stop(`${maxProducts} products reached`);
        }
      }
    }
  } catch (e) {
    if (e instanceof Stop) report.stopped = e.message;
    else {
      await save();
      throw e;
    }
  }
  for (const e of bySku.values()) {
    if (e.has3d) report.withModel++;
    else report.withoutModel++;
  }
  await save();
  return report;
}

// ---------------------------------------------------------------------------------------------
// --refresh-prices: price and availability only
// ---------------------------------------------------------------------------------------------

export interface RefreshOptions {
  dir: string;
  ctx: ProviderContext;
  limit?: number;
  now?: () => Date;
  log?: (message: string) => void;
  shouldStop?: () => boolean;
}

export interface RefreshReport {
  checked: number;
  changed: { sku: string; from: number; to: number }[];
  discontinued: string[];
  failed: { sku: string; reason: string }[];
  stopped?: string;
}

const availabilityFrom = (a: ReturnType<typeof availabilityOf>): Availability => a ?? 'in_stock';

/** Re-reads the product page of every entry (oldest first) and updates price, VAT flag, variant prices, availability and the check date. Dimensions, model and photo are left alone. */
export async function refreshPrices(o: RefreshOptions): Promise<RefreshReport> {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? (() => undefined);
  const file = await loadCatalogFile(o.dir, now().toISOString());
  const report: RefreshReport = { checked: 0, changed: [], discontinued: [], failed: [] };
  const queue = [...file.entries].sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt)).slice(0, o.limit ?? Infinity);
  let sinceSave = 0;
  const save = async () => {
    file.builtAt = now().toISOString();
    await saveCatalogFile(o.dir, file);
    sinceSave = 0;
  };
  try {
    for (const entry of queue) {
      if (o.shouldStop?.()) {
        report.stopped = 'interrupted';
        break;
      }
      const sku = entry.record.sku;
      const url = safePageUrl(entry.record.url);
      if (!url) {
        report.failed.push({ sku, reason: 'stored page link is not an allowed shop URL' });
        continue;
      }
      report.checked++;
      try {
        const res = await o.ctx.fetch(url, { headers: { accept: 'text/html', 'accept-language': 'fr-FR,fr;q=0.9' } });
        if (res.status === 404 || res.status === 410) {
          await res.body?.cancel().catch(() => undefined);
          entry.availability = 'discontinued';
          entry.checkedAt = now().toISOString();
          report.discontinued.push(sku);
          log(`  ${sku} no longer on the shop`);
        } else if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          report.failed.push({ sku, reason: `page answered ${res.status}` });
          continue;
        } else {
          const html = await readTextCapped(res, 4 * 1024 * 1024);
          const iso = now().toISOString();
          const fresh = parseProductPage(html, { sku, pageUrl: res.url || url, fetchedAt: iso });
          const availability = availabilityFrom(availabilityOf(html));
          if (fresh.price !== entry.record.price) {
            report.changed.push({ sku, from: entry.record.price, to: fresh.price });
            log(`  ${sku} price ${entry.record.price} -> ${fresh.price}`);
          }
          const variants = entry.record.variants.map((v) => {
            const nv = fresh.variants.find((x) => x.sku === v.sku);
            return nv?.price !== undefined ? { ...v, price: nv.price } : v;
          });
          entry.record = ProductRecord.parse({ ...entry.record, price: fresh.price, currency: fresh.currency, priceTtc: fresh.priceTtc, variants, fetchedAt: iso });
          entry.availability = availability;
          entry.checkedAt = iso;
        }
      } catch (e) {
        if (e instanceof ProviderError && FATAL.has(e.code)) throw e;
        report.failed.push({ sku, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) });
        continue;
      }
      if (++sinceSave >= SAVE_EVERY) await save();
    }
  } finally {
    await save();
  }
  return report;
}

/** Removes a half-written temporary file left by an interrupted run. */
export async function cleanTemp(dir: string): Promise<void> {
  await rm(join(dir, 'catalog.json.tmp'), { force: true });
}
