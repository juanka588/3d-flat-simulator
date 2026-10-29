import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ImageProviderError,
  type EditRequest,
  type GenerateRequest,
  type GeneratedImage,
  type ImageProvider,
  type JobState,
  type JobStatus,
  type ProviderHealth,
  type WaitOptions,
} from './types';

/**
 * Client of the image sidecar (`tools/imagegen`): `POST /generate`, `POST /edit`, `GET /jobs/:id`, `GET /health`. The same
 * API is served by the native mflux backend (Mac) and the Docker diffusers backend (NVIDIA), local or on another machine
 * (`IMAGEGEN_URL`). Inputs always travel as base64 (a remote sidecar cannot read our paths); results are downloaded to
 * `outDir` unless the reported path already exists here (same machine).
 *
 * Errors carry no token. `fetch` and `sleep` are injectable for tests.
 */

export interface LocalSidecarOptions {
  url?: string;
  token?: string | undefined;
  /** Where results from a remote sidecar are saved. */
  outDir?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds between polls while waiting. */
  pollIntervalMs?: number;
  /** Timeout of one HTTP request. Default 30 s. */
  requestTimeoutMs?: number;
  /** Longest side of the preview handed to the model. Default 768. */
  previewMaxSide?: number;
}

export const DEFAULT_SIDECAR_URL = 'http://127.0.0.1:8790';

interface RemoteJob {
  jobId: string;
  status: JobState;
  progress: number;
  images: { path: string; seed: number; seconds: number; peakGb?: number | null }[];
  error?: string;
  queuePosition?: number;
}

const TERMINAL = new Set<JobState>(['done', 'error', 'cancelled']);

export class LocalSidecarProvider implements ImageProvider {
  readonly id = 'local';
  private readonly url: string;
  private readonly token: string | undefined;
  private readonly outDir: string;
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly previewMax: number;
  private readonly materialised = new Map<string, GeneratedImage[]>();

  constructor(o: LocalSidecarOptions = {}) {
    this.url = (o.url?.trim() || DEFAULT_SIDECAR_URL).replace(/\/+$/, '');
    this.token = o.token || undefined;
    this.outDir = o.outDir ?? join(process.cwd(), '.tmp', 'imagegen', 'out');
    this.f = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollMs = o.pollIntervalMs ?? 1500;
    this.timeoutMs = o.requestTimeoutMs ?? 30_000;
    this.previewMax = o.previewMaxSide ?? 768;
  }

  async generate(req: GenerateRequest, opts: WaitOptions = {}): Promise<JobStatus> {
    const body = {
      prompt: req.prompt,
      ...(req.negativePrompt ? { negativePrompt: req.negativePrompt } : {}),
      seed: req.seed,
      n: req.n,
      width: req.width,
      height: req.height,
      model: req.model ?? 'qwen-cn',
      controls: req.controls.map((c) => ({ type: c.type, image: c.image.data, strength: c.strength })),
      ...(req.steps !== undefined ? { steps: req.steps } : {}),
    };
    const { jobId } = await this.json<{ jobId: string }>('POST', '/generate', body);
    return this.poll(jobId, opts);
  }

  async edit(req: EditRequest, opts: WaitOptions = {}): Promise<JobStatus> {
    const body = {
      image: req.image.data,
      prompt: req.prompt,
      seed: req.seed,
      strength: req.strength,
      model: req.model ?? 'klein-edit',
      ...(req.width && req.height ? { width: req.width, height: req.height } : {}),
    };
    const { jobId } = await this.json<{ jobId: string }>('POST', '/edit', body);
    return this.poll(jobId, opts);
  }

  async poll(jobId: string, opts: WaitOptions = {}): Promise<JobStatus> {
    const deadline = Date.now() + (opts.waitMs ?? 0);
    for (;;) {
      const j = await this.json<RemoteJob>('GET', `/jobs/${encodeURIComponent(jobId)}`, undefined, opts.signal);
      if (TERMINAL.has(j.status) || Date.now() >= deadline) return this.status(j);
      await this.sleep(Math.min(this.pollMs, Math.max(0, deadline - Date.now())));
    }
  }

  async cancel(jobId: string): Promise<void> {
    await this.json('DELETE', `/jobs/${encodeURIComponent(jobId)}`);
  }

  async health(): Promise<ProviderHealth> {
    try {
      const h = await this.json<{ ready?: boolean; models?: { id: string; downloaded: boolean }[] } & Record<string, unknown>>('GET', '/health');
      const usable = (h.models ?? []).some((m) => m.downloaded);
      return { provider: this.id, ok: h.ready !== false && usable, ...(usable ? {} : { reason: 'no model is downloaded: run `pnpm imagegen:setup --download` (or point IMAGEGEN_HF_HOME at a cache)' }), detail: h };
    } catch (e) {
      return { provider: this.id, ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  // -- internals -----------------------------------------------------------------------------------------------------
  private headers(json: boolean): Record<string, string> {
    return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) };
  }

  private async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.f(`${this.url}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new ImageProviderError('provider_unreachable', `image sidecar not reachable at ${this.url} (${e instanceof Error ? e.message : 'network error'}); start it with \`pnpm imagegen\` or check IMAGEGEN_URL`);
    }
    if (res.ok) return res;
    let message = `HTTP ${res.status}`;
    let code = '';
    try {
      const b = (await res.json()) as { message?: string; code?: string };
      message = b.message ?? message;
      code = b.code ?? '';
    } catch {
      /* not JSON */
    }
    if (res.status === 401) throw new ImageProviderError('provider_refused', 'image sidecar rejected the token: set IMAGEGEN_TOKEN to the sidecar token');
    if (res.status === 403) throw new ImageProviderError('provider_refused', `image sidecar refused the request: ${message}`);
    if (res.status === 404 && path.startsWith('/jobs/')) throw new ImageProviderError('job_not_found', 'no such image job (the sidecar may have restarted)');
    if (res.status === 400) throw new ImageProviderError('invalid_request', `image sidecar: ${message}`);
    throw new ImageProviderError('provider_failed', `image sidecar ${code || res.status}: ${message}`);
  }

  private async json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return (await (await this.request(method, path, body, signal)).json()) as T;
  }

  private async status(j: RemoteJob): Promise<JobStatus> {
    const out: JobStatus = {
      provider: this.id,
      jobId: j.jobId,
      status: j.status,
      progress: j.progress,
      images: j.status === 'done' ? await this.materialise(j) : [],
      ...(j.error ? { error: j.error } : {}),
      ...(j.queuePosition !== undefined ? { queuePosition: j.queuePosition } : {}),
    };
    return out;
  }

  private async materialise(j: RemoteJob): Promise<GeneratedImage[]> {
    const cached = this.materialised.get(j.jobId);
    if (cached) return cached;
    const images: GeneratedImage[] = [];
    for (const [i, img] of j.images.entries()) {
      let path = img.path;
      if (!existsSync(path)) {
        const bytes = Buffer.from(await (await this.request('GET', `/jobs/${j.jobId}/images/${i}`)).arrayBuffer());
        mkdirSync(this.outDir, { recursive: true });
        path = join(this.outDir, `${j.jobId}-s${img.seed}.png`);
        writeFileSync(path, bytes);
      }
      let preview: GeneratedImage['preview'];
      try {
        const res = await this.request('GET', `/jobs/${j.jobId}/images/${i}?maxSide=${this.previewMax}`);
        preview = { data: Buffer.from(await res.arrayBuffer()).toString('base64'), mimeType: (res.headers.get('content-type') ?? '').includes('png') ? 'image/png' : 'image/jpeg' };
      } catch {
        preview = undefined; // no Pillow on the sidecar: the tool reports the file path only
      }
      images.push({ path, seed: img.seed, seconds: img.seconds, peakGb: img.peakGb ?? null, preview });
    }
    this.materialised.set(j.jobId, images);
    return images;
  }
}
