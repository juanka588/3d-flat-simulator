import { describe, expect, it } from 'vitest';
import * as scene from '@flat/scene';
import * as assets from './index';
import * as assetsNode from './node';

// Step A2: the facade re-exports the very same values as @flat/scene (A4 moves the implementations without changing this).
describe('@flat/assets facade', () => {
  it('re-exports scene values by identity', () => {
    const names = Object.keys(assets);
    expect(names.length).toBeGreaterThan(40);
    for (const name of names) {
      expect(assets[name as keyof typeof assets], name).toBe(scene[name as keyof typeof scene]);
    }
  });

  it('registers the generators on import', () => {
    expect(scene.GENERATORS.list().length).toBe(assets.ALL_GENERATORS.length);
  });

  it('has an empty node entry', () => {
    expect(Object.keys(assetsNode)).toEqual([]);
  });
});
