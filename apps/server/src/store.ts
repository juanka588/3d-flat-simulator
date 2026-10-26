import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  applyCommand,
  canRedo,
  canUndo,
  createHistory,
  loadSceneText,
  parseCommand,
  recordCommand,
  redo,
  undo,
  type Author,
  type ApplyOk,
  type CommandEnvelope,
  type History,
  type HistoryResponse,
  type LogEntry,
  type LogResponse,
  type PostCommandResponse,
  type ErrorResponse,
  type Scene,
  type ServerMsg,
} from '@flat/scene';
import type { ServerConfig } from './config';
import { Persistence, type Snapshot } from './persistence';

export type Outcome =
  | { status: 200; body: PostCommandResponse }
  | { status: 404 | 409 | 422 | 500; body: ErrorResponse };

const IDEMPOTENCY_CAP = 10_000;
const SERVER_AUTHOR: Author = { kind: 'user', name: 'server' };

const fail = (status: 404 | 409 | 422 | 500, code: string, message: string, extra: Partial<ErrorResponse> = {}, path = ''): Outcome => ({
  status,
  body: { ok: false, errors: [{ code, path, message }], ...extra },
});

const outcomeOf = (r: ApplyOk) => ({
  changed: r.changed,
  warnings: r.warnings,
  ...(r.noop ? { noop: true as const } : {}),
});

/** Applies one logged entry to a state; the only place history and scene advance together. */
function advance(
  scene: Scene,
  history: History,
  env: CommandEnvelope,
  rev?: number,
): { ok: true; scene: Scene; history: History; result: ApplyOk } | { ok: false; errors: ErrorResponse['errors'] } {
  if (env.undoOf !== undefined) {
    const s = undo(history, scene, { id: env.id, ts: env.ts, author: env.author });
    return s.ok ? { ok: true, scene: s.scene, history: s.history, result: s.result } : { ok: false, errors: stepErrors(s) };
  }
  if (env.redoOf !== undefined) {
    const s = redo(history, scene, { id: env.id, ts: env.ts, author: env.author });
    return s.ok ? { ok: true, scene: s.scene, history: s.history, result: s.result } : { ok: false, errors: stepErrors(s) };
  }
  const r = applyCommand(scene, env, rev === undefined ? {} : { rev });
  if (!r.ok) return { ok: false, errors: r.errors };
  return { ok: true, scene: r.scene, history: recordCommand(history, env, r), result: r };
}

function stepErrors(s: { ok: false; reason: string } & Partial<{ errors: ErrorResponse['errors'] }>): ErrorResponse['errors'] {
  if (s.errors) return s.errors;
  return [{ code: 'invalid_command', path: '', message: s.reason === 'nothing_to_undo' ? 'nothing to undo' : 'nothing to redo' }];
}

export class SceneStore {
  epoch = '';
  rev = 0;
  seq = 0;
  scene!: Scene;
  history: History = createHistory();

  private readonly listeners = new Set<(msg: ServerMsg) => void>();
  private readonly idempotent = new Map<string, PostCommandResponse>();
  /** Entries currently in log.ndjson, in order. */
  private logEntries: LogEntry[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private snapshotTimer: NodeJS.Timeout | undefined;
  private dirty = false;

  private constructor(
    private readonly config: ServerConfig,
    private readonly disk: Persistence,
  ) {}

  /** Boot: snapshot + replay of the log tail, or the initial scene file on first boot. */
  static async open(config: ServerConfig): Promise<SceneStore> {
    const disk = new Persistence(config.dataDir);
    await disk.init();
    const store = new SceneStore(config, disk);
    await store.recover();
    return store;
  }

  private async recover(): Promise<void> {
    const { snapshot, problem } = await this.disk.readSnapshot();
    const log = await this.disk.readLog();
    if (problem) this.config.log('warn', `${problem}; starting from the initial scene and discarding the log`);

    if (!snapshot) {
      this.epoch = randomUUID();
      this.rev = this.seq = 0;
      this.scene = await this.loadInitialScene();
      this.history = createHistory();
      this.logEntries = [];
      await this.disk.writeSnapshot(this.snapshot());
      await this.disk.rewriteLog([]);
      this.config.log('info', `initialised from ${this.config.sceneFile}`);
      return;
    }

    this.epoch = snapshot.epoch;
    this.rev = snapshot.rev;
    this.seq = snapshot.seq;
    this.scene = snapshot.scene;
    this.history = snapshot.history;
    if (log.dropped > 0) this.config.log('warn', `ignored ${log.dropped} unreadable log line(s) (torn write after a crash?)`);

    let replayed = 0;
    let stopped = false;
    const kept: LogEntry[] = [];
    for (const entry of log.entries) {
      if (entry.epoch !== this.epoch) continue; // leftovers of a replaced scene
      kept.push(entry);
      this.remember(entry.envelope.id, this.responseOf(entry));
      if (entry.seq <= snapshot.seq || stopped) continue;
      if (entry.seq !== this.seq + 1) {
        this.config.log('warn', `log gap at seq ${entry.seq} (expected ${this.seq + 1}); stopping replay`);
        stopped = true;
        continue;
      }
      const r = advance(this.scene, this.history, entry.envelope);
      if (!r.ok) {
        this.config.log('warn', `log entry ${entry.seq} no longer applies (${r.errors[0]?.message}); stopping replay`);
        stopped = true;
        continue;
      }
      this.scene = r.scene;
      this.history = r.history;
      this.seq = entry.seq;
      this.rev = entry.rev;
      replayed++;
    }
    this.logEntries = kept.filter((e) => e.seq <= this.seq);
    if (log.dropped > 0 || kept.length !== log.entries.length || this.logEntries.length !== kept.length) {
      await this.disk.rewriteLog(this.logEntries);
    }
    if (replayed > 0) {
      this.config.log('info', `replayed ${replayed} log entries; at rev ${this.rev}`);
      this.scheduleSnapshot();
    }
  }

  private async loadInitialScene(): Promise<Scene> {
    const loaded = loadSceneText(await readFile(this.config.sceneFile, 'utf8'));
    if (!loaded.ok) throw new Error(`invalid initial scene ${this.config.sceneFile}: ${loaded.errors.join('; ')}`);
    return loaded.scene;
  }

  // ---- reads ----------------------------------------------------------------------------

  sceneResponse() {
    return { epoch: this.epoch, rev: this.rev, scene: this.scene };
  }

  helloMessage(): ServerMsg {
    return { type: 'hello', epoch: this.epoch, rev: this.rev, scene: this.scene };
  }

  historyView(): HistoryResponse {
    const item = (e: History['past'][number]) => ({
      id: e.envelope.id,
      label: e.envelope.cmd.type === 'batch' ? e.envelope.cmd.label : e.envelope.cmd.type,
      ts: e.envelope.ts,
      author: e.envelope.author,
    });
    return {
      epoch: this.epoch,
      rev: this.rev,
      canUndo: canUndo(this.history),
      canRedo: canRedo(this.history),
      past: this.history.past.map(item),
      future: this.history.future.map(item),
    };
  }

  logSince(since: number): LogResponse {
    const oldest = this.logEntries[0]?.seq ?? this.seq + 1;
    return {
      epoch: this.epoch,
      rev: this.rev,
      entries: this.logEntries.filter((e) => e.seq > since),
      truncated: since + 1 < oldest,
    };
  }

  subscribe(fn: (msg: ServerMsg) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---- mutations (all serialised through one queue) -----------------------------------------

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  applyEnvelope(input: unknown): Promise<Outcome> {
    return this.enqueue(async () => {
      const parsed = parseCommand(input);
      if (!parsed.ok) return { status: 422, body: { ok: false, errors: parsed.errors } } satisfies Outcome;
      const env = parsed.envelope;
      if (env.undoOf !== undefined || env.redoOf !== undefined) {
        return fail(422, 'invalid_command', 'undoOf/redoOf are set by the server; use POST /api/undo or /api/redo', {}, env.undoOf !== undefined ? 'undoOf' : 'redoOf');
      }
      const dup = this.idempotent.get(env.id);
      if (dup) return { status: 200, body: dup } satisfies Outcome;
      const r = advance(this.scene, this.history, env, this.rev);
      return this.commit(env, r);
    });
  }

  undo(body: { id?: string; author?: Author; ifRev?: number }): Promise<Outcome> {
    return this.step('undo', body);
  }

  redo(body: { id?: string; author?: Author; ifRev?: number }): Promise<Outcome> {
    return this.step('redo', body);
  }

  private step(kind: 'undo' | 'redo', body: { id?: string; author?: Author; ifRev?: number }): Promise<Outcome> {
    return this.enqueue(async () => {
      const id = body.id ?? `srv-${randomUUID()}`;
      const dup = this.idempotent.get(id);
      if (dup) return { status: 200, body: dup } satisfies Outcome;
      if (body.ifRev !== undefined && body.ifRev !== this.rev) {
        return fail(409, 'precondition_failed', `scene is at revision ${this.rev}, request expected ${body.ifRev}`, { rev: this.rev, epoch: this.epoch }, 'ifRev');
      }
      const target = kind === 'undo' ? this.history.past.at(-1) : this.history.future.at(-1);
      if (!target) return fail(409, 'invalid_command', `nothing to ${kind}`, { rev: this.rev, epoch: this.epoch });
      const ctx = { id, ts: Date.now(), author: body.author ?? SERVER_AUTHOR };
      const s = kind === 'undo' ? undo(this.history, this.scene, ctx) : redo(this.history, this.scene, ctx);
      if (!s.ok) return { status: 422, body: { ok: false, errors: stepErrors(s) } } satisfies Outcome;
      return this.commit(s.envelope, { ok: true, scene: s.scene, history: s.history, result: s.result });
    });
  }

  /** Logs first, then commits state and notifies; a failed log write leaves the state untouched. */
  private async commit(env: CommandEnvelope, r: ReturnType<typeof advance>): Promise<Outcome> {
    if (!r.ok) {
      const stale = r.errors.find((e) => e.code === 'precondition_failed');
      return { status: stale ? 409 : 422, body: { ok: false, errors: r.errors, ...(stale ? { rev: this.rev, epoch: this.epoch } : {}) } };
    }
    if (r.result.noop) {
      const response = this.response(this.rev, this.seq, r.result);
      this.remember(env.id, response);
      return { status: 200, body: response };
    }
    const entry: LogEntry = {
      epoch: this.epoch,
      seq: this.seq + 1,
      rev: this.rev + 1,
      envelope: env,
      inverse: r.result.inverse,
      ...(env.undoOf !== undefined ? { undoOf: env.undoOf } : {}),
      ...(env.redoOf !== undefined ? { redoOf: env.redoOf } : {}),
      result: outcomeOf(r.result),
    };
    try {
      await this.disk.append(entry);
    } catch (e) {
      this.config.log('error', `log append failed: ${String(e)}`);
      return fail(500, 'internal_error', 'could not persist the command');
    }
    this.scene = r.scene;
    this.history = r.history;
    this.seq = entry.seq;
    this.rev = entry.rev;
    this.logEntries.push(entry);
    const response = this.responseOf(entry);
    this.remember(env.id, response);
    this.broadcast({
      type: 'applied',
      epoch: entry.epoch,
      seq: entry.seq,
      rev: entry.rev,
      envelope: entry.envelope,
      inverse: entry.inverse,
      ...(entry.undoOf !== undefined ? { undoOf: entry.undoOf } : {}),
      ...(entry.redoOf !== undefined ? { redoOf: entry.redoOf } : {}),
    });
    if (this.logEntries.length >= this.config.compactAfter) {
      await this.snapshotNow(true).catch((e) => this.config.log('error', `compaction failed: ${String(e)}`));
    } else this.scheduleSnapshot();
    return { status: 200, body: response };
  }

  /** Replaces the scene: new epoch, history and log reset. */
  importScene(scene: Scene): Promise<{ epoch: string; rev: number }> {
    return this.enqueue(async () => {
      this.epoch = randomUUID();
      this.scene = scene;
      this.rev = this.seq = 0;
      this.history = createHistory();
      this.idempotent.clear();
      this.logEntries = [];
      await this.snapshotNow(true);
      this.broadcast({ type: 'reset', epoch: this.epoch, rev: 0, scene });
      return { epoch: this.epoch, rev: 0 };
    });
  }

  // ---- persistence ----------------------------------------------------------------------------

  private snapshot(): Snapshot {
    return { format: 1, epoch: this.epoch, rev: this.rev, seq: this.seq, scene: this.scene, history: this.history };
  }

  private scheduleSnapshot(): void {
    this.dirty = true;
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      void this.enqueue(() => this.snapshotNow(false)).catch((e) => this.config.log('error', `snapshot failed: ${String(e)}`));
    }, this.config.snapshotDebounceMs);
    this.snapshotTimer.unref?.();
  }

  /** Must run inside the queue. With `truncate`, the log is emptied once the snapshot is durable. */
  private async snapshotNow(truncate: boolean): Promise<void> {
    await this.disk.writeSnapshot(this.snapshot());
    this.dirty = false;
    if (truncate) {
      await this.disk.rewriteLog([]);
      this.logEntries = [];
    }
  }

  /** Flushes a pending snapshot and waits for in-flight work (shutdown, tests). */
  async close(): Promise<void> {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = undefined;
    await this.enqueue(async () => {
      if (this.dirty) await this.snapshotNow(false);
    });
  }

  // ---- helpers ----------------------------------------------------------------------------------

  private response(rev: number, seq: number, r: ApplyOk): PostCommandResponse {
    return { ok: true, epoch: this.epoch, rev, seq, result: outcomeOf(r) };
  }

  private responseOf(e: LogEntry): PostCommandResponse {
    return { ok: true, epoch: e.epoch, rev: e.rev, seq: e.seq, result: e.result };
  }

  private remember(id: string, response: PostCommandResponse): void {
    this.idempotent.set(id, response);
    if (this.idempotent.size > IDEMPOTENCY_CAP) this.idempotent.delete(this.idempotent.keys().next().value!);
  }

  private broadcast(msg: ServerMsg): void {
    for (const fn of this.listeners) {
      try {
        fn(msg);
      } catch (e) {
        this.config.log('warn', `listener failed: ${String(e)}`);
      }
    }
  }
}
