import { describe, expect, it } from 'vitest';
import {
  CC0_DEED_NEEDLE,
  assertAssetLicence,
  assertPolicyPage,
  assetLicenceField,
  checkPins,
  licenceEvidence,
  stableTimestamp,
} from './lib.mjs';

describe('licence assertion', () => {
  it('needs the CC0 deed URL, not just the word CC0', () => {
    expect(() => assertPolicyPage('polyhaven', `<a href="https://${CC0_DEED_NEEDLE}/1.0/">CC0</a>`)).not.toThrow();
    expect(() => assertPolicyPage('ambientcg', '<p>CC0 1.0 Universal</p>')).toThrow(/no longer links/);
    expect(() => assertPolicyPage('polyhaven', 'All assets are CC0')).toThrow();
    expect(() => assertPolicyPage('unknown', 'x')).toThrow(/no licence policy/);
  });

  it('uses a per-asset licence field when the API has one, and rejects non-CC0', () => {
    expect(assetLicenceField({ assetId: 'x', license: 'CC0-1.0' })).toBe('CC0-1.0');
    expect(assetLicenceField({ licenseType: ' CC-BY-4.0 ' })).toBe('CC-BY-4.0');
    expect(assetLicenceField({ assetId: 'x', displayName: 'y' })).toBeUndefined();
    expect(() => assertAssetLicence('s', undefined)).not.toThrow();
    expect(() => assertAssetLicence('s', 'CC0 1.0 Universal')).not.toThrow();
    expect(() => assertAssetLicence('s', `https://${CC0_DEED_NEEDLE}/1.0/`)).not.toThrow();
    expect(() => assertAssetLicence('s', 'CC-BY-4.0')).toThrow(/not CC0/);
  });

  it('records what was checked', () => {
    const site = licenceEvidence({ source: 'polyhaven', assetApiUrl: 'https://api.polyhaven.com/info/x', checkedAt: '2026-10-26T00:00:00.000Z' });
    expect(site).toMatchObject({ basis: 'site-policy', policyUrl: 'https://polyhaven.com/license', needle: CC0_DEED_NEEDLE });
    expect(site).not.toHaveProperty('assetField');
    expect(licenceEvidence({ source: 'ambientcg', assetApiUrl: 'u', assetField: 'CC0-1.0', checkedAt: 't' })).toMatchObject({ basis: 'asset-field', assetField: 'CC0-1.0' });
  });
});

describe('reproducibility', () => {
  const entry = { source: 'polyhaven', sourceId: 'a', sha256: { color: '1', thumb: '2' } };
  it('keeps retrievedAt while the output hashes (in any key order) and source are unchanged', () => {
    const prev = { ...entry, sha256: { thumb: '2', color: '1' }, retrievedAt: '2026-01-01T00:00:00.000Z' };
    expect(stableTimestamp(prev, entry, 'NOW')).toBe('2026-01-01T00:00:00.000Z');
  });
  it('takes the new time when a hash, the source id or the entry itself changed', () => {
    const prev = { ...entry, retrievedAt: 'OLD' };
    expect(stableTimestamp({ ...prev, sha256: { color: '9', thumb: '2' } }, entry, 'NOW')).toBe('NOW');
    expect(stableTimestamp({ ...prev, sourceId: 'b' }, entry, 'NOW')).toBe('NOW');
    expect(stableTimestamp(undefined, entry, 'NOW')).toBe('NOW');
  });

  it('fills missing pins, accepts matching ones, rejects a changed download unless updating', () => {
    expect(checkPins('s', undefined, { zip: 'aa' })).toEqual({ pins: { zip: 'aa' }, changed: true });
    expect(checkPins('s', { zip: 'aa' }, { zip: 'aa' })).toEqual({ pins: { zip: 'aa' }, changed: false });
    expect(() => checkPins('s', { zip: 'aa' }, { zip: 'bb' })).toThrow(/--update-pins/);
    expect(checkPins('s', { zip: 'aa' }, { zip: 'bb' }, { update: true })).toEqual({ pins: { zip: 'bb' }, changed: true });
  });
});
