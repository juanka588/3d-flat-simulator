import type { ApplyResult, Command, CommandEnvelope, CommandError, Scene } from '@flat/scene';

/**
 * Web-side command API (M3.5 contract). Every scene edit goes through `dispatch`, which applies
 * the command with the pure reducer, records it in the undo history and (M3.12) syncs it.
 */
export interface DispatchOptions {
  author?: 'user' | 'llm' | 'planner';
  coalesceKey?: string;
  label?: string;
}

/**
 * Hook for the sync lane (M3.11/12). Inert until set: when present the store calls `send` with
 * every envelope it records locally (dispatch, committed preview, undo, redo), after applying it.
 */
export interface CommandTransport {
  send: (envelope: CommandEnvelope) => void;
  /**
   * Server mode (M3.12): undo/redo are server calls on the one shared stack. When present, the store
   * keeps no local history (dispatch records nothing) and `undo`/`redo` call this instead.
   * Resolves true once the step is applied and shown.
   */
  step?: (kind: 'undo' | 'redo') => Promise<boolean>;
  /** Whether `step(kind)` can run now (connected and something to undo/redo). */
  canStep?: (kind: 'undo' | 'redo') => boolean;
  /** A scene was loaded locally (file, fixture, reset): the shared server scene is replaced by it. */
  replaceScene?: (scene: Scene) => void;
}

/** History as the server reports it (server mode). */
export interface RemoteHistory {
  /** Oldest first. */
  past: { id: string; label: string; type: string; author: string }[];
  /** Entries available to redo. */
  futureCount: number;
}

export interface CommandApi {
  /** Applies and records a command; failures leave the scene untouched and set `lastErrors`. */
  dispatch: (cmd: Command, opts?: DispatchOptions) => ApplyResult;
  /**
   * Shows a command's result without recording it (e.g. while dragging a colour). Each call is
   * applied to the committed scene, not stacked on the previous preview. `opts` (additive) is kept
   * for the commit.
   */
  preview: (cmd: Command, opts?: DispatchOptions) => ApplyResult;
  /** Records the current preview as one history entry (no-op without a preview). */
  commitPreview: () => void;
  /** Drops the current preview and restores the committed scene. */
  cancelPreview: () => void;
  undo: () => boolean;
  redo: () => boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Labels of past entries, newest last (for a history popover). */
  historyLabels: string[];
  /** Errors from the last failed dispatch/preview, cleared on the next success. */
  lastErrors: CommandError[];
  /** Monotonic revision, bumped on every scene change (used by whenRendered and sync). */
  rev: number;
  /** Additive: plugs the sync transport in (null unplugs). Inert by default. */
  setTransport: (transport: CommandTransport | null) => void;
  /**
   * Additive: applies an envelope that originated elsewhere (the server), with the result the
   * caller computed from the same reducer. Replaces the committed scene (cancelling any preview),
   * bumps `rev`, keeps the camera, is NOT recorded in the local undo history and is NOT re-sent.
   * Failed results are ignored. `replace` marks a whole-scene swap (hello, resync): the camera is
   * kept unless the walls/rooms differ from the displayed scene.
   */
  receiveRemote: (envelope: CommandEnvelope, result: ApplyResult, opts?: { replace?: boolean }) => void;
}
