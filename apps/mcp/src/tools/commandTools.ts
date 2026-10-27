import { MCP_ERROR_HINTS, applyCommand, commandToolSchemas, diffScenes, makeEnvelope, parseCommand, toolCallToCommand, type Changed, type Command, type RenderSpecInput, type SceneResponse } from '@flat/scene';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { DEFAULT_LIMITS } from '../config';
import { apiFailure, commandErrors, toolError, toolOk } from '../errors';
import { guardWrite, fetchScene } from './common';
import { splitExtras, withMcpExtras } from './extras';
import { RenderViewArgs } from './render';
import type { ToolContext, ToolDef } from './registry';

/**
 * The 13 write tools, generated from `commandToolSchemas()` (@flat/scene) plus the MCP extras
 * (`preview`, `render`, `label`; see `extras.ts`). The tool schema is advertised as given (plus the
 * extras); `toolCallToCommand` + `parseCommand` (and then the server's reducer) are the only source
 * of validation errors. Flow of a call:
 *
 *   args -> size limit -> split extras -> validate `render` -> toolCallToCommand (+ label wrapper) -> batch limit
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

/** A validated `render` argument, before the changed rooms are known. */
export interface RenderPlan {
  /** What the caller asked for; absent for `render: true`. */
  spec?: RenderSpecInput;
  /** The caller named a view (otherwise it follows the `render: true` default). */
  hadView: boolean;
  format?: 'jpeg';
}

/**
 * Validates the `render` argument with the SAME schema as `render_view` (so a bad value fails before a
 * write or a rate-limit token is spent). `previewOf` is set by the server, never by the model.
 */
export function planRender(render: true | Record<string, unknown> | undefined): { ok: true; plan: RenderPlan | undefined } | { ok: false; result: CallToolResult } {
  if (render === undefined) return { ok: true, plan: undefined };
  if (render === true) return { ok: true, plan: { hadView: false } };
  const fail = (path: string, message: string) => ({ ok: false as const, result: toolError('invalid_command', `render/${path}: ${message}`, 'Pass render: true, or the arguments of render_view (view, roomId, facing, preset, ...).', { errors: [{ code: 'invalid_command', path: `render/${path}`, message }] }) });
  if ('previewOf' in render) return fail('previewOf', 'is set by the server for previews; do not pass it (use preview: true on the tool instead)');
  const r = RenderViewArgs.safeParse(render);
  if (!r.success) {
    const i = r.error.issues[0]!;
    return fail(i.path.map(String).join('/'), `${i.message}${r.error.issues.length > 1 ? ` (and ${r.error.issues.length - 1} more)` : ''}`);
  }
  // Only what the caller sent (schema defaults such as lamps {} or exposureEV 0 must not override the session's lighting).
  const { format, view, ...parsed } = r.data;
  const given = Object.fromEntries(Object.entries(parsed).filter(([k]) => k in render));
  const spec = { ...given, ...('view' in render ? { view: view === 'flat' ? 'orbit' : view } : {}) } as RenderSpecInput;
  return { ok: true, plan: { spec, hadView: 'view' in render, ...(format === 'jpeg' ? { format: 'jpeg' as const } : {}) } };
}

/**
 * THE meaning of `render: true`, defined once: the overview of the first changed room, else the whole
 * flat from above. An object without a `view` follows the same default; with a room/walk view and no
 * `roomId` it fills in the first changed room.
 */
export function renderSpecFor(plan: RenderPlan, changed: Pick<Changed, 'rooms'>): RenderSpecInput {
  const room = changed.rooms[0];
  if (!plan.spec) return room ? { view: 'room', roomId: room } : { view: 'orbit' };
  const spec = { ...plan.spec };
  if (!plan.hadView && spec.roomId === undefined) return { ...spec, ...(room ? { view: 'room', roomId: room } : { view: 'orbit' }) } as RenderSpecInput;
  if ((spec.view === 'room' || spec.view === 'walk') && spec.roomId === undefined && room) spec.roomId = room;
  return spec;
}

/**
 * The `render` argument: an image after the change (committed) or of the previewed state. The write
 * itself is never undone by a render problem: the failure is reported next to the result under `render`.
 */
async function renderPart(ctx: ToolContext, plan: RenderPlan | undefined, changed: Changed, preview?: SceneResponse): Promise<{ content: CallToolResult['content']; fields: Record<string, unknown> }> {
  if (!plan) return { content: [], fields: {} };
  if (!ctx.renderer) return { content: [], fields: renderFailure('render_unavailable', NO_RENDERER) };
  const t = ctx.session.renders.take();
  if (!t.ok) return { content: [], fields: renderFailure('rate_limited', `more than ${ctx.limits.rendersPerMinute} renders per minute`, { retryAfterMs: t.retryAfterMs }) };
  const spec = renderSpecFor(plan, changed);
  try {
    const r = await ctx.renderer.render(spec, { session: ctx.session, ...(plan.format ? { format: plan.format } : {}), ...(preview ? { scene: preview } : {}) });
    const content: CallToolResult['content'] = [{ type: 'image', data: r.image, mimeType: r.mimeType }, ...(r.before ? [{ type: 'image' as const, data: r.before.image, mimeType: r.before.mimeType }] : []), ...(r.meta.caption ? [{ type: 'text' as const, text: r.meta.caption }] : [])];
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
  // The render argument is validated before anything is spent or sent.
  const planned = planRender(extras.render);
  if (!planned.ok) return planned.result;
  const plan = planned.plan;

  let cmd = toolCallToCommand(toolName, rest);
  if (!cmd) return toolError('invalid_command', `tool "${toolName}" needs an object of arguments`);
  if (cmd.type === 'batch' && Array.isArray(cmd.commands) && cmd.commands.length > ctx.limits.maxBatch) {
    return toolError('batch_too_large', `batch has ${cmd.commands.length} commands; the limit is ${ctx.limits.maxBatch}`);
  }
  // A labelled single command is recorded as a one-command batch: same effect, the label in the history.
  if (extras.label !== undefined) cmd = { type: 'batch', label: extras.label, commands: [cmd] };
  return executeCommand(ctx, cmd as unknown as Command, { ifRev: extras.ifRev, preview: extras.preview, plan });
}

/**
 * The shared tail of every write tool (generated command tools and `place_item`): envelope with a fresh
 * ULID, `parseCommand`, then preview (pure reducer on a fresh scene) or commit (write guard, `postCommand`),
 * with the optional render. `plan` comes from `planRender`.
 */
export async function executeCommand(ctx: ToolContext, cmd: Command, opts: { ifRev: number | undefined; preview: boolean; plan: RenderPlan | undefined }): Promise<CallToolResult> {
  const { plan } = opts;
  const envelope = makeEnvelope(cmd, { id: ctx.clock.newId(), ts: ctx.clock.now(), author: ctx.author, ...(opts.ifRev !== undefined ? { ifRev: opts.ifRev } : {}) });
  const parsed = parseCommand(envelope);
  if (!parsed.ok) return commandErrors(parsed.errors);

  if (opts.preview) return previewCommand(ctx, parsed.envelope, plan);

  const blocked = guardWrite(ctx);
  if (blocked) return blocked;

  const res = await ctx.flat.postCommand(parsed.envelope);
  if (!res.ok) return apiFailure(res);
  const { rev, seq, epoch, result } = res.data;
  const render = await renderPart(ctx, plan, result.changed);
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
async function previewCommand(ctx: ToolContext, envelope: Parameters<typeof applyCommand>[1], plan: RenderPlan | undefined): Promise<CallToolResult> {
  if (ctx.config.readOnly) return toolError('read_only', 'this MCP server is read-only (FLAT_MCP_READONLY)');
  const sc = await fetchScene(ctx);
  if (!sc.ok) return sc.result;
  const { scene, rev, epoch } = sc.data;
  const applied = applyCommand(scene, envelope, { rev });
  if (!applied.ok) return commandErrors(applied.errors, rev);
  const diff = diffScenes(scene, applied.scene);
  const render = await renderPart(ctx, plan, applied.changed, { epoch, rev, scene: applied.scene });
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

/** The batch tool with THIS server's command limit (`FLAT_MCP_MAX_BATCH`) in its description and schema; the reducer's own cap (500) is not what the model should plan around. */
function withBatchLimit(t: { name: string; description: string; inputSchema: Record<string, unknown> }, maxBatch: number) {
  if (t.name !== 'batch') return t;
  const props = t.inputSchema.properties as Record<string, Record<string, unknown>>;
  const commands = { ...props.commands, maxItems: maxBatch, description: `Commands applied in order and atomically: all succeed or none apply. At most ${maxBatch} per batch (split larger edits); batches cannot nest.` };
  return {
    ...t,
    description: t.description.replace('The server limits the number of commands per batch.', `At most ${maxBatch} commands per batch.`),
    inputSchema: { ...t.inputSchema, properties: { ...props, commands } },
  };
}

/**
 * What the scene package's descriptions could not say because the M5.11 tools did not exist when they were written.
 * Appended to the advertised description of the `item_*` tools (the tools stay for fine edits).
 */
export const DESCRIPTION_NOTES: Record<string, string> = {
  item_place: ' Prefer place_item: it checks the product against search_products and fills in price, dims and link itself. To see valid spots first, call get_placement_options; get_product lists variants and weight.',
  item_move: ' To find a valid spot first, call get_placement_options.',
  item_set_variant: ' get_product lists the variants (variants[].sku) of a product.',
  item_remove: ' To find which item to remove, read items[] with describe_room; get_bill_of_materials shows the cost.',
};

export function commandTools(limits: { maxBatch: number } = DEFAULT_LIMITS): ToolDef[] {
  return commandToolSchemas().map((raw) => withBatchLimit(raw, limits.maxBatch) as typeof raw).map((t) => ({
    name: t.name,
    description: t.description + (DESCRIPTION_NOTES[t.name] ?? ''),
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
