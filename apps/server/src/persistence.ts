import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LogEntry, Scene, serializeScene, type History } from '@flat/scene';

/** Authoritative snapshot (scene + history + counters). `scene.flat.json` is a human-readable copy. */
export interface Snapshot {
  format: 1;
  epoch: string;
  rev: number;
  seq: number;
  scene: Scene;
  history: History;
}

export interface LoadedLog {
  entries: LogEntry[];
  /** Number of unreadable lines dropped (a torn last write, or corruption). */
  dropped: number;
}

export class Persistence {
  readonly snapshotPath: string;
  readonly sceneCopyPath: string;
  readonly logPath: string;

  constructor(readonly dir: string) {
    this.snapshotPath = join(dir, 'state.json');
    this.sceneCopyPath = join(dir, 'scene.flat.json');
    this.logPath = join(dir, 'log.ndjson');
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async readSnapshot(): Promise<{ snapshot?: Snapshot; problem?: string }> {
    let text: string;
    try {
      text = await readFile(this.snapshotPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      return { problem: String(e) };
    }
    try {
      const raw = JSON.parse(text) as Partial<Snapshot>;
      const scene = Scene.safeParse(raw.scene);
      if (raw.format !== 1 || !scene.success || typeof raw.epoch !== 'string' || !Number.isInteger(raw.rev) || !Number.isInteger(raw.seq) || !raw.history) {
        return { problem: 'state.json is not a valid snapshot' };
      }
      return { snapshot: { ...(raw as Snapshot), scene: scene.data } };
    } catch (e) {
      return { problem: `state.json: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async writeSnapshot(s: Snapshot): Promise<void> {
    await this.writeAtomic(this.snapshotPath, JSON.stringify(s));
    await this.writeAtomic(this.sceneCopyPath, serializeScene(s.scene));
  }

  /** Reads the log, stopping at the first unreadable line (a torn tail after a crash). */
  async readLog(): Promise<LoadedLog> {
    let text: string;
    try {
      text = await readFile(this.logPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], dropped: 0 };
      throw e;
    }
    const lines = text.split('\n');
    const entries: LogEntry[] = [];
    let dropped = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === '') continue;
      const parsed = this.parseLine(line);
      if (!parsed) {
        dropped = lines.slice(i).filter((l) => l.trim() !== '').length;
        break;
      }
      entries.push(parsed);
    }
    return { entries, dropped };
  }

  private parseLine(line: string): LogEntry | undefined {
    try {
      const r = LogEntry.safeParse(JSON.parse(line));
      return r.success ? r.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** The log is written before the response is sent, so an acknowledged command survives a crash. */
  async append(entry: LogEntry): Promise<void> {
    await appendFile(this.logPath, `${JSON.stringify(entry)}\n`);
  }

  async rewriteLog(entries: LogEntry[]): Promise<void> {
    await this.writeAtomic(this.logPath, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }

  private async writeAtomic(path: string, data: string): Promise<void> {
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, path);
  }
}
