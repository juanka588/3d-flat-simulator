import { Command, CommandEnvelope, parseScene, serializeScene } from '@flat/scene';
import type { HistoryEntry, Scene } from '@flat/scene';
import { create } from 'zustand';
import { DEFAULT_FIXTURE } from './fixtures';
import { committedScene, useSceneStore } from './sceneStore';

/** Autosaved document (M3.6). Bump `schemaVersion` on incompatible changes; unknown versions are not restored. */
export interface PersistedDoc {
  schemaVersion: 1;
  scene: Scene;
  /** Last entries of the undo stack, oldest first, so undo still works after a reload. */
  historyTail: HistoryEntry[];
  /** ISO timestamp of the save. */
  savedAt: string;
  /** Fixture id or file name, which also selects the generated site context. */
  source: string;
}

export const HISTORY_TAIL = 50;
export const AUTOSAVE_DELAY_MS = 500;
export const BOOT_READ_TIMEOUT_MS = 3000;
const DB_NAME = 'flat-simulator';
const STORE = 'documents';
const KEY = 'current';
export const LOCAL_STORAGE_KEY = 'flat.autosave.v1';

/** Where the document lives. Implementations may throw/reject (blocked, quota); callers never let that escape. */
export interface StorageAdapter {
  /** The raw stored value, or null when nothing is stored. Rejects when storage is unreadable. */
  read: () => Promise<unknown>;
  write: (doc: PersistedDoc) => Promise<void>;
  /** Best-effort synchronous write for `pagehide`, when async writes may be dropped. */
  writeSync?: (doc: PersistedDoc) => void;
}

// ---------------------------------------------------------------- pure parts

export function buildDoc(scene: Scene, source: string, past: HistoryEntry[], now: Date = new Date()): PersistedDoc {
  return { schemaVersion: 1, scene, historyTail: past.slice(-HISTORY_TAIL), savedAt: now.toISOString(), source };
}

export type ParsedDoc = { ok: true; scene: Scene; source: string; historyTail: HistoryEntry[]; savedAt: string } | { ok: false; reason: string };

/** Validates a stored value. A bad history tail is dropped (the scene still restores); a bad scene is an error. */
export function parsePersisted(raw: unknown): ParsedDoc {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'the saved data is not a document' };
  const doc = raw as Record<string, unknown>;
  if (doc.schemaVersion !== 1) return { ok: false, reason: `unsupported save format (version ${String(doc.schemaVersion)})` };
  const scene = parseScene(doc.scene);
  if (!scene.ok) return { ok: false, reason: `the saved flat is invalid (${scene.errors[0] ?? 'unknown error'})` };
  const source = typeof doc.source === 'string' ? doc.source : '';
  const savedAt = typeof doc.savedAt === 'string' ? doc.savedAt : '';
  const historyTail: HistoryEntry[] = [];
  if (Array.isArray(doc.historyTail)) {
    for (const e of doc.historyTail as { envelope?: unknown; inverse?: unknown }[]) {
      const envelope = CommandEnvelope.safeParse(e?.envelope);
      const inverse = Command.safeParse(e?.inverse);
      if (!envelope.success || !inverse.success) {
        historyTail.length = 0; // a partial tail would not undo cleanly
        break;
      }
      historyTail.push({ envelope: envelope.data, inverse: inverse.data });
    }
  }
  return { ok: true, scene: scene.scene, source, historyTail, savedAt };
}

/** `.flat.json` text of the committed scene, or null when no scene is loaded. */
export function exportSceneText(): string | null {
  const scene = committedScene(useSceneStore.getState());
  return scene ? serializeScene(scene) : null;
}

// ------------------------------------------------------------------- status

export type AutosaveState = 'idle' | 'saving' | 'saved' | 'unavailable';

interface DocumentStatus {
  autosave: AutosaveState;
  savedAt: string | null;
  /** Why autosave is unavailable. */
  reason: string | null;
  /** Non-blocking message shown after boot (e.g. a saved flat could not be restored). */
  bootNotice: string | null;
  dismissBootNotice: () => void;
}

export const useDocumentStatus = create<DocumentStatus>((set) => ({
  autosave: 'idle',
  savedAt: null,
  reason: null,
  bootNotice: null,
  dismissBootNotice: () => set({ bootNotice: null }),
}));

function failureReason(error: unknown): string {
  const name = error instanceof Error || (typeof error === 'object' && error !== null && 'name' in error) ? String((error as { name: unknown }).name) : '';
  return name === 'QuotaExceededError' ? 'browser storage is full' : 'browser storage is blocked';
}

// ----------------------------------------------------------------- autosaver

export class Autosaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;
  private inflight: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: StorageAdapter,
    private readonly getDoc: () => PersistedDoc | null,
    private readonly delayMs: number = AUTOSAVE_DELAY_MS,
  ) {}

  /** Marks the document dirty; saves after the debounce delay. */
  schedule(): void {
    this.pending = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  /** Saves now if dirty. Never rejects; resolves once the write finished (or failed). */
  flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending) return this.inflight;
    this.pending = false;
    const doc = this.getDoc();
    if (!doc) return this.inflight;
    useDocumentStatus.setState({ autosave: 'saving' });
    this.inflight = this.inflight.then(async () => {
      try {
        await this.adapter.write(doc);
        useDocumentStatus.setState({ autosave: 'saved', savedAt: doc.savedAt, reason: null });
      } catch (error) {
        useDocumentStatus.setState({ autosave: 'unavailable', reason: failureReason(error) });
      }
    });
    return this.inflight;
  }

  /** For `pagehide`: starts the async save and also a synchronous best-effort write. */
  flushOnHide(): void {
    if (!this.pending) return;
    const doc = this.getDoc();
    void this.flush();
    if (doc) {
      try {
        this.adapter.writeSync?.(doc);
      } catch {
        // best effort
      }
    }
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = false;
  }
}

// ----------------------------------------------------------- browser adapter

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('indexedDB blocked'));
    } catch (error) {
      reject(error);
    }
  });
}

async function idbRead(): Promise<unknown> {
  const db = await openDb();
  try {
    return (await idbRequest(db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY))) ?? null;
  } finally {
    db.close();
  }
}

async function idbWrite(doc: PersistedDoc): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(doc, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
  } finally {
    db.close();
  }
}

function lsRead(): unknown {
  const text = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text; // not a document: parsePersisted reports it as corrupt
  }
}

const savedAtOf = (v: unknown): number => {
  const t = typeof v === 'object' && v !== null ? Date.parse(String((v as { savedAt?: unknown }).savedAt)) : NaN;
  return Number.isNaN(t) ? -1 : t;
};

/** IndexedDB first, localStorage as a fallback/backup. Throws only when no storage works at all. */
export function createBrowserAdapter(): StorageAdapter {
  return {
    async read() {
      let idb: unknown = null;
      let ls: unknown = null;
      let idbOk = true;
      let lsOk = true;
      try {
        idb = await idbRead();
      } catch {
        idbOk = false;
      }
      try {
        ls = lsRead();
      } catch {
        lsOk = false;
      }
      if (!idbOk && !lsOk) throw new Error('no storage available');
      if (idb === null) return ls;
      if (ls === null) return idb;
      return savedAtOf(ls) > savedAtOf(idb) ? ls : idb; // a pagehide backup newer than the last IDB write
    },
    async write(doc) {
      try {
        await idbWrite(doc);
      } catch {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(doc)); // throws when blocked or full
        return;
      }
      try {
        localStorage.removeItem(LOCAL_STORAGE_KEY); // IDB holds the newest; drop a stale backup
      } catch {
        // ignore
      }
    },
    writeSync(doc) {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(doc));
    },
  };
}

// ------------------------------------------------------------------ boot/wiring

function loadDefault(): void {
  useSceneStore.getState().loadText(DEFAULT_FIXTURE.text, DEFAULT_FIXTURE.id);
}

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('storage timed out')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Opens the autosaved document if it is valid; otherwise opens the default flat and says why in
 * `bootNotice` (a first visit with nothing saved gets no notice). Never throws.
 */
export async function bootDocument(adapter: StorageAdapter, readTimeoutMs: number = BOOT_READ_TIMEOUT_MS): Promise<void> {
  let raw: unknown;
  try {
    raw = await timeout(adapter.read(), readTimeoutMs);
  } catch (error) {
    useDocumentStatus.setState({ autosave: 'unavailable', reason: failureReason(error) });
    loadDefault();
    return;
  }
  if (raw === null || raw === undefined) {
    loadDefault();
    return;
  }
  const parsed = parsePersisted(raw);
  const store = useSceneStore.getState();
  if (parsed.ok && store.loadText(JSON.stringify(parsed.scene), parsed.source || 'autosave').ok) {
    store.restoreHistory(parsed.historyTail);
    return;
  }
  loadDefault();
  const reason = parsed.ok ? 'it failed to load' : parsed.reason;
  useDocumentStatus.setState({ bootNotice: `Your last session could not be restored (${reason}). The ${DEFAULT_FIXTURE.label} is open instead.` });
}

let autosaver: Autosaver | null = null;

/** Starts saving the committed document on every change (debounced) and when the page is hidden. */
export function installAutosave(adapter: StorageAdapter): () => void {
  autosaver?.dispose();
  const saver = new Autosaver(adapter, () => {
    const s = useSceneStore.getState();
    const scene = committedScene(s);
    return scene ? buildDoc(scene, s.source, s.history.past) : null;
  });
  autosaver = saver;
  const unsubscribe = useSceneStore.subscribe((s, prev) => {
    if (committedScene(s) !== committedScene(prev) || s.history !== prev.history) saver.schedule();
  });
  const onHide = () => {
    if (document.visibilityState === 'hidden') saver.flushOnHide();
  };
  const onPageHide = () => saver.flushOnHide();
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);
  return () => {
    unsubscribe();
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onPageHide);
    saver.dispose();
    if (autosaver === saver) autosaver = null;
  };
}

/** Saves now if there are unsaved changes; resolves when the write finished (never rejects). */
export function flushAutosave(): Promise<void> {
  return autosaver ? autosaver.flush() : Promise.resolve();
}
