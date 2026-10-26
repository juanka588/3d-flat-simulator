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
