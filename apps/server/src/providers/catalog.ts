import type { ProviderCapabilities } from '@flat/assets';

/**
 * Static facts about the providers this server knows. Kept free of provider code, so `GET /api/providers`
 * can list a disabled provider (and explain it) without loading its module: a disabled provider's code is
 * never imported (D3). A test checks that each entry matches what the loaded provider declares.
 */
export interface ProviderMeta {
  id: string;
  label: string;
  capabilities: ProviderCapabilities;
  personalUseOnly: boolean;
  note?: string;
}

export const MOCK_META: ProviderMeta = {
  id: 'mock',
  label: 'Mock catalog (offline fixtures)',
  capabilities: { search: true, model3d: false, dims: 'structured', resolveUrl: true },
  personalUseOnly: false,
  note: 'Fictional products for tests and demos.',
};

export const IKEA_FR_META: ProviderMeta = {
  id: 'ikea-fr',
  label: 'IKEA France',
  capabilities: { search: true, model3d: true, dims: 'structured', resolveUrl: false },
  personalUseOnly: true,
  note: 'Personal use only: IKEA data and 3D models are shown privately on this machine, never shared or committed. Unofficial endpoints, may break.',
};

/**
 * The local tier: the catalogue built by `pnpm catalog:build` (not a provider module, nothing to load). It serves search, get,
 * model and photo for `ikea-fr:<sku>` products from disk; listed by `GET /api/providers` only when a catalogue is loaded.
 */
export const IKEA_FR_LOCAL_META: ProviderMeta = {
  id: 'ikea-fr-local',
  label: 'IKEA local catalogue',
  capabilities: { search: true, model3d: true, dims: 'structured', resolveUrl: false },
  personalUseOnly: true,
  note: 'Personal use only: a catalogue you built on this machine from IKEA FR pages (instant, offline, checked 3D models). Never shared or committed.',
};

export const PASTED_URL_META: ProviderMeta = {
  id: 'pasted-url',
  label: 'Pasted product URL',
  capabilities: { search: false, model3d: true, dims: 'structured', resolveUrl: true },
  personalUseOnly: true,
  note: 'Reads one product page you paste (schema.org data). Sites with bot protection cannot be read; enter the details by hand.',
};

export const PROVIDER_CATALOG: Readonly<Record<string, ProviderMeta>> = {
  mock: MOCK_META,
  'ikea-fr': IKEA_FR_META,
  'pasted-url': PASTED_URL_META,
};
