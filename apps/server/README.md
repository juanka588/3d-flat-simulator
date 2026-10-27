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
| `GET /api/materials` | `apps/web/public/materials/catalog.json` |
| `WS /ws` | `hello {epoch, rev, scene}` on connect; `applied {seq, rev, envelope, inverse, undoOf?, redoOf?}` after every command/undo/redo; `reset {epoch, rev, scene}` on import; send `{"type":"ping"}` to get `{"type":"pong"}` |

Message types live in `packages/scene/src/protocol.ts`.

Semantics: the server log defines order (last writer wins per command). `seq` is gapless within an
`epoch`. Envelope ids are idempotent: re-posting an id returns the original response and writes
nothing. Undo/redo are appended to the log (`undoOf`/`redoOf`), never truncated. A command that changes
nothing returns 200 with `result.noop` and no new rev.

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
- `FLAT_TOKEN` (optional) is compared in constant time; reads are not gated.
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
