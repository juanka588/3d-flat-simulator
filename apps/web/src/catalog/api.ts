import { GetProductResponse, ProductRecord, ProductSearchResponse, ProvidersResponse } from '@flat/scene';
import type { ProviderInfo } from '@flat/scene';
import { serverToken } from '../sync/client';
import { useSyncStore } from '../sync/sync-store';

/** Where the product routes are: the connected scene server. Null in Local / Pages mode (no product request is ever made). */
export interface ServerRef {
  origin: string;
  token: string | null;
}

export function serverRef(): ServerRef | null {
  const s = useSyncStore.getState();
  return s.mode === 'server' && s.serverUrl ? { origin: s.serverUrl, token: serverToken() } : null;
}

/** A failed product call, with the server's code and hint (`product_dims_missing` carries the draft in `details`). */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: Record<string, unknown>,
    readonly status = 0,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

async function call(ref: ServerRef, method: 'GET' | 'POST', path: string, body?: unknown, fetchImpl: Fetch = (...a) => fetch(...a)): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (ref.token) headers.authorization = `Bearer ${ref.token}`;
  let res: Response;
  try {
    res = await fetchImpl(ref.origin + path, { method, headers, cache: 'no-store', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch {
    throw new ApiError('unreachable', 'The scene server could not be reached.', 'Check that `pnpm dev:all` is still running.');
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // not JSON
  }
  if (!res.ok) {
    const e = (json as { errors?: { code?: string; message?: string; hint?: string; details?: Record<string, unknown> }[] } | null)?.errors?.[0];
    throw new ApiError(e?.code ?? 'http_error', e?.message ?? `HTTP ${res.status}`, e?.hint, e?.details, res.status);
  }
  return json;
}

export async function fetchProviders(ref: ServerRef, f?: Fetch): Promise<ProviderInfo[]> {
  return ProvidersResponse.parse(await call(ref, 'GET', '/api/providers', undefined, f)).providers;
}

export interface SearchQuery {
  q: string;
  provider?: string;
  limit?: number;
}

export async function searchProducts(ref: ServerRef, query: SearchQuery, f?: Fetch): Promise<ProductSearchResponse> {
  const p = new URLSearchParams({ q: query.q, limit: String(query.limit ?? 12) });
  if (query.provider) p.set('provider', query.provider);
  return ProductSearchResponse.parse(await call(ref, 'GET', `/api/products/search?${p}`, undefined, f));
}

export async function getProduct(ref: ServerRef, productId: string, f?: Fetch): Promise<ProductRecord> {
  return GetProductResponse.parse(await call(ref, 'GET', `/api/products/${encodeURIComponent(productId)}`, undefined, f)).product;
}

export async function resolveUrl(ref: ServerRef, url: string, f?: Fetch): Promise<ProductRecord> {
  return GetProductResponse.parse(await call(ref, 'POST', '/api/products/resolve', { url }, f)).product;
}

/** `product_dims_missing`: the draft record the user completes with a width, depth and height (`dimsSource: 'user'`). */
export function draftFromDimsError(e: ApiError): Record<string, unknown> | null {
  const d = e.details?.['draft'];
  return e.code === 'product_dims_missing' && d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
}

/** Completes a draft with the dimensions the user typed (centimetres), as a full record. Throws a `ZodError` when the result is not a valid product. */
export function recordWithUserDims(draft: Record<string, unknown>, cm: { w: number; d: number; h: number }, now: Date = new Date()): ProductRecord {
  const mount = draft['mount'] === 'wall' ? 'wall' : 'floor';
  return ProductRecord.parse({
    mount,
    styleTags: [],
    colours: [],
    variants: [],
    fetchedAt: now.toISOString(),
    personalUseOnly: true,
    ...draft,
    dims: { w: cm.w / 100, d: cm.d / 100, h: cm.h / 100 },
    dimsSource: 'user',
  });
}

/** Thumbnail URL of a result: the product photo, shown only in server mode (a Pages visitor never sees or requests one). */
export function thumbnailUrl(photoUrl: string | undefined, ref: ServerRef | null): string | undefined {
  return ref && photoUrl ? photoUrl : undefined;
}
