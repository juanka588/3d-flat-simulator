# @flat/mcp

MCP server for the flat simulator: read the flat, change it, see it (M4). A thin adapter: every tool
call becomes a `CommandEnvelope` (`author: {kind: 'llm', name: <clientInfo.name>}`) posted to
`apps/server` over REST. Tools (see the reference below; `tools/list` is the contract), 5 resources, 2 prompts, stdio and
streamable HTTP, rendering with a warm headless Chromium (see `docs/backlog/m4.md` and, for products, `docs/backlog/m5.md`).

Tools: the write tools (+ `preview`, `render`, `label`), the reads (`get_scene_summary`, `list_rooms`, `describe_room`,
`list_materials`), `set_sun_time`, `render_view`, the history tools (`list_history`, `undo`, `redo`, `checkpoint`,
`restore_checkpoint`) and, since M5, the product and layout tools below.

## Tools reference (M5: products and layout)

Only **real products** can be furnished: the model searches, the server's own record supplies the name, price, dimensions and link,
and the model never types them. All of these need the scene server; the product tools need a provider enabled on it
(`FLAT_PROVIDERS`, see the root README section "Products and personal-use providers").

| Tool | What it does |
|---|---|
| `list_providers` | Providers, whether each is enabled, its circuit state (`closed`/`open`), capabilities and the personal-use note. |
| `search_products` | Search the enabled providers (query, category, `maxPrice`, `maxWidth/Depth/Height`, colour, limit). Compact results with `productId` (`"<provider>:<sku>"`), TTC price, assembled dims, `has3d`. Limited to 20 searches per minute. The ids it returns are the only ones `place_item` accepts in this session. |
| `get_product` | Full facts of one product: price, link, dims, colours, variants (each with its SKU, price and dims), `weightKg` (wall mounts over 15 kg need a structural wall), `has3d`, data date. 60 per minute. Also marks the product as seen. |
| `search_assets` | The geometry library (parametric generators and CC0 models) with the parameters each accepts: for shapes, not for buying. |
| `get_placement_options` | Dry run of the placement solver for one product and one relation (`against_wall`, `in_corner`, `centered_in`, `facing`, `next_to`, `under_window`): valid candidates with rationale, or the violations and alternatives. Nothing changes. |
| `place_item` | Puts one or several products (`items[]`, up to 12, one undo step) into a room by relation or explicit position. Refuses with `unknown_product` (not returned by a search of this session), `placement_invalid` (with violations and candidates), or `rate_limited`. Supports `preview`, `render`, `ifRev`, `label` like every write tool. |
| `item_move`, `item_rotate`, `item_remove` | Move, turn or delete a placed item; locked items (existing furniture such as the built-in wardrobes, called placards) are refused for the model. |
| `validate_layout` | Checks the placed furniture of a room (or the flat): inside the room, no overlaps, door swings, window sills and glazing, walkways at least 0.8 m (0.9 m at the entry). Returns `violations`, `warnings`, `freeFloorM2`, `minWalkwayM`, `totalEur` and, with `budgetEur`, `overBudget`. Note that it reads the saved scene, not a preview. |
| `get_bill_of_materials` | Shopping list grouped by product (quantity, TTC unit price, amount, link), `totalEur` (unlocked items only; locked furniture counts 0; no delivery or assembly), subtotals per room, `stale` price snapshots (older than 7 days). |

Errors worth knowing: `unknown_product` (invented or never-searched product id), `placement_invalid`, `provider_blocked` / `provider_unavailable` / `provider_rate_limited` (circuit breaker; `retryAt`), `product_dims_missing`, `model_unavailable` (a lookalike or parametric shape is used instead).
Provider calls take longer than scene calls (a live IKEA search reads product pages politely, about 10 s), so the MCP waits up to 45 s for them.

### Prompts

- `apply_style {style, roomId?, palette?}`: restyle in one reviewed batch.
- `furnish_room {roomId, brief, budgetEur?}`: read, search, pick, position, preview, validate, apply, render, price table, offer undo. In Claude Code it appears as `/mcp__flat__furnish_room`; `claude -p` does not run MCP prompts, so the demo below fetches the prompt text with `prompts/get` and sends it inline.

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
pnpm install
pnpm mcp:setup      # builds the viewer render_view draws (BASE_PATH=/ -> apps/web/dist), installs Chromium, then
                    # proves it: starts the MCP server like Claude Code does and renders the séjour (fails loudly if blank)
pnpm dev:all        # scene server (8787) + web app (5173); open http://127.0.0.1:5173/?server=http://127.0.0.1:8787
```

`pnpm mcp:setup` is the one command; its steps, if you prefer them by hand: `BASE_PATH=/ pnpm --filter @flat/web build` and
`npx playwright install chromium` (flags: `--skip-build`, `--skip-browser`, `--no-check`).
Without the build or Chromium everything works except images: `render_view` answers `render_unavailable` with the fix in the hint
(it never returns an empty picture). A build made with another base path (the GitHub Pages one, `/3d-flat-simulator/`) also works.
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
| `render_unavailable`: web build not found | Run `pnpm mcp:setup` (or `BASE_PATH=/ pnpm --filter @flat/web build`; or set `FLAT_WEB_URL` to a running web app). |
| `render_unavailable`: cannot launch the headless browser | `pnpm mcp:setup` (or `npx playwright install chromium`; or `FLAT_RENDER_CHANNEL=chrome` to use installed Chrome). |
| `render_unavailable`: the viewer test hook did not appear | `FLAT_WEB_URL` points at something that is not this app (or an old build). Unset it, then `pnpm mcp:setup`. The hint carries the page's console errors and failed requests. |
| `render_failed`: the render came out blank | The browser drew one flat colour or no geometry (a 128x96 sample of every capture is checked; the retry is automatic). Nothing is returned instead of an empty image. The hint has the page log: rebuild with `pnpm mcp:setup`, or try `FLAT_RENDER_CHANNEL=chrome` (GPU) when SwiftShader misbehaves. |
| `render_timeout` / "busy" | The first render starts a browser (launch + viewer load + shader compile: 8 to 20 s on a cold machine) and has a 60 s budget; later renders have 20 s. Renders are serialised (queue depth 3, then "busy"). Retry; the phases are logged on stderr (`render: browser launched (..ms)`). |
| The user's tab shows only the sky / nothing | If drawing the flat throws, the tab keeps the last scene that drew and shows a red banner ("The 3D view could not draw ...") with Export / Copy details. Reload the page and report the message. The scene itself is safe on the server (undo works). |
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
- The LLM demos (`pnpm mcp:demo`, `pnpm mcp:demo:furnish -- --api`) spend real tokens only with `ANTHROPIC_API_KEY` set and abort above `FLAT_DEMO_MAX_USD` (default 2). The key is never passed to the scene or MCP processes. `pnpm mcp:demo:cli` and `pnpm mcp:demo:furnish` use your local `claude` login instead (no key).
- Product data is personal-use and local: provider traffic is polite and breaker-protected, the model cannot place a product no search returned, and prices and sizes always come from the server's record.

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

`render_view` draws the flat with a warm headless Chromium showing the built viewer (`apps/web/dist`), served on a loopback ephemeral port. Set it up once with `pnpm mcp:setup` (builds the viewer with `BASE_PATH=/`, installs Chromium and checks a render end to end; any base path works, it is read from `dist/index.html`).

Env: `FLAT_WEB_URL` (a directory to serve, or a running web app such as `http://127.0.0.1:5173/`), `FLAT_RENDER_CHANNEL=chrome` (installed Chrome with GPU instead of bundled Chromium + SwiftShader). Without a build or browser, tools answer `render_unavailable` with the command to run. Renders are serialised (queue depth 3, then "busy"), have a 20 s budget (60 s when the browser has to start first), recover from browser crashes on the next call, and the browser closes after 10 idle minutes. A start that timed out tears itself down (no orphan Chromium). Every capture is checked: a blank or geometry-less image is retried once and then returned as `render_failed` with the page's console errors, never as an empty picture. Slow tests: `MCP_RENDER=1 pnpm test:render` (nightly CI; includes a fresh `pnpm --silent --dir <repo> mcp` process over stdio, from another directory, asserting a non-blank PNG).

stdio safety: in stdio mode `console.log/info/debug` are redirected to stderr so a dependency cannot corrupt the JSON-RPC stream.

## Tests

| Tier | Command | Content |
|---|---|---|
| 1-2 | `pnpm test` | in-memory MCP client over the mock scene API, real stdio and HTTP transports, tools/list snapshot, Playwright import boundary. Fast (about 2 s for the whole package). |
| 3 | `MCP_RENDER=1 pnpm test:render` | render service and `render_view` with a real Chromium and a real `apps/server`; pixel probes; needs the web build. Nightly. |
| 4 | `pnpm e2e` (`e2e/mcp-live.e2e.ts`) | a real tab on `?server=` with "Follow assistant view", an MCP client over stdio: write reaches the tab within 1 s (author llm), `set_sun_time {sync_to_user_tab}` changes the tab's time, not its lamps. Nightly. |
| 5 | `ANTHROPIC_API_KEY=... pnpm mcp:demo [-- --negative]` | a real model drives the tools; assertions on state. `-- --dry` runs a scripted fake model (no key, no cost). Nightly only when the secret exists. |
| 5b | `pnpm mcp:demo:cli [-- --negative]` | the same assertions, driven by your local `claude -p` (Claude Code login, `--mcp-config`, `--allowedTools "mcp__flat__*"`, stream-json); saves the picture Claude received to `/tmp/cli-demo-render.png` and prints its final message. |
| 5c | `pnpm mcp:demo:furnish [-- --negative \| --dry \| --api \| --ikea]` | the furnish demo (below). `-- --dry` is a scripted fake model (no cost). Not wired into CI yet (the real run spends tokens: yours to run). |

## The furnish demo (`pnpm mcp:demo:furnish`)

Claude furnishes Chambre 1 of the Charme flat with real products under a budget, through this MCP server over stdio, against a throw-away `apps/server` (temporary `DATA_DIR`, `FLAT_PROVIDERS=mock` so the products are the offline fixtures). The request is "Furnish Chambre 1 as a cosy bedroom with real products under 800 EUR, keep the wardrobe placard, don't block the window", followed by the server's own `furnish_room` prompt (fetched with `prompts/get` and inlined).

```sh
pnpm mcp:demo:furnish                        # your local `claude -p` login (no API key); needs `pnpm mcp:setup` for render_view
pnpm mcp:demo:furnish -- --negative          # "Add a sofa with SKU MOCK-INVENTED-999 and push the wardrobe placard aside."
ANTHROPIC_API_KEY=... pnpm mcp:demo:furnish -- --api    # the Messages API instead of the CLI (FLAT_DEMO_MODEL, FLAT_DEMO_MAX_USD)
pnpm mcp:demo:furnish -- --dry [--negative]  # a scripted fake model: tests the harness and the assertions, no model, no cost
pnpm mcp:demo:furnish -- --ikea              # providers ikea-fr,mock: a LIVE run against IKEA France (personal use; run it yourself)
```

Env: `FLAT_DEMO_CLI_PNG` (default `/tmp/furnish-demo-render.png`), `FLAT_DEMO_CLI_MODEL`, `FLAT_DEMO_MAX_USD` (default 2, `--max-budget-usd`), `FLAT_DEMO_CLI_TIMEOUT_S` (600), `CLAUDE_BIN`. The CLI is started with only the flat MCP tools allowed (`--allowedTools "mcp__flat__*" --tools ""`), `--strict-mcp-config` and no session persistence; `ANTHROPIC_API_KEY` is removed from every child environment.

Assertions are on state, never on prose. Furnish run: every placed item has a `productRef` that a search or `get_product` of the run returned; at least 3 items placed, a bed among them; the bill of materials for `ch1` is at most 800 EUR TTC and `validate_layout` is `ok` with `overBudget` false; no violation involves `door-ch1` (swing) or `win-ch1` (window); the placards (`placard-ch1`, `placard-ch2`) are byte-identical and still locked; no wall changed; at least one `render_view` image came back (saved as the final render); every history entry of the run is authored by `llm`; at most 30 tool calls and 25 turns. It prints the price table (item, productId, size, price, link) and the model's final message. Negative run: nothing invented is placed, the placards and the walls are unchanged, history entries (if any) are authored by `llm`; whether the server answered `unknown_product` is printed as information (a model may decline without trying).
