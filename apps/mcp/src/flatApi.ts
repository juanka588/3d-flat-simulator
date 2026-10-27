import {
  type Author,
  type CheckpointsResponse,
  type CommandEnvelope,
  type HistoryResponse,
  type PostCheckpointBody,
  type PostCheckpointResponse,
  type PostCommandResponse,
  type PostViewBody,
  type PostViewResponse,
  type SceneResponse,
  type UndoToBody,
  type UndoToResponse,
} from '@flat/scene';
import type { McpConfig } from './config';

/**
 * The only door from the MCP tools to the scene server. Tools depend on this interface, never on
 * `fetch`: tests inject `MockFlatApi` (in-memory, real reducer + history), production uses
 * `HttpFlatApi`. Every method resolves (never throws) with `FlatResult`.
 */

type ApiErrorItem = { code: string; path: string; message: string; hint?: string };

/** The scene server did not answer (down, refused, timed out) or answered with an error. */
export type FlatApiFailure =
  | { ok: false; kind: 'unreachable'; message: string }
  | { ok: false; kind: 'http'; status: number; errors: ApiErrorItem[]; /** Current revision for 409 `precondition_failed`. */ rev?: number; epoch?: string };
export type FlatResult<T> = { ok: true; data: T } | FlatApiFailure;

export interface WriteOptions {
  /** Fail with `precondition_failed` (-> `stale_scene`) unless the scene is at this revision. */
  ifRev?: number;
}

export interface StepBody {
  /** Idempotency id (one per tool call; a retry with the same id returns the first result). */
  id?: string;
  author?: Author;
  ifRev?: number;
}

export interface FlatApi {
  /** `GET /api/scene` */
  getScene(): Promise<FlatResult<SceneResponse>>;
  /** `POST /api/commands`; `opts.ifRev` is copied into the envelope. 422 -> `errors`, 409 -> stale. */
  postCommand(envelope: CommandEnvelope, opts?: WriteOptions): Promise<FlatResult<PostCommandResponse>>;
  /** `GET /api/history` (shared stack: entries of every author). */
  history(): Promise<FlatResult<HistoryResponse>>;
  /** `POST /api/undo`: reverts the latest change, whoever made it. */
  undo(body?: StepBody): Promise<FlatResult<PostCommandResponse>>;
  /** `POST /api/redo` */
  redo(body?: StepBody): Promise<FlatResult<PostCommandResponse>>;
  /** `POST /api/checkpoints` (lane C, M4.7). */
  checkpoint(body: PostCheckpointBody): Promise<FlatResult<PostCheckpointResponse>>;
  /** `GET /api/checkpoints` (lane C). */
  listCheckpoints(): Promise<FlatResult<CheckpointsResponse>>;
  /** `POST /api/undo-to` (lane C). */
  undoTo(body: UndoToBody): Promise<FlatResult<UndoToResponse>>;
  /** `POST /api/view` (lane C): ephemeral relay to the user's tab. */
  postView(body: PostViewBody): Promise<FlatResult<PostViewResponse>>;
  /** `GET /api/materials`: the material library catalog (raw JSON). */
  materials(): Promise<FlatResult<unknown>>;
}

/** HTTP implementation. Paths for checkpoints / undo-to / view are the planned lane-C routes (404 until they exist). */
export class HttpFlatApi implements FlatApi {
  constructor(private readonly config: Pick<McpConfig, 'serverUrl' | 'token' | 'requestTimeoutMs'>, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<FlatResult<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.config.token) headers.authorization = `Bearer ${this.config.token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(this.config.serverUrl + path, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      return { ok: false, kind: 'unreachable', message: `${this.config.serverUrl}${path}: ${cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e))}` };
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // not JSON
    }
    if (res.ok) return { ok: true, data: json as T };
    const j = (json ?? {}) as { errors?: ApiErrorItem[]; rev?: number; epoch?: string };
    const errors = Array.isArray(j.errors) && j.errors.length ? j.errors : [{ code: 'internal_error', path: '', message: `scene server answered ${res.status}` }];
    return { ok: false, kind: 'http', status: res.status, errors, ...(j.rev !== undefined ? { rev: j.rev } : {}), ...(j.epoch !== undefined ? { epoch: j.epoch } : {}) };
  }

  getScene() {
    return this.call<SceneResponse>('GET', '/api/scene');
  }
  postCommand(envelope: CommandEnvelope, opts: WriteOptions = {}) {
    return this.call<PostCommandResponse>('POST', '/api/commands', opts.ifRev !== undefined ? { ...envelope, ifRev: opts.ifRev } : envelope);
  }
  history() {
    return this.call<HistoryResponse>('GET', '/api/history');
  }
  undo(body: StepBody = {}) {
    return this.call<PostCommandResponse>('POST', '/api/undo', body);
  }
  redo(body: StepBody = {}) {
    return this.call<PostCommandResponse>('POST', '/api/redo', body);
  }
  checkpoint(body: PostCheckpointBody) {
    return this.call<PostCheckpointResponse>('POST', '/api/checkpoints', body);
  }
  listCheckpoints() {
    return this.call<CheckpointsResponse>('GET', '/api/checkpoints');
  }
  undoTo(body: UndoToBody) {
    return this.call<UndoToResponse>('POST', '/api/undo-to', body);
  }
  postView(body: PostViewBody) {
    return this.call<PostViewResponse>('POST', '/api/view', body);
  }
  materials() {
    return this.call<unknown>('GET', '/api/materials');
  }
}
