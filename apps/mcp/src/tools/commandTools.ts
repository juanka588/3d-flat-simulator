import { MCP_ERROR_HINTS, applyCommand, commandToolSchemas, diffScenes, makeEnvelope, parseCommand, toolCallToCommand, type Changed, type Command, type RenderSpecInput, type SceneResponse } from '@flat/scene';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { apiFailure, commandErrors, toolError, toolOk } from '../errors';
import { guardWrite, fetchScene } from './common';
import { splitExtras, withMcpExtras, type Extras } from './extras';
import type { ToolContext, ToolDef } from './registry';

/**
 * The 13 write tools, generated from `commandToolSchemas()` (@flat/scene) plus the MCP extras
 * (`preview`, `render`, `label`; see `extras.ts`). The tool schema is advertised as given (plus the
 * extras); `toolCallToCommand` + `parseCommand` (and then the server's reducer) are the only source
 * of validation errors. Flow of a call:
 *
 *   args -> size limit -> split extras -> toolCallToCommand (+ label wrapper) -> batch limit
 *        -> makeEnvelope(ULID id, author llm) -> parseCommand -> write guard (read-only, cap, rate)
 *        -> preview ? applyCommand on a fresh scene + diffScenes : FlatApi.postCommand
 *        -> structured result | tool error
 *
 * A retry is safe: every call carries one ULID, and the server answers a repeated id with the first result.
 */

const SETTERS = new Set(['wall.setFinish', 'wall.setStructural', 'room.setWallFinish', 'room.setFloor', 'room.setCeiling', 'scene.setDefaults', 'site.set', 'light.update', 'material.define']);
const DESTRUCTIVE = new Set(['material.remove', 'light.remove']);

const NO_RENDERER = 'rendering is not wired in this server; the change itself was handled. Use describe_room to verify.';

const renderFailure = (code: 'render_unavailable' | 'render_timeout' | 'rate_limited', message: string, extra: Record<string, unknown> = {}) => ({ render: { ok: false, code, message, hint: MCP_ERROR_HINTS[code === 'rate_limited' ? 'rate_limited' : code], ...extra } });

/**
 * The `render` argument: an image after the change (committed) or of the previewed state. `true`
 * renders the first changed room (else the whole flat). The write itself is never undone by a render
 * problem: the failure is reported next to the result under `render`.
 */
async function renderPart(ctx: ToolContext, extras: Extras, changed: Changed, preview?: SceneResponse): Promise<{ content: CallToolResult['content']; fields: Record<string, unknown> }> {
  if (extras.render === undefined) return { content: [], fields: {} };
  if (!ctx.renderer) return { content: [], fields: renderFailure('render_unavailable', NO_RENDERER) };
  const t = ctx.session.renders.take();
  if (!t.ok) return { content: [], fields: renderFailure('rate_limited', `more than ${ctx.limits.rendersPerMinute} renders per minute`, { retryAfterMs: t.retryAfterMs }) };
  const room = changed.rooms[0];
  const spec: RenderSpecInput = extras.render === true ? (room ? { view: 'room', roomId: room } : { view: 'orbit' }) : (extras.render as RenderSpecInput);
  try {
    const r = await ctx.renderer.render(spec, { session: ctx.session, ...(preview ? { scene: preview } : {}) });
    const content: CallToolResult['content'] = [{ type: 'image', data: r.image, mimeType: r.mimeType }, ...(r.before ? [{ type: 'image' as const, data: r.before.image, mimeType: r.before.mimeType }] : [])];
    return { content, fields: { render: { ok: true, ...r.meta } } };
  } catch (e) {
    const code = (e as { code?: string }).code === 'render_timeout' ? 'render_timeout' : 'render_unavailable';
    return { content: [], fields: renderFailure(code, e instanceof Error ? e.message : String(e)) };
  }
}

export async function runCommandTool(ctx: ToolContext, toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
  if (Buffer.byteLength(JSON.stringify(args)) > ctx.limits.maxArgBytes) {
    return toolError('invalid_command', `arguments exceed ${ctx.limits.maxArgBytes} bytes`, 'Send fewer or smaller commands.');
  }
  const isBatch = toolName === 'batch';
  const split = splitExtras(args, { labelIsExtra: !isBatch });
  if (!split.ok) return split.result;
  const { extras, rest } = split;

  let cmd = toolCallToCommand(toolName, rest);
  if (!cmd) return toolError('invalid_command', `tool "${toolName}" needs an object of arguments`);
  if (cmd.type === 'batch' && Array.isArray(cmd.commands) && cmd.commands.length > ctx.limits.maxBatch) {
    return toolError('batch_too_large', `batch has ${cmd.commands.length} commands; the limit is ${ctx.limits.maxBatch}`);
  }
  // A labelled single command is recorded as a one-command batch: same effect, the label in the history.
  if (extras.label !== undefined) cmd = { type: 'batch', label: extras.label, commands: [cmd] };

  const envelope = makeEnvelope(cmd as unknown as Command, { id: ctx.clock.newId(), ts: ctx.clock.now(), author: ctx.author });
  const parsed = parseCommand(envelope);
  if (!parsed.ok) return commandErrors(parsed.errors);

  if (extras.preview) return previewCommand(ctx, parsed.envelope, extras);

  const blocked = guardWrite(ctx);
  if (blocked) return blocked;

  const res = await ctx.flat.postCommand(parsed.envelope);
  if (!res.ok) return apiFailure(res);
  const { rev, seq, epoch, result } = res.data;
  const render = await renderPart(ctx, extras, result.changed);
  return toolOk(
    {
      ok: true,
      committed: true,
      commandId: envelope.id,
      epoch,
      rev,
      seq,
      changed: result.changed,
      warnings: result.warnings,
      ...(result.noop ? { noop: true, note: 'nothing changed (already in that state)' } : {}),
      ...render.fields,
    },
    render.content,
  );
}

/** `preview: true`: the pure reducer on a freshly fetched scene; nothing is posted, nothing is counted as a write. */
async function previewCommand(ctx: ToolContext, envelope: Parameters<typeof applyCommand>[1], extras: Extras): Promise<CallToolResult> {
  if (ctx.config.readOnly) return toolError('read_only', 'this MCP server is read-only (FLAT_MCP_READONLY)');
  const sc = await fetchScene(ctx);
  if (!sc.ok) return sc.result;
  const { scene, rev, epoch } = sc.data;
  const applied = applyCommand(scene, envelope, { rev });
  if (!applied.ok) return commandErrors(applied.errors, rev);
  const diff = diffScenes(scene, applied.scene);
  const render = await renderPart(ctx, extras, applied.changed, { epoch, rev, scene: applied.scene });
  return toolOk(
    {
      ok: true,
      committed: false,
      preview: true,
      epoch,
      baseRev: rev,
      diff,
      warnings: applied.warnings,
      wouldChange: applied.changed,
      ...(applied.noop ? { noop: true, note: 'nothing would change (already in that state)' } : {}),
      ...render.fields,
    },
    render.content,
  );
}

export function commandTools(): ToolDef[] {
  return commandToolSchemas().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: withMcpExtras(t.inputSchema),
    group: 'write' as const,
    mutatesScene: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: DESTRUCTIVE.has(t.commandType),
      idempotentHint: SETTERS.has(t.commandType),
      openWorldHint: false,
    },
    handler: (ctx, args) => runCommandTool(ctx, t.name, args),
  }));
}
