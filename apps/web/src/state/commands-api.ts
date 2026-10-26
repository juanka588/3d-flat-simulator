import type { ApplyResult, Command, CommandEnvelope, CommandError } from '@flat/scene';

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
   * Failed results are ignored.
   */
  receiveRemote: (envelope: CommandEnvelope, result: ApplyResult) => void;
}
