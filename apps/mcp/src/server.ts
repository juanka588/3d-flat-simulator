import { CLIENT_INFO_META_KEY, McpServer, fromJsonSchema, type CallToolResult, type JsonSchemaType, type jsonSchemaValidator, type ServerContext } from '@modelcontextprotocol/server';
import { assertGeneratorsRegistered } from '@flat/assets';
import type { Author } from '@flat/scene';
import type { McpConfig } from './config';
import { toolError } from './errors';
import type { FlatApi } from './flatApi';
import { INSTRUCTIONS } from './instructions';
import { registerPrompts } from './prompts';
import { registerResources } from './resources';
import { allTools, newSession, systemClock, visibleTools, type Clock, type McpSession, type Renderer, type ToolContext, type ToolDef } from './tools';

export const SERVER_NAME = 'flat';
export const SERVER_VERSION = '0.0.0';

/**
 * SDK-side validation is switched OFF: arguments reach our handlers untouched and `toolCallToCommand`
 * + `parseCommand` (then the server's reducer) are the single source of validation errors, with their
 * paths and nearest-id hints. (Decision recorded in README.md, M4.1 spike.)
 */
const passthroughValidator: jsonSchemaValidator = {
  getValidator: () => ((input: unknown) => ({ valid: true, data: input, errorMessage: undefined })) as never,
};

export interface ServerDeps {
  config: McpConfig;
  flat: FlatApi;
  clock?: Clock;
  /** Override the tool set (tests). Defaults to `allTools()`. */
  tools?: ToolDef[];
  /**
   * The session state (lighting, rate limits, write count). Default: a fresh one per server. The
   * stateless HTTP transport builds a server per request and passes ONE shared session so limits
   * and `set_sun_time` survive across requests.
   */
  session?: McpSession;
  /**
   * Whether a request without client info inherits the name the session saw before (stdio: one client
   * for the whole process, so yes). The shared HTTP endpoint serves several clients: never borrow
   * another client's name there.
   */
  stickyClientName?: boolean;
  /** Lane E: the render service (`render_view`, and the `render` argument of write tools). */
  renderer?: Renderer;
}

/** Product token of a User-Agent (`claude-code/2.1 (cli)` -> `claude-code`), the last resort when the client did not introduce itself. */
function userAgentName(ctx: ServerContext): string | undefined {
  const ua = ctx.http?.req?.headers.get('user-agent') ?? '';
  const token = /^[\w.-]{1,60}/.exec(ua)?.[0];
  return token || undefined;
}

/** Client name for the history's author: the request envelope, then `initialize`'s clientInfo, then the User-Agent (stateless HTTP), then (stdio only) what the session saw before. */
function clientNameOf(server: McpServer, ctx: ServerContext, previous: string, sticky: boolean): string {
  const fromEnvelope = (ctx.mcpReq.envelope as Record<string, { name?: string } | undefined> | undefined)?.[CLIENT_INFO_META_KEY];
  return fromEnvelope?.name ?? server.server.getClientVersion()?.name ?? userAgentName(ctx) ?? (sticky && previous !== 'unknown' ? previous : 'unknown');
}

/** Builds one MCP server (one per connection). Registers the visible tools, prompts and instructions. */
export function createFlatMcpServer(deps: ServerDeps): McpServer {
  // `place_item` params are checked against the generators; scene no longer registers them (importing @flat/assets does).
  assertGeneratorsRegistered();
  const { config, flat } = deps;
  const clock = deps.clock ?? systemClock();
  const session = deps.session ?? newSession(config.limits, clock);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  for (const tool of visibleTools(deps.tools ?? allTools(config.limits), config)) {
    server.registerTool(
      tool.name,
      {
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema as JsonSchemaType, passthroughValidator),
        annotations: { ...tool.annotations },
      },
      async (args, ctx): Promise<CallToolResult> => {
        session.clientName = clientNameOf(server, ctx, session.clientName, deps.stickyClientName ?? true);
        const author: Author = { kind: 'llm', name: session.clientName.slice(0, 200) };
        const toolCtx: ToolContext = { flat, limits: config.limits, clock, author, session, config, ...(deps.renderer ? { renderer: deps.renderer } : {}) };
        try {
          return await tool.handler(toolCtx, (args ?? {}) as Record<string, unknown>);
        } catch (e) {
          config.log('error', `tool ${tool.name} crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
          return toolError('internal_error', `tool ${tool.name} failed unexpectedly`);
        }
      },
    );
  }
  registerPrompts(server);
  registerResources(server, { flat, session });
  return server;
}
