import { describe, expect, it } from 'vitest';
import { CC0_DEED_NEEDLE, assertApiDims, assertCc0Text, assertPlausibleSize, budgetProblems, checkPins, cleanTags, creditLine, objaverseLicence, stableTimestamp } from './lib.mjs';

describe('licence assertions', () => {
  it('needs the CC0 deed URL, not just the word CC0', () => {
    expect(() => assertCc0Text('p', `<a href="https://${CC0_DEED_NEEDLE}/1.0/">CC0</a>`)).not.toThrow();
    expect(() => assertCc0Text('p', 'License: CC0')).toThrow(/refusing/);
    expect(() => assertCc0Text('p', undefined)).toThrow();
  });
  it('accepts objaverse cc0 and by, rejects nc / sa / nd / unknown', () => {
    expect(objaverseLicence('cc0')).toBe('CC0-1.0');
    expect(objaverseLicence('BY')).toBe('CC-BY-4.0');
    for (const bad of ['by-nc', 'by-sa', 'by-nd', 'by-nc-sa', 'by-nc-nd', 'st', 'weird', undefined]) expect(() => objaverseLicence(bad, 'x')).toThrow(/rejected/);
  });
  it('writes a credit line with author and source', () => {
    expect(creditLine({ name: 'Sofa', author: 'A. Artist', source: 'polyhaven', sourceUrl: 'https://polyhaven.com/a/s', licence: 'CC0-1.0' })).toBe('"Sofa" by A. Artist, Poly Haven, CC0-1.0 (https://polyhaven.com/a/s)');
  });
});

describe('pins and timestamps', () => {
  it('fills missing pins, throws on change unless updating', () => {
    expect(checkPins('s', undefined, { a: '1' })).toEqual({ pins: { a: '1' }, changed: true });
    expect(checkPins('s', { a: '1' }, { a: '1' }).changed).toBe(false);
    expect(() => checkPins('s', { a: '1' }, { a: '2' })).toThrow(/--update-pins/);
    expect(checkPins('s', { a: '1' }, { a: '2' }, { update: true }).pins).toEqual({ a: '2' });
  });
  it('keeps retrievedAt for identical output', () => {
    const prev = { source: 'polyhaven', sha256: 'x', retrievedAt: 'then' };
    expect(stableTimestamp(prev, { source: 'polyhaven', sha256: 'x' }, 'now')).toBe('then');
    expect(stableTimestamp(prev, { source: 'polyhaven', sha256: 'y' }, 'now')).toBe('now');
  });
});

describe('size and budget checks', () => {
  it('flags wrong units', () => {
    expect(() => assertPlausibleSize('s', { w: 1, d: 1, h: 1 }, [0.5, 2])).not.toThrow();
    expect(() => assertPlausibleSize('s', { w: 100, d: 1, h: 1 }, [0.5, 2])).toThrow(/unit/);
    expect(() => assertApiDims('s', { w: 1.8, d: 0.8, h: 0.7 }, [800, 700, 1800])).not.toThrow();
    expect(() => assertApiDims('s', { w: 180, d: 80, h: 70 }, [800, 700, 1800])).toThrow(/API/);
  });
  it('reports over-budget models', () => {
    const b = { modelBytes: 100, triangles: 10, materials: 2 };
    expect(budgetProblems({ id: 'a', bytes: 100, triangles: 10, materials: 2 }, b)).toEqual([]);
    expect(budgetProblems({ id: 'a', bytes: 101, triangles: 11, materials: 3 }, b)).toHaveLength(3);
  });
  it('cleans tags', () => {
    expect(cleanTags(['Wood', 'wood', 'Living Room!', ''])).toEqual(['wood', 'living room']);
  });
});
