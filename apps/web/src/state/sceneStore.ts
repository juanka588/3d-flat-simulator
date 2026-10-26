import type { ApplyOk, ApplyResult, Changed, Command, CommandEnvelope, History, HistoryEntry, Scene } from '@flat/scene';
import { create } from 'zustand';
import {
  applyCommand,
  applyPreset,
  canRedo as historyCanRedo,
  canUndo as historyCanUndo,
  createHistory,
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
import type { CommandApi, CommandTransport, DispatchOptions } from './commands-api';

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
  /** Loads JSON text; on failure keeps the previous scene and records the errors. Resets history. */
  loadText: (text: string, source: string) => LoadResult;
  /** Records load errors (e.g. a file rejected before parsing) without touching the scene. */
  fail: (errors: string[]) => void;
  /** Replaces the undo stack (used when restoring an autosaved document). */
  restoreHistory: (past: HistoryEntry[]) => void;
}

/** The committed scene (never a preview). */
export function committedScene(s: Pick<SceneStore, 'scene' | 'previewBase'>): Scene | null {
  return s.previewBase ?? s.scene;
}

const NO_SCENE: ApplyResult = { ok: false, errors: [{ code: 'invalid_command', path: '', message: 'no scene is loaded' }] };

const labels = new Map<string, string>();
let transport: CommandTransport | null = null;

function labelOf(env: CommandEnvelope): string {
  return labels.get(env.id) ?? (env.cmd.type === 'batch' ? env.cmd.label : env.cmd.type);
}

function flagsOf(history: History) {
  return {
    canUndo: historyCanUndo(history),
    canRedo: historyCanRedo(history),
    historyLabels: history.past.map((e) => labelOf(e.envelope)),
  };
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
  if (opts?.label) labels.set(env.id, opts.label);
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
  canUndo: false,
  canRedo: false,
  historyLabels: [],
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
    const history = recordCommand(s.history, env, result);
    set({ scene: result.scene, history, ...flagsOf(history), previewBase: null, previewEnv: null, lastErrors: [], rev: s.rev + 1 });
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
    set({ scene: result.scene, previewBase: base, previewEnv: env, lastErrors: [], rev: s.rev + 1 });
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
    const history = recordCommand(s.history, s.previewEnv, result);
    set({ history, ...flagsOf(history), previewBase: null, previewEnv: null, lastErrors: [] });
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

  receiveRemote: (_env, result) => {
    const s = get();
    if (!result.ok || !s.scene) return;
    const next = result.scene;
    adopt(s.scene, next, result.changed);
    set({ scene: next, previewBase: null, previewEnv: null, rev: s.rev + 1 });
    keepSelection(next);
  },

  fail: (errors) => set({ errors }),

  restoreHistory: (past) => {
    const history = { ...createHistory(), past };
    set({ history, ...flagsOf(history) });
  },

  loadText: (text, source) => {
    latestLoad++; // a synchronous load supersedes any file still being read
    const result = loadSceneText(text);
    if (result.ok) {
      const first = get().scene === null;
      labels.clear();
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
        previewBase: null,
        previewEnv: null,
        rev: s.rev + 1,
      }));
      const view = useViewStore.getState();
      view.select(null);
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
