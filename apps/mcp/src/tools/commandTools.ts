import { commandToolSchemas, makeEnvelope, parseCommand, toolCallToCommand, type Command } from '@flat/scene';
import { apiFailure, commandErrors, toolError, toolOk } from '../errors';
import type { ToolContext, ToolDef } from './registry';

/**
 * The 13 write tools, generated from `commandToolSchemas()` (@flat/scene). The raw JSON schema is
 * advertised unchanged; `toolCallToCommand` + `parseCommand` (and then the server's reducer) are the
 * only source of validation errors. Flow of a call:
 *
 *   args -> size/batch limits -> toolCallToCommand -> makeEnvelope(ULID id, author llm) -> parseCommand
 *        -> FlatApi.postCommand -> structured result | tool error
 *
 * Planned (lane D, M4.5/M4.6): `preview?` and `render?` arguments, rate limits, idempotent retry of
 * the same call id, the batch label taken from the model's plan text.
 */

const SETTERS = new Set(['wall.setFinish', 'wall.setStructural', 'room.setWallFinish', 'room.setFloor', 'room.setCeiling', 'scene.setDefaults', 'site.set', 'light.update', 'material.define']);
const DESTRUCTIVE = new Set(['material.remove', 'light.remove']);

export async function runCommandTool(ctx: ToolContext, toolName: string, args: Record<string, unknown>) {
  if (Buffer.byteLength(JSON.stringify(args)) > ctx.limits.maxArgBytes) {
    return toolError('invalid_command', `arguments exceed ${ctx.limits.maxArgBytes} bytes`, 'Send fewer or smaller commands.');
  }
  const cmd = toolCallToCommand(toolName, args);
  if (!cmd) return toolError('invalid_command', `tool "${toolName}" needs an object of arguments`);
  if (cmd.type === 'batch' && Array.isArray(cmd.commands) && cmd.commands.length > ctx.limits.maxBatch) {
    return toolError('batch_too_large', `batch has ${cmd.commands.length} commands; the limit is ${ctx.limits.maxBatch}`);
  }
  const envelope = makeEnvelope(cmd as unknown as Command, { id: ctx.clock.newId(), ts: ctx.clock.now(), author: ctx.author });
  const parsed = parseCommand(envelope);
  if (!parsed.ok) return commandErrors(parsed.errors);
  const res = await ctx.flat.postCommand(parsed.envelope);
  if (!res.ok) return apiFailure(res);
  const { rev, seq, epoch, result } = res.data;
  return toolOk({
    ok: true,
    commandId: envelope.id,
    epoch,
    rev,
    seq,
    changed: result.changed,
    warnings: result.warnings,
    ...(result.noop ? { noop: true, note: 'nothing changed (already in that state)' } : {}),
  });
}

export function commandTools(): ToolDef[] {
  return commandToolSchemas().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
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
