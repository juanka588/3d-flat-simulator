import { nearestIds, type HistoryResponse } from '@flat/scene';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { apiFailure, toolError, toolOk } from '../errors';
import type { FlatApiFailure } from '../flatApi';
import { HISTORY_WRITE, READ, authorText, guardWrite, obj, parseArgs } from './common';
import type { ToolContext, ToolDef } from './registry';

/**
 * History tools (M4.7). The undo stack is SHARED with the user: `undo` reverts the latest change
 * whoever made it (plain server undo/redo, no LLM-only scoping). Each call names the entry it is
 * about to revert and sends `ifRev`, so a change made in between turns into `stale_scene` instead of
 * silently reverting something the model never saw.
 */

const HistoryArgs = z.strictObject({ limit: z.number().int().min(1).max(100).optional() });
const Empty = z.strictObject({});
const CheckpointArgs = z.strictObject({ name: z.string().trim().min(1).max(80), replace: z.boolean().optional() });
const RestoreArgs = z.strictObject({ name: z.string().trim().min(1).max(80) });

const item = (e: HistoryResponse['past'][number]) => ({ id: e.id, label: e.label, ts: e.ts, author: authorText(e.author) });

/** Maps history-specific server failures to tool errors; everything else goes through `apiFailure`. */
function historyFailure(f: FlatApiFailure, kind: 'undo' | 'redo' | 'checkpoint'): CallToolResult {
  if (f.kind === 'http') {
    const e = f.errors[0];
    if (e && /^nothing to (undo|redo)$/.test(e.message)) return toolError(e.message.endsWith('undo') ? 'nothing_to_undo' : 'nothing_to_redo', e.message);
    if (e?.code === 'checkpoint_unreachable') {
      return toolError('precondition_failed', e.message, 'The history moved past this checkpoint or diverged from it. Call list_history, then use undo / redo, or take a new checkpoint.', { ...(f.rev !== undefined ? { rev: f.rev } : {}) });
    }
    if (e?.code === 'checkpoint_exists') {
      return toolError('invalid_command', e.message, 'Pick another name, or pass replace: true to move the checkpoint to the current state.', { errors: [{ code: 'checkpoint_exists', path: 'name', message: e.message }] });
    }
  }
  void kind;
  return apiFailure(f);
}

async function checkpointNames(ctx: ToolContext): Promise<string[]> {
  const r = await ctx.flat.listCheckpoints();
  return r.ok ? r.data.checkpoints.map((c) => c.name) : [];
}

async function step(ctx: ToolContext, kind: 'undo' | 'redo'): Promise<CallToolResult> {
  const blocked = guardWrite(ctx);
  if (blocked) return blocked;
  const h = await ctx.flat.history();
  if (!h.ok) return apiFailure(h);
  const target = kind === 'undo' ? h.data.past.at(-1) : h.data.future.at(-1);
  if (!target) return toolError(kind === 'undo' ? 'nothing_to_undo' : 'nothing_to_redo', kind === 'undo' ? 'the history is empty' : 'nothing was undone');
  const body = { id: ctx.clock.newId(), author: ctx.author, ifRev: h.data.rev };
  const res = await (kind === 'undo' ? ctx.flat.undo(body) : ctx.flat.redo(body));
  if (!res.ok) return historyFailure(res, kind);
  const { rev, seq, epoch, result } = res.data;
  const foreign = target.author.kind !== 'llm';
  return toolOk({
    ok: true,
    committed: true,
    [kind === 'undo' ? 'undid' : 'redid']: item(target),
    epoch,
    rev,
    seq,
    changed: result.changed,
    warnings: result.warnings,
    canUndo: kind === 'undo' ? h.data.past.length > 1 : true,
    canRedo: kind === 'undo' ? true : h.data.future.length > 1,
    ...(foreign ? { note: `the ${kind === 'undo' ? 'reverted' : 're-applied'} change was made by ${authorText(target.author)} (the history is shared with the user)` } : {}),
  });
}

export function historyTools(): ToolDef[] {
  return [
    {
      name: 'list_history',
      description: 'List the undo and redo stacks (who changed what, newest last) and the named checkpoints. The stack is shared with the user: undo reverts the latest entry whoever made it.',
      inputSchema: obj({ limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many of the newest entries to list (default 20).' } }),
      annotations: READ,
      group: 'history',
      mutatesScene: false,
      async handler(ctx, args) {
        const a = parseArgs(HistoryArgs, args);
        if (!a.ok) return a.result;
        const limit = a.data.limit ?? 20;
        const h = await ctx.flat.history();
        if (!h.ok) return apiFailure(h);
        const cps = await ctx.flat.listCheckpoints();
        let checkpointsNote: string | undefined;
        if (!cps.ok) {
          if (cps.kind === 'unreachable') return apiFailure(cps);
          checkpointsNote = 'checkpoints are not available from this scene server';
        }
        const { past, future } = h.data;
        return toolOk({
          ok: true,
          rev: h.data.rev,
          canUndo: h.data.canUndo,
          canRedo: h.data.canRedo,
          undoDepth: past.length,
          redoDepth: future.length,
          past: past.slice(-limit).map(item),
          redoNext: future.slice(-limit).reverse().map(item),
          checkpoints: cps.ok ? cps.data.checkpoints.map((c) => ({ name: c.name, rev: c.rev, depth: c.depth, ts: c.ts, author: authorText(c.author) })) : [],
          ...(checkpointsNote ? { note: checkpointsNote } : {}),
        });
      },
    },
    {
      name: 'undo',
      description: 'Undo the latest change in the shared history, whoever made it (the result names the entry). Fails with stale_scene if the flat changed since the history was read; call list_history and retry.',
      inputSchema: obj({}),
      annotations: HISTORY_WRITE,
      group: 'history',
      mutatesScene: true,
      async handler(ctx, args) {
        const a = parseArgs(Empty, args);
        return a.ok ? step(ctx, 'undo') : a.result;
      },
    },
    {
      name: 'redo',
      description: 'Redo the most recently undone change.',
      inputSchema: obj({}),
      annotations: HISTORY_WRITE,
      group: 'history',
      mutatesScene: true,
      async handler(ctx, args) {
        const a = parseArgs(Empty, args);
        return a.ok ? step(ctx, 'redo') : a.result;
      },
    },
    {
      name: 'checkpoint',
      description: 'Name the current state so you can return to it with restore_checkpoint. A name that exists is refused unless replace is true (which moves it to now). Take one before big edits.',
      inputSchema: obj(
        {
          name: { type: 'string', minLength: 1, maxLength: 80, description: 'Checkpoint name.' },
          replace: { type: 'boolean', description: 'true: move an existing checkpoint of that name to the current state (default false).' },
        },
        ['name'],
      ),
      annotations: HISTORY_WRITE,
      group: 'history',
      mutatesScene: false,
      async handler(ctx, args) {
        const a = parseArgs(CheckpointArgs, args);
        if (!a.ok) return a.result;
        if (ctx.config.readOnly) return toolError('read_only', 'this MCP server is read-only (FLAT_MCP_READONLY)');
        const res = await ctx.flat.checkpoint({ name: a.data.name, author: ctx.author, ...(a.data.replace ? { replace: true } : {}) });
        if (!res.ok) return historyFailure(res, 'checkpoint');
        const cp = res.data.checkpoint;
        return toolOk({ ok: true, checkpoint: { name: cp.name, rev: cp.rev, depth: cp.depth }, epoch: res.data.epoch, note: `restore with restore_checkpoint {"name":"${cp.name}"}` });
      },
    },
    {
      name: 'restore_checkpoint',
      description: 'Undo back to a named checkpoint, whoever made the changes since (the undone steps stay redoable). Fails with precondition_failed when the history was undone past the checkpoint or diverged from it.',
      inputSchema: obj({ name: { type: 'string', minLength: 1, maxLength: 80, description: 'Checkpoint name (see list_history).' } }, ['name']),
      annotations: HISTORY_WRITE,
      group: 'history',
      mutatesScene: true,
      async handler(ctx, args) {
        const a = parseArgs(RestoreArgs, args);
        if (!a.ok) return a.result;
        const blocked = guardWrite(ctx);
        if (blocked) return blocked;
        const res = await ctx.flat.undoTo({ checkpoint: a.data.name, id: ctx.clock.newId(), author: ctx.author });
        if (!res.ok) {
          if (res.kind === 'http' && res.status === 404 && res.errors[0]?.code === 'not_found') {
            const names = await checkpointNames(ctx);
            const near = nearestIds(a.data.name, names);
            return toolError('unknown_checkpoint', `no checkpoint named "${a.data.name}"`, names.length ? `Did you mean ${near.map((n) => `"${n}"`).join(', ')}? Checkpoints: ${names.join(', ')}.` : 'There are no checkpoints; create one with checkpoint.');
          }
          return historyFailure(res, 'undo');
        }
        const { rev, seq, epoch, result, steps } = res.data;
        return toolOk({
          ok: true,
          committed: steps > 0,
          restored: a.data.name,
          steps,
          epoch,
          rev,
          seq,
          changed: result.changed,
          warnings: result.warnings,
          ...(steps === 0 ? { noop: true, note: 'already at that checkpoint' } : {}),
        });
      },
    },
  ];
}
