import { LOCAL_STALE_DAYS } from '@flat/assets';
import { loadCatalogFile } from './build';

const DAY = 86_400_000;
const MB = 1024 * 1024;

export interface StatusReport {
  dir: string;
  exists: boolean;
  builtAt?: string;
  products: number;
  withModel: number;
  withoutModel: number;
  incomplete: number;
  stale: number;
  discontinued: number;
  rejected: number;
  queries: number;
  oldest?: string;
  newest?: string;
  byCategory: Record<string, number>;
  noModelReasons: { reason: string; count: number }[];
  modelBytes: number;
  modelBytesBeforeNormalising: number;
  decodedBefore: number;
  decodedAfter: number;
  quarterTurns: number;
  photos: number;
}

/** Short reason class so 200 distinct sentences group into a handful of lines. */
const reasonClass = (r: string): string =>
  r
    .replace(/\(\d+(?:\.\d+)?%?[^)]*\)/g, '')
    .replace(/\d+x\d+x?\d* cm/g, 'N cm')
    .replace(/\d+(?:\.\d+)?%/g, 'N%')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);

export async function statusReport(dir: string, now: Date = new Date()): Promise<StatusReport> {
  const empty: StatusReport = { dir, exists: false, products: 0, withModel: 0, withoutModel: 0, incomplete: 0, stale: 0, discontinued: 0, rejected: 0, queries: 0, byCategory: {}, noModelReasons: [], modelBytes: 0, modelBytesBeforeNormalising: 0, decodedBefore: 0, decodedAfter: 0, quarterTurns: 0, photos: 0 };
  const file = await loadCatalogFile(dir, now.toISOString());
  if (file.entries.length === 0 && Object.keys(file.queryLog).length === 0) return empty;
  const r: StatusReport = { ...empty, exists: true, builtAt: file.builtAt, products: file.entries.length, rejected: Object.keys(file.rejected).length, queries: Object.keys(file.queryLog).length };
  const reasons = new Map<string, number>();
  const times = file.entries.map((e) => Date.parse(e.checkedAt)).filter(Number.isFinite);
  if (times.length) {
    r.oldest = new Date(Math.min(...times)).toISOString();
    r.newest = new Date(Math.max(...times)).toISOString();
  }
  for (const e of file.entries) {
    r.byCategory[e.record.category] = (r.byCategory[e.record.category] ?? 0) + 1;
    if (e.has3d && e.model) {
      r.withModel++;
      r.modelBytes += e.model.bytes;
      r.modelBytesBeforeNormalising += e.model.bytesBefore;
      r.decodedBefore += e.model.decodedBytesBefore;
      r.decodedAfter += e.model.decodedBytesAfter;
      if (e.model.fit.quarterTurn) r.quarterTurns++;
    } else {
      r.withoutModel++;
      const k = reasonClass(e.noModelReason ?? 'unknown');
      reasons.set(k, (reasons.get(k) ?? 0) + 1);
    }
    if (e.photo) r.photos++;
    if (e.incomplete.length) r.incomplete++;
    if (e.availability === 'discontinued') r.discontinued++;
    if (!(now.getTime() - Date.parse(e.record.fetchedAt) <= LOCAL_STALE_DAYS * DAY)) r.stale++;
  }
  r.noModelReasons = [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  return r;
}

export function formatStatus(r: StatusReport): string {
  if (!r.exists) return `No local catalogue in ${r.dir}.\nBuild one with: pnpm catalog:build   (a sample: pnpm catalog:build --limit 15)`;
  const out: string[] = [];
  out.push(`Local catalogue ${r.dir}`);
  out.push(`  built ${r.builtAt?.slice(0, 16).replace('T', ' ')}; ${r.products} products (${r.withModel} with a 3D model, ${r.withoutModel} without), ${r.photos} photos, ${r.queries} queries searched`);
  out.push(`  prices read ${r.oldest?.slice(0, 10)} .. ${r.newest?.slice(0, 10)}; ${r.stale} older than ${LOCAL_STALE_DAYS} days${r.stale ? ' (run: pnpm catalog:build --refresh-prices)' : ''}; ${r.discontinued} no longer sold`);
  if (r.incomplete) out.push(`  ${r.incomplete} product(s) are missing a model or photo after a network failure (the next build retries them)`);
  if (r.rejected) out.push(`  ${r.rejected} shop hit(s) were rejected (no usable size, unreadable page...) and are not retried until they age`);
  if (r.withModel) {
    out.push(`  models: ${(r.modelBytes / MB).toFixed(1)} MB on disk (${(r.modelBytesBeforeNormalising / MB).toFixed(1)} MB as downloaded); decoded in the browser ~${(r.decodedAfter / MB).toFixed(0)} MB (was ~${(r.decodedBefore / MB).toFixed(0)} MB); ${r.quarterTurns} needed a quarter turn`);
  }
  out.push(`  categories: ${Object.entries(r.byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (r.noModelReasons.length) {
    out.push('  no 3D model because:');
    for (const x of r.noModelReasons.slice(0, 8)) out.push(`    ${String(x.count).padStart(4)}  ${x.reason}`);
  }
  return out.join('\n');
}
