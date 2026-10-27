import type { SceneResponse } from '@flat/scene';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { apiFailure, toolError } from '../errors';
import type { ToolAnnotationsDef, ToolContext } from './registry';

/** Annotations of a tool that never changes the scene or the history. */
export const READ: ToolAnnotationsDef = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Annotations of a history tool that changes the shared history. */
export const HISTORY_WRITE: ToolAnnotationsDef = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** `{type:'object', properties, required, additionalProperties:false}`. */
export const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export type Fetched<T> = { ok: true; data: T } | { ok: false; result: CallToolResult };

/** Fresh scene from the server (`GET /api/scene`), or the tool error to return. */
export async function fetchScene(ctx: ToolContext): Promise<Fetched<SceneResponse>> {
  const res = await ctx.flat.getScene();
  return res.ok ? { ok: true, data: res.data } : { ok: false, result: apiFailure(res) };
}

/** Validates tool arguments with a strict zod schema; failures are `invalid_command` with located errors. */
export function parseArgs<S extends z.ZodType>(schema: S, args: Record<string, unknown>): Fetched<z.infer<S>> {
  const r = schema.safeParse(args);
  if (r.success) return { ok: true, data: r.data };
  const errors = r.error.issues.map((i) => ({ code: 'invalid_command', path: i.path.map(String).join('/'), message: i.message }));
  const first = errors[0]!;
  const message = errors.length > 1 ? `${first.path ? `${first.path}: ` : ''}${first.message} (and ${errors.length - 1} more)` : `${first.path ? `${first.path}: ` : ''}${first.message}`;
  return { ok: false, result: toolError('invalid_command', message, undefined, { errors }) };
}

/**
 * Gate of every scene-mutating call, run after the arguments validated (so invalid calls cost no
 * allowance): read-only mode, the per-session write cap, then the token bucket. A pass counts the call.
 */
export function guardWrite(ctx: ToolContext): CallToolResult | undefined {
  if (ctx.config.readOnly) return toolError('read_only', 'this MCP server is read-only (FLAT_MCP_READONLY)');
  const s = ctx.session;
  if (s.writeCount >= ctx.limits.sessionWriteCap) {
    const how =
      s.transport === 'http'
        ? 'ask the user to restart the MCP server (`--http`; its sessions are per client, not per connection, so reconnecting does not reset the cap) or raise FLAT_MCP_SESSION_WRITES.'
        : 'ask the user to reconnect the MCP server (new session) or raise FLAT_MCP_SESSION_WRITES.';
    return toolError('rate_limited', `this session reached its write cap of ${ctx.limits.sessionWriteCap} calls`, `Stop editing; ${how}`);
  }
  const t = s.writes.take();
  if (!t.ok) {
    return toolError('rate_limited', `more than ${ctx.limits.writesPerMinute} writes per minute`, `Wait ${t.retryAfterMs} ms and retry; batch several commands into one call to use fewer writes.`, { retryAfterMs: t.retryAfterMs });
  }
  s.writeCount += 1;
  return undefined;
}

/** `user`, `llm:claude-code`, ... for history lines. */
export function authorText(a: { kind: string; name?: string | undefined }): string {
  return a.name ? `${a.kind}:${a.name}` : a.kind;
}
