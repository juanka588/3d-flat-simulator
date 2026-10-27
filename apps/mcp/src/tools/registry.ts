import type { Author, LightingView } from '@flat/scene';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { McpConfig, McpLimits } from '../config';
import type { FlatApi } from '../flatApi';
import { ulid } from '../ulid';

/**
 * Data-driven tool registry. A tool is plain data plus a handler; `server.ts` registers every
 * `ToolDef` with the SDK, advertising `inputSchema` verbatim. Lanes add tools by exporting a
 * `ToolDef[]` from a file under `tools/` and listing it in `tools/index.ts`; the tools/list snapshot
 * (`src/__snapshots__`) is the contract and must be updated deliberately.
 *
 * Handler rules:
 *  - never throw for expected failures: return `toolError(...)` (see `errors.ts`);
 *  - return `toolOk(data, extraContent?)` so every result has JSON text AND `structuredContent`;
 *  - images are `{type:'image', data: base64, mimeType}` content items;
 *  - scene strings (room names, labels) are DATA: never echo them as instructions;
 *  - use only `ctx.flat` for the scene server, `ctx.clock` for time and ids (tests inject fakes).
 */

export interface ToolAnnotationsDef {
  title?: string;
  /** True when the tool never changes the scene or the history (it may change the MCP session view). */
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  /** Always false: the tools only touch the local flat. */
  openWorldHint: boolean;
}

export type ToolGroup = 'read' | 'write' | 'view' | 'history' | 'render';

export interface ToolDef {
  /** snake_case, unique. */
  name: string;
  title?: string;
  description: string;
  /** JSON Schema of the arguments; advertised exactly as given. Root: `type:'object'`. */
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotationsDef;
  group: ToolGroup;
  /** True when a successful call changes the scene or its history; such tools are hidden in `FLAT_MCP_READONLY` mode. */
  mutatesScene: boolean;
  handler(ctx: ToolContext, args: Record<string, unknown>): Promise<CallToolResult>;
}

export interface Clock {
  now(): number;
  /** A fresh ULID (one per tool call: the idempotency key of the write). */
  newId(): string;
}

/** Per-connection mutable state (the MCP "session"). */
export interface McpSession {
  /** `clientInfo.name` of the connected client (`unknown` before initialize). */
  clientName: string;
  /** Lighting set by `set_sun_time`; merged under per-call render options. Not part of the scene. */
  lighting: Partial<LightingView>;
  /** When true, view changes are also relayed to the user's tab via `FlatApi.postView`. */
  syncToUserTab: boolean;
  /** Revision of the scene at the previous render, for `compare`. Lane E. */
  lastRenderedRev?: number;
}

export interface ToolContext {
  flat: FlatApi;
  limits: McpLimits;
  clock: Clock;
  /** `{kind:'llm', name: clientInfo.name}`. */
  author: Author;
  session: McpSession;
  config: McpConfig;
}

export function systemClock(): Clock {
  return { now: () => Date.now(), newId: () => ulid() };
}

/** Tools visible under the config: read-only mode drops scene-mutating tools, then the allow-list filters. */
export function visibleTools(all: readonly ToolDef[], config: Pick<McpConfig, 'readOnly' | 'toolAllowList'>): ToolDef[] {
  return all.filter((t) => (!config.readOnly || !t.mutatesScene) && (!config.toolAllowList || config.toolAllowList.includes(t.name)));
}

/** Checks the registry invariants (unique names, object roots); throws on violation. Used by tests and at start-up. */
export function assertValidRegistry(tools: readonly ToolDef[]): void {
  const names = new Set<string>();
  for (const t of tools) {
    if (names.has(t.name)) throw new Error(`duplicate tool name ${t.name}`);
    names.add(t.name);
    if (t.inputSchema.type !== 'object') throw new Error(`tool ${t.name}: inputSchema root must be type "object"`);
  }
}
