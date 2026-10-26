import type { ApplyResult, Command, CommandError } from '@flat/scene';

/**
 * Web-side command API (M3.5 contract). Every scene edit goes through `dispatch`, which applies
 * the command with the pure reducer, records it in the undo history and (M3.12) syncs it.
 */
export interface CommandApi {
  /** Applies and records a command; failures leave the scene untouched and set `lastErrors`. */
  dispatch: (cmd: Command, opts?: { author?: 'user' | 'llm' | 'planner'; coalesceKey?: string; label?: string }) => ApplyResult;
  /** Shows a command's result without recording it (e.g. while dragging a colour). */
  preview: (cmd: Command) => ApplyResult;
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
}
