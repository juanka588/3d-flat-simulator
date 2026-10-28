import { describe, expect, it } from 'vitest';
import products from '@flat/scene/fixtures/products.json';
import { ProductRecord } from '../products/records';
import { RECORD_TTL_MS, RecordCache } from './record-cache';

const record = ProductRecord.parse((products as unknown[])[1]);

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
});
