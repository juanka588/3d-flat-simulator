# @flat/mcp

MCP server for the flat simulator: read the flat, change it, see it (M4). A thin adapter: every tool
call becomes a `CommandEnvelope` (`author: {kind: 'llm', name: <clientInfo.name>}`) posted to
`apps/server` over REST. Status: M4.0 contracts and M4.1 stdio skeleton; read, view, history and
render tools are `not_implemented` stubs that the lanes fill in (see `docs/backlog/m4.md`).

## SDK decision (M4.1 spike): GO on `@modelcontextprotocol/server` v2

| | |
|---|---|
| Chosen | `@modelcontextprotocol/server` **2.4.0** + `@modelcontextprotocol/client` **2.4.0** (tests) |
| Rejected | v1 `@modelcontextprotocol/sdk` 1.32.2 (still on the registry; kept as fallback only) |

Proved by `src/server.test.ts` and `src/stdio.test.ts`:

- (a) **Raw JSON schemas are advertised unchanged.** v2 `fromJsonSchema(schema, validator?)` wraps a raw
  JSON Schema as a Standard Schema, so `registerTool` accepts it; the client sees `commandToolSchemas()`
  byte-for-byte, including `batch` with `$defs`/`$ref` and `type: ["string","null"]`. v1's `registerTool`
  needs zod shapes, so it would force the low-level `Server` handlers; v2 does not.
- (b) **Validation comes from us only.** The default (Ajv) validator accepts our schemas but answers bad
  calls with its own text (`Input validation error: ... data/side must be equal to one of the allowed
  values`). We pass a pass-through validator to `fromJsonSchema`, so arguments reach the handler untouched
  and `toolCallToCommand` + `parseCommand` (then the server's reducer) produce every error, with paths
  and nearest-id hints.
- (c) **A real client process works.** `StdioClientTransport` spawns `src/main.ts`; initialize, tools/list,
  tools/call and prompts/list work; stdout carries JSON-RPC only (tested by parsing every stdout line).
  `main.ts` uses v2's `serveStdio(factory)`, which serves 2025-era clients (Claude Code today) and the
  newer protocol era from the same factory.

Notes: tool errors are `isError: true` results (never JSON-RPC errors) with `structuredContent`; the client
name is read from `ctx.mcpReq.envelope` (new era) or `getClientVersion()` (2025 era).

## Run

```sh
pnpm dev:all          # scene server + web app (or: pnpm server)
pnpm mcp              # MCP over stdio (used by an MCP client, not by hand)

claude mcp add flat -- pnpm --silent --dir "$PWD" mcp
claude mcp add flat -e FLAT_SERVER_URL=http://127.0.0.1:8787 -e FLAT_TOKEN=... -- pnpm --silent --dir /path/to/3d-flat-simulator mcp
```

Always pass `--silent` to pnpm: without it pnpm prints a `> script` banner on stdout, which corrupts the protocol.
stdout is the JSON-RPC channel: logs go to stderr, and ESLint forbids `console.log` in `src/`.
If the scene server is down the tools answer `server_unreachable` (with a hint) and the process stays up.

## Configuration (environment)

| env | default | |
|---|---|---|
| `FLAT_SERVER_URL` | `http://127.0.0.1:8787` | scene server |
| `FLAT_TOKEN` | unset | bearer token for the scene server (and the HTTP transport, M4.2) |
| `FLAT_MCP_READONLY` | `false` | only non-mutating tools are listed |
| `FLAT_MCP_TOOLS` | all | comma-separated allow-list of tool names |
| `FLAT_WEB_URL` | unset | web app to render against (else `apps/web/dist`) |
| `FLAT_RENDER_CHANNEL` | unset | `chrome` for GPU rendering (default: Chromium + SwiftShader) |
| `FLAT_MCP_MAX_BATCH` / `_WRITES_PER_MIN` / `_RENDERS_PER_MIN` / `_MAX_ARG_BYTES` | 50 / 30 / 10 / 262144 | limits |

## Layout (for lanes)

| file | |
|---|---|
| `src/main.ts` | stdio entry |
| `src/server.ts` | `createFlatMcpServer({config, flat, clock?, tools?})`: registers tools and prompts |
| `src/config.ts` | env -> `McpConfig` |
| `src/tools/registry.ts` | `ToolDef`, `ToolContext`, `McpSession`, `visibleTools` |
| `src/tools/commandTools.ts` | the 13 write tools (lane D extends: preview, render, limits) |
| `src/tools/stubs.ts` | read / view / history / render stubs: replace in place |
| `src/flatApi.ts` | `FlatApi` + `HttpFlatApi` |
| `src/testing/mockFlatApi.ts` | `MockFlatApi`: in-memory, real `applyCommand` + history; `down`, `failNext`, `calls`, `views` |
| `src/testing/harness.ts` | `connectStdio` (real process), `startRealServer` (in-process `apps/server`) |
| `src/errors.ts` | `toolError`, `toolOk`, `commandErrors`, `apiFailure` |
| `src/__snapshots__` | tools/list, prompts/list and instructions snapshots = the contract |

Shared contracts live in `@flat/scene`: `mcp-types.ts` (RenderSpec, RenderResult, RoomDescription,
SceneDiff, error codes), `camera-presets.ts`, `describe.ts`, `diff.ts`, `protocol.ts` (ViewMsg,
checkpoints, undo-to).
