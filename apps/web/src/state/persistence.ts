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
  /**
   * Keeps a copy of a stored value that could not be restored under `flat.autosave.rejected.<ts>`
   * (newest 3 kept), so the first edit after a failed restore cannot destroy it. Rejects when no copy could be made.
   */
  quarantine?: (raw: unknown, ts: number) => Promise<void>;
}

export const REJECTED_PREFIX = 'flat.autosave.rejected.';
export const REJECTED_KEEP = 3;

/** Keys of rejected copies to delete so that only the newest `keep` remain (keys end in a numeric timestamp). */
export function rejectedKeysToPrune(keys: string[], keep: number = REJECTED_KEEP): string[] {
  const stamp = (k: string): number => Number(k.slice(REJECTED_PREFIX.length));
  return [...new Set(keys)]
    .filter((k) => k.startsWith(REJECTED_PREFIX))
    .sort((a, b) => stamp(b) - stamp(a))
    .slice(keep);
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
    for (const e of doc.historyTail as { envelope?: unknown; inverse?: unknown; label?: unknown }[]) {
      const envelope = CommandEnvelope.safeParse(e?.envelope);
      const inverse = Command.safeParse(e?.inverse);
      if (!envelope.success || !inverse.success) {
        historyTail.length = 0; // a partial tail would not undo cleanly
        break;
      }
      historyTail.push({ envelope: envelope.data, inverse: inverse.data, ...(typeof e.label === 'string' ? { label: e.label.slice(0, 200) } : {}) });
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

export type AutosaveState = 'idle' | 'saving' | 'saved' | 'unavailable' | 'paused';

/**
 * Why autosave is paused (nothing is written while it is): 'loading' = the saved flat is still being read
 * (it resumes by itself), 'failed' = the saved flat could not be restored; the user must choose.
 */
export type AutosavePause = 'loading' | 'failed';
export type PauseChoice = 'startFresh' | 'keepEditing';

interface DocumentStatus {
  autosave: AutosaveState;
  savedAt: string | null;
  /** Why autosave is unavailable. */
  reason: string | null;
  /** Non-blocking message shown after boot (e.g. a saved flat could not be restored). */
  bootNotice: string | null;
  dismissBootNotice: () => void;
  /** Non-null while autosave is paused to protect a saved flat that was not restored. */
  pause: AutosavePause | null;
  /** 'failed' pause only: "Start fresh" reopens the default flat; "Keep editing" overwrites the saved flat with the open one. Both resume autosave. */
  resolvePause: (choice: PauseChoice) => void;
}

export const useDocumentStatus = create<DocumentStatus>((set) => ({
  autosave: 'idle',
  savedAt: null,
  reason: null,
  bootNotice: null,
  dismissBootNotice: () => set({ bootNotice: null }),
  pause: null,
  resolvePause: (choice) => resolvePause(choice),
}));

const isPaused = (): boolean => useDocumentStatus.getState().pause !== null;

function resolvePause(choice: PauseChoice): void {
  if (useDocumentStatus.getState().pause !== 'failed') return;
  if (choice === 'startFresh') loadDefault();
  useDocumentStatus.setState({ pause: null, autosave: 'idle', reason: null, bootNotice: null });
  autosaver?.markDirty(); // the open flat replaces the saved one now
  void autosaver?.flush();
}

function failureReason(error: unknown): string {
  const name = error instanceof Error || (typeof error === 'object' && error !== null && 'name' in error) ? String((error as { name: unknown }).name) : '';
  return name === 'QuotaExceededError' ? 'browser storage is full' : 'browser storage is blocked';
}

// ----------------------------------------------------------------- autosaver

export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 30_000;
export const RETRY_ATTEMPTS = 8;

export class Autosaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;
  private writing = 0;
  private failures = 0;
  private inflight: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: StorageAdapter,
    private readonly getDoc: () => PersistedDoc | null,
    private readonly delayMs: number = AUTOSAVE_DELAY_MS,
  ) {}

  /** Marks the document dirty without scheduling. */
  markDirty(): void {
    this.pending = true;
  }

  /** Marks the document dirty; saves after the debounce delay. */
  schedule(): void {
    this.pending = true;
    this.clearTimers();
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  private clearTimers(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
  }

  /** Saves now if dirty (and not paused). Never rejects; resolves once the write finished (or failed). */
  flush(): Promise<void> {
    this.clearTimers();
    if (!this.pending || isPaused()) return this.inflight;
    this.pending = false;
    const doc = this.getDoc();
    if (!doc) return this.inflight;
    useDocumentStatus.setState({ autosave: 'saving' });
    this.writing++;
    this.inflight = this.inflight.then(async () => {
      try {
        await this.adapter.write(doc);
        this.failures = 0;
        if (!isPaused()) useDocumentStatus.setState({ autosave: 'saved', savedAt: doc.savedAt, reason: null });
      } catch (error) {
        this.pending = true; // still unsaved: retry with backoff
        this.failures++;
        if (!isPaused()) useDocumentStatus.setState({ autosave: 'unavailable', reason: failureReason(error) });
        if (this.timer === null && this.retryTimer === null && this.failures <= RETRY_ATTEMPTS) {
          const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.failures - 1));
          this.retryTimer = setTimeout(() => void this.flush(), wait);
        }
      } finally {
        this.writing--;
      }
    });
    return this.inflight;
  }

  /**
   * For `pagehide`: whenever there is unsaved state or a write in flight (which the browser may drop),
   * also write the synchronous backup, which read-back prefers when it is newer than the stored copy.
   */
  flushOnHide(): void {
    if (isPaused() || (!this.pending && this.writing === 0)) return;
    const doc = this.getDoc();
    if (this.pending) void this.flush();
    if (doc) {
      try {
        this.adapter.writeSync?.(doc);
      } catch {
        // best effort
      }
    }
  }

  dispose(): void {
    this.clearTimers();
    this.pending = false;
  }
}

// ----------------------------------------------------------- browser adapter

/** The slice of IndexedDB the adapter needs (abstracted so tests can use an in-memory fake). */
export interface KeyValueStore {
  get: (key: string) => Promise<unknown>;
  put: (key: string, value: unknown) => Promise<void>;
  keys: () => Promise<string[]>;
  remove: (keys: string[]) => Promise<void>;
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

async function withDb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | null): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
  } finally {
    db.close();
  }
}

export function createIdbStore(): KeyValueStore {
  return {
    get: async (key) => (await withDb('readonly', (st) => st.get(key))) ?? null,
    put: async (key, value) => {
      await withDb('readwrite', (st) => st.put(value, key));
    },
    keys: async () => ((await withDb('readonly', (st) => st.getAllKeys())) ?? []).map(String),
    remove: async (keys) => {
      await withDb('readwrite', (st) => {
        for (const k of keys) st.delete(k);
        return null;
      });
    },
  };
}

function lsRead(ls: Storage): unknown {
  const text = ls.getItem(LOCAL_STORAGE_KEY);
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
export function createBrowserAdapter(idb: KeyValueStore = createIdbStore(), getLs: () => Storage = () => localStorage): StorageAdapter {
  return {
    async read() {
      let stored: unknown = null;
      let backup: unknown = null;
      let idbOk = true;
      let lsOk = true;
      try {
        stored = (await idb.get(KEY)) ?? null;
      } catch {
        idbOk = false;
      }
      try {
        backup = lsRead(getLs());
      } catch {
        lsOk = false;
      }
      if (!idbOk && !lsOk) throw new Error('no storage available');
      if (stored === null) return backup;
      if (backup === null) return stored;
      return savedAtOf(backup) > savedAtOf(stored) ? backup : stored; // a pagehide backup newer than the last IDB write
    },
    async write(doc) {
      try {
        await idb.put(KEY, doc);
      } catch {
        getLs().setItem(LOCAL_STORAGE_KEY, JSON.stringify(doc)); // throws when blocked or full
        return;
      }
      try {
        // IDB now holds this document; drop the backup unless a newer pagehide write landed meanwhile.
        const ls = getLs();
        const backup = lsRead(ls);
        if (backup !== null && savedAtOf(backup) <= savedAtOf(doc)) ls.removeItem(LOCAL_STORAGE_KEY);
      } catch {
        // ignore
      }
    },
    writeSync(doc) {
      getLs().setItem(LOCAL_STORAGE_KEY, JSON.stringify(doc));
    },
    async quarantine(raw, ts) {
      const key = `${REJECTED_PREFIX}${ts}`;
      let saved = false;
      try {
        await idb.put(key, raw);
        await idb.remove(rejectedKeysToPrune([...(await idb.keys()), key]));
        saved = true;
      } catch {
        // fall through to localStorage
      }
      try {
        const ls = getLs();
        ls.setItem(key, typeof raw === 'string' ? raw : JSON.stringify(raw));
        const keys: string[] = [];
        for (let i = 0; i < ls.length; i++) keys.push(ls.key(i) ?? '');
        for (const k of rejectedKeysToPrune([...keys, key])) ls.removeItem(k);
        saved = true;
      } catch {
        // quota: IDB copy (if any) is enough
      }
      if (!saved) throw new Error('could not keep a copy of the unreadable save');
    },
  };
}

// ------------------------------------------------------------------ boot/wiring

function loadDefault(): void {
  useSceneStore.getState().loadText(DEFAULT_FIXTURE.text, DEFAULT_FIXTURE.id);
}

/** True when the open document differs from the pristine built-in flat (an import, edits, or a restored save). */
export function isDocumentDirty(): boolean {
  const s = useSceneStore.getState();
  const scene = committedScene(s);
  if (!scene) return false;
  if (s.canUndo || s.history.past.length > 0) return true;
  if (s.source !== DEFAULT_FIXTURE.id) return true;
  return serializeScene(scene) !== serializeScene(parseDefault());
}

let defaultScene: Scene | null = null;
function parseDefault(): Scene {
  if (!defaultScene) {
    const parsed = parseScene(JSON.parse(DEFAULT_FIXTURE.text));
    if (!parsed.ok) throw new Error('the built-in flat is invalid');
    defaultScene = parsed.scene;
  }
  return defaultScene;
}

type ReadOutcome = { kind: 'value'; value: unknown } | { kind: 'error'; error: unknown } | { kind: 'slow' };

/** Copies a rejected stored value aside; resolves to whether a copy was made. */
async function keepRejected(adapter: StorageAdapter, raw: unknown): Promise<boolean> {
  try {
    await adapter.quarantine?.(raw, Date.now());
    return adapter.quarantine !== undefined;
  } catch {
    return false;
  }
}

/** Opens `raw` if it is a valid document. Returns the failure reason otherwise. */
function tryRestore(raw: unknown): string | null {
  const parsed = parsePersisted(raw);
  const store = useSceneStore.getState();
  if (parsed.ok && store.loadText(JSON.stringify(parsed.scene), parsed.source || 'autosave').ok) {
    store.restoreHistory(parsed.historyTail);
    return null;
  }
  return parsed.ok ? 'it failed to load' : parsed.reason;
}

async function rejectSaved(adapter: StorageAdapter, raw: unknown, reason: string): Promise<void> {
  // Copy first: nothing may be written over the saved flat before it is safe (autosave stays paused until the user chooses).
  const kept = await keepRejected(adapter, raw);
  useDocumentStatus.setState({
    pause: 'failed',
    autosave: 'paused',
    reason: 'your saved flat was not restored',
    bootNotice: `Your last session could not be restored (${reason}). The ${DEFAULT_FIXTURE.label} is open instead. Autosave is paused so the saved flat is not overwritten${kept ? ' (a copy of it was kept)' : ''}.`,
  });
}

/**
 * Opens the autosaved document if it is valid; otherwise opens the default flat, says why in
 * `bootNotice` and PAUSES autosave (after copying the rejected value aside) until the user picks
 * `resolvePause('startFresh' | 'keepEditing')`. A first visit with nothing saved gets no notice.
 * A read slower than `readTimeoutMs` opens the default flat with autosave paused ("loading") and keeps
 * waiting for the read: a saved flat that arrives while nothing was edited is opened, else it is kept aside
 * and the user chooses. Never throws.
 */
export async function bootDocument(adapter: StorageAdapter, readTimeoutMs: number = BOOT_READ_TIMEOUT_MS): Promise<void> {
  const read: Promise<ReadOutcome> = Promise.resolve()
    .then(() => adapter.read())
    .then(
      (value): ReadOutcome => ({ kind: 'value', value }),
      (error: unknown): ReadOutcome => ({ kind: 'error', error }),
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<ReadOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'slow' }), readTimeoutMs);
  });
  const outcome = await Promise.race([read, slow]);
  clearTimeout(timer);

  if (outcome.kind === 'slow') {
    loadDefault();
    useDocumentStatus.setState({ pause: 'loading', autosave: 'paused', reason: 'loading your saved flat', bootNotice: 'Loading your saved flat… (autosave is paused until it has loaded)' });
    void read.then((late) => finishLateRead(adapter, late));
    return;
  }
  await handleRead(adapter, outcome);
}

async function handleRead(adapter: StorageAdapter, outcome: ReadOutcome): Promise<void> {
  if (outcome.kind === 'error') {
    useDocumentStatus.setState({ autosave: 'unavailable', reason: failureReason(outcome.error) });
    loadDefault();
    return;
  }
  const raw = outcome.kind === 'value' ? outcome.value : null;
  if (raw === null || raw === undefined) {
    loadDefault();
    return;
  }
  const failure = tryRestore(raw);
  if (failure === null) return;
  loadDefault();
  await rejectSaved(adapter, raw, failure);
}

async function finishLateRead(adapter: StorageAdapter, outcome: ReadOutcome): Promise<void> {
  const resume = (patch: Partial<DocumentStatus> = {}) => {
    useDocumentStatus.setState({ pause: null, autosave: 'idle', reason: null, bootNotice: null, ...patch });
    void autosaver?.flush(); // edits made while waiting are saved now
  };
  if (outcome.kind === 'error') return resume({ autosave: 'unavailable', reason: failureReason(outcome.error) });
  const raw = outcome.kind === 'value' ? outcome.value : null;
  if (raw === null || raw === undefined) return resume();
  const parsed = parsePersisted(raw);
  if (!isDocumentDirty() && parsed.ok && tryRestore(raw) === null) return resume();
  await rejectSaved(adapter, raw, parsed.ok ? 'it arrived after you started editing' : parsed.reason);
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
