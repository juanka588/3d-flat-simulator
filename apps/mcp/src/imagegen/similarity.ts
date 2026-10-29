/**
 * Client of the sidecar's whole-image scoring routes (CG5): `POST /embed` (CLIP image embeddings, for the cosine similarity of
 * our render and the reference) and `POST /aesthetic` (LAION linear predictor on the OpenAI ViT-B/32 embedding). Same host, token
 * and error rules as the provider and the matcher. Only our own renders and our own reference images are sent.
 */

export class SimilarityError extends Error {
  constructor(
    readonly code: 'unavailable' | 'invalid_request' | 'model_missing' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'SimilarityError';
  }
}

export interface EmbedResponse {
  model: string;
  vectors: number[][];
}
export interface AestheticResponse {
  model: string;
  licence: string;
  scores: number[];
}

export interface ImageScorer {
  /** L2-normalised CLIP embeddings of base64 PNG images. */
  embed(imagesB64: string[]): Promise<EmbedResponse>;
  /** Aesthetic predictor scores (about 1 to 10) of base64 PNG images. */
  aesthetic(imagesB64: string[]): Promise<AestheticResponse>;
}

export const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

export class SidecarScorer implements ImageScorer {
  private readonly url: string;
  constructor(
    url: string,
    private readonly token?: string,
    private readonly f: typeof fetch = fetch,
    private readonly timeoutMs = 120_000,
  ) {
    this.url = url.replace(/\/+$/, '');
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.f(`${this.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new SimilarityError('unavailable', `image service at ${this.url} is not reachable (${e instanceof Error ? e.name : 'error'})`);
    }
    let j: Record<string, unknown> = {};
    try {
      j = (await res.json()) as Record<string, unknown>;
    } catch {
      // not JSON
    }
    if (res.ok) return j;
    const msg = typeof j['message'] === 'string' ? j['message'] : `image service answered ${res.status}`;
    switch (j['code']) {
      case 'model_missing':
        throw new SimilarityError('model_missing', msg);
      case 'invalid_request':
        throw new SimilarityError('invalid_request', msg);
      case 'not_implemented':
      case 'not_found':
        throw new SimilarityError('unavailable', msg);
      default:
        throw new SimilarityError('failed', msg);
    }
  }

  async embed(imagesB64: string[]): Promise<EmbedResponse> {
    const j = await this.post('/embed', { images: imagesB64 });
    return { model: String(j['model'] ?? ''), vectors: (j['images'] as number[][]) ?? [] };
  }

  async aesthetic(imagesB64: string[]): Promise<AestheticResponse> {
    const j = await this.post('/aesthetic', { images: imagesB64 });
    return { model: String(j['model'] ?? ''), licence: String(j['licence'] ?? ''), scores: (j['scores'] as number[]) ?? [] };
  }
}

/** Deterministic scorer for tests: every image embeds to its `vectors[i]` (default: the same unit vector), aesthetic from `scores`. */
export class FakeImageScorer implements ImageScorer {
  readonly embedded: string[][] = [];
  constructor(
    public vectors: number[][] = [],
    public scores: number[] = [],
    public fail?: { embed?: SimilarityError; aesthetic?: SimilarityError },
  ) {}
  async embed(images: string[]): Promise<EmbedResponse> {
    this.embedded.push(images);
    if (this.fail?.embed) throw this.fail.embed;
    return { model: 'fake/clip', vectors: images.map((_, i) => this.vectors[i] ?? [1, 0, 0]) };
  }
  async aesthetic(images: string[]): Promise<AestheticResponse> {
    if (this.fail?.aesthetic) throw this.fail.aesthetic;
    return { model: 'fake/aesthetic', licence: 'MIT (fake)', scores: images.map((_, i) => this.scores[i] ?? 5) };
  }
}
