import type { ProviderInfo } from '@flat/scene';

export const SERVER_HINT = 'Connect the local scene server (`pnpm dev:all`) to search real products.';
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_DEBOUNCE_MS = 300;

/** Products need the scene server: without it (Pages, Local mode) the tab only shows a hint and makes no request. */
export function productsAvailability(s: { mode: 'local' | 'server'; status: string; serverUrl: string | null }): 'server' | 'no-server' {
  return s.mode === 'server' && s.serverUrl ? 'server' : 'no-server';
}

/** The banner shown whenever an enabled provider is personal-use only (retailer data and models). Null when none is. */
export function personalUseBanner(providers: readonly Pick<ProviderInfo, 'enabled' | 'personalUseOnly'>[]): string | null {
  return providers.some((p) => p.enabled && p.personalUseOnly)
    ? 'Personal use only: product data, photos and models come from retailers and may only be used privately on this machine. Do not share or publish them.'
    : null;
}

export type CircuitLabel = 'ok' | 'checking' | 'paused' | 'off';

/** State word and tooltip of a provider chip. */
export function providerView(p: ProviderInfo, now: number = Date.now()): { state: CircuitLabel; tooltip: string } {
  const state: CircuitLabel = !p.enabled ? 'off' : p.circuit === 'open' ? 'paused' : p.circuit === 'half_open' ? 'checking' : 'ok';
  const parts = [p.label];
  if (!p.enabled) parts.push('Not enabled on this server (FLAT_PROVIDERS).');
  else if (p.circuit === 'open') {
    const secs = p.retryAt !== undefined ? Math.max(1, Math.ceil((p.retryAt - now) / 1000)) : undefined;
    parts.push(`Paused after repeated errors${secs !== undefined ? `; retries in ${secs >= 90 ? `${Math.round(secs / 60)} min` : `${secs} s`}` : ''}.`);
  } else if (p.circuit === 'half_open') parts.push('Testing the connection again.');
  else parts.push('Working.');
  if (p.capabilities.model3d) parts.push('Can supply real 3D models.');
  parts.push(p.capabilities.dims === 'structured' ? 'Dimensions are read from structured fields.' : p.capabilities.dims === 'text' ? 'Dimensions are parsed from text (check them).' : 'No dimensions: type them.');
  if (p.personalUseOnly) parts.push('Personal use only.');
  if (p.note) parts.push(p.note);
  return { state, tooltip: parts.join(' ') };
}
