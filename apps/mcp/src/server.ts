import { CLIENT_INFO_META_KEY, McpServer, fromJsonSchema, type CallToolResult, type JsonSchemaType, type jsonSchemaValidator, type ServerContext } from '@modelcontextprotocol/server';
import type { Author } from '@flat/scene';
import type { McpConfig } from './config';
import { toolError } from './errors';
import type { FlatApi } from './flatApi';
import { INSTRUCTIONS } from './instructions';
import { registerPrompts } from './prompts';
import { allTools, systemClock, visibleTools, type Clock, type McpSession, type ToolContext, type ToolDef } from './tools';

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
}

function clientNameOf(server: McpServer, ctx: ServerContext): string {
  const fromEnvelope = (ctx.mcpReq.envelope as Record<string, { name?: string } | undefined> | undefined)?.[CLIENT_INFO_META_KEY];
  return fromEnvelope?.name ?? server.server.getClientVersion()?.name ?? 'unknown';
}

/** Builds one MCP server (one per connection). Registers the visible tools, prompts and instructions. */
export function createFlatMcpServer(deps: ServerDeps): McpServer {
  const { config, flat } = deps;
  const clock = deps.clock ?? systemClock();
  const session: McpSession = { clientName: 'unknown', lighting: {}, syncToUserTab: false };
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  for (const tool of visibleTools(deps.tools ?? allTools(), config)) {
    server.registerTool(
      tool.name,
      {
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema as JsonSchemaType, passthroughValidator),
        annotations: { ...tool.annotations },
      },
      async (args, ctx): Promise<CallToolResult> => {
        session.clientName = clientNameOf(server, ctx);
        const author: Author = { kind: 'llm', name: session.clientName };
        const toolCtx: ToolContext = { flat, limits: config.limits, clock, author, session, config };
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
  return server;
}
