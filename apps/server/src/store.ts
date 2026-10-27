import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  applyCommand,
  canRedo,
  canUndo,
  createHistory,
  loadSceneText,
  parseCommand,
  recordCommand,
  describeCommand,
  redo,
  undo,
  type Author,
  type ApplyOk,
  type CommandEnvelope,
  type Checkpoint,
  type CheckpointsResponse,
  type PostCheckpointResponse,
  type History,
  type HistoryResponse,
  type LogEntry,
  type LogResponse,
  type PostCommandResponse,
  type ErrorResponse,
  type Scene,
  type ServerMsg,
  type UndoToResponse,
  type ViewMsg,
  type PostViewBody,
} from '@flat/scene';
import type { ServerConfig } from './config';
import { Persistence, type IdempotencyRecord, type Snapshot, type StoredCheckpoint } from './persistence';

/** An outcome that may still be waiting for its log write to reach disk. */
interface Staged {
  outcome: Outcome;
  after?: Promise<void>;
}

export type Outcome =
  | { status: 200; body: PostCommandResponse | UndoToResponse | PostCheckpointResponse }
  | { status: 404 | 409 | 422 | 500; body: ErrorResponse };

/** At most this many checkpoints; creating one more evicts the oldest. */
export const MAX_CHECKPOINTS = 20;
const IDEMPOTENCY_CAP = 10_000;
/** How many recent idempotency records are persisted in the snapshot. */
const IDEMPOTENCY_PERSISTED = 1000;

interface Remembered {
  hash: string;
  response: PostCommandResponse;
}

/** Key-sorted JSON so equal envelopes hash equally regardless of property order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Hash of an envelope without its timestamp: a retry may carry a new `ts`, a different body is a different request. */
const hashEnvelope = (env: CommandEnvelope): string => {
  const rest: Record<string, unknown> = { ...env };
  delete rest.ts;
  return createHash('sha256').update(canonical(rest)).digest('hex');
};
const STEP_HASH = 'step';

/** Undo/redo ids live in their own namespace so they never collide with command ids. */
const stepKey = (kind: 'undo' | 'redo', id: string) => `${kind}:${id}`;
const entryKey = (e: LogEntry): string =>
  e.undoOf !== undefined ? stepKey('undo', e.envelope.id) : e.redoOf !== undefined ? stepKey('redo', e.envelope.id) : e.envelope.id;
const entryHash = (e: LogEntry): string => (e.undoOf !== undefined || e.redoOf !== undefined ? STEP_HASH : hashEnvelope(e.envelope));
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

/** The author a replayed undo / redo runs as: the log is already validated history, so the live "LLM may not touch locked items" guard (which undo / redo apply by author) must not reject it. */
const REPLAY_AUTHOR: Author = { kind: 'user' };

/**
 * Applies one logged entry to a state; the only place history and scene advance together.
 * `replay` (boot, from the log): undo / redo steps are re-applied as trusted history. Their envelope is not
 * used (the log keeps the original one), so the author only selects whether the live guard runs.
 */
function advance(
  scene: Scene,
  history: History,
  env: CommandEnvelope,
  rev?: number,
  replay = false,
): { ok: true; scene: Scene; history: History; result: ApplyOk } | { ok: false; errors: ErrorResponse['errors'] } {
  if (env.undoOf !== undefined) {
    const s = undo(history, scene, { id: env.id, ts: env.ts, author: replay ? REPLAY_AUTHOR : env.author });
    return s.ok ? { ok: true, scene: s.scene, history: s.history, result: s.result } : { ok: false, errors: stepErrors(s) };
  }
  if (env.redoOf !== undefined) {
    const s = redo(history, scene, { id: env.id, ts: env.ts, author: replay ? REPLAY_AUTHOR : env.author });
    return s.ok ? { ok: true, scene: s.scene, history: s.history, result: s.result } : { ok: false, errors: stepErrors(s) };
  }
  const r = applyCommand(scene, env, rev === undefined ? {} : { rev });
  if (!r.ok) return { ok: false, errors: r.errors };
  return { ok: true, scene: r.scene, history: recordCommand(history, env, r, env.ts, describeCommand(env.cmd, scene)), result: r };
}

function stepErrors(s: { ok: false; reason: string } & Partial<{ errors: ErrorResponse['errors'] }>): ErrorResponse['errors'] {
  if (s.errors) return s.errors;
  return [{ code: 'invalid_command', path: '', message: s.reason === 'nothing_to_undo' ? 'nothing to undo' : 'nothing to redo' }];
}

const publicCheckpoint = ({ topId: _topId, abs: _abs, ...cp }: StoredCheckpoint): Checkpoint => cp;

/**
 * How many entries `advance` dropped off the bottom of the capped undo history. Undo / redo never
 * trim; a coalesced command replaces the top entry (it keeps the OLDEST inverse by reference) and
 * adds nothing; any other recorded command adds one and trims what exceeds the cap.
 */
function trimmedBy(before: History, after: History, env: CommandEnvelope): number {
  if (env.undoOf !== undefined || env.redoOf !== undefined) return 0;
  const top = before.past.at(-1);
  if (top && after.past.at(-1)?.inverse === top.inverse) return 0; // merged
  if (after.past === before.past) return 0; // nothing recorded (a no-op)
  return Math.max(0, before.past.length + 1 - after.past.length);
}

export class SceneStore {
  epoch = '';
  rev = 0;
  seq = 0;
  scene!: Scene;
  history: History = createHistory();

  checkpoints: StoredCheckpoint[] = [];
  /** Entries dropped off the bottom of the capped history since this epoch began (see `StoredCheckpoint.abs`). */
  trimmed = 0;
  private viewSeq = 0;
  private readonly listeners = new Set<(msg: ServerMsg) => void>();
  private readonly viewSinks = new Set<(msg: ViewMsg, exceptClient?: string) => number>();
  private readonly idempotent = new Map<string, Remembered>();
  /** Entries currently in log.ndjson, in order. */
  private logEntries: LogEntry[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private snapshotTimer: NodeJS.Timeout | undefined;
  private dirty = false;
  /** A log sync failed after the state advanced: refuse writes until restart (memory is ahead of disk). */
  private failed = false;

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
    const cur = await this.disk.readSnapshotFile(this.disk.snapshotPath); // throws on EACCES/EIO: never a first boot
    let base: Snapshot | undefined;
    let fromPrev = false;
    if (cur.kind === 'ok') base = cur.snapshot;
    else {
      const prev = await this.disk.readSnapshotFile(this.disk.prevPath);
      if (prev.kind === 'ok') {
        if (cur.kind === 'corrupt') {
          const moved = await this.disk.quarantineSnapshot();
          this.config.log('error', `state.json is unreadable (${cur.problem}); moved to ${moved}; recovering from state.json.prev plus the log`);
        } else this.config.log('warn', 'state.json is missing; recovering from state.json.prev plus the log');
        base = prev.snapshot;
        fromPrev = true;
      } else {
        const { logEntries } = await this.disk.hasData();
        const corrupt = await this.disk.listCorrupt();
        if (cur.kind === 'corrupt') {
          throw new Error(`${this.disk.snapshotPath} is unreadable (${cur.problem}) and there is no usable state.json.prev. Refusing to start so no data is lost; the log (${logEntries} entries) and the file are untouched. Restore a backup or remove the file deliberately.`);
        }
        if (prev.kind === 'corrupt') {
          throw new Error(`${this.disk.prevPath} is unreadable (${prev.problem}) and state.json is missing. Refusing to start; remove the file deliberately to initialise from ${this.config.sceneFile}.`);
        }
        if (logEntries > 0 || corrupt.length > 0) {
          throw new Error(`state.json is missing but ${this.disk.dir} holds ${logEntries} log entries${corrupt.length ? ` and quarantined snapshots (${corrupt.join(', ')})` : ''}. Refusing to initialise over them; restore state.json or move those files away.`);
        }
      }
    }

    if (!base) {
      this.epoch = randomUUID();
      this.rev = this.seq = 0;
      this.scene = await this.loadInitialScene();
      this.history = createHistory();
      this.checkpoints = [];
      this.trimmed = 0;
      this.logEntries = [];
      await this.disk.writeSnapshot(this.snapshot());
      await this.disk.rewriteLog([]);
      this.config.log('info', `initialised from ${this.config.sceneFile}`);
      return;
    }

    const log = await this.disk.readLog();
    const all = fromPrev ? [...(await this.disk.readLog(this.disk.prevLogPath)).entries, ...log.entries] : log.entries;
    this.epoch = base.epoch;
    this.rev = base.rev;
    this.seq = base.seq;
    this.scene = base.scene;
    this.history = base.history;
    this.checkpoints = base.checkpoints ?? [];
    this.trimmed = base.trimmed ?? 0;
    for (const r of base.idempotency ?? []) this.remember(r.key, r.hash, r.response);
    if (log.dropped > 0) this.config.log('warn', `ignored ${log.dropped} unreadable trailing log line (torn write after a crash?)`);

    let replayed = 0;
    let stopped = false;
    const kept: LogEntry[] = [];
    const leftover: LogEntry[] = [];
    const seen = new Set<number>();
    for (const entry of all) {
      if (entry.epoch !== this.epoch) continue; // leftovers of a replaced scene
      if (seen.has(entry.seq)) continue;
      seen.add(entry.seq);
      if (entry.seq <= base.seq) {
        kept.push(entry); // already part of the snapshot
        this.remember(entryKey(entry), entryHash(entry), this.responseOf(entry));
        continue;
      }
      if (stopped) {
        leftover.push(entry);
        continue;
      }
      if (entry.seq !== this.seq + 1) {
        this.config.log('warn', `log gap at seq ${entry.seq} (expected ${this.seq + 1}); stopping replay`);
        stopped = true;
        leftover.push(entry);
        continue;
      }
      const r = advance(this.scene, this.history, entry.envelope, undefined, true);
      if (!r.ok) {
        this.config.log('warn', `log entry ${entry.seq} no longer applies (${r.errors[0]?.message}); stopping replay`);
        stopped = true;
        leftover.push(entry);
        continue;
      }
      this.trimmed += trimmedBy(this.history, r.history, entry.envelope);
      this.scene = r.scene;
      this.history = r.history;
      this.seq = entry.seq;
      this.rev = entry.rev;
      kept.push(entry);
      this.remember(entryKey(entry), entryHash(entry), this.responseOf(entry));
      replayed++;
    }
    this.logEntries = kept;
    if (leftover.length > 0) {
      const path = await this.disk.archiveEntries(leftover);
      this.config.log('error', `${leftover.length} log entries could not be replayed; kept in ${path}`);
    }
    if (fromPrev || log.dropped > 0 || log.unterminated || leftover.length > 0 || kept.length !== log.entries.length) {
      await this.disk.rewriteLog(this.logEntries);
    }
    if (fromPrev) await this.disk.writeSnapshot(this.snapshot());
    if (replayed > 0) {
      this.config.log('info', `replayed ${replayed} log entries; at rev ${this.rev}`);
      if (!fromPrev) this.scheduleSnapshot();
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
      label: e.label ?? describeCommand(e.envelope.cmd, this.scene),
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

  /** Waits for the staged outcome's durability outside the queue so concurrent commands share fsyncs. */
  private async settle(staged: Promise<Staged>): Promise<Outcome> {
    const s = await staged;
    if (!s.after) return s.outcome;
    try {
      await s.after;
    } catch (e) {
      this.failed = true;
      this.config.log('error', `log fsync failed; refusing writes until restart: ${String(e)}`);
      return fail(500, 'internal_error', 'could not persist the command');
    }
    return s.outcome;
  }

  applyEnvelope(input: unknown): Promise<Outcome> {
    return this.settle(
      this.enqueue(async (): Promise<Staged> => {
        const parsed = parseCommand(input);
        if (!parsed.ok) return { outcome: { status: 422, body: { ok: false, errors: parsed.errors } } };
        const env = parsed.envelope;
        if (env.undoOf !== undefined || env.redoOf !== undefined) {
          return { outcome: fail(422, 'invalid_command', 'undoOf/redoOf are set by the server; use POST /api/undo or /api/redo', {}, env.undoOf !== undefined ? 'undoOf' : 'redoOf') };
        }
        const hash = hashEnvelope(env);
        const dup = this.idempotent.get(env.id);
        if (dup) {
          if (dup.hash !== hash) {
            return { outcome: fail(409, 'idempotency_conflict', `id ${env.id} was already used with a different command`, { rev: this.rev, epoch: this.epoch }, 'id') };
          }
          return { outcome: { status: 200, body: dup.response }, after: this.disk.barrier() };
        }
        const r = advance(this.scene, this.history, env, this.rev);
        return this.commit(env, r, env.id, hash);
      }),
    );
  }

  undo(body: { id?: string; author?: Author; ifRev?: number }): Promise<Outcome> {
    return this.step('undo', body);
  }

  redo(body: { id?: string; author?: Author; ifRev?: number }): Promise<Outcome> {
    return this.step('redo', body);
  }

  private step(kind: 'undo' | 'redo', body: { id?: string; author?: Author; ifRev?: number }): Promise<Outcome> {
    return this.settle(
      this.enqueue(async (): Promise<Staged> => {
        const id = body.id ?? `srv-${randomUUID()}`;
        const key = stepKey(kind, id);
        const dup = this.idempotent.get(key);
        if (dup) return { outcome: { status: 200, body: dup.response }, after: this.disk.barrier() };
        if (body.ifRev !== undefined && body.ifRev !== this.rev) {
          return { outcome: fail(409, 'precondition_failed', `scene is at revision ${this.rev}, request expected ${body.ifRev}`, { rev: this.rev, epoch: this.epoch }, 'ifRev') };
        }
        const target = kind === 'undo' ? this.history.past.at(-1) : this.history.future.at(-1);
        if (!target) return { outcome: fail(409, 'invalid_command', `nothing to ${kind}`, { rev: this.rev, epoch: this.epoch }) };
        const ctx = { id, ts: Date.now(), author: body.author ?? SERVER_AUTHOR };
        const s = kind === 'undo' ? undo(this.history, this.scene, ctx) : redo(this.history, this.scene, ctx);
        if (!s.ok) return { outcome: { status: 422, body: { ok: false, errors: stepErrors(s) } } };
        return this.commit(s.envelope, { ok: true, scene: s.scene, history: s.history, result: s.result }, key, STEP_HASH);
      }),
    );
  }

  /**
   * Writes the log entry, then commits state in memory (in queue order). The caller acknowledges
   * and broadcasts only after the entry is fsync'ed (`after`); fsyncs are shared between commands.
   */
  private async commit(env: CommandEnvelope, r: ReturnType<typeof advance>, key: string, hash: string): Promise<Staged> {
    if (!r.ok) {
      const stale = r.errors.find((e) => e.code === 'precondition_failed');
      return { outcome: { status: stale ? 409 : 422, body: { ok: false, errors: r.errors, ...(stale ? { rev: this.rev, epoch: this.epoch } : {}) } } };
    }
    if (this.failed) return { outcome: fail(500, 'internal_error', 'storage failed earlier; restart the server') };
    if (r.result.noop) {
      const response = this.response(this.rev, this.seq, r.result);
      this.remember(key, hash, response);
      return { outcome: { status: 200, body: response }, after: this.disk.barrier() };
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
      await this.disk.write(entry);
    } catch (e) {
      this.config.log('error', `log append failed: ${String(e)}`);
      return { outcome: fail(500, 'internal_error', 'could not persist the command') };
    }
    const durable = this.disk.durable();
    durable.catch(() => {}); // surfaced through `after`
    this.trimmed += trimmedBy(this.history, r.history, env);
    this.scene = r.scene;
    this.history = r.history;
    this.seq = entry.seq;
    this.rev = entry.rev;
    this.logEntries.push(entry);
    const response = this.responseOf(entry);
    this.remember(key, hash, response);
    const msg: ServerMsg = {
      type: 'applied',
      epoch: entry.epoch,
      seq: entry.seq,
      rev: entry.rev,
      envelope: entry.envelope,
      inverse: entry.inverse,
      ...(entry.undoOf !== undefined ? { undoOf: entry.undoOf } : {}),
      ...(entry.redoOf !== undefined ? { redoOf: entry.redoOf } : {}),
    };
    // Registered in queue order and durable promises resolve in order, so broadcasts stay ordered.
    const after = durable.then(() => this.broadcast(msg));
    if (this.logEntries.length >= this.config.compactAfter) {
      await this.snapshotNow(true).catch((e) => this.config.log('error', `compaction failed: ${String(e)}`));
    } else this.scheduleSnapshot();
    return { outcome: { status: 200, body: response }, after };
  }

  // ---- checkpoints, undo-to, view relay ------------------------------------------------------

  checkpointsView(): CheckpointsResponse {
    return { epoch: this.epoch, rev: this.rev, checkpoints: this.checkpoints.map(publicCheckpoint) };
  }

  /**
   * Names are unique (409 `checkpoint_exists` unless `replace`). At `MAX_CHECKPOINTS` the oldest is
   * evicted. The snapshot is written (fsync) before answering, so a checkpoint survives a restart.
   */
  createCheckpoint(body: { name: string; author?: Author; replace?: boolean }): Promise<Outcome> {
    return this.enqueue(async (): Promise<Outcome> => {
      if (this.failed) return fail(500, 'internal_error', 'storage failed earlier; restart the server');
      const exists = this.checkpoints.some((c) => c.name === body.name);
      if (exists && !body.replace) {
        return fail(409, 'checkpoint_exists', `checkpoint "${body.name}" already exists; pick another name or send replace: true`, { rev: this.rev, epoch: this.epoch }, 'name');
      }
      // Close the coalescing window: a later edit with the same key must not merge into the entry
      // the checkpoint sits on (that would change the state the checkpoint stands for).
      const closed = this.history.open === null ? this.history : { ...this.history, open: null };
      const top = this.history.past.at(-1);
      const cp: StoredCheckpoint = {
        name: body.name,
        rev: this.rev,
        seq: this.seq,
        depth: this.history.past.length,
        ts: Date.now(),
        author: body.author ?? SERVER_AUTHOR,
        abs: this.trimmed + this.history.past.length,
        ...(top ? { topId: top.envelope.id } : {}),
      };
      const prevHistory = this.history;
      this.history = closed;
      const before = this.checkpoints;
      const next = [...before.filter((c) => c.name !== body.name), cp];
      this.checkpoints = next.slice(-MAX_CHECKPOINTS);
      try {
        await this.snapshotNow(false);
      } catch (e) {
        this.checkpoints = before;
        this.history = prevHistory;
        this.config.log('error', `could not persist checkpoint: ${String(e)}`);
        return fail(500, 'internal_error', 'could not persist the checkpoint');
      }
      return { status: 200, body: { ok: true, epoch: this.epoch, checkpoint: publicCheckpoint(cp) } };
    });
  }

  /**
   * Undoes the shared stack back to the checkpoint's depth in one queue turn (nothing interleaves),
   * as ordinary undo entries in the log (never truncated; redo works). Every step is broadcast as its
   * own `applied` message, in order, once durable. Idempotent by `id`.
   */
  undoTo(body: { checkpoint: string; id?: string; author?: Author; ifRev?: number }): Promise<Outcome> {
    return this.settle(
      this.enqueue(async (): Promise<Staged> => {
        const id = body.id ?? `srv-${randomUUID()}`;
        const key = `undoto:${id}`;
        const dup = this.idempotent.get(key);
        if (dup) return { outcome: { status: 200, body: dup.response }, after: this.disk.barrier() };
        const cp = this.checkpoints.find((c) => c.name === body.checkpoint);
        if (!cp) return { outcome: fail(404, 'not_found', `no checkpoint named "${body.checkpoint}"`, {}, 'checkpoint') };
        if (body.ifRev !== undefined && body.ifRev !== this.rev) {
          return { outcome: fail(409, 'precondition_failed', `scene is at revision ${this.rev}, request expected ${body.ifRev}`, { rev: this.rev, epoch: this.epoch }, 'ifRev') };
        }
        const past = this.history.past;
        const gone = (why: string) => ({ outcome: fail(409, 'checkpoint_unreachable', `checkpoint "${cp.name}" ${why}`, { rev: this.rev, epoch: this.epoch }, 'checkpoint') });
        // Depth of the checkpoint in the history as it is NOW: its absolute index minus what the cap has trimmed since.
        const depth = (cp.abs ?? cp.depth) - this.trimmed;
        if (depth < 0) return gone(`fell out of the capped history (only the last ${this.history.cap} changes are kept, and ${-depth} of the changes made since it was taken pushed it out)`);
        if (past.length < depth) return gone(`is at undo depth ${depth} but the history is only ${past.length} deep (it was undone past the checkpoint)`);
        if (depth > 0 && cp.topId !== undefined && past[depth - 1]?.envelope.id !== cp.topId) {
          return gone('is no longer on the undo stack (the history diverged after it was taken)');
        }
        if (this.failed) return { outcome: fail(500, 'internal_error', 'storage failed earlier; restart the server') };
        const steps = past.length - depth;
        if (steps === 0) {
          const response: UndoToResponse = {
            ok: true,
            epoch: this.epoch,
            rev: this.rev,
            seq: this.seq,
            result: { changed: { materials: [], walls: [], rooms: [], lights: [], site: false, defaults: false }, warnings: [], noop: true },
            steps: 0,
          };
          this.remember(key, STEP_HASH, response);
          return { outcome: { status: 200, body: response }, after: this.disk.barrier() };
        }
        const author = body.author ?? SERVER_AUTHOR;
        const base = id.length <= 56 ? id : createHash('sha256').update(id).digest('hex').slice(0, 40);
        // All-or-nothing: dry-run every step on a copy of the state first. A refusal part-way (e.g. an LLM undo that
        // would touch a locked item) leaves the scene, history and log untouched; only then are the steps committed.
        type Planned = { s: Extract<ReturnType<typeof undo>, { ok: true }>; stepId: string };
        const plan: Planned[] = [];
        let simScene = this.scene;
        let simHistory = this.history;
        for (let i = 0; i < steps; i++) {
          const stepId = `${base}~${i}`;
          const s = undo(simHistory, simScene, { id: stepId, ts: Date.now(), author });
          if (!s.ok) {
            const errors = stepErrors(s).map((e) => ({ ...e, message: `step ${i + 1} of ${steps}: ${e.message}; nothing was undone` }));
            return { outcome: { status: 422, body: { ok: false, errors } } };
          }
          plan.push({ s, stepId });
          simScene = s.scene;
          simHistory = s.history;
        }
        const afters: Promise<void>[] = [];
        let last: Outcome | undefined;
        for (const { s, stepId } of plan) {
          const staged = await this.commit(s.envelope, { ok: true, scene: s.scene, history: s.history, result: s.result }, stepKey('undo', stepId), STEP_HASH);
          last = staged.outcome;
          if (staged.outcome.status !== 200) break;
          if (staged.after) afters.push(staged.after);
        }
        if (!last || last.status !== 200) {
          // Only a storage failure gets here: earlier steps are already committed and logged; `redo` can restore them.
          return { outcome: last ?? fail(500, 'internal_error', 'undo-to made no progress'), ...(afters.length ? { after: Promise.all(afters).then(() => undefined) } : {}) };
        }
        const response: UndoToResponse = { ...(last.body as PostCommandResponse), steps };
        this.remember(key, STEP_HASH, response);
        return { outcome: { status: 200, body: response }, after: Promise.all(afters).then(() => undefined) };
      }),
    );
  }

  /** Registers a transport that can deliver ephemeral view messages; returns the number of clients reached. */
  addViewSink(fn: (msg: ViewMsg, exceptClient?: string) => number): () => void {
    this.viewSinks.add(fn);
    return () => this.viewSinks.delete(fn);
  }

  /** Ephemeral: never logged, no history, no rev bump, not replayed to late joiners. */
  relayView(body: PostViewBody, exceptClient?: string): number {
    const msg: ViewMsg = { type: 'view', seq: ++this.viewSeq, ...(body.from !== undefined ? { from: body.from } : {}), ...(body.pose ? { pose: body.pose } : {}), ...(body.lighting ? { lighting: body.lighting } : {}) };
    let delivered = 0;
    for (const sink of this.viewSinks) {
      try {
        delivered += sink(msg, exceptClient);
      } catch (e) {
        this.config.log('warn', `view sink failed: ${String(e)}`);
      }
    }
    return delivered;
  }

  /** Replaces the scene: new epoch, history and log reset. Disk first, then memory. */
  importScene(scene: Scene): Promise<{ epoch: string; rev: number }> {
    return this.enqueue(async () => {
      const epoch = randomUUID();
      const history = createHistory();
      await this.disk.writeSnapshot({ format: 1, epoch, rev: 0, seq: 0, scene, history, idempotency: [], checkpoints: [] }, { rotate: false });
      await this.disk.discardHistory();
      await this.disk.rewriteLog([]);
      this.epoch = epoch;
      this.scene = scene;
      this.rev = this.seq = 0;
      this.history = history;
      this.idempotent.clear();
      this.checkpoints = [];
      this.trimmed = 0;
      this.logEntries = [];
      this.dirty = false;
      this.broadcast({ type: 'reset', epoch: this.epoch, rev: 0, scene });
      return { epoch: this.epoch, rev: 0 };
    });
  }

  // ---- persistence ----------------------------------------------------------------------------

  private snapshot(): Snapshot {
    return { format: 1, epoch: this.epoch, rev: this.rev, seq: this.seq, scene: this.scene, history: this.history, idempotency: this.idempotencyRecords(), checkpoints: this.checkpoints, trimmed: this.trimmed };
  }

  private idempotencyRecords(): IdempotencyRecord[] {
    return [...this.idempotent].slice(-IDEMPOTENCY_PERSISTED).map(([key, v]) => ({ key, hash: v.hash, response: v.response }));
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
      await this.disk.rotateLog();
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
    await this.disk.close();
  }

  // ---- helpers ----------------------------------------------------------------------------------

  private response(rev: number, seq: number, r: ApplyOk): PostCommandResponse {
    return { ok: true, epoch: this.epoch, rev, seq, result: outcomeOf(r) };
  }

  private responseOf(e: LogEntry): PostCommandResponse {
    return { ok: true, epoch: e.epoch, rev: e.rev, seq: e.seq, result: e.result };
  }

  private remember(key: string, hash: string, response: PostCommandResponse): void {
    this.idempotent.delete(key);
    this.idempotent.set(key, { hash, response });
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
