import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sample from '@flat/scene/fixtures/sample.flat.json';
import {
  Autosaver,
  bootDocument,
  buildDoc,
  createBrowserAdapter,
  isDocumentDirty,
  installAutosave,
  parsePersisted,
  rejectedKeysToPrune,
  type KeyValueStore,
  useDocumentStatus,
  type PersistedDoc,
  type StorageAdapter,
} from './persistence';
import { useSceneStore } from './sceneStore';

const text = JSON.stringify(sample);

function memoryAdapter(initial: unknown = null) {
  const a = {
    stored: initial,
    writes: 0,
    failWith: null as Error | null,
    read: () => Promise.resolve(a.stored),
    quarantined: [] as { raw: unknown; ts: number }[],
    quarantine: (raw: unknown, ts: number) => {
      a.quarantined.push({ raw, ts });
      return Promise.resolve();
    },
    write: (doc: PersistedDoc) => {
      if (a.failWith) return Promise.reject(a.failWith);
      a.writes++;
      a.stored = structuredClone(doc);
      return Promise.resolve();
    },
  };
  return a;
}

function editedDoc(): PersistedDoc {
  const s = useSceneStore.getState();
  s.loadText(text, 'sample');
  s.dispatch({ type: 'site.set', site: { northAngle: 77 } });
  const after = useSceneStore.getState();
  return buildDoc(after.scene!, after.source, after.history.past);
}

beforeEach(() => {
  useDocumentStatus.setState({ autosave: 'idle', savedAt: null, reason: null, bootNotice: null, pause: null });
  useSceneStore.setState({ scene: null });
});

describe('parsePersisted', () => {
  it('accepts a saved document and restores the history tail', () => {
    const doc = editedDoc();
    const parsed = parsePersisted(structuredClone(doc));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.scene.site.northAngle).toBe(77);
      expect(parsed.historyTail).toHaveLength(1);
    }
  });

  it('rejects garbage, unknown versions and invalid scenes', () => {
    expect(parsePersisted('{oops').ok).toBe(false);
    expect(parsePersisted(null).ok).toBe(false);
    expect(parsePersisted({ ...editedDoc(), schemaVersion: 2 }).ok).toBe(false);
    expect(parsePersisted({ ...editedDoc(), scene: { version: 1 } }).ok).toBe(false);
  });

  it('drops a corrupt history tail but keeps the scene', () => {
    const parsed = parsePersisted({ ...editedDoc(), historyTail: [{ envelope: 1, inverse: 2 }] });
    expect(parsed.ok && parsed.historyTail).toEqual([]);
  });

  it('keeps only the last 50 history entries', () => {
    const doc = editedDoc();
    const past = Array.from({ length: 80 }, () => doc.historyTail[0]!);
    expect(buildDoc(doc.scene, 'x', past).historyTail).toHaveLength(50);
  });
});

describe('bootDocument', () => {
  it('restores a valid document with its history', async () => {
    const adapter = memoryAdapter(structuredClone(editedDoc()));
    await bootDocument(adapter);
    const s = useSceneStore.getState();
    expect(s.scene?.site.northAngle).toBe(77);
    expect(s.canUndo).toBe(true);
    expect(useDocumentStatus.getState().bootNotice).toBeNull();
    s.undo();
    expect(useSceneStore.getState().scene?.site.northAngle).not.toBe(77);
  });

  it('opens the default flat silently when nothing is saved', async () => {
    await bootDocument(memoryAdapter(null));
    expect(useSceneStore.getState().scene).not.toBeNull();
    expect(useDocumentStatus.getState().bootNotice).toBeNull();
  });

  it('falls back to the default flat with a notice for a corrupt blob', async () => {
    await bootDocument(memoryAdapter('{not a document'));
    expect(useSceneStore.getState().scene).not.toBeNull();
    expect(useDocumentStatus.getState().bootNotice).toMatch(/could not be restored/);
  });

  it('falls back with a notice for an invalid scene inside a valid envelope', async () => {
    await bootDocument(memoryAdapter({ ...editedDoc(), scene: { version: 1, name: 5 } }));
    expect(useSceneStore.getState().scene).not.toBeNull();
    expect(useDocumentStatus.getState().bootNotice).toMatch(/invalid/);
  });

  it('reports unreadable storage as autosave unavailable and still boots', async () => {
    const adapter = memoryAdapter();
    adapter.read = () => Promise.reject(new Error('denied'));
    await bootDocument(adapter);
    expect(useSceneStore.getState().scene).not.toBeNull();
    expect(useDocumentStatus.getState().autosave).toBe('unavailable');
  });

  it('does not hang on storage that never answers', async () => {
    const adapter = memoryAdapter();
    adapter.read = () => new Promise(() => undefined);
    await bootDocument(adapter, 20);
    expect(useSceneStore.getState().scene).not.toBeNull();
  });
});

describe('Autosaver', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces writes by 500 ms and saves the latest document', async () => {
    const adapter = memoryAdapter();
    let n = 0;
    const saver = new Autosaver(adapter, () => ({ ...editedDoc(), source: `s${++n}` }));
    saver.schedule();
    await vi.advanceTimersByTimeAsync(400);
    saver.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(adapter.writes).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(adapter.writes).toBe(1);
    expect(useDocumentStatus.getState().autosave).toBe('saved');
  });

  it('flush saves immediately and only when dirty', async () => {
    const adapter = memoryAdapter();
    const saver = new Autosaver(adapter, () => editedDoc());
    await saver.flush();
    expect(adapter.writes).toBe(0);
    saver.schedule();
    await saver.flush();
    expect(adapter.writes).toBe(1);
    await saver.flush();
    expect(adapter.writes).toBe(1);
  });

  it('surfaces quota and denied errors as unavailable and never throws', async () => {
    const adapter = memoryAdapter();
    const saver = new Autosaver(adapter, () => editedDoc());
    adapter.failWith = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    saver.schedule();
    await expect(saver.flush()).resolves.toBeUndefined();
    expect(useDocumentStatus.getState()).toMatchObject({ autosave: 'unavailable', reason: 'browser storage is full' });
    adapter.failWith = new Error('denied');
    saver.schedule();
    await saver.flush();
    expect(useDocumentStatus.getState().reason).toBe('browser storage is blocked');
    adapter.failWith = null;
    saver.schedule();
    await saver.flush();
    expect(useDocumentStatus.getState().autosave).toBe('saved');
  });
});

describe('a failed restore never lets an edit overwrite the saved flat', () => {
  beforeEach(() => {
    const target = { addEventListener: () => undefined, removeEventListener: () => undefined, visibilityState: 'visible' };
    vi.stubGlobal('document', target);
    vi.stubGlobal('window', target);
  });
  afterEach(() => vi.unstubAllGlobals());
  const edit = () => useSceneStore.getState().dispatch({ type: 'site.set', site: { northAngle: 11 } });

  async function bootAndEdit(adapter: ReturnType<typeof memoryAdapter>, timeoutMs?: number) {
    await bootDocument(adapter, timeoutMs);
    const off = installAutosave(adapter);
    edit();
    await new Promise((r) => setTimeout(r, 700));
    return off;
  }

  const cases: [string, unknown][] = [
    ['a newer schema version', { ...editedDoc(), schemaVersion: 2 }],
    ['a corrupt blob', '{not json'],
    ['an invalid scene', { ...editedDoc(), scene: { version: 1 } }],
  ];
  for (const [name, raw] of cases) {
    it(`keeps ${name}: copied aside, autosave paused, nothing written`, async () => {
      const adapter = memoryAdapter(structuredClone(raw));
      const off = await bootAndEdit(adapter);
      expect(adapter.writes).toBe(0);
      expect(adapter.stored).toEqual(raw);
      expect(adapter.quarantined).toHaveLength(1);
      expect(adapter.quarantined[0]!.raw).toEqual(raw);
      expect(useDocumentStatus.getState()).toMatchObject({ pause: 'failed', autosave: 'paused' });
      expect(useDocumentStatus.getState().bootNotice).toMatch(/could not be restored/);
      off();
    });
  }

  it('Keep editing resumes autosave and overwrites the saved flat with the open one', async () => {
    const adapter = memoryAdapter('{not json');
    const off = await bootAndEdit(adapter);
    useDocumentStatus.getState().resolvePause('keepEditing');
    await new Promise((r) => setTimeout(r, 20));
    expect(adapter.writes).toBeGreaterThan(0);
    expect((adapter.stored as PersistedDoc).scene.site.northAngle).toBe(11);
    expect(useDocumentStatus.getState()).toMatchObject({ pause: null, autosave: 'saved', bootNotice: null });
    off();
  });

  it('Start fresh reopens the default flat and resumes autosave', async () => {
    const adapter = memoryAdapter('{not json');
    const off = await bootAndEdit(adapter);
    useDocumentStatus.getState().resolvePause('startFresh');
    await new Promise((r) => setTimeout(r, 20));
    expect((adapter.stored as PersistedDoc).scene.site.northAngle).not.toBe(11);
    expect(useDocumentStatus.getState().pause).toBeNull();
    off();
  });

  it('a slow read keeps waiting: paused "loading", no writes, and the saved flat opens when it arrives', async () => {
    const saved = structuredClone(editedDoc());
    const adapter = memoryAdapter();
    let deliver: (v: unknown) => void = () => undefined;
    adapter.read = () => new Promise((resolve) => (deliver = resolve));
    await bootDocument(adapter, 10);
    expect(useDocumentStatus.getState()).toMatchObject({ pause: 'loading', autosave: 'paused' });
    expect(useDocumentStatus.getState().bootNotice).toMatch(/Loading your saved flat/);
    deliver(saved);
    await new Promise((r) => setTimeout(r, 10));
    expect(useSceneStore.getState().scene?.site.northAngle).toBe(77);
    expect(useDocumentStatus.getState()).toMatchObject({ pause: null, bootNotice: null });
    expect(adapter.writes).toBe(0);
  });

  it('a slow read that arrives after an edit is kept aside and asks the user, without writing', async () => {
    const saved = structuredClone(editedDoc());
    const adapter = memoryAdapter(null);
    let deliver: (v: unknown) => void = () => undefined;
    adapter.read = () => new Promise((resolve) => (deliver = resolve));
    await bootDocument(adapter, 10);
    const off = installAutosave(adapter);
    edit();
    await new Promise((r) => setTimeout(r, 700));
    expect(adapter.writes).toBe(0);
    deliver(saved);
    await new Promise((r) => setTimeout(r, 10));
    expect(useDocumentStatus.getState()).toMatchObject({ pause: 'failed', autosave: 'paused' });
    expect(adapter.quarantined[0]!.raw).toEqual(saved);
    expect(adapter.writes).toBe(0);
    off();
  });

  it('a slow read of an empty store resumes and saves the edits made meanwhile', async () => {
    const adapter = memoryAdapter(null);
    let deliver: (v: unknown) => void = () => undefined;
    adapter.read = () => new Promise((resolve) => (deliver = resolve));
    await bootDocument(adapter, 10);
    const off = installAutosave(adapter);
    edit();
    await new Promise((r) => setTimeout(r, 700));
    deliver(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(adapter.writes).toBe(1);
    expect(useDocumentStatus.getState().pause).toBeNull();
    off();
  });
});

describe('isDocumentDirty', () => {
  it('is false for the untouched default flat, true after an edit or for another source', () => {
    useSceneStore.setState({ scene: null });
    expect(isDocumentDirty()).toBe(false);
    useSceneStore.getState().loadText(JSON.stringify(sample), 'import.flat.json');
    expect(isDocumentDirty()).toBe(true);
  });
});

describe('Autosaver resilience', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries a failed write with backoff until it succeeds', async () => {
    const adapter = memoryAdapter();
    const saver = new Autosaver(adapter, () => editedDoc());
    adapter.failWith = new Error('denied');
    saver.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(useDocumentStatus.getState().autosave).toBe('unavailable');
    adapter.failWith = null;
    await vi.advanceTimersByTimeAsync(999);
    expect(adapter.writes).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(adapter.writes).toBe(1);
    expect(useDocumentStatus.getState().autosave).toBe('saved');
  });

  it('flushOnHide writes the sync backup while an async write is in flight', async () => {
    const adapter = memoryAdapter();
    const syncWrites: PersistedDoc[] = [];
    (adapter as StorageAdapter).writeSync = (d) => void syncWrites.push(d);
    let finish: () => void = () => undefined;
    adapter.write = () => new Promise<void>((resolve) => (finish = resolve));
    const saver = new Autosaver(adapter, () => editedDoc());
    saver.schedule();
    await vi.advanceTimersByTimeAsync(500); // debounce fired: the IDB write is now in flight
    saver.flushOnHide();
    expect(syncWrites).toHaveLength(1);
    finish();
  });

  it('flushOnHide is a no-op when nothing is unsaved and paused autosave never writes', async () => {
    const adapter = memoryAdapter();
    const syncWrites: PersistedDoc[] = [];
    (adapter as StorageAdapter).writeSync = (d) => void syncWrites.push(d);
    const saver = new Autosaver(adapter, () => editedDoc());
    saver.flushOnHide();
    expect(syncWrites).toHaveLength(0);
    useDocumentStatus.setState({ pause: 'failed', autosave: 'paused' });
    saver.schedule();
    saver.flushOnHide();
    await vi.advanceTimersByTimeAsync(1000);
    expect(syncWrites).toHaveLength(0);
    expect(adapter.writes).toBe(0);
  });
});

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

function fakeKv(): KeyValueStore & { data: Map<string, unknown>; down: boolean } {
  const kv = {
    data: new Map<string, unknown>(),
    down: false,
    get: (k: string) => (kv.down ? Promise.reject(new Error('idb down')) : Promise.resolve(kv.data.get(k) ?? null)),
    put: (k: string, v: unknown) => {
      if (kv.down) return Promise.reject(new Error('idb down'));
      kv.data.set(k, structuredClone(v));
      return Promise.resolve();
    },
    keys: () => Promise.resolve([...kv.data.keys()]),
    remove: (keys: string[]) => {
      for (const k of keys) kv.data.delete(k);
      return Promise.resolve();
    },
  };
  return kv;
}

describe('browser adapter', () => {
  it('prefers the sync backup when it is newer than the IDB copy, and drops only a stale backup after an IDB write', async () => {
    const kv = fakeKv();
    const ls = fakeStorage();
    const adapter = createBrowserAdapter(kv, () => ls);
    const old = buildDoc(editedDoc().scene, 's', [], new Date(1000));
    const newer = buildDoc(editedDoc().scene, 's', [], new Date(3000));
    await adapter.write(old);
    adapter.writeSync!(newer);
    expect((await adapter.read() as PersistedDoc).savedAt).toBe(newer.savedAt);
    // an older in-flight IDB write completing after the pagehide backup must not delete that backup
    await adapter.write(buildDoc(newer.scene, 's', [], new Date(2000)));
    expect(ls.getItem('flat.autosave.v1')).not.toBeNull();
    await adapter.write(buildDoc(newer.scene, 's', [], new Date(4000)));
    expect(ls.getItem('flat.autosave.v1')).toBeNull();
  });

  it('falls back to localStorage when IDB is down, and throws only when both are', async () => {
    const kv = fakeKv();
    kv.down = true;
    const ls = fakeStorage();
    const adapter = createBrowserAdapter(kv, () => ls);
    const doc = editedDoc();
    await adapter.write(doc);
    expect((await adapter.read() as PersistedDoc).savedAt).toBe(doc.savedAt);
    const dead = { ...ls, getItem: () => { throw new Error('blocked'); } } as unknown as Storage;
    await expect(createBrowserAdapter(kv, () => dead).read()).rejects.toThrow();
  });

  it('quarantines rejected values and keeps only the newest 3', async () => {
    const kv = fakeKv();
    const ls = fakeStorage();
    const adapter = createBrowserAdapter(kv, () => ls);
    for (const ts of [1, 2, 3, 4, 5]) await adapter.quarantine!({ n: ts }, ts);
    const idbKeys = [...kv.data.keys()].sort();
    expect(idbKeys).toEqual(['flat.autosave.rejected.3', 'flat.autosave.rejected.4', 'flat.autosave.rejected.5']);
    expect(ls.getItem('flat.autosave.rejected.5')).toBe('{"n":5}');
    expect(ls.getItem('flat.autosave.rejected.2')).toBeNull();
    expect(rejectedKeysToPrune(['flat.autosave.rejected.10', 'flat.autosave.rejected.9', 'flat.autosave.rejected.8', 'flat.autosave.rejected.7', 'other'])).toEqual(['flat.autosave.rejected.7']);
  });
});
