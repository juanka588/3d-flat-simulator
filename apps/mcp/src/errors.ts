import { MCP_ERROR_HINTS, type CommandError, type McpErrorCode, type McpErrorItem, type McpToolError } from '@flat/scene';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { FlatApiFailure } from './flatApi';

/**
 * Error table of the MCP layer. Every failed tool call is `{isError: true, content: [text JSON],
 * structuredContent}` with the `McpToolError` shape: `code`, `message`, a "what to call next" `hint`
 * and optional located `errors`. Tool-level problems are NEVER JSON-RPC errors (those are for
 * protocol faults), so the model always sees and can act on them.
 *
 * Code origins: the reducer (`invalid_command`, `unknown_entity`, ...), the scene server
 * (`unauthorized`, ...), and this layer (`server_unreachable`, `stale_scene`, `rate_limited`,
 * `batch_too_large`, `read_only`, `render_*`, `unknown_room`, `not_implemented`, ...). The default
 * hint per code lives in `MCP_ERROR_HINTS` (`@flat/scene`).
 */

export interface ToolErrorExtra {
  errors?: McpErrorItem[];
  retryAfterMs?: number;
  rev?: number;
}

/** Builds the failed `CallToolResult`. `hint` defaults to the table entry for `code`. */
export function toolError(code: McpErrorCode, message: string, hint?: string, extra: ToolErrorExtra = {}): CallToolResult & { structuredContent: McpToolError } {
  const body: McpToolError = {
    ok: false,
    code,
    message,
    hint: hint ?? MCP_ERROR_HINTS[code],
    ...(extra.errors?.length ? { errors: extra.errors } : {}),
    ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
    ...(extra.rev !== undefined ? { rev: extra.rev } : {}),
  };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
}

/** Successful result: JSON text (for clients that ignore `structuredContent`) plus the structured object. */
export function toolOk<T extends Record<string, unknown>>(data: T, extraContent: CallToolResult['content'] = []): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }, ...extraContent], structuredContent: data };
}

/** Maps non-MCP server codes onto the MCP union. */
const SERVER_CODE_MAP: Record<string, McpErrorCode> = {
  malformed_json: 'invalid_command',
  payload_too_large: 'invalid_command',
  idempotency_conflict: 'invalid_command',
  forbidden: 'unauthorized',
  unauthorized: 'unauthorized',
  rate_limited: 'rate_limited',
  not_found: 'not_implemented',
  checkpoint_exists: 'invalid_command',
  checkpoint_unreachable: 'precondition_failed',
  internal_error: 'internal_error',
};
const KNOWN = new Set<string>(Object.keys(MCP_ERROR_HINTS));

/** Reducer / server code string -> MCP code (unknown codes become `internal_error`). */
export function mcpCodeOf(code: string): McpErrorCode {
  if (KNOWN.has(code)) return code as McpErrorCode;
  return SERVER_CODE_MAP[code] ?? 'internal_error';
}

/**
 * Turns reducer / `parseCommand` errors into a tool error. The first error picks `code`; every error
 * is kept in `errors[]` with its path and hint (which carries the nearest ids for unknown ids).
 * A stale `ifRev` is reported as `stale_scene` with the current `rev`.
 */
export function commandErrors(errors: readonly CommandError[], rev?: number): CallToolResult {
  const first = errors[0];
  const stale = errors.find((e) => e.code === 'precondition_failed' && /revision|ifRev/.test(e.path + e.message));
  const items: McpErrorItem[] = errors.map((e) => ({ code: e.code, path: e.path, message: e.message, ...(e.hint ? { hint: e.hint } : {}) }));
  if (stale) return toolError('stale_scene', stale.message, undefined, { errors: items, ...(rev !== undefined ? { rev } : {}) });
  const code = mcpCodeOf(first?.code ?? 'internal_error');
  const message = errors.length > 1 ? `${first?.message} (and ${errors.length - 1} more)` : (first?.message ?? 'request failed');
  return toolError(code, message, first?.hint, { errors: items, ...(rev !== undefined ? { rev } : {}) });
}

/** Turns a `FlatApi` failure (unreachable server, HTTP error) into a tool error. */
export function apiFailure(f: FlatApiFailure): CallToolResult {
  if (f.kind === 'unreachable') {
    if (f.mayHaveApplied) {
      return toolError('server_unreachable', `the scene server did not answer in time (${f.message}); the change may have been applied`, 'It may have been applied: call list_history (or get_scene_summary) to see whether it landed BEFORE retrying; do not repeat the call blindly.');
    }
    if ((f as { timedOut?: boolean }).timedOut) {
      return toolError('server_unreachable', `the scene server is up but did not answer in time: ${f.message}`, 'The shop is read politely, one page every 1.5 s, so parallel searches queue behind each other. What was read is cached: retry the SAME call now (it is much faster), and run searches one after another instead of all at once.');
    }
    return toolError('server_unreachable', `cannot reach the scene server: ${f.message}`, 'Start it with `pnpm server` (or `pnpm dev:all`) and retry; the URL is FLAT_SERVER_URL.');
  }
  if (f.status === 404 && f.errors[0]?.code === 'internal_error') {
    return toolError('not_implemented', 'the scene server has no such endpoint (it is older than this MCP server)', 'Update and restart apps/server, then retry.');
  }
  if (f.status === 429) return toolError('rate_limited', 'the scene server is rate limiting this client', undefined, { retryAfterMs: 1000 });
  return commandErrors(f.errors.map((e) => ({ code: e.code as CommandError['code'], path: e.path, message: e.message, ...(e.hint ? { hint: e.hint } : {}) })), f.rev);
}
