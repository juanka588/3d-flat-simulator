/* global console, process, fetch */
// Re-checks that both texture sources still publish a CC0 licence policy (the strict needle used by
// `pnpm materials:build`). Run on main and weekly in CI: the committed library only stays CC0 if the sources do.
import { LICENCE_POLICIES, assertPolicyPage } from '../materials/lib.mjs';

let failed = false;
for (const [source, policy] of Object.entries(LICENCE_POLICIES)) {
  try {
    const res = await fetch(policy.url, { headers: { 'User-Agent': '3d-flat-simulator/0.1 (licence check)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    assertPolicyPage(source, await res.text());
    console.log(`${source}: ${policy.url} links ${policy.needle}`);
  } catch (err) {
    console.error(`${source}: ${err.message}`);
    failed = true;
  }
}
if (failed) process.exit(1);
