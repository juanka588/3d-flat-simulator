import { describe, expect, it } from 'vitest';
import { Material } from '../schema';
import { ALBEDO_RANGE, ALL_SWATCHES, PALETTE, clampAlbedo, normalizeHex, paintMaterial, relativeLuminance } from './paint';

describe('paintMaterial', () => {
  it('normalises hex input to one id', () => {
    const ids = ['#abc', 'ABC', '#aabbcc', 'AABBCC', ' #AaBbCc '].map((h) => paintMaterial(h, 'matt').id);
    expect(new Set(ids)).toEqual(new Set(['paint-aabbcc-matt']));
  });

  it('maps sheen to roughness and id suffix', () => {
    expect(paintMaterial('#102030', 'matt')).toMatchObject({ id: 'paint-102030-matt', roughness: 0.95, kind: 'paint', color: '#102030' });
    expect(paintMaterial('#102030', 'satin')).toMatchObject({ id: 'paint-102030-satin', roughness: 0.6 });
    expect(paintMaterial('#102030', 'gloss')).toMatchObject({ id: 'paint-102030-gloss', roughness: 0.3 });
  });

  it('produces schema-valid materials', () => {
    expect(Material.safeParse(paintMaterial('#f00', 'gloss')).success).toBe(true);
  });

  it.each(['', '#', '#12', '#12345', '#1234567', 'ggg', '#xyz123', 'rgb(1,2,3)'])('rejects %j', (bad) => {
    expect(() => paintMaterial(bad, 'matt')).toThrow(/Invalid hex colour/);
    expect(() => normalizeHex(bad)).toThrow();
  });

  it('rejects an unknown sheen', () => {
    expect(() => paintMaterial('#fff', 'shiny' as never)).toThrow(/sheen/);
  });
});

describe('PALETTE', () => {
  it('has about two dozen valid, unique, named swatches in four groups', () => {
    expect(PALETTE).toHaveLength(4);
    expect(ALL_SWATCHES.length).toBeGreaterThanOrEqual(22);
    expect(ALL_SWATCHES.length).toBeLessThanOrEqual(26);
    const hexes = ALL_SWATCHES.map((s) => s.hex);
    for (const s of ALL_SWATCHES) {
      expect(s.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(normalizeHex(s.hex)).toBe(s.hex);
    }
    expect(new Set(hexes).size).toBe(hexes.length);
    expect(new Set(ALL_SWATCHES.map((s) => s.name)).size).toBe(ALL_SWATCHES.length);
  });

  it('keeps every swatch within the albedo range', () => {
    for (const s of ALL_SWATCHES) {
      const l = relativeLuminance(s.hex);
      expect(l, s.name).toBeGreaterThanOrEqual(ALBEDO_RANGE.min);
      expect(l, s.name).toBeLessThanOrEqual(ALBEDO_RANGE.max);
      expect(clampAlbedo(s.hex)).toBe(s.hex);
    }
  });
});

describe('clampAlbedo', () => {
  it('lifts black and pulls white into range, keeping valid hex', () => {
    const black = clampAlbedo('#000');
    const white = clampAlbedo('#ffffff');
    expect(black).toMatch(/^#[0-9a-f]{6}$/);
    expect(relativeLuminance(black)).toBeGreaterThanOrEqual(ALBEDO_RANGE.min - 0.002);
    expect(relativeLuminance(white)).toBeLessThanOrEqual(ALBEDO_RANGE.max + 0.002);
    expect(relativeLuminance(white)).toBeGreaterThan(0.9);
  });

  it('is idempotent', () => {
    for (const h of ['#000000', '#ffffff', '#ff0000', '#0000ff', '#123456']) {
      expect(clampAlbedo(clampAlbedo(h))).toBe(clampAlbedo(h));
    }
  });
});
