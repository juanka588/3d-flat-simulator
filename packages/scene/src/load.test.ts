import { describe, expect, it } from 'vitest';
import charme from '../fixtures/charme-3205.flat.json';
import sample from '../fixtures/sample.flat.json';
import { loadSceneText, MAX_SCENE_BYTES } from './load';

describe('loadSceneText', () => {
  it('loads a valid scene with warnings', () => {
    const r = loadSceneText(JSON.stringify(sample));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scene.walls.length).toBeGreaterThan(0);
      expect(Array.isArray(r.warnings)).toBe(true);
    }
  });

  it('tolerates a BOM', () => {
    expect(loadSceneText('﻿' + JSON.stringify(charme)).ok).toBe(true);
  });

  it('reports the line and column of a JSON syntax error', () => {
    const r = loadSceneText('{\n  "version": 1,\n  "name": ,\n}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatch(/line 3, column \d+/);
    }
  });

  it('reports truncated JSON at the end of the text', () => {
    const r = loadSceneText('{\n"version": 1,\n"name": "x"');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/line 3, column \d+/);
  });

  it('reuses schema error paths', () => {
    const bad = structuredClone(charme) as { walls: { thickness: number }[] };
    bad.walls[2]!.thickness = -1;
    const r = loadSceneText(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('walls[2].thickness:'))).toBe(true);
  });

  it('rejects empty input and wrong versions', () => {
    expect(loadSceneText('  ').ok).toBe(false);
    const r = loadSceneText(JSON.stringify({ ...sample, version: 2 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('version');
  });

  it('rejects text over 5 MB', () => {
    const r = loadSceneText(' '.repeat(MAX_SCENE_BYTES + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/larger than 5 MB/);
  });

  it('counts bytes, not characters, for the size limit', () => {
    const r = loadSceneText('é'.repeat(MAX_SCENE_BYTES / 2 + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/larger than/);
  });
});
