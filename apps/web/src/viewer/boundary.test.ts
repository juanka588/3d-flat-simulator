import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// V6: the viewer is decoupled from the app (docs/architecture/modules.md section 4 / 8.1.4). It gets everything through
// FlatCanvas props and viewer/config.ts, never from the app's stores, sync layer, catalog/editor logic or UI.
// Test files are excluded: they may use app fixtures.
const FORBIDDEN = /from\s+['"](?:\.\.\/)+(?:state|sync|catalog|ui|editor)\b|import\.meta\.env\.BASE_URL/;
const files = readdirSync(__dirname).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

describe('apps/web/src/viewer boundary', () => {
  it('has source files to check', () => expect(files.length).toBeGreaterThan(20));
  it.each(files)('%s imports nothing from the app', (f) => {
    const offending = readFileSync(join(__dirname, f), 'utf8')
      .split('\n')
      .filter((l) => FORBIDDEN.test(l));
    expect(offending).toEqual([]);
  });
});
