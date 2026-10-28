import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as scene from '@flat/scene';
import { describe, expect, it } from 'vitest';
import * as assets from './index';
import * as assetsNode from './node';

describe('@flat/assets public API', () => {
  it('registers the generators on import and asserts it', () => {
    expect(scene.GENERATORS.list().length).toBe(assets.ALL_GENERATORS.length);
    expect(() => assets.assertGeneratorsRegistered()).not.toThrow();
  });

  it('owns its names: none of them is exported by @flat/scene any more', () => {
    for (const name of Object.keys(assets)) expect(name in scene, name).toBe(false);
  });

  it('has an empty node entry', () => {
    expect(Object.keys(assetsNode)).toEqual([]);
  });

  it('is not marked side-effect free: the index registers the generators', () => {
    const json = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as { sideEffects?: unknown };
    expect(json.sideEffects).toBeUndefined();
  });
});
