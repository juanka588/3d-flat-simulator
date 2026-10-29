import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { LOCAL_STALE_DAYS, type LocalCatalogInfo, type ProductRecord } from '@flat/assets';
import { reclassify } from '../category';
import { indexEntry, rank } from './search';
import { LOCAL_PROVIDER_ID, LOCAL_SKU, LocalCatalogFile, type LocalEntry } from './schema';
import type { LocalCatalogSource, ModelBytes } from '../types';

/**
 * The local catalogue reader used by the server (personal use, this machine only): `catalog.json` + `models/` + `photos/`
 * in a gitignored folder (see `schema.ts`). Loaded into memory once (a few hundred records), searched in microseconds and
 * reloaded when the build rewrites `catalog.json`. A missing or invalid folder simply means "no local catalogue".
 */

const DAY = 86_400_000;
const GLB_MAX_BYTES = 20 * 1024 * 1024;
const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const RELOAD_CHECK_MS = 1000;

export interface OpenOptions {
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** What the server shows of an entry: the record, with `modelRef` / `photoUrl` set only when the catalogue really has the file. */
export function servedRecord(entry: LocalEntry): ProductRecord {
  const rec: ProductRecord = { ...entry.record };
  delete rec.modelRef;
  delete rec.photoUrl;
  if (entry.has3d) rec.modelRef = `local:${entry.record.sku}`;
  if (entry.photo && entry.record.photoUrl) rec.photoUrl = entry.record.photoUrl;
  return rec;
}

/** The entry with its category and mount recomputed from the shop type and the name by the CURRENT classifier (no re-download). */
export function reclassifyEntry(entry: LocalEntry): LocalEntry {
  const { category, mount } = reclassify(entry.typeName, entry.record.name, entry.record.category);
  if (category === entry.record.category && mount === entry.record.mount) return entry;
  return { ...entry, record: { ...entry.record, category, mount } };
}

export async function openLocalCatalog(dir: string, options: OpenOptions = {}): Promise<LocalCatalogSource | undefined> {
  const cat = new LocalCatalogReader(dir, options);
  await cat.refresh(true);
  return cat.info() ? cat : undefined;
}

class LocalCatalogReader implements LocalCatalogSource {
  readonly id = LOCAL_PROVIDER_ID;
  private file: LocalCatalogFile | undefined;
  private index: ReturnType<typeof indexEntry>[] = [];
  private bySku = new Map<string, LocalEntry>();
  private stamp = '';
  private checkedAt = 0;
  private loading: Promise<void> | undefined;
  private readonly now: () => number;

  constructor(
    readonly dir: string,
    private readonly options: OpenOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async refresh(force = false): Promise<void> {
    const t = this.now();
    if (!force && t - this.checkedAt < RELOAD_CHECK_MS) return this.loading;
    this.checkedAt = t;
    this.loading = this.load().finally(() => (this.loading = undefined));
    return this.loading;
  }

  private async load(): Promise<void> {
    const path = join(this.dir, 'catalog.json');
    let stamp: string;
    try {
      const s = await stat(path);
      stamp = `${s.mtimeMs}:${s.size}`;
    } catch {
      if (this.file) this.options.log?.('warn', `local catalogue: ${path} disappeared`);
      this.file = undefined;
      this.index = [];
      this.bySku = new Map();
      this.stamp = '';
      return;
    }
    if (stamp === this.stamp) return;
    let parsed: LocalCatalogFile;
    try {
      parsed = LocalCatalogFile.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (e) {
      this.options.log?.('warn', `local catalogue: ${path} is not valid (${e instanceof Error ? e.message.split('\n')[0] : String(e)}); ignored`);
      this.file = undefined;
      this.index = [];
      this.bySku = new Map();
      this.stamp = stamp;
      return;
    }
    // A model that the catalogue lists but whose file is gone or truncated is not offered: nothing may 404 at run time.
    const entries: LocalEntry[] = [];
    let missing = 0;
    for (const e of parsed.entries) {
      if (!LOCAL_SKU.test(e.record.sku)) continue;
      let entry = reclassifyEntry(e);
      if (e.has3d && e.model) {
        const ok = await stat(join(this.dir, e.model.file)).then((s) => s.isFile() && s.size === e.model!.bytes, () => false);
        if (!ok) {
          missing++;
          entry = { ...entry, has3d: false, noModelReason: 'model file missing or changed since the build', model: undefined };
        }
      } else if (e.has3d) entry = { ...entry, has3d: false, noModelReason: 'model entry incomplete' };
      if (e.photo) {
        const ok = await stat(join(this.dir, e.photo.file)).then((s) => s.isFile(), () => false);
        if (!ok) entry = { ...entry, photo: undefined };
      }
      entries.push(entry);
    }
    if (missing > 0) this.options.log?.('warn', `local catalogue: ${missing} model file(s) missing; those products are listed without a 3D model (run pnpm catalog:build)`);
    this.file = { ...parsed, entries };
    this.index = entries.map(indexEntry);
    this.bySku = new Map(entries.map((e) => [e.record.sku, e]));
    this.stamp = stamp;
    this.options.log?.('info', `local catalogue: ${entries.length} products (${entries.filter((e) => e.has3d).length} with a 3D model), built ${parsed.builtAt.slice(0, 10)}`);
  }

  info(): LocalCatalogInfo | undefined {
    const f = this.file;
    if (!f) return undefined;
    const newest = f.entries.reduce((m, e) => Math.max(m, Date.parse(e.record.fetchedAt) || 0), 0);
    return {
      id: this.id,
      count: f.entries.length,
      withModels: f.entries.filter((e) => e.has3d).length,
      builtAt: f.builtAt,
      stale: f.entries.length > 0 && this.now() - newest > LOCAL_STALE_DAYS * DAY,
    };
  }

  search(query: string, opts: Parameters<LocalCatalogSource['search']>[1]): ProductRecord[] {
    return rank(this.index, query, opts).map((r) => servedRecord(r.entry));
  }

  get(sku: string): ProductRecord | undefined {
    const e = this.bySku.get(sku);
    return e ? servedRecord(e) : undefined;
  }

  isStale(sku: string): boolean {
    const e = this.bySku.get(sku);
    return e !== undefined && !(this.now() - Date.parse(e.record.fetchedAt) <= LOCAL_STALE_DAYS * DAY);
  }

  async readModel(sku: string): Promise<ModelBytes | undefined> {
    const e = this.bySku.get(sku);
    if (!e) return undefined;
    if (!e.has3d || !e.model) return { state: 'none', reason: e.noModelReason ?? 'the local catalogue has no usable 3D model for this product' };
    try {
      const path = join(this.dir, e.model.file);
      const s = await stat(path);
      if (!s.isFile() || s.size > GLB_MAX_BYTES || s.size < 12) return { state: 'none', reason: 'model file is not usable' };
      const bytes = await readFile(path);
      if (bytes[0] !== 0x67 || bytes[1] !== 0x6c || bytes[2] !== 0x54 || bytes[3] !== 0x46) return { state: 'none', reason: 'model file is not a GLB' };
      return { state: 'ready', bytes };
    } catch {
      return { state: 'none', reason: 'model file could not be read' };
    }
  }

  async readPhoto(sku: string): Promise<Uint8Array | undefined> {
    const e = this.bySku.get(sku);
    if (!e?.photo) return undefined;
    try {
      const path = join(this.dir, e.photo.file);
      const s = await stat(path);
      if (!s.isFile() || s.size > PHOTO_MAX_BYTES) return undefined;
      return await readFile(path);
    } catch {
      return undefined;
    }
  }
}
