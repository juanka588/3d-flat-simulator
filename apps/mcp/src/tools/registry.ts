import type { Author, LightingView, RenderResult, RenderSpecInput, SceneResponse } from '@flat/scene';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { McpConfig, McpLimits } from '../config';
import type { FlatApi } from '../flatApi';
import { TokenBucket } from '../limits';
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
  /** Rate limit of scene-mutating calls (`FLAT_MCP_WRITES_PER_MIN`). */
  writes: TokenBucket;
  /** Rate limit of renders (`FLAT_MCP_RENDERS_PER_MIN`); lane E takes from it. */
  renders: TokenBucket;
  /** Scene-mutating calls that passed validation in this session (cap: `limits.sessionWriteCap`). */
  writeCount: number;
}

/** A fresh session. In stateless HTTP mode one session is shared by all requests of the process. */
export function newSession(limits: Pick<McpLimits, 'writesPerMinute' | 'rendersPerMinute'>, clock: Pick<Clock, 'now'>): McpSession {
  return {
    clientName: 'unknown',
    lighting: {},
    syncToUserTab: false,
    writes: new TokenBucket(limits.writesPerMinute, () => clock.now()),
    renders: new TokenBucket(limits.rendersPerMinute, () => clock.now()),
    writeCount: 0,
  };
}

/**
 * The render service as the MCP core sees it (lane E implements it; `deps.renderer` of
 * `createFlatMcpServer` installs it into `ToolContext.renderer`). `render_view` and the `render`
 * argument of write tools both go through it.
 *
 * `opts.scene` renders THAT scene state (identified as `{epoch, rev}` plus the scene itself) instead
 * of the server's current one: the preview of an uncommitted change. Absent: the renderer fetches
 * the current scene. Errors are thrown as `RenderError`-like objects with a `code` of
 * `render_unavailable` | `render_timeout` (any other throw is reported as `render_unavailable`).
 */
export interface Renderer {
  render(
    spec: RenderSpecInput,
    opts?: { scene?: SceneResponse },
  ): Promise<{
    /** Base64 PNG of the requested view (the "after" image with `compare`). */
    image: string;
    mimeType: 'image/png';
    meta: RenderResult;
    /** With `compare: 'before_after'`: the "before" image (meta.compare.beforeRev). */
    before?: { image: string; mimeType: 'image/png' };
  }>;
}

export interface ToolContext {
  flat: FlatApi;
  limits: McpLimits;
  clock: Clock;
  /** `{kind:'llm', name: clientInfo.name}`. */
  author: Author;
  session: McpSession;
  config: McpConfig;
  /** Absent when rendering is not wired (then `render` reports `render_unavailable`). */
  renderer?: Renderer;
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
