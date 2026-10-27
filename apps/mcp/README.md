# @flat/mcp

MCP server for the flat simulator: read the flat, change it, see it (M4). A thin adapter: every tool
call becomes a `CommandEnvelope` (`author: {kind: 'llm', name: <clientInfo.name>}`) posted to
`apps/server` over REST. 24 tools, 5 resources, 2 prompts, stdio and streamable HTTP, rendering with a warm
headless Chromium (see `docs/backlog/m4.md`).

Tools: the 13 write tools (+ `preview`, `render`, `label`), `get_scene_summary`, `list_rooms`, `describe_room`,
`list_materials`, `set_sun_time`, `render_view`, `list_history`, `undo`, `redo`, `checkpoint`, `restore_checkpoint`.

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

## Set up an assistant

### Prerequisites

```sh
npx pnpm@10 install
BASE_PATH=/ npx pnpm@10 --filter @flat/web build   # the viewer that render_view draws (read from apps/web/dist)
npx playwright install chromium                     # the headless browser for render_view (first time only)
npx pnpm@10 dev:all                                 # scene server (8787) + web app (5173); open http://127.0.0.1:5173/?server=http://127.0.0.1:8787
```

Without the build or Chromium everything works except images (`render_unavailable`, with the fix in the hint).
In the open tab, switch on "Follow assistant view" to see the assistant's `set_sun_time {sync_to_user_tab: true}` and camera.

### Claude Code

```sh
claude mcp add flat -- pnpm --silent --dir "$PWD" mcp
# or over HTTP (start it first: pnpm --silent mcp --http), with a bearer token when FLAT_TOKEN is set:
claude mcp add --transport http flat http://127.0.0.1:8788/mcp --header "Authorization: Bearer $FLAT_TOKEN"
```

A project-scoped `.mcp.json` (checked in; no secrets in it):

```json
{
  "mcpServers": {
    "flat": {
      "command": "pnpm",
      "args": ["--silent", "--dir", "/absolute/path/to/3d-flat-simulator", "mcp"],
      "env": { "FLAT_SERVER_URL": "http://127.0.0.1:8787" }
    }
  }
}
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS). Desktop starts the process without your shell
profile, so `pnpm`, `npx` and nvm-managed `node` are usually NOT on its PATH: use the absolute path of a node >= 22 (`which node`)
and run `src/main.ts` with the tsx loader (`--import <abs path>/tsx/dist/loader.mjs`; a bare `--import tsx` resolves from the unknown working directory of Desktop, so use absolute paths).

```json
{
  "mcpServers": {
    "flat": {
      "command": "/absolute/path/to/node",
      "args": ["--import", "/absolute/path/to/3d-flat-simulator/apps/mcp/node_modules/tsx/dist/loader.mjs", "/absolute/path/to/3d-flat-simulator/apps/mcp/src/main.ts"],
      "env": { "FLAT_SERVER_URL": "http://127.0.0.1:8787" }
    }
  }
}
```

Restart Claude Desktop after editing.

### Debugging with the inspector

```sh
npx @modelcontextprotocol/inspector -- pnpm --silent --dir "$PWD" mcp
npx @modelcontextprotocol/inspector --transport http --server-url http://127.0.0.1:8788/mcp   # HTTP mode
```

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The client reports invalid JSON / "unexpected token >" / connection closed at start | Something wrote to stdout, which is the JSON-RPC channel. Always run `pnpm --silent` (pnpm's `> script` banner is the usual culprit); never `console.log` in `src/`; logs go to stderr. |
| `server_unreachable` | The scene server is not running or `FLAT_SERVER_URL` is wrong. `pnpm dev:all` or `pnpm server`; the MCP process itself stays up. |
| `render_unavailable`: web build not found | Run `BASE_PATH=/ pnpm --filter @flat/web build` (or set `FLAT_WEB_URL` to a running web app). |
| `render_unavailable`: cannot launch the headless browser | `npx playwright install chromium` (or `FLAT_RENDER_CHANNEL=chrome` to use installed Chrome). |
| `render_timeout` / "busy" | First render starts a browser (several seconds); renders are serialised, 20 s limit. Retry. |
| HTTP 403 `Host` / `Origin` not allowed | DNS-rebinding guard: only loopback names are accepted. Behind a proxy or on a LAN address set `FLAT_MCP_ALLOWED_HOSTS=name1,name2`. |
| HTTP 401 | The endpoint requires `Authorization: Bearer $FLAT_TOKEN` (the same token the scene server uses). |
| Refuses to start with `--host 0.0.0.0` | Non-loopback binds require `FLAT_TOKEN`. |
| `rate_limited` | 30 writes and 10 renders per minute per session by default (`retryAfterMs` says when); see the table below. |
| The tab does not show a view change | "Follow assistant view" is off in that tab, or the tab is not connected (`?server=`). |
| `command not found: pnpm` in Claude Desktop | PATH/nvm: use the absolute node path configuration above. |

### Security notes

- Local use only: the scene server and the MCP HTTP endpoint bind to `127.0.0.1`. Non-loopback needs `FLAT_TOKEN`; Host and Origin are validated on every HTTP request; the token comparison is constant-time. stdio trusts the parent process.
- The assistant cannot remove or un-protect structural walls (enforced by the scene reducer, not by the prompt), writes are rate-limited and capped per session, batches are capped at 50 commands and arguments at 256 KB.
- `FLAT_MCP_READONLY=1` lists only read, view and history-read tools; `FLAT_MCP_TOOLS` restricts the list further.
- Everything stored in the scene (room names, labels) is treated as untrusted data, never as instructions.
- Every change is attributed (`author: llm`, the client's name) and undoable; undo is shared with the user.
- `render_view` runs a headless browser against files served on a loopback ephemeral port; it never touches your tab.
- The LLM demo (`pnpm mcp:demo`) spends real tokens only with `ANTHROPIC_API_KEY` set and aborts above `FLAT_DEMO_MAX_USD` (default 2).

## Run

```sh
pnpm dev:all          # scene server + web app (or: pnpm server)
pnpm mcp              # MCP over stdio (used by an MCP client, not by hand)

claude mcp add flat -- pnpm --silent --dir "$PWD" mcp
claude mcp add flat -e FLAT_SERVER_URL=http://127.0.0.1:8787 -e FLAT_TOKEN=... -- pnpm --silent --dir /path/to/3d-flat-simulator mcp
```

### Streamable HTTP

```sh
pnpm --silent mcp --http [--port 8788] [--host 127.0.0.1]     # POST http://127.0.0.1:8788/mcp, GET /healthz
claude mcp add --transport http flat http://127.0.0.1:8788/mcp
FLAT_TOKEN=... pnpm --silent mcp --http --host 0.0.0.0        # non-loopback needs FLAT_TOKEN; add FLAT_MCP_ALLOWED_HOSTS=name1,name2
```

Stateless (a server per request); the session (`set_sun_time` lighting, rate limits, write cap) is shared by
the process. Host and Origin are validated (403), `Authorization: Bearer $FLAT_TOKEN` is required when the token is set (401).

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
| `FLAT_MCP_MAX_BATCH` / `_WRITES_PER_MIN` / `_RENDERS_PER_MIN` / `_MAX_ARG_BYTES` / `_SESSION_WRITES` | 50 / 30 / 10 / 262144 / 500 | limits |
| `FLAT_MCP_HTTP_PORT` / `_HTTP_HOST` / `_ALLOWED_HOSTS` | 8788 / 127.0.0.1 / unset | HTTP transport |

## Layout (for lanes)

| file | |
|---|---|
| `src/main.ts` | stdio entry |
| `src/server.ts` | `createFlatMcpServer({config, flat, clock?, tools?, session?, renderer?})`: registers tools and prompts |
| `src/config.ts` | env -> `McpConfig` |
| `src/tools/registry.ts` | `ToolDef`, `ToolContext`, `McpSession`, `visibleTools` |
| `src/tools/commandTools.ts` | the 13 write tools (lane D extends: preview, render, limits) |
| `src/tools/render.ts`, `src/render/` | `render_view` and the render service (the only place that imports Playwright; checked by `playwrightBoundary.test.ts`) |
| `src/flatApi.ts` | `FlatApi` + `HttpFlatApi` |
| `src/testing/mockFlatApi.ts` | `MockFlatApi`: in-memory, real `applyCommand` + history; `down`, `failNext`, `calls`, `views` |
| `src/testing/harness.ts` | `connectStdio` (real process), `startRealServer` (in-process `apps/server`) |
| `src/errors.ts` | `toolError`, `toolOk`, `commandErrors`, `apiFailure` |
| `src/__snapshots__` | tools/list, prompts/list and instructions snapshots = the contract |

Shared contracts live in `@flat/scene`: `mcp-types.ts` (RenderSpec, RenderResult, RoomDescription,
SceneDiff, error codes), `camera-presets.ts`, `describe.ts`, `diff.ts`, `protocol.ts` (ViewMsg,
checkpoints, undo-to).

## Rendering (`render_view`)

`render_view` draws the flat with a warm headless Chromium showing the built viewer (`apps/web/dist`), served on a loopback ephemeral port. Build it once with the root base path:

```sh
BASE_PATH=/ pnpm --filter @flat/web build     # any base path works; it is read from dist/index.html
npx playwright install chromium               # first time only
```

Env: `FLAT_WEB_URL` (a directory to serve, or a running web app such as `http://127.0.0.1:5173/`), `FLAT_RENDER_CHANNEL=chrome` (installed Chrome with GPU instead of bundled Chromium + SwiftShader). Without a build, tools answer `render_unavailable`. Renders are serialised (queue depth 3, then "busy"), time out at 20 s, recover from browser crashes on the next call, and the browser closes after 10 idle minutes. Slow tests: `MCP_RENDER=1 pnpm test:render` (nightly CI).

## Tests

| Tier | Command | Content |
|---|---|---|
| 1-2 | `pnpm test` | in-memory MCP client over the mock scene API, real stdio and HTTP transports, tools/list snapshot, Playwright import boundary. Fast (about 2 s for the whole package). |
| 3 | `MCP_RENDER=1 pnpm test:render` | render service and `render_view` with a real Chromium and a real `apps/server`; pixel probes; needs the web build. Nightly. |
| 4 | `pnpm e2e` (`e2e/mcp-live.e2e.ts`) | a real tab on `?server=` with "Follow assistant view", an MCP client over stdio: write reaches the tab within 1 s (author llm), `set_sun_time {sync_to_user_tab}` changes the tab's time, not its lamps. Nightly. |
| 5 | `ANTHROPIC_API_KEY=... pnpm mcp:demo [-- --negative]` | a real model drives the tools; assertions on state. `-- --dry` runs a scripted fake model (no key, no cost). Nightly only when the secret exists. |
