import {
  ImageProviderError,
  type EditRequest,
  type GenerateRequest,
  type ImageInput,
  type ImageProvider,
  type JobStatus,
  type ProviderHealth,
  type WaitOptions,
} from './types';

/**
 * Hosted providers: STUBS behind the same interface, opt-in by an environment key (`OPENAI_API_KEY`, `GEMINI_API_KEY`).
 * They are disabled without the key and never print it. Privacy rules (docs/backlog/cg.md, constraints):
 *  - only our own renders and control passes may leave the machine: any input whose provenance is not `render` or `pass`
 *    is refused before anything is sent (catalogue photos and retailer models never are);
 *  - nothing is sent in this build at all: the call path ends in `not_implemented` after the guard.
 */

export function assertOwnImages(provider: string, images: readonly ImageInput[]): void {
  for (const img of images) {
    if ((img.provenance as string) !== 'render' && (img.provenance as string) !== 'pass') {
      throw new ImageProviderError('provider_refused', `${provider} only accepts our own renders and control passes, not images of provenance "${String(img.provenance)}"`);
    }
  }
}

abstract class ApiStub implements ImageProvider {
  abstract readonly id: string;
  protected abstract readonly envKey: string;
  protected readonly env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.env = env;
  }

  /** True when the key is set. The value is never read into any message. */
  get enabled(): boolean {
    return Boolean(this.env[this.envKey]?.trim());
  }

  private guard(images: readonly ImageInput[]): void {
    if (!this.enabled) throw new ImageProviderError('provider_disabled', `${this.id} is disabled: set ${this.envKey} to opt in`);
    assertOwnImages(this.id, images);
  }

  async generate(req: GenerateRequest, _opts?: WaitOptions): Promise<JobStatus> {
    this.guard(req.controls.map((c) => c.image));
    throw new ImageProviderError('not_implemented', `${this.id} image generation is a stub in this build`);
  }

  async edit(req: EditRequest, _opts?: WaitOptions): Promise<JobStatus> {
    this.guard([req.image]);
    throw new ImageProviderError('not_implemented', `${this.id} image editing is a stub in this build`);
  }

  async poll(_jobId: string): Promise<JobStatus> {
    throw new ImageProviderError('job_not_found', `${this.id} has no jobs`);
  }

  async cancel(_jobId: string): Promise<void> {}

  async health(): Promise<ProviderHealth> {
    return this.enabled ? { provider: this.id, ok: false, reason: 'stub: not implemented in this build' } : { provider: this.id, ok: false, reason: `disabled (set ${this.envKey})` };
  }
}

export class OpenAIImageProvider extends ApiStub {
  readonly id = 'openai';
  protected readonly envKey = 'OPENAI_API_KEY';
}

export class GeminiImageProvider extends ApiStub {
  readonly id = 'gemini';
  protected readonly envKey = 'GEMINI_API_KEY';
}
