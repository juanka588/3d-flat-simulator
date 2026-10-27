// Pure helpers of the material pipeline (no network, no disk), unit-tested in lib.test.mjs.

/**
 * Licence policy per source. Neither API exposes a per-asset licence field (checked 2026-10: ambientCG
 * `full_json` and Poly Haven `/info` have none), so the evidence is (a) the API knows the asset and (b) the
 * site's licence page links the CC0 1.0 deed. The needle is the deed URL, not the bare word "CC0".
 */
export const CC0_DEED_NEEDLE = 'creativecommons.org/publicdomain/zero';
export const LICENCE_POLICIES = {
  ambientcg: { url: 'https://docs.ambientcg.com/license/', needle: CC0_DEED_NEEDLE },
  polyhaven: { url: 'https://polyhaven.com/license', needle: CC0_DEED_NEEDLE },
};

/** Throws unless the licence page text contains the strict CC0 deed needle. */
export function assertPolicyPage(source, html) {
  const policy = LICENCE_POLICIES[source];
  if (!policy) throw new Error(`no licence policy for source "${source}"`);
  if (typeof html !== 'string' || !html.includes(policy.needle)) {
    throw new Error(`Licence page ${policy.url} no longer links "${policy.needle}"; refusing to build.`);
  }
  return policy;
}

/** The value of a per-asset licence field of an API record (`license`, `licence`, `licenseType`...), when it has one. */
export function assetLicenceField(asset) {
  if (!asset || typeof asset !== 'object') return undefined;
  for (const [key, value] of Object.entries(asset)) {
    if (/^licen[cs]e/i.test(key) && typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** A per-asset licence value must be CC0 (its deed URL or an id such as "CC0", "CC0-1.0", "CC0 1.0 Universal"). */
export function assertAssetLicence(slug, value) {
  if (value === undefined) return;
  if (!(value.includes(CC0_DEED_NEEDLE) || /^cc0\b/i.test(value))) {
    throw new Error(`${slug}: the API reports licence "${value}", not CC0; refusing to build.`);
  }
}

/** What was checked for one catalog entry (`licenseEvidence`). */
export function licenceEvidence({ source, assetApiUrl, assetField, checkedAt }) {
  const policy = LICENCE_POLICIES[source];
  return {
    basis: assetField === undefined ? 'site-policy' : 'asset-field',
    policyUrl: policy.url,
    needle: policy.needle,
    assetApiUrl,
    ...(assetField === undefined ? {} : { assetField }),
    checkedAt,
  };
}

/**
 * `retrievedAt` stays what it was when the entry's output is byte-identical (same source id, same file
 * hashes), so a rebuild that changes nothing leaves catalog.json (and the credits) untouched.
 */
export function stableTimestamp(previous, entry, now) {
  if (
    previous &&
    previous.source === entry.source &&
    previous.sourceId === entry.sourceId &&
    previous.sha256 &&
    JSON.stringify(sortKeys(previous.sha256)) === JSON.stringify(sortKeys(entry.sha256)) &&
    typeof previous.retrievedAt === 'string'
  ) {
    return previous.retrievedAt;
  }
  return now;
}

function sortKeys(o) {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Compares the hashes of what was downloaded with the manifest's `sourceSha256` pins.
 * Returns `{ pins, changed }`: `pins` is what the manifest should hold. A missing pin is filled in; a pin that
 * differs throws (upstream changed the file) unless `update` is set (`--update-pins`).
 */
export function checkPins(slug, pinned, actual, { update = false } = {}) {
  const pins = { ...(pinned ?? {}) };
  let changed = false;
  for (const [name, hash] of Object.entries(actual)) {
    if (pins[name] === undefined) {
      pins[name] = hash;
      changed = true;
    } else if (pins[name] !== hash) {
      if (!update) {
        throw new Error(`${slug}: ${name} download hash ${hash} differs from the pinned ${pins[name]}. The upstream file changed; review it, then re-run with --update-pins.`);
      }
      pins[name] = hash;
      changed = true;
    }
  }
  return { pins: sortKeys(pins), changed };
}
