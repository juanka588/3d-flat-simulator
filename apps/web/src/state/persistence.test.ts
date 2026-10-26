import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sample from '@flat/scene/fixtures/sample.flat.json';
import {
  Autosaver,
  bootDocument,
  buildDoc,
  parsePersisted,
  useDocumentStatus,
  type PersistedDoc,
  type StorageAdapter,
} from './persistence';
import { useSceneStore } from './sceneStore';

const text = JSON.stringify(sample);

function memoryAdapter(initial: unknown = null): StorageAdapter & { stored: unknown; writes: number; failWith: Error | null } {
  const a = {
    stored: initial,
    writes: 0,
    failWith: null as Error | null,
    read: () => Promise.resolve(a.stored),
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
  useDocumentStatus.setState({ autosave: 'idle', savedAt: null, reason: null, bootNotice: null });
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
