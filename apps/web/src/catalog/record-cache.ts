import type { ProductRecord } from '@flat/assets';

/** A cached record is read again after this long, so a price placed from it is never much older than its `fetchedAt` says. */
export const RECORD_TTL_MS = 60 * 60 * 1000;

/** Product records already read from the server, expiring after `ttl` (a card warms its record on press / hover so a drop does not wait). */
export class RecordCache {
  private readonly map = new Map<string, { record: ProductRecord; at: number }>();
  constructor(
    private readonly ttl = RECORD_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  get(productId: string): ProductRecord | undefined {
    const hit = this.map.get(productId);
    if (!hit) return undefined;
    if (this.clock() - hit.at >= this.ttl) {
      this.map.delete(productId);
      return undefined;
    }
    return hit.record;
  }

  set(productId: string, record: ProductRecord): void {
    this.map.set(productId, { record, at: this.clock() });
  }

  clear(): void {
    this.map.clear();
  }
}
