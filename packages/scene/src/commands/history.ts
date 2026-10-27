import { applyCommand, type ApplyFail, type ApplyOk, type ApplyResult } from './apply';
import type { Author, Command, CommandEnvelope, LeafCommand } from './schema';
import type { Scene } from '../schema';
import { deepEqual, err, type CommandError } from './util';

/** Maximum undo steps kept. */
export const HISTORY_CAP = 200;
/** Default coalescing window, in milliseconds. */
export const COALESCE_WINDOW_MS = 1000;

export interface HistoryEntry {
  /** The command that was applied (the newest one when coalesced; it supersedes the older ones). */
  envelope: CommandEnvelope;
  /** Restores the scene to before the entry. */
  inverse: Command;
  /** Human-readable label, fixed when the entry was recorded (see `describeCommand`). Older snapshots have none. */
  label?: string;
}

/** Plain JSON-serialisable history state. */
export interface History {
  past: HistoryEntry[];
  future: HistoryEntry[];
  cap: number;
  coalesceWindowMs: number;
  /**
   * The last entry may still absorb commands with this key/author/signature until `at + window`.
   * `sig` identifies command type, targets and patch keys (see `coalesceSignature`); a snapshot
   * written before signatures existed has none and so never coalesces.
   */
  open: { key: string; author: Author; at: number; sig?: string } | null;
}

export function createHistory(options: { cap?: number; coalesceWindowMs?: number } = {}): History {
  return { past: [], future: [], cap: options.cap ?? HISTORY_CAP, coalesceWindowMs: options.coalesceWindowMs ?? COALESCE_WINDOW_MS, open: null };
}

export const canUndo = (h: History) => h.past.length > 0;
export const canRedo = (h: History) => h.future.length > 0;
export const clearHistory = (h: History): History => ({ ...h, past: [], future: [], open: null });

const fields = (o: Record<string, unknown>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k)
    .sort()
    .join(',');

function leafSignature(c: LeafCommand): string | undefined {
  switch (c.type) {
    case 'material.define': return `${c.type}:${c.material.id}`;
    case 'wall.setFinish': return `${c.type}:${c.wallId}:${c.roomId ?? ''}:${c.side}`;
    case 'wall.setStructural': return `${c.type}:${c.wallId}`;
    case 'room.setWallFinish':
    case 'room.setFloor':
    case 'room.setCeiling': return `${c.type}:${c.roomId}`;
    case 'scene.setDefaults': return `${c.type}:${fields(c)}`;
    case 'site.set': return `${c.type}:${fields(c.site)}`;
    case 'light.update': return `${c.type}:${c.id}:${fields(c.patch)}`;
    case 'item.move': return `${c.type}:${c.id}:${fields({ ...c, type: undefined, id: undefined })}`;
    case 'item.rotate': return `${c.type}:${c.id}`;
    // Structural changes (add / remove) do not supersede one another: never merge them.
    default: return undefined;
  }
}

/**
 * What a command overwrites: its type, target ids and patch keys. Two commands may merge into one
 * undo entry only when their signatures are equal, because the merged entry keeps the OLDEST
 * inverse and the NEWEST command: that is only correct when the newer command overwrites exactly the
 * fields the older one did. `undefined` means the command never coalesces.
 */
export function coalesceSignature(cmd: Command): string | undefined {
  if (cmd.type !== 'batch') return leafSignature(cmd);
  if (cmd.commands.length === 0) return undefined;
  const parts = cmd.commands.map(leafSignature);
  return parts.some((p) => p === undefined) ? undefined : `batch:${parts.join('|')}`;
}

/**
 * Records an applied command. Failed and no-op results are ignored. A new command clears the
 * redo stack. A command with the same `coalesceKey`, author and signature (same command type,
 * target ids and patch keys; see `coalesceSignature`) within the window after the previous one
 * merges into it: the entry keeps the oldest inverse and the newest command, so a colour drag is a
 * single undo step. Anything that differs (another field, another wall) starts a new entry.
 * `now` is injected (defaults to `envelope.ts`); `label` is stored on the entry (a coalesced entry takes the newest).
 */
export function recordCommand(history: History, envelope: CommandEnvelope, result: ApplyResult, now: number = envelope.ts, label?: string): History {
  if (!result.ok || result.noop) return history;
  const key = envelope.coalesceKey;
  const sig = coalesceSignature(envelope.cmd);
  const open = history.open;
  const last = history.past[history.past.length - 1];
  if (
    key !== undefined && sig !== undefined && open && last && open.key === key && open.sig === sig && deepEqual(open.author, envelope.author) &&
    now - open.at >= 0 && now - open.at <= history.coalesceWindowMs
  ) {
    return {
      ...history,
      past: [...history.past.slice(0, -1), { envelope, inverse: last.inverse, ...(label !== undefined ? { label } : {}) }],
      future: [],
      open: { key, author: envelope.author, at: now, sig },
    };
  }
  const past = [...history.past, { envelope, inverse: result.inverse, ...(label !== undefined ? { label } : {}) }];
  return {
    ...history,
    past: past.length > history.cap ? past.slice(past.length - history.cap) : past,
    future: [],
    open: key !== undefined && sig !== undefined ? { key, author: envelope.author, at: now, sig } : null,
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
  | ({ reason: 'apply_failed'; history: History; entryId: string } & ApplyFail);

/**
 * Discards the entry an undo (`'undo'`: the newest past entry) or redo (`'redo'`: the next future
 * entry) would use, without applying anything. This is the explicit way out when `undo` / `redo`
 * report `apply_failed`: the stack never skips a failing entry by itself. Later undos still apply
 * their inverses, which are absolute values, but they may no longer restore the exact earlier scene.
 */
export function dropEntry(history: History, which: 'undo' | 'redo'): History {
  if (which === 'undo') return history.past.length ? { ...history, past: history.past.slice(0, -1), open: null } : history;
  return history.future.length ? { ...history, future: history.future.slice(0, -1), open: null } : history;
}

const itemLeaves = (cmd: Command): LeafCommand[] => (cmd.type === 'batch' ? cmd.commands : [cmd]);

/**
 * Undo, redo and checkpoint rollback re-apply commands as `trusted`, which skips the locked-item guard.
 * A non-user author must not use that to create, remove, move or alter a locked item (existing furniture):
 * the shared stack is kept, but such an entry is refused ("locked item: ask the user").
 */
function lockedConflict(scene: Scene, cmd: Command, author: Author): CommandError | undefined {
  if (author.kind === 'user') return undefined;
  for (const leaf of itemLeaves(cmd)) {
    let id: string | undefined;
    if (leaf.type === 'item.place') {
      if (leaf.item.locked === true) id = leaf.item.id ?? 'item';
    } else if (leaf.type === 'item.move' || leaf.type === 'item.rotate' || leaf.type === 'item.setVariant' || leaf.type === 'item.remove') {
      if (scene.items.some((i) => i.id === leaf.id && i.locked === true)) id = leaf.id;
    }
    if (id !== undefined) {
      return err('precondition_failed', 'id', `this step would change the locked item "${id}" (existing furniture); only the user can`, 'locked item: ask the user');
    }
  }
  return undefined;
}

/** Undoes the last entry by appending an `undoOf` envelope; returns data a server can log. */
export function undo(history: History, scene: Scene, ctx: StepContext): HistoryStep {
  const entry = history.past[history.past.length - 1];
  if (!entry) return { ok: false, reason: 'nothing_to_undo', history };
  const envelope: CommandEnvelope = { v: 1, id: ctx.id, ts: ctx.ts, author: ctx.author, undoOf: entry.envelope.id, cmd: entry.inverse };
  const locked = lockedConflict(scene, entry.inverse, ctx.author);
  if (locked) return { ok: false, errors: [locked], reason: 'apply_failed', history, entryId: entry.envelope.id };
  const result = applyCommand(scene, envelope, { trusted: true });
  if (!result.ok) return { ...result, reason: 'apply_failed', history, entryId: entry.envelope.id };
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
  const locked = lockedConflict(scene, entry.envelope.cmd, ctx.author);
  if (locked) return { ok: false, errors: [locked], reason: 'apply_failed', history, entryId: entry.envelope.id };
  const result = applyCommand(scene, envelope, { trusted: true });
  if (!result.ok) return { ...result, reason: 'apply_failed', history, entryId: entry.envelope.id };
  return {
    ok: true,
    scene: result.scene,
    envelope,
    result,
    history: {
      ...history,
      past: [...history.past, { envelope: entry.envelope, inverse: result.inverse, ...(entry.label !== undefined ? { label: entry.label } : {}) }],
      future: history.future.slice(0, -1),
      open: null,
    },
  };
}
