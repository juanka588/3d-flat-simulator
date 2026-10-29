import { existsSync, readFileSync } from 'node:fs';
import {
  ImageProviderError,
  type EditRequest,
  type GenerateRequest,
  type GeneratedImage,
  type ImageProvider,
  type JobStatus,
  type ProviderHealth,
  type WaitOptions,
} from './types';

/** A valid 1x1 PNG (grey). */
export const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * Deterministic provider for tests: returns fixed images immediately, records every request, can be told to stay
 * `running` (to exercise polling) or to fail.
 */
export class FakeImageProvider implements ImageProvider {
  readonly id = 'fake';
  readonly generated: GenerateRequest[] = [];
  readonly edited: EditRequest[] = [];
  readonly cancelled: string[] = [];
  /** When set, the next jobs stay `running` for this many `poll` calls before completing. */
  pendingPolls = 0;
  /** When set, jobs end in `error` with this message. */
  failWith: string | undefined;
  private n = 0;
  private readonly jobs = new Map<string, { req: { n: number; seed: number }; polls: number }>();

  /** `path`: a real PNG every image points at (the dry run of the design runner; the metrics read it). Default: a made-up path and a 1x1 preview. */
  constructor(private readonly opts: { path?: string } = {}) {}

  private image(seed: number): GeneratedImage {
    const p = this.opts.path;
    if (p && existsSync(p)) return { path: p, seed, seconds: 0.1, peakGb: null, preview: { data: readFileSync(p).toString('base64'), mimeType: 'image/png' } };
    return { path: `/fake/out/img-s${seed}.png`, seed, seconds: 0.1, peakGb: null, preview: { data: TINY_PNG_B64, mimeType: 'image/png' } };
  }

  private submit(req: { n: number; seed: number }): string {
    const jobId = `fake${String(++this.n).padStart(12, '0')}`;
    this.jobs.set(jobId, { req, polls: 0 });
    return jobId;
  }

  private status(jobId: string): JobStatus {
    const j = this.jobs.get(jobId);
    if (!j) throw new ImageProviderError('job_not_found', 'no such fake job');
    if (this.failWith) return { provider: this.id, jobId, status: 'error', progress: 0, images: [], error: this.failWith };
    if (j.polls < this.pendingPolls) {
      j.polls += 1;
      return { provider: this.id, jobId, status: 'running', progress: j.polls / (this.pendingPolls + 1), images: [] };
    }
    return { provider: this.id, jobId, status: 'done', progress: 1, images: Array.from({ length: j.req.n }, (_, i) => this.image(j.req.seed + i)) };
  }

  async generate(req: GenerateRequest, _opts?: WaitOptions): Promise<JobStatus> {
    this.generated.push(req);
    return this.status(this.submit(req));
  }

  async edit(req: EditRequest, _opts?: WaitOptions): Promise<JobStatus> {
    this.edited.push(req);
    return this.status(this.submit({ n: 1, seed: req.seed }));
  }

  async poll(jobId: string, _opts?: WaitOptions): Promise<JobStatus> {
    return this.status(jobId);
  }

  async cancel(jobId: string): Promise<void> {
    this.cancelled.push(jobId);
  }

  async health(): Promise<ProviderHealth> {
    return { provider: this.id, ok: true };
  }
}
