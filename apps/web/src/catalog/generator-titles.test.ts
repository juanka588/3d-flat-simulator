import { readFileSync } from 'node:fs';
import { GENERATORS } from '@flat/scene';
import { describe, expect, it } from 'vitest';
import { GENERATOR_TITLE_IDS, generatorTitle } from './generator-titles';

describe('generator titles', () => {
  it('every registered generator has a short title, and no title is stale', () => {
    const ids = GENERATORS.list().map((g) => g.id).sort();
    expect([...GENERATOR_TITLE_IDS].sort()).toEqual(ids);
    for (const g of GENERATORS.list()) {
      const t = generatorTitle(g);
      expect(t.length, g.id).toBeLessThanOrEqual(24);
      expect(t, g.id).not.toMatch(/[(":]/);
    }
  });
  it('an unknown generator falls back to the start of its description', () => {
    expect(generatorTitle({ id: 'x', label: 'Hammock, with a stand' })).toBe('Hammock');
  });
});

describe('generator thumbnails', () => {
  it('every generator has a committed WebP of at most 8 KB (pnpm assets:thumbs)', () => {
    for (const g of GENERATORS.list()) {
      const bytes = readFileSync(new URL(`../../public/models/thumbs/param-${g.id}.webp`, import.meta.url));
      expect(bytes.length, g.id).toBeLessThanOrEqual(8 * 1024);
      expect(bytes.subarray(8, 12).toString('latin1'), g.id).toBe('WEBP');
    }
  });
});
