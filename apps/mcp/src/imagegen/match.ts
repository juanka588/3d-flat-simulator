/**
 * Client of the sidecar's similarity index (CG3): `POST /index/query`. Same host, token and error rules as the provider
 * (`IMAGEGEN_URL`, `IMAGEGEN_TOKEN`). Photos never travel here: only our own crops (render / reference image paths or job
 * images) go to the sidecar, which runs on this machine or one the user owns.
 */

export const MATCH_SOURCES = ['catalog', 'hd', 'all'] as const;

export interface MatchRequest {
  /** A file the sidecar can read (path under its input roots), or a finished sidecar job image. */
  image?: { path: string } | { jobId: string; index: number };
  /** Pixels of the image: [x0, y0, x1, y1]. */
  box?: [number, number, number, number];
  /** Instance-id image of the same frame (CG1 render pass) and the colour of the object in it: background outside it is whitened. */
  mask?: { path: string; color?: [number, number, number] };
  /** Whiten pixels close to the crop border colour (no mask available). */
  cutout?: boolean;
  text?: string;
  topK: number;
  category?: string | undefined;
  maxPrice?: number | undefined;
  source?: (typeof MATCH_SOURCES)[number];
}

export interface MatchHit {
  /** `ikea-fr:<sku>` for a product, the library id for an asset. */
  id: string;
  kind: 'product' | 'asset';
  score: number;
  name: string;
  category?: string;
  price?: number;
  currency?: string;
  dims?: { w: number; d: number; h: number };
  has3d: boolean;
}

export interface MatchResponse {
  model: string;
  results: MatchHit[];
  /** Sources that have no index yet. */
  missing?: string[];
  prep: string[];
}

export class ImageMatchError extends Error {
  constructor(
    readonly code: 'unavailable' | 'invalid_request' | 'index_missing' | 'model_missing' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'ImageMatchError';
  }
}

export interface ImageMatcher {
  query(req: MatchRequest): Promise<MatchResponse>;
}

export class SidecarMatcher implements ImageMatcher {
  private readonly url: string;
  constructor(
    url: string,
    private readonly token?: string,
    private readonly f: typeof fetch = fetch,
    private readonly timeoutMs = 120_000,
  ) {
    this.url = url.replace(/\/+$/, '');
  }

  async query(r: MatchRequest): Promise<MatchResponse> {
    const body = {
      ...(r.image ? { image: 'path' in r.image ? r.image.path : r.image } : {}),
      ...(r.box ? { box: r.box } : {}),
      ...(r.mask ? { mask: r.mask.path, ...(r.mask.color ? { maskColor: r.mask.color } : {}) } : {}),
      ...(r.cutout ? { background: 'border' } : {}),
      ...(r.text ? { text: r.text } : {}),
      topK: r.topK,
      source: r.source ?? 'all',
      ...(r.category || r.maxPrice !== undefined ? { filters: { ...(r.category ? { category: r.category } : {}), ...(r.maxPrice !== undefined ? { maxPrice: r.maxPrice } : {}) } } : {}),
    };
    let res: Response;
    try {
      res = await this.f(`${this.url}/index/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ImageMatchError('unavailable', `image service at ${this.url} is not reachable (${e instanceof Error ? e.name : 'error'})`);
    }
    let j: Record<string, unknown> = {};
    try {
      j = (await res.json()) as Record<string, unknown>;
    } catch {
      // not JSON
    }
    if (res.ok) return j as unknown as MatchResponse;
    const msg = typeof j.message === 'string' ? j.message : `image service answered ${res.status}`;
    switch (j.code) {
      case 'index_missing':
        throw new ImageMatchError('index_missing', msg);
      case 'model_missing':
        throw new ImageMatchError('model_missing', msg);
      case 'invalid_request':
        throw new ImageMatchError('invalid_request', msg);
      case 'not_implemented':
        throw new ImageMatchError('unavailable', msg);
      default:
        throw new ImageMatchError('failed', msg);
    }
  }
}

/** Deterministic matcher for tests: returns `hits` and records every request. */
export class FakeImageMatcher implements ImageMatcher {
  readonly requests: MatchRequest[] = [];
  constructor(public hits: MatchHit[] = [], public fail?: ImageMatchError) {}
  async query(req: MatchRequest): Promise<MatchResponse> {
    this.requests.push(req);
    if (this.fail) throw this.fail;
    return { model: 'fake/colour', results: this.hits.slice(0, req.topK), prep: ['plain'] };
  }
}
