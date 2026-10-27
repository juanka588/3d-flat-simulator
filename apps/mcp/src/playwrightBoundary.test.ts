import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** CI meta-check (M4.13): Playwright is only ever imported under `src/render/`, so the non-render tools and stdio start-up never load it. */
const SRC = fileURLToPath(new URL('.', import.meta.url));
const RENDER = join(SRC, 'render');
const IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](?:playwright|playwright-core|@playwright\/[^'"]+)['"]/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('playwright boundary', () => {
  it('nothing outside src/render imports playwright', () => {
    const offenders = walk(SRC)
      .filter((f) => !f.startsWith(RENDER + '/') && f !== fileURLToPath(import.meta.url))
      .filter((f) => IMPORT.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('the pattern does detect an import (self-check)', () => {
    expect(IMPORT.test("import { chromium } from 'playwright';")).toBe(true);
    expect(IMPORT.test("const m = await import('playwright')")).toBe(true);
    expect(IMPORT.test("import x from './render/browser'")).toBe(false);
  });
});
