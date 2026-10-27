import { describe, expect, it } from 'vitest';
import { ProductRecord } from '@flat/scene';
import { readFileSync } from 'node:fs';
import { RECORD_TTL_MS, RecordCache } from './record-cache';
import { snapshotOf } from './place';

const products = JSON.parse(readFileSync(new URL('../../../../packages/scene/fixtures/products.json', import.meta.url), 'utf8')) as unknown[];
const record = ProductRecord.parse(products[1]);

describe('RecordCache', () => {
  it('serves a record until the TTL, then forgets it', () => {
    let now = 1_000;
    const cache = new RecordCache(RECORD_TTL_MS, () => now);
    cache.set('mock:a', record);
    now += RECORD_TTL_MS - 1;
    expect(cache.get('mock:a')).toBe(record);
    now += 1;
    expect(cache.get('mock:a')).toBeUndefined();
  });
  it('a placement from an old cached record carries the record date, so it can go stale', () => {
    const old = { ...record, fetchedAt: '2026-01-01T00:00:00.000Z' };
    expect(snapshotOf(old).snapshotAt).toBe('2026-01-01T00:00:00.000Z');
    expect(snapshotOf(old, 'oak').snapshotAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
