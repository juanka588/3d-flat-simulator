import { describe, expect, it } from 'vitest';
import charme from '../fixtures/charme-3205.flat.json';
import sample from '../fixtures/sample.flat.json';
import { loadSceneText } from './load';
import { parseScene } from './parse';
import { serializeScene } from './serialize';

function scene(data: unknown) {
  const r = parseScene(data);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.scene;
}

describe('serializeScene', () => {
  for (const [name, data] of [['charme', charme], ['sample', sample]] as const) {
    it(`round-trips ${name} byte-for-byte`, () => {
      const text = serializeScene(scene(data));
      const loaded = loadSceneText(text);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(JSON.parse(JSON.stringify(loaded.scene))).toEqual(JSON.parse(JSON.stringify(scene(data)))); // JSON drops the fixture's -0
      expect(serializeScene(loaded.scene)).toBe(text);
    });
  }

  it('does not depend on key insertion order', () => {
    const s = scene(sample);
    const reordered = { ...Object.fromEntries(Object.entries(s).reverse()) } as typeof s;
    expect(serializeScene(reordered)).toBe(serializeScene(s));
  });

  it('sorts keys, ends with a newline and drops undefined', () => {
    const text = serializeScene({ ...scene(sample), name: 'x', site: { ...scene(sample).site, address: undefined } });
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.indexOf('"defaults"')).toBeLessThan(text.indexOf('"walls"'));
    expect(text).not.toContain('undefined');
  });
});
