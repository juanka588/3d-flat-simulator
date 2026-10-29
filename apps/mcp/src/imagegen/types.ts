/**
 * The image-provider seam (CG2). Everything that generates or edits pictures goes through `ImageProvider`:
 * the local sidecar (`tools/imagegen`, mflux on a Mac or diffusers on an NVIDIA box), the API stubs, and the fake used
 * by tests. Generated images are never assets: the tools label them as `reference` or `visualisation`.
 */

/**
 * Where an input image came from. The only provenances that exist are our own renders and our own control passes:
 * there is deliberately no `product` / `catalogue` value, so a retailer photo cannot be wrapped into an `ImageInput`
 * by accident, and the API providers refuse anything else at run time as well.
 */
export type ImageProvenance = 'render' | 'pass';

export interface ImageInput {
  provenance: ImageProvenance;
  /** Base64 PNG or JPEG (no data: prefix). */
  data: string;
  mimeType: 'image/png' | 'image/jpeg';
}

export type ControlType = 'canny' | 'depth';
export type GenerateModel = 'qwen-cn';
export type EditModel = 'klein-edit';

export interface ControlImage {
  type: ControlType;
  image: ImageInput;
  /** 0 to 1.5; 1 keeps our geometry. */
  strength: number;
}

export interface GenerateRequest {
  prompt: string;
  negativePrompt?: string | undefined;
  seed: number;
  /** 1 to 4; image i uses seed + i. */
  n: number;
  /** Multiples of 32. */
  width: number;
  height: number;
  model?: GenerateModel | undefined;
  controls: ControlImage[];
  steps?: number | undefined;
}

export interface EditRequest {
  image: ImageInput;
  prompt: string;
  seed: number;
  /** 0 to 1; how far the edit may move away from the input (recorded; the klein CLI has no such knob, see tools/imagegen/README.md). */
  strength: number;
  model?: EditModel | undefined;
  width?: number | undefined;
  height?: number | undefined;
}

export interface GeneratedImage {
  /** A local file (the provider downloads remote results next to the scene data under `.tmp/imagegen/out`). */
  path: string;
  seed: number;
  seconds: number;
  peakGb?: number | null | undefined;
  /** A size-capped JPEG for the model to look at; absent when the provider could not make one. */
  preview?: { data: string; mimeType: 'image/jpeg' | 'image/png' } | undefined;
}

export type JobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface JobStatus {
  provider: string;
  jobId: string;
  status: JobState;
  /** 0 to 1. */
  progress: number;
  images: GeneratedImage[];
  error?: string | undefined;
  /** Jobs ahead of this one when queued. */
  queuePosition?: number | undefined;
}

export interface WaitOptions {
  /** Longest wait in ms for the job to finish; on expiry the current (running / queued) status is returned. Default: 0 (do not wait). */
  waitMs?: number;
  signal?: AbortSignal;
}

export interface ProviderHealth {
  provider: string;
  /** True when a request could be served right now. */
  ok: boolean;
  /** Why not, when `ok` is false (no secrets). */
  reason?: string;
  /** Backend-specific facts (models, GPU, settings) as the provider reports them. */
  detail?: Record<string, unknown>;
}

export interface ImageProvider {
  readonly id: string;
  /** Submits a job and waits up to `opts.waitMs` for it. */
  generate(req: GenerateRequest, opts?: WaitOptions): Promise<JobStatus>;
  edit(req: EditRequest, opts?: WaitOptions): Promise<JobStatus>;
  /** Current status of a job from `generate` / `edit`, waiting up to `opts.waitMs` for it to finish. */
  poll(jobId: string, opts?: WaitOptions): Promise<JobStatus>;
  cancel(jobId: string): Promise<void>;
  health(): Promise<ProviderHealth>;
}

/** An expected failure of a provider (disabled, unreachable, refused request); `code` is stable for the tools. */
export class ImageProviderError extends Error {
  constructor(
    readonly code: 'provider_disabled' | 'provider_unreachable' | 'provider_refused' | 'invalid_request' | 'not_implemented' | 'job_not_found' | 'provider_failed',
    message: string,
  ) {
    super(message);
    this.name = 'ImageProviderError';
  }
}
