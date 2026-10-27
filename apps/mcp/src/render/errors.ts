import type { McpErrorCode } from '@flat/scene';
import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * A render that did not happen. `code` is an MCP error code (`render_unavailable`, `render_timeout`,
 * `unknown_room`, `invalid_command`, `server_unreachable`, ...). When the failure was already turned into a
 * tool error (resolution problems, scene server failures) `result` carries it for the tool to return as is.
 */
export class RenderError extends Error {
  constructor(
    public readonly code: McpErrorCode,
    message: string,
    public readonly hint?: string,
    public readonly result?: CallToolResult,
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

export type RenderFailureCode = McpErrorCode;
