import { mkdir, open, readFile, readdir, rename, rm, type FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Checkpoint, LogEntry, Scene, serializeScene, type History, type PostCommandResponse } from '@flat/scene';

/** One remembered command response, persisted so idempotency survives compaction and restarts. */
export interface IdempotencyRecord {
  key: string;
  hash: string;
  response: PostCommandResponse;
}

/** Authoritative snapshot (scene + history + counters). `scene.flat.json` is a human-readable copy. */
/**
 * A checkpoint plus what the server needs to find it again in the capped history:
 * - `topId`: the id of the entry on top of the undo stack when it was taken (detects divergence);
 * - `abs`: ABSOLUTE index of the checkpoint in the history, i.e. the number of entries trimmed off the
 *   bottom of the capped history so far (`Snapshot.trimmed`) plus its depth then. The depth now is
 *   `abs - trimmed`; below 0 the checkpoint has fallen out of the history (older snapshots have no
 *   `abs`: their `depth` is used).
 */
export type StoredCheckpoint = Checkpoint & { topId?: string; abs?: number };

export interface Snapshot {
  format: 1;
  epoch: string;
  rev: number;
  seq: number;
  scene: Scene;
  history: History;
  /** Most recent idempotency records (additive field; absent in older snapshots). */
  idempotency?: IdempotencyRecord[];
  /** Named checkpoints of the shared history (additive field; absent in older snapshots). */
  checkpoints?: StoredCheckpoint[];
  /** Entries dropped off the bottom of the capped undo history since the epoch began (additive field; absent = 0). */
  trimmed?: number;
}

export interface LoadedLog {
  entries: LogEntry[];
  /** Number of unreadable trailing lines dropped (a torn last write). */
  dropped: number;
  /** The file did not end with a newline, so it must be rewritten before appending. */
  unterminated: boolean;
}

export type SnapshotRead = { kind: 'ok'; snapshot: Snapshot } | { kind: 'missing' } | { kind: 'corrupt'; problem: string };

/** The log is damaged somewhere other than a torn final line; nothing has been modified. */
export class LogCorruptError extends Error {}
/** Another live process owns the data directory. */
export class DataDirLockedError extends Error {}

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;

function parseSnapshot(text: string): SnapshotRead {
  try {
    const raw = JSON.parse(text) as Partial<Snapshot> | null;
    if (!raw || typeof raw !== 'object') return { kind: 'corrupt', problem: 'not an object' };
    const scene = Scene.safeParse(raw.scene);
    if (raw.format !== 1 || !scene.success || typeof raw.epoch !== 'string' || !Number.isInteger(raw.rev) || !Number.isInteger(raw.seq) || !raw.history) {
      return { kind: 'corrupt', problem: 'not a valid snapshot' };
    }
    const idempotency = Array.isArray(raw.idempotency)
      ? raw.idempotency.filter((r): r is IdempotencyRecord => !!r && typeof r.key === 'string' && typeof r.hash === 'string' && typeof r.response === 'object' && r.response !== null)
      : undefined;
    const snapshot = { ...(raw as Snapshot), scene: scene.data };
    if (idempotency) snapshot.idempotency = idempotency;
    else delete snapshot.idempotency;
    if (Array.isArray(raw.checkpoints)) {
      snapshot.checkpoints = raw.checkpoints.flatMap((c) => {
        const ok = Checkpoint.safeParse(c);
        const { topId, abs } = c as { topId?: unknown; abs?: unknown };
        return ok.success ? [{ ...ok.data, ...(typeof topId === 'string' ? { topId } : {}), ...(typeof abs === 'number' && Number.isInteger(abs) && abs >= 0 ? { abs } : {}) }] : [];
      });
    } else delete snapshot.checkpoints;
    if (!(typeof raw.trimmed === 'number' && Number.isInteger(raw.trimmed) && raw.trimmed >= 0)) delete snapshot.trimmed;
    return { kind: 'ok', snapshot };
  } catch (e) {
    return { kind: 'corrupt', problem: e instanceof Error ? e.message : String(e) };
  }
}

export class Persistence {
  readonly snapshotPath: string;
  readonly prevPath: string;
  readonly sceneCopyPath: string;
  readonly logPath: string;
  readonly prevLogPath: string;
  readonly lockPath: string;
  private logHandle: FileHandle | undefined;
  private logSize = 0;
  private broken: Error | undefined;
  private syncing: Promise<void> | undefined;
  private nextSync: Promise<void> | undefined;
  private locked = false;

  constructor(readonly dir: string) {
    this.snapshotPath = join(dir, 'state.json');
    this.prevPath = join(dir, 'state.json.prev');
    this.sceneCopyPath = join(dir, 'scene.flat.json');
    this.logPath = join(dir, 'log.ndjson');
    this.prevLogPath = join(dir, 'log.ndjson.prev');
    this.lockPath = join(dir, 'server.lock');
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.acquireLock();
  }

  // ---- single-instance lock -----------------------------------------------------------------

  /** Lockfile with the owner's pid. A lock owned by a dead pid (or by this very process) is stale. */
  private async acquireLock(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fh = await open(this.lockPath, 'wx');
        await fh.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now() }));
        await fh.sync();
        await fh.close();
        this.locked = true;
        return;
      } catch (e) {
        if (errno(e) !== 'EEXIST') throw e;
      }
      let owner = 0;
      try {
        owner = (JSON.parse(await readFile(this.lockPath, 'utf8')) as { pid?: number }).pid ?? 0;
      } catch {
        /* unreadable lock: treat as stale */
      }
      if (owner > 0 && owner !== process.pid && pidAlive(owner)) {
        throw new DataDirLockedError(`data directory ${this.dir} is already in use by pid ${owner} (${this.lockPath}); stop that server or use another DATA_DIR`);
      }
      await rm(this.lockPath, { force: true });
    }
    throw new DataDirLockedError(`could not take the lock ${this.lockPath}`);
  }

  async close(): Promise<void> {
    await this.dropLogHandle();
    if (this.locked) {
      this.locked = false;
      try {
        const owner = (JSON.parse(await readFile(this.lockPath, 'utf8')) as { pid?: number }).pid;
        if (owner === process.pid) await rm(this.lockPath, { force: true });
      } catch {
        /* already gone */
      }
    }
  }

  // ---- snapshot -----------------------------------------------------------------------------------

  /** Throws on I/O errors other than ENOENT: those are never a reason to start from scratch. */
  async readSnapshotFile(path: string): Promise<SnapshotRead> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      if (errno(e) === 'ENOENT') return { kind: 'missing' };
      throw e;
    }
    return parseSnapshot(text);
  }

  /** Moves an unreadable `state.json` aside (never deletes it). */
  async quarantineSnapshot(): Promise<string> {
    const target = `${this.snapshotPath}.corrupt-${Date.now()}`;
    await rename(this.snapshotPath, target);
    return target;
  }

  /** Rotates the current good `state.json` to `state.json.prev`, then writes the new one durably. */
  async writeSnapshot(s: Snapshot, opts: { rotate?: boolean } = {}): Promise<void> {
    if (opts.rotate !== false) await this.rotatePrev();
    await this.writeAtomic(this.snapshotPath, JSON.stringify(s));
    await this.writeAtomic(this.sceneCopyPath, serializeScene(s.scene));
  }

  private async rotatePrev(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.snapshotPath, 'utf8');
    } catch (e) {
      if (errno(e) === 'ENOENT') return;
      throw e;
    }
    if (parseSnapshot(text).kind !== 'ok') return; // never replace a good prev with garbage
    await this.writeAtomic(this.prevPath, text);
  }

  /** After an import the old lineage is gone on purpose: drop prev and the archived log. */
  async discardHistory(): Promise<void> {
    await rm(this.prevPath, { force: true });
    await rm(this.prevLogPath, { force: true });
  }

  // ---- log ----------------------------------------------------------------------------------------

  /**
   * Reads a log. Only a torn final line is tolerated; an unreadable line followed by valid data
   * throws `LogCorruptError` and the file is left untouched.
   */
  async readLog(path: string = this.logPath): Promise<LoadedLog> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      if (errno(e) === 'ENOENT') return { entries: [], dropped: 0, unterminated: false };
      throw e;
    }
    const lines = text.split('\n');
    let lastNonEmpty = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.trim() !== '') {
        lastNonEmpty = i;
        break;
      }
    }
    const entries: LogEntry[] = [];
    let dropped = 0;
    for (let i = 0; i <= lastNonEmpty; i++) {
      const line = lines[i]!;
      if (line.trim() === '') continue;
      const parsed = this.parseLine(line);
      if (parsed) entries.push(parsed);
      else if (i === lastNonEmpty) dropped = 1;
      else throw new LogCorruptError(`${path}: unreadable entry at line ${i + 1} followed by more data; refusing to start. The file was not modified; repair or remove that line.`);
    }
    return { entries, dropped, unterminated: text.length > 0 && !text.endsWith('\n') };
  }

  private parseLine(line: string): LogEntry | undefined {
    try {
      const r = LogEntry.safeParse(JSON.parse(line));
      return r.success ? r.data : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Writes the entry to the log (not yet durable). Pair with `durable()`; the caller must not
   * acknowledge the command before that promise resolves.
   */
  async write(entry: LogEntry): Promise<void> {
    if (this.broken) throw this.broken;
    const line = Buffer.from(`${JSON.stringify(entry)}\n`);
    const fh = await this.ensureLog();
    try {
      await fh.write(line);
      this.logSize += line.length;
    } catch (e) {
      // Do not leave a partial line that a later append would bury mid-file.
      try {
        await fh.truncate(this.logSize);
      } catch (e2) {
        this.broken = new Error(`log is in an unknown state after a failed write (${String(e2)}); restart the server`);
      }
      throw e;
    }
  }

  /** Convenience: write then wait for durability. */
  async append(entry: LogEntry): Promise<void> {
    await this.write(entry);
    await this.durable();
  }

  /**
   * Resolves once everything written so far is fdatasync'ed. Group commit: while one sync is in
   * flight, all later callers share the next one, so N concurrent commands cost ~2 syncs, not N.
   */
  durable(): Promise<void> {
    if (!this.syncing) return this.startSync();
    if (!this.nextSync) {
      this.nextSync = this.syncing
        .catch(() => {})
        .then(() => {
          this.nextSync = undefined;
          return this.startSync();
        });
    }
    return this.nextSync;
  }

  /** Resolves when all outstanding syncs have finished (immediately if none). */
  barrier(): Promise<void> {
    return this.nextSync ?? this.syncing ?? Promise.resolve();
  }

  private startSync(): Promise<void> {
    const fh = this.logHandle;
    const p: Promise<void> = (fh ? fh.datasync() : Promise.resolve()).finally(() => {
      if (this.syncing === p) this.syncing = undefined;
    });
    this.syncing = p;
    return p;
  }

  private async ensureLog(): Promise<FileHandle> {
    if (this.logHandle) return this.logHandle;
    const fh = await open(this.logPath, 'a');
    this.logSize = (await fh.stat()).size;
    await fh.sync();
    await this.syncDir();
    this.logHandle = fh;
    return fh;
  }

  private async dropLogHandle(): Promise<void> {
    await this.barrier().catch(() => {});
    const fh = this.logHandle;
    this.logHandle = undefined;
    await fh?.close().catch(() => {});
  }

  async rewriteLog(entries: LogEntry[]): Promise<void> {
    await this.dropLogHandle();
    await this.writeAtomic(this.logPath, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }

  /** Compaction: keeps the retired log as `log.ndjson.prev` (enough to replay from `state.json.prev`). */
  async rotateLog(): Promise<void> {
    await this.dropLogHandle();
    try {
      await rename(this.logPath, this.prevLogPath);
    } catch (e) {
      if (errno(e) !== 'ENOENT') throw e;
    }
    await this.writeAtomic(this.logPath, '');
  }

  /** Keeps entries that could not be replayed so no acknowledged data is silently deleted. */
  async archiveEntries(entries: LogEntry[]): Promise<string> {
    const path = `${this.logPath}.dropped-${Date.now()}`;
    await this.writeAtomic(path, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
    return path;
  }

  async hasData(): Promise<{ logEntries: number }> {
    const a = await this.readLog();
    const b = await this.readLog(this.prevLogPath);
    return { logEntries: a.entries.length + b.entries.length };
  }

  async listCorrupt(): Promise<string[]> {
    return (await readdir(this.dir)).filter((f) => f.startsWith('state.json.corrupt-'));
  }

  // ---- durable primitives -----------------------------------------------------------------------

  /** Write temp, fsync it, rename, fsync the directory. */
  private async writeAtomic(path: string, data: string): Promise<void> {
    const tmp = `${path}.${process.pid}.tmp`;
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
    await this.syncDir();
  }

  private async syncDir(): Promise<void> {
    let fh: FileHandle | undefined;
    try {
      fh = await open(this.dir, 'r');
      await fh.sync();
    } catch (e) {
      // Directories cannot be fsynced on every platform (e.g. Windows).
      if (!['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP', 'EBADF', 'EACCES'].includes(errno(e) ?? '')) throw e;
    } finally {
      await fh?.close().catch(() => {});
    }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errno(e) === 'EPERM';
  }
}

