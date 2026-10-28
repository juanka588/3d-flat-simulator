# @flat/server

Optional local scene server: one shared scene, one shared undo stack, live sync over WebSocket.
The web app stays fully functional without it (GitHub Pages mode). All apply/undo/validation logic
comes from `@flat/scene`; this package only adds ordering, persistence and transport.

## Run

```sh
pnpm server            # http://127.0.0.1:8787
pnpm dev:all           # server + web dev server
```

| env | default | |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | keep the host on loopback |
| `DATA_DIR` | `apps/server/data` (git-ignored) | `state.json`, `scene.flat.json`, `log.ndjson` |
| `SCENE_FILE` | `packages/scene/fixtures/charme-3205.flat.json` | scene used on first boot |
| `ALLOWED_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | CORS + Origin allow-list |
| `FLAT_TOKEN` | unset | when set, writes need `Authorization: Bearer <token>` |
| `RATE_LIMIT` | `200` | writes per second per client |

## Connect the web app

```sh
pnpm dev:all                                   # server + web dev server; the dev app finds the server by itself
# or, against any build (dev server, `vite preview`, the public Pages site):
open 'http://127.0.0.1:5173/?server=http://127.0.0.1:8787'
open 'http://127.0.0.1:5173/?server=http://127.0.0.1:8787&token=<FLAT_TOKEN>'   # when the server has a token
```

- `?server=<url>` works on every build. In `vite dev` only, the app also probes
  `http://127.0.0.1:8787/healthz` once (1 s timeout) and connects when something answers; a production
  build without `?server` never probes, so the public Pages site stays purely local. `?server=off`
  forces Local mode. Automated browsers (`navigator.webdriver`, e.g. the e2e suite) skip the probe so
  a running dev server is never edited by tests; they can still pass `?server=`.
- The server's `ALLOWED_ORIGINS` must include the page's origin (default: the Vite dev origins
  `http://127.0.0.1:5173` and `http://localhost:5173`).
- `?token=` is kept in memory only (sent as a Bearer header on writes) and is removed from the address
  bar right after it is read.
- A chip in the sidebar shows `Local`, `Connected · rev N`, `Reconnecting…` or `Conflict: choose`.
  Edits apply immediately and are confirmed by the server; if the server is down they stay pending and
  are re-sent after the reconnect (backoff up to 10 s). A pending edit that no longer applies after
  someone else's change (e.g. its target was deleted) is dropped and reported in a toast.
- Undo/redo are server calls on the one shared history; the local stack is not used while connected.
- If the server's scene changes epoch (an import, or another server), a dialog asks: *Use server scene*
  (drops your unsynced edits) or *Keep mine (overwrite server)* (`PUT /api/scene`). Loading a file or
  fixture while connected replaces the shared scene the same way. Browser autosave keeps working as an
  offline cache, but the first connection of a page adopts the server's scene.
- Safari blocks an `https:` page (such as the public Pages site) from reaching `http://localhost`/
  `127.0.0.1` (mixed content), so `?server=` only works there from an `http:` page. Chrome and Firefox
  treat loopback as secure and allow it.

## Endpoints

| | |
|---|---|
| `GET /healthz` | `{ok, epoch, rev}` |
| `GET /api/scene` | `{epoch, rev, scene}` |
| `POST /api/commands` | body: a `CommandEnvelope` (optional `ifRev`). 200 `{ok, epoch, rev, seq, result}`, 400 malformed JSON, 409 `precondition_failed` (with current `rev`), 422 `{ok:false, errors: CommandError[]}` |
| `POST /api/undo`, `POST /api/redo` | optional body `{id?, author?, ifRev?}`; same responses (409 when nothing to undo/redo) |
| `GET /api/history` | `{canUndo, canRedo, past[], future[]}` with `{id, label, ts, author}` per step |
| `GET /api/log?since=<seq>` | log entries after `seq`; `truncated: true` if compaction removed some (resync via `/api/scene`) |
| `PUT /api/scene` | import a `.flat.json`: new `epoch`, history and log reset. 422 with path-annotated errors, 400 on bad JSON |
| `POST /api/checkpoints` | body `{name, author?, replace?}`. Records `{name, rev, seq, depth (undo-stack length), ts, author}`. Names are unique: 409 `checkpoint_exists` unless `replace: true`. At most 20: the oldest is evicted. 200 `{ok, epoch, checkpoint}` |
| `GET /api/checkpoints` | `{epoch, rev, checkpoints[]}`, oldest first |
| `POST /api/undo-to` | body `{checkpoint, id?, author?, ifRev?}`. Undoes the shared stack back to the checkpoint's depth in one atomic step; 200 `{ok, epoch, rev, seq, result, steps}` (`steps: 0` + `noop` when already there). 404 unknown checkpoint, 409 `precondition_failed` (stale `ifRev`), 409 `checkpoint_unreachable` (history is shallower than the checkpoint, or diverged after it), 422 bad body |
| `POST /api/view` | body `{pose?, lighting?, from?}` (at least one of pose/lighting). Relays an ephemeral `view` message to WS clients; response `{ok, delivered}`. Not logged, not in history, no rev bump. Limited to 10/s per client (429). Send header `X-Flat-Client: <id>` to skip the WS connection opened with `/ws?client=<id>` |
| `GET /api/materials` | `apps/web/public/materials/catalog.json` |
| `WS /ws` | `hello {epoch, rev, scene}` on connect; `applied {seq, rev, envelope, inverse, undoOf?, redoOf?}` after every command/undo/redo; `reset {epoch, rev, scene}` on import; `view {seq, from?, pose?, lighting?}` (ephemeral, only to connected clients, never replayed); send `{"type":"ping"}` to get `{"type":"pong"}` |

Message types live in `packages/scene/src/protocol.ts`.

Semantics: the server log defines order (last writer wins per command). `seq` is gapless within an
`epoch`. Envelope ids are idempotent: re-posting an id returns the original response and writes
nothing. Undo/redo are appended to the log (`undoOf`/`redoOf`), never truncated. A command that changes
nothing returns 200 with `result.noop` and no new rev.

Checkpoints (M4.7): a checkpoint stores the undo depth and the id of the top history entry. `undo-to`
appends one ordinary undo entry per step to the log (never truncated, so redo works) and broadcasts one
`applied` message per step, in order, after they are fsync'ed; sync clients need nothing new. The whole
request runs in one queue turn, so no other write interleaves. If a disk failure interrupts it midway, the
steps already done stay committed and the error is returned. Checkpoints are stored in `state.json`
(written and fsync'ed before the create call answers), and dropped on import (new epoch).

## Persistence

Every applied entry is appended to `log.ndjson` before the response is sent. `state.json` (scene,
history, counters) is rewritten atomically after a short debounce, with a human-readable copy in
`scene.flat.json`. Boot = snapshot + replay of the log tail; an unreadable (torn) last line is ignored
with a warning and cut. When the log reaches 1000 entries the snapshot is written and the log truncated.

## Security notes

- Binds to `127.0.0.1` only unless `HOST` is changed (a warning is printed).
- `Host` must be `127.0.0.1`, `localhost` or `[::1]` (DNS rebinding).
- Writes (`POST`/`PUT`) and the WebSocket upgrade are rejected with 403 when an `Origin` header is
  present and not in `ALLOWED_ORIGINS`. Browsers always send `Origin` on cross-site writes and WS
  upgrades, which is what blocks hostile web pages from driving a localhost server; non-browser
  clients (curl, MCP) send none and pass.
- `FLAT_TOKEN` (optional) is compared in constant time; scene reads are not gated.
- `author.kind` (`user` / `llm` / `planner`) in a command is taken from the request body: it selects the
  guards (locked items, structural walls, "LLM items must reference a product"). It is a convention between
  cooperating clients, not authentication. With `FLAT_TOKEN` set, every write (any author) needs the bearer
  token. With it unset (the loopback default) any local process can claim any kind; that is accepted for a
  single-user local tool, and it is why `HOST` other than loopback requires `FLAT_TOKEN`.
- Product and local-asset routes (`/api/providers`, `/api/products/*`, `/api/assets/products/*`,
  `/api/assets/meshes/*`) also guard READS: a request with an `Origin` must come from `ALLOWED_ORIGINS`; one
  without `Origin` is refused when the browser marks it `cross-site` or `same-site` (a page on another
  localhost port), so use `fetch()` from an allowed origin (not `<img src>`) from the web app. Responses are `no-store`.
- Retailer traffic: GET only, honest UA, one request per host at a time (the slot is held until the body is
  read, then 1.5 s gap), at most 20 queued per host, 10 s to the headers and 30 s to finish the body, robots.txt
  (404/410 = allow, 403/429/other errors = refuse and, for 403/429, open the circuit; never cached as allow-all).
  The circuit is re-checked inside the host slot before every attempt; half-open lets exactly one probe through.
- Pasted URLs: https, port 443, public hosts only; the connection itself is pinned to the vetted address
  (`providers/pinned.ts`), so DNS rebinding between check and connect is refused.
- IKEA URLs taken from responses must be `https://www.ikea.com/fr/fr/p/...` (pages) or on `www.ikea.com` /
  `web-api.ikea.com` (photos, models); anything else is replaced by a URL rebuilt from the SKU or dropped.
- `GET /api/products/:id/photo`: product photo proxy (memory-cached 1 h, 2 MB, raster images sniffed from the bytes). With a local catalogue it answers from `photos/<sku>.webp` first.
- The local product catalogue (`apps/server/local-assets/ikea-fr`, `LOCAL_CATALOG_DIR`, `FLAT_LOCAL_CATALOG=off` to ignore it; gitignored, denied in CI) is served through the same product routes, so the same Origin / `Sec-Fetch-Site` guards apply. See the README section "Local product catalogue".
- `GET /api/assets/meshes/catalog.json` and `GET /api/assets/meshes/:assetId.glb`: the local 3D-FUTURE pack
  (`apps/server/local-assets/3d-future`, `LOCAL_ASSETS_DIR`; gitignored, research licence). `:assetId` is
  `local:3dfuture:<model_id>` or the bare `<model_id>` (`[A-Za-z0-9][A-Za-z0-9_-]*`); only ids listed in the catalog are served.
- 2 MB body limit (imports up to the 5 MB scene limit), 200 writes/s per client, 50 WebSocket clients.

## curl

```sh
curl -s localhost:8787/api/scene | jq '.rev'

# one command
curl -s localhost:8787/api/commands -H 'content-type: application/json' -d '{
  "v":1,"id":"demo-1","ts":1,"author":{"kind":"user","name":"me"},
  "cmd":{"type":"room.setFloor","roomId":"sejour","materialId":"floor-tile"}}'

# an LLM plan as one atomic batch = one history entry
curl -s localhost:8787/api/commands -H 'content-type: application/json' -d '{
  "v":1,"id":"demo-2","ts":2,"author":{"kind":"llm","name":"claude"},
  "cmd":{"type":"batch","label":"warm living room","commands":[
    {"type":"room.setFloor","roomId":"sejour","materialId":"floor-oak"},
    {"type":"scene.setDefaults","wall":"paint-white"},
    {"type":"site.set","site":{"northAngle":20}}]}}'

curl -s localhost:8787/api/history | jq '.past[].label'
curl -s -X POST localhost:8787/api/undo      # reverts the whole batch
curl -s -X PUT  localhost:8787/api/scene --data-binary @packages/scene/fixtures/sample.flat.json
```

## Durability and recovery (M3 hardening)

- Each log append is written then `fdatasync`ed before the command is acknowledged or broadcast;
  concurrent commands share fsyncs (group commit). Snapshots and other atomic writes fsync the temp
  file, rename, then fsync the directory. (Earlier text claiming durability without fsync is superseded.)
- A rotating `state.json.prev` is kept; compaction archives the retired log as `log.ndjson.prev`.
- Boot: only a missing `state.json` (with no prev, log or quarantined files) is a first boot. An
  unreadable `state.json` is moved to `state.json.corrupt-<ts>` and the server recovers from
  `state.json.prev` plus log replay. If nothing is recoverable, or on EACCES/EIO, it refuses to start and
  deletes nothing. A corrupt line in the middle of the log also stops the boot (only a torn final line
  is tolerated). Entries that cannot be replayed go to `log.ndjson.dropped-<ts>`.
- Idempotency: the last 1000 `{id, hash, response}` records are stored in the snapshot, so retries
  survive compaction and restarts. Reusing an id with a different body (ignoring `ts`) returns
  409 `idempotency_conflict`. Undo/redo ids are namespaced separately and retried undos are idempotent.
- `server.lock` in `DATA_DIR` holds the owner pid; a second live server on the same directory refuses to start.
- `ALLOWED_HOSTS` (comma list) adds `Host` names beyond loopback; required for `HOST=0.0.0.0` LAN mode
  (also set `ALLOWED_ORIGINS` and `FLAT_TOKEN`).
- WebSocket heartbeat: ping every 30 s, a client that misses a pong is terminated.
