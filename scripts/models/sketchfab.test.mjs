import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectUnitScale } from './build-hd.mjs';
import { loadToken, redact, sketchfabLicence } from './sketchfab.mjs';

describe('Sketchfab licence gate', () => {
  it('accepts cc0 and by only', () => {
    expect(sketchfabLicence({ license: { slug: 'cc0' } }, 'm')).toBe('CC0-1.0');
    expect(sketchfabLicence({ license: { slug: 'by' } }, 'm')).toBe('CC-BY-4.0');
    for (const bad of ['by-nc', 'by-nd', 'by-sa', 'by-nc-nd', 'st', 'ed', undefined]) expect(() => sketchfabLicence({ license: { slug: bad } }, 'm')).toThrow(/rejected/);
    expect(() => sketchfabLicence({}, 'm')).toThrow();
  });
});

describe('token handling', () => {
  it('reads SKETCHFAB_TOKEN from the environment first, then from the env file, and tolerates quotes', () => {
    expect(loadToken({ SKETCHFAB_TOKEN: ' abc123 ' }, '/nonexistent')).toBe('abc123');
    const dir = mkdtempSync(join(tmpdir(), 'sk-'));
    const file = join(dir, '.env.local');
    writeFileSync(file, '# comment\nOTHER=1\nSKETCHFAB_TOKEN="deadbeefdeadbeef"\n');
    expect(loadToken({}, file)).toBe('deadbeefdeadbeef');
    expect(loadToken({}, join(dir, 'missing'))).toBeUndefined();
  });
  it('redacts the token and Authorization headers from messages', () => {
    const t = '0123456789abcdef0123456789abcdef';
    expect(redact(`GET failed with Token ${t} in ${t}`, t)).not.toContain(t);
    expect(redact('header Token fedcba9876543210fedcba9876543210', undefined)).toBe('header Token [redacted]');
  });
});

describe('unit scale detection', () => {
  it('picks the unit that lands in the expected range, in the order m, cm, mm, inch', () => {
    expect(detectUnitScale(2.1, [1.6, 3])).toBe(1);
    expect(detectUnitScale(210, [1.6, 3])).toBe(0.01);
    expect(detectUnitScale(2100, [1.6, 3])).toBe(0.001);
    expect(detectUnitScale(80, [1.6, 3])).toBe(0.0254);
  });
  it('honours an explicit scale or a fitted size, and fails loudly when nothing fits', () => {
    expect(detectUnitScale(210, [1.6, 3], 0.005)).toBe(0.005);
    expect(detectUnitScale(0.5, [1.6, 3], undefined, 2)).toBe(4);
    expect(() => detectUnitScale(0.5, [1.6, 3])).toThrow(/no common unit/);
  });
});
