import type { ApplyOk, ApplyResult, Changed, Command, CommandEnvelope, History, HistoryEntry, Scene } from '@flat/scene';
import { create } from 'zustand';
import {
  applyCommand,
  applyPreset,
  canRedo as historyCanRedo,
  canUndo as historyCanUndo,
  createHistory,
  describeCommand,
  loadSceneText,
  makeEnvelope,
  recordCommand,
  redo as historyRedo,
  undo as historyUndo,
} from '@flat/scene';
import type { LoadResult, ValidationWarning } from '@flat/scene';
import { adoptSceneIdentity } from '../viewer/scene-identity';
import { selectionForId } from '../viewer/selection';
import { newId } from './ids';
import { instantToLocal } from './localTime';
import { useViewStore } from './viewStore';
import type { CommandApi, CommandTransport, DispatchOptions, RemoteHistory } from './commands-api';

/** Today's date (YYYY-MM-DD) in a time zone, or null if the zone is unknown. */
function localDate(timezone: string): string | null {
  try {
    return instantToLocal(new Date(), timezone).date;
  } catch {
    return null;
  }
}

let latestLoad = 0;
/** Starts an asynchronous load; only the latest token may apply its result. */
export function beginLoad(): number {
  return ++latestLoad;
}
export function isLatestLoad(token: number): boolean {
  return token === latestLoad;
}

interface SceneStore extends CommandApi {
  /** The displayed scene: the committed one, or the preview of it while a preview is active. */
  scene: Scene | null;
  /** Where the current scene came from (fixture name or file name). */
  source: string;
  warnings: ValidationWarning[];
  /** Errors of the last failed load; the previous scene stays displayed. */
  errors: string[];
  /** Undo history (plain data; the autosave stores its tail). */
  history: History;
  /** The committed scene while a preview is displayed, else null. */
  previewBase: Scene | null;
  /** Envelope of the active preview. */
  previewEnv: CommandEnvelope | null;
  /** Options of the active preview (its label is kept for the commit). */
  previewOpts: DispatchOptions | undefined;
  /** Loads JSON text; on failure keeps the previous scene and records the errors. Resets history. */
  loadText: (text: string, source: string) => LoadResult;
  /** Records load errors (e.g. a file rejected before parsing) without touching the scene. */
  fail: (errors: string[]) => void;
  /** Replaces the undo stack (used when restoring an autosaved document). */
  restoreHistory: (past: HistoryEntry[]) => void;
  /** Server mode: the shared history as reported by the server (null = local mode). */
  remoteHistory: RemoteHistory | null;
  /** Server mode: sets the undo/redo flags and labels from the server's history (null leaves server mode). */
  setRemoteHistory: (h: (RemoteHistory & { canUndo: boolean; canRedo: boolean }) | null) => void;
  /** Server mode: sets only the flags (between history fetches). */
  setHistoryFlags: (canUndo: boolean, canRedo: boolean) => void;
}

/** The committed scene (never a preview). */
export function committedScene(s: Pick<SceneStore, 'scene' | 'previewBase'>): Scene | null {
  return s.previewBase ?? s.scene;
}

const NO_SCENE: ApplyResult = { ok: false, errors: [{ code: 'invalid_command', path: '', message: 'no scene is loaded' }] };

let transport: CommandTransport | null = null;

/** The plugged-in sync transport, if any (server mode). */
export function getTransport(): CommandTransport | null {
  return transport;
}

/** In server mode the server owns the history: nothing is recorded locally. */
const serverHistory = () => transport?.step !== undefined;

function flagsOf(history: History) {
  return {
    canUndo: historyCanUndo(history),
    canRedo: historyCanRedo(history),
    historyLabels: history.past.map((e) => e.label ?? (e.envelope.cmd.type === 'batch' ? e.envelope.cmd.label : e.envelope.cmd.type)),
    historyItems: history.past.map((e) => ({
      id: e.envelope.id,
      label: e.label ?? (e.envelope.cmd.type === 'batch' ? e.envelope.cmd.label : e.envelope.cmd.type),
      author: e.envelope.author.kind,
      ts: e.envelope.ts,
    })),
  };
}

/** The label recorded with a history entry: an explicit one, else the description computed against the scene it applied to. */
function entryLabel(env: CommandEnvelope, base: Scene, opts: DispatchOptions | undefined): string {
  return opts?.label ?? describeCommand(env.cmd, base);
}

/** Only a site edit leaves the built shell (walls, rooms, finishes) valid. */
function shellSurvives(changed: Changed): boolean {
  return changed.site && !changed.defaults && !changed.materials.length && !changed.walls.length && !changed.rooms.length && !changed.lights.length;
}

/** Keeps the camera framing (and the shell, when valid) across an edit. */
function adopt(prev: Scene, next: Scene, changed: Changed): void {
  if (prev !== next) adoptSceneIdentity(prev, next, { shell: shellSurvives(changed) });
}

/** The selection survives while its entity still exists. */
function keepSelection(scene: Scene): void {
  const view = useViewStore.getState();
  const sel = view.selection;
  if (sel && sel.kind !== 'context' && !selectionForId(scene, sel.entityId)) view.select(null);
  // A removed floor zone falls back to its room's floor.
  else if (sel?.zoneId && !scene.rooms.find((r) => r.id === sel.entityId)?.floorZones?.some((z) => z.id === sel.zoneId)) view.select({ kind: 'floor', entityId: sel.entityId });
}

function send(env: CommandEnvelope): void {
  try {
    transport?.send(env);
  } catch {
    // a failing transport must never break local editing
  }
}

function stamp(cmd: Command, opts: DispatchOptions | undefined): CommandEnvelope {
  const env = makeEnvelope(cmd, {
    id: newId(),
    ts: Date.now(),
    author: { kind: opts?.author ?? 'user' },
    ...(opts?.coalesceKey !== undefined ? { coalesceKey: opts.coalesceKey } : {}),
  });
  return env;
}

export const useSceneStore = create<SceneStore>((set, get) => ({
  scene: null,
  source: '',
  warnings: [],
  errors: [],
  history: createHistory(),
  previewBase: null,
  previewEnv: null,
  previewOpts: undefined,
  canUndo: false,
  canRedo: false,
  historyLabels: [],
  historyItems: [],
  lastErrors: [],
  rev: 0,

  dispatch: (cmd, opts) => {
    const s = get();
    const base = committedScene(s);
    if (!base || !s.scene) return NO_SCENE;
    const env = stamp(cmd, opts);
    const result = applyCommand(base, env);
    if (!result.ok) {
      set({ lastErrors: result.errors });
      return result;
    }
    if (result.noop) {
      // Nothing changed: drop a pending preview so the display shows the committed scene.
      if (s.previewBase) set({ scene: s.previewBase, previewBase: null, previewEnv: null, rev: s.rev + 1, lastErrors: [] });
      else set({ lastErrors: [] });
      return result;
    }
    adopt(s.scene, result.scene, result.changed);
    const history = serverHistory() ? s.history : recordCommand(s.history, env, result, env.ts, entryLabel(env, base, opts));
    set({ scene: result.scene, history, ...(serverHistory() ? {} : flagsOf(history)), previewBase: null, previewEnv: null, lastErrors: [], rev: s.rev + 1 });
    keepSelection(result.scene);
    send(env);
    return result;
  },

  preview: (cmd, opts) => {
    const s = get();
    const base = committedScene(s);
    if (!base || !s.scene) return NO_SCENE;
    const env = stamp(cmd, opts);
    const result = applyCommand(base, env);
    if (!result.ok) {
      set({ lastErrors: result.errors });
      return result;
    }
    adopt(s.scene, result.scene, result.changed);
    set({ scene: result.scene, previewBase: base, previewEnv: env, previewOpts: opts, lastErrors: [], rev: s.rev + 1 });
    keepSelection(result.scene);
    return result;
  },

  commitPreview: () => {
    const s = get();
    if (!s.previewBase || !s.previewEnv || !s.scene) return;
    // Re-apply on the committed scene only for the inverse; the displayed scene object is kept.
    const result = applyCommand(s.previewBase, s.previewEnv);
    if (!result.ok || result.noop) {
      set({ scene: s.previewBase, previewBase: null, previewEnv: null, rev: s.rev + 1 });
      return;
    }
    const history = serverHistory() ? s.history : recordCommand(s.history, s.previewEnv, result, s.previewEnv.ts, entryLabel(s.previewEnv, s.previewBase, s.previewOpts));
    set({ history, ...(serverHistory() ? {} : flagsOf(history)), previewBase: null, previewEnv: null, lastErrors: [] });
    send(s.previewEnv);
  },

  cancelPreview: () => {
    const s = get();
    if (!s.previewBase || !s.scene) return;
    adoptSceneIdentity(s.scene, s.previewBase, { shell: false });
    set({ scene: s.previewBase, previewBase: null, previewEnv: null, rev: s.rev + 1 });
    keepSelection(s.previewBase);
  },

  undo: () => stepHistory('undo'),
  redo: () => stepHistory('redo'),

  setTransport: (t) => {
    transport = t;
  },

  receiveRemote: (_env, result, opts) => {
    const s = get();
    if (!result.ok || !s.scene) return;
    const next = result.scene;
    // A different flat (other walls/rooms) re-frames the camera like a load; edits never do.
    const sameFlat = !opts?.replace || (JSON.stringify(s.scene.walls) === JSON.stringify(next.walls) && JSON.stringify(s.scene.rooms) === JSON.stringify(next.rooms));
    if (sameFlat) adopt(s.scene, next, result.changed);
    set({ scene: next, previewBase: null, previewEnv: null, rev: s.rev + 1 });
    keepSelection(next);
  },

  fail: (errors) => set({ errors }),

  remoteHistory: null,
  setRemoteHistory: (h) =>
    set(
      h
        ? {
            remoteHistory: { past: h.past, futureCount: h.futureCount },
            canUndo: h.canUndo,
            canRedo: h.canRedo,
            historyLabels: h.past.map((e) => e.label),
            historyItems: h.past.map((e) => ({ id: e.id, label: e.label, author: e.author, ts: e.ts })),
          }
        : { remoteHistory: null },
    ),
  setHistoryFlags: (canUndo, canRedo) => {
    const s = get();
    if (s.canUndo !== canUndo || s.canRedo !== canRedo) set({ canUndo, canRedo });
  },

  restoreHistory: (past) => {
    // Entries saved before labels existed get one from the current scene (names may have changed since).
    const scene = committedScene(get());
    const history = { ...createHistory(), past: past.map((e) => (e.label !== undefined || !scene ? e : { ...e, label: describeCommand(e.envelope.cmd, scene) })) };
    set({ history, ...flagsOf(history) });
  },

  loadText: (text, source) => {
    latestLoad++; // a synchronous load supersedes any file still being read
    const result = loadSceneText(text);
    if (result.ok) {
      const first = get().scene === null;
      // A new Scene object gets a new identity: the camera re-frames on load, as expected.
      set((s) => ({
        scene: result.scene,
        source,
        warnings: result.warnings,
        errors: [],
        lastErrors: [],
        history: createHistory(),
        canUndo: false,
        canRedo: false,
        historyLabels: [],
        historyItems: [],
        previewBase: null,
        previewEnv: null,
        rev: s.rev + 1,
      }));
      const view = useViewStore.getState();
      view.select(null);
      try {
        transport?.replaceScene?.(result.scene);
      } catch {
        // a failing transport must never break local editing
      }
      // The app opens in daytime (12:00): start from the 'day' preset so lamps are off, not glowing at noon.
      if (first) {
        // "Today" is the date at the flat, not on the user's machine (they can be a day apart).
        const date = localDate(result.scene.site.timezone) ?? view.lighting.date;
        useViewStore.setState({ lighting: applyPreset({ ...view.lighting, date }, 'day', result.scene.site, result.scene.lights) });
      }
    } else {
      set({ errors: result.errors });
    }
    return result;
  },
}));

function stepHistory(kind: 'undo' | 'redo'): boolean {
  if (transport?.step) {
    // Server mode: the shared stack lives on the server; the result arrives as an `applied` entry.
    if (!transport.canStep?.(kind)) return false;
    void transport.step(kind);
    return true;
  }
  const s = useSceneStore.getState();
  const base = committedScene(s);
  if (!base || !s.scene) return false;
  const step = (kind === 'undo' ? historyUndo : historyRedo)(s.history, base, { id: newId(), ts: Date.now(), author: { kind: 'user' } });
  if (!step.ok) {
    if (step.reason === 'apply_failed') useSceneStore.setState({ lastErrors: step.errors });
    return false;
  }
  const result: ApplyOk = step.result;
  adopt(s.scene, step.scene, result.changed);
  useSceneStore.setState({
    scene: step.scene,
    history: step.history,
    ...flagsOf(step.history),
    previewBase: null,
    previewEnv: null,
    lastErrors: [],
    rev: s.rev + 1,
  });
  keepSelection(step.scene);
  send(step.envelope);
  return true;
}
