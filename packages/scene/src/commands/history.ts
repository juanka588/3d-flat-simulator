import { applyCommand, type ApplyFail, type ApplyOk, type ApplyResult } from './apply';
import type { Author, Command, CommandEnvelope } from './schema';
import type { Scene } from '../schema';
import { deepEqual } from './util';

/** Maximum undo steps kept. */
export const HISTORY_CAP = 200;
/** Default coalescing window, in milliseconds. */
export const COALESCE_WINDOW_MS = 1000;

export interface HistoryEntry {
  /** The command that was applied (the newest one when coalesced; it supersedes the older ones). */
  envelope: CommandEnvelope;
  /** Restores the scene to before the entry. */
  inverse: Command;
}

/** Plain JSON-serialisable history state. */
export interface History {
  past: HistoryEntry[];
  future: HistoryEntry[];
  cap: number;
  coalesceWindowMs: number;
  /** The last entry may still absorb commands with this key/author until `at + window`. */
  open: { key: string; author: Author; at: number } | null;
}

export function createHistory(options: { cap?: number; coalesceWindowMs?: number } = {}): History {
  return { past: [], future: [], cap: options.cap ?? HISTORY_CAP, coalesceWindowMs: options.coalesceWindowMs ?? COALESCE_WINDOW_MS, open: null };
}

export const canUndo = (h: History) => h.past.length > 0;
export const canRedo = (h: History) => h.future.length > 0;
export const clearHistory = (h: History): History => ({ ...h, past: [], future: [], open: null });

/**
 * Records an applied command. Failed and no-op results are ignored. A new command clears the
 * redo stack. A command with the same `coalesceKey` and author within the window after the
 * previous one merges into it: the entry keeps the oldest inverse and the newest command, so
 * a colour drag is a single undo step (the key asserts the newer command supersedes the older).
 * `now` is injected (defaults to `envelope.ts`).
 */
export function recordCommand(history: History, envelope: CommandEnvelope, result: ApplyResult, now: number = envelope.ts): History {
  if (!result.ok || result.noop) return history;
  const key = envelope.coalesceKey;
  const open = history.open;
  const last = history.past[history.past.length - 1];
  if (
    key !== undefined && open && last && open.key === key && deepEqual(open.author, envelope.author) &&
    now - open.at >= 0 && now - open.at <= history.coalesceWindowMs
  ) {
    return {
      ...history,
      past: [...history.past.slice(0, -1), { envelope, inverse: last.inverse }],
      future: [],
      open: { key, author: envelope.author, at: now },
    };
  }
  const past = [...history.past, { envelope, inverse: result.inverse }];
  return {
    ...history,
    past: past.length > history.cap ? past.slice(past.length - history.cap) : past,
    future: [],
    open: key !== undefined ? { key, author: envelope.author, at: now } : null,
  };
}

/** Identity of the step envelope; supplied by the caller because the reducer has no clock or RNG. */
export interface StepContext {
  id: string;
  ts: number;
  author: Author;
}

export type HistoryStep =
  | { ok: true; history: History; scene: Scene; envelope: CommandEnvelope; result: ApplyOk }
  | { ok: false; reason: 'nothing_to_undo' | 'nothing_to_redo'; history: History }
  | ({ reason: 'apply_failed'; history: History } & ApplyFail);

/** Undoes the last entry by appending an `undoOf` envelope; returns data a server can log. */
export function undo(history: History, scene: Scene, ctx: StepContext): HistoryStep {
  const entry = history.past[history.past.length - 1];
  if (!entry) return { ok: false, reason: 'nothing_to_undo', history };
  const envelope: CommandEnvelope = { v: 1, id: ctx.id, ts: ctx.ts, author: ctx.author, undoOf: entry.envelope.id, cmd: entry.inverse };
  const result = applyCommand(scene, envelope);
  if (!result.ok) return { ...result, reason: 'apply_failed', history };
  return {
    ok: true,
    scene: result.scene,
    envelope,
    result,
    history: { ...history, past: history.past.slice(0, -1), future: [...history.future, entry], open: null },
  };
}

/** Re-applies the most recently undone entry. */
export function redo(history: History, scene: Scene, ctx: StepContext): HistoryStep {
  const entry = history.future[history.future.length - 1];
  if (!entry) return { ok: false, reason: 'nothing_to_redo', history };
  const envelope: CommandEnvelope = { v: 1, id: ctx.id, ts: ctx.ts, author: ctx.author, redoOf: entry.envelope.id, cmd: entry.envelope.cmd };
  const result = applyCommand(scene, envelope);
  if (!result.ok) return { ...result, reason: 'apply_failed', history };
  return {
    ok: true,
    scene: result.scene,
    envelope,
    result,
    history: {
      ...history,
      past: [...history.past, { envelope: entry.envelope, inverse: result.inverse }],
      future: history.future.slice(0, -1),
      open: null,
    },
  };
}
