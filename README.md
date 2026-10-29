# 3D Flat Simulator

Blueprint → 3D flat in the browser, with sun and lamp lighting; later furnished by an LLM through an MCP server.

**Live demo:** https://juanka588.github.io/3d-flat-simulator/ (deployed from `main` on every push).

## Run it

pnpm does not need to be installed globally; `npx` fetches it. Run each command on its own line:

```sh
npx pnpm@10 install
npx pnpm@10 dev
```

Then open **http://127.0.0.1:5173**. Orbit / Top / Walk switch views; click any surface to inspect it; drop a `.flat.json` to load another flat.

Other commands:

```sh
npx pnpm@10 check   # lint + typecheck + unit tests
npx pnpm@10 e2e     # Playwright browser tests (first time: npx playwright install chromium)
```

`e2e` runs the whole suite on desktop Chromium, and `e2e/mobile.e2e.ts` only on two phone projects: `mobile-iphone` (iPhone 13 viewport, DPR, user agent and touch, in Chromium) and `mobile-pixel` (Pixel 7). To also run the mobile spec in real WebKit (`mobile-safari`, iPhone 13; works with WebGL on macOS, not verified on the Linux CI image): `npx playwright install webkit`, then `E2E_WEBKIT=1 npx pnpm@10 e2e`. `E2E_SHOTS=/tmp` additionally saves screenshots.

## Let an assistant edit the flat (MCP)

`apps/mcp` is an MCP server (stdio, or streamable HTTP on loopback) that lets Claude read the flat, change it and see it (`render_view`). Setup, one-time prerequisites, Claude Code / Claude Desktop configuration, troubleshooting and security notes are in [`apps/mcp/README.md`](apps/mcp/README.md). Short version:

```sh
BASE_PATH=/ npx pnpm@10 --filter @flat/web build && npx playwright install chromium   # once
npx pnpm@10 dev:all                                                                    # scene server + web app
claude mcp add flat -- pnpm --silent --dir "$PWD" mcp                                  # always pnpm --silent
```

`pnpm mcp:demo` runs an automated LLM twin of the demo (needs `ANTHROPIC_API_KEY`; `-- --dry` tests the harness without a key). `pnpm mcp:demo:furnish` has Claude furnish Chambre 1 with real products under a budget through your local `claude` CLI and checks the result.

## Products and personal-use providers

The furniture of a flat comes from **real products** (name, price, link, exact size), never from invented ones. Product data lives in `apps/server`, so it only exists when you run the local scene server (`npx pnpm@10 dev:all`); the GitHub Pages build has no server, makes no retailer or provider request, and still opens flats that hold product items (stand-in shapes at the exact size, an "offline" badge).

**Enable providers** with `FLAT_PROVIDERS`, a comma list (default: none, and then no provider code is even loaded):

```sh
FLAT_PROVIDERS=ikea-fr,pasted-url npx pnpm@10 server     # IKEA France search + product pages + 3D models, and "paste a product URL"
FLAT_PROVIDERS=mock npx pnpm@10 server                   # fictional offline catalogue for tests and demos
```

`apps/server/.env.local` (gitignored, loaded by the server; the process environment wins) may hold the same setting and any provider credential. Credentials are read from the environment only and redacted from logs. Check what is on with `list_providers` (MCP) or `GET /api/providers`; `npx pnpm@10 providers:probe ikea-fr "lit 160"` makes a few polite live requests and prints what the parser found.

**Personal-use rules.** The IKEA FR and pasted-URL providers use unofficial endpoints and public pages. Their data and 3D models are for your own private design work on your own machine:

- they are shown in the UI under a "personal use" banner, and in `render_view` captions ("IKEA models, personal use");
- live results are streamed through your local server on demand and kept in memory only (search results 10 min, products 1 h, models 1 h; 200 MB in total, 20 MB per model). They are cached on disk only in the gitignored local catalogue that you build yourself (see "Local product catalogue" below), and never committed, never served from Pages;
- the traffic is polite: an honest User-Agent, GET only, one request at a time per host with a 1.5 s gap, `robots.txt` honoured, and a circuit breaker that pauses the provider after a 403/429 (so a blocked provider is not hammered);
- they may break without notice when the retailer changes its pages. A site with bot protection (Leroy Merlin, Maisons du Monde, La Redoute, Darty) cannot be read by "paste a product URL"; you then type the size by hand;
- you decide per provider (see `docs/research/m5-retailer-spike.md` for the spike and `docs/MODELS-CREDITS.md` for the CC0 model library that ships with the app).

## Local product catalogue (personal use)

Live IKEA requests are slow (10-20 s per search, 1.5 s per page) and IKEA's pages and models are sometimes unexpected. So you can build, once, a **local catalogue** of the products you actually use, and the simulator, the web Products tab and the MCP tools then answer from it instantly and offline:

```sh
pnpm catalog:build --limit 15           # a small sample first (about a minute)
pnpm catalog:build                      # the full curated build: about 400 products, 1-2 hours of polite fetching; Ctrl-C and run again to resume
pnpm catalog:build --refresh-prices     # later: update price and availability only (one page read per product)
pnpm catalog:status                     # what is in it: counts, products without a 3D model and why, memory before/after
```

Options: `--queries file` (your own list: one query per line, `query | category`), `--from-scene file.flat.json` (also fetch the IKEA products a flat uses), `--per-query 12`, `--max-products 400`, `--no-photos`, `--texture-max 1024`, `--no-optimize`, `--out dir`. The default query list is the "modern French flat" kit of `docs/research/m5-modern-assets.md` in French ("canapé 3 places", "îlot cuisine", "tabouret de bar", "lit 160x200", "table de chevet", "rideaux", "plante artificielle", "salon de jardin", ...) plus the products already used in the design sessions. It is curated, not a crawl: at most 12 results per query and 400 products.

- **Where.** `apps/server/local-assets/ikea-fr/` (`catalog.json`, `models/<sku>.glb`, `photos/<sku>.webp`), gitignored. CI fails if a file of that folder is tracked or appears in the Pages build (`retailer-hosts.json` `denyDirs` + a marker string; `check-no-retailer`). Personal use only, like the live provider.
- **Polite.** The build uses the same network layer as the live provider (honest User-Agent, GET only, one request at a time per host, 1.5 s gap, robots.txt, circuit breaker; a 403/429 stops the build and keeps what it has). Entries younger than 30 days are skipped, so every run is incremental and resumable.
- **Cleaned truth.** At build time every record is validated (schema, plausible dimensions, category, mount) and every GLB is parsed with glTF-Transform (Draco and Meshopt inputs), measured against the listed dimensions with the viewer's own rules, quarter-turned when the shop's width and depth are swapped, resized to textures of at most 1024 px and Meshopt-compressed. A missing height (sofas) is taken from the model. A product whose model is missing, unreadable or more than 25% out of proportion stays in the catalogue with `has3d: false` and the reason (`catalog:status`), so nothing 404s at run time.
- **Serving.** The ids stay `ikea-fr:<sku>`, so saved flats and the seen registry work unchanged. `search_products` and the Products tab query the catalogue first (French or English words, "queen size bed" finds 160x200); live IKEA is only a fallback when fewer results than the limit are found, or when you tick "Search IKEA live" / pass `live: true`. Results say `source: local|live` and `fetchedAt`; a local price older than 30 days is flagged stale (the bill of materials flags 30 days too). Models and photos are served by the same guarded routes as live ones (`LOCAL_CATALOG_DIR` to move it, `FLAT_LOCAL_CATALOG=off` to ignore it).

**What is stored.** A saved or exported flat keeps, per product item, only the **reference and a snapshot**: provider, SKU, link, name, price (TTC), currency, dimensions, category and the snapshot date. No photos, no 3D models and no provider response are written into the file; models are re-streamed when you open the flat with the server running, and fall back to a CC0 lookalike or a parametric shape at the exact size otherwise. A price older than 30 days is flagged "stale" and can be refreshed from the server ("Update price/dims"). The bill of materials (`get_bill_of_materials`, the room item list) counts TTC prices of the items you placed; the existing built-in wardrobes (placards) are locked and count 0; delivery and assembly are not included.

**Guards that keep retailer data local** (D4 of `docs/backlog/m5.md`):

- provider modules are imported lazily, only for ids listed in `FLAT_PROVIDERS`, and only from `apps/server`;
- `node scripts/ci/check-no-retailer.mjs` (run in CI after a Pages build, and `--worktree` locally) fails when the Pages `dist` or any tracked file mentions a retailer host from `scripts/ci/retailer-hosts.json`, contains a stray `.glb`/`.gltf`/`.usdz` outside the CC0 library, a `.env*` file or 3D-FUTURE content;
- provider routes (reads too) answer 403 to a foreign `Origin`, the server only accepts loopback `Host` names, and "paste a URL" has an SSRF guard (public addresses only);
- the model can only place products that a search returned in its own session (`unknown_product` otherwise), and price and size always come from the server's record, never from the model's arguments;
- the e2e suite checks that Pages mode makes zero retailer, provider or `/api` requests (`e2e/static-products.e2e.ts` on the Pages build).

Provider authors: see [`apps/server/src/providers/README.md`](apps/server/src/providers/README.md). Furnishing with an assistant: `npx pnpm@10 mcp:demo:furnish` (see [`apps/mcp/README.md`](apps/mcp/README.md)).

## Walk camera

- **Eye height** = person height - 11 cm (the eyes sit below the top of the head): 1.55 m for the default 166 cm person. "Person height" (120-210 cm) is in the sidebar, applies live and is stored in localStorage (`flat.personHeightCm`); it is view state, not part of the Scene.
- **Field of view.** Things looked "small" mostly because of the old 70 degree *vertical* fov (about 100 degrees across on a 16:10 window: a fisheye look). The walk camera now uses 50 degrees vertical on landscape/square screens (a normal lens, about 78 degrees across at 16:10). On portrait screens (aspect < 1) 50 degrees vertical would be a keyhole, so the vertical fov is derived from a 75 degree horizontal fov, capped at 100 degrees vertical (a 390x844 phone gets 100 degrees vertical, about 57 across). Helpers and tests: `viewer/walk-camera.ts`.

## Phones and tablets

The layout switches to the mobile one when the viewport is narrower than 768 px or the primary pointer is coarse (`ui/useMobileLayout.ts`, styles under `.app.mobile`).

- **Menu.** The sidebar is a drawer opened by the menu button (top-left; `aria-expanded`, focus moves into the drawer, Esc or a tap on the backdrop closes it and focus returns to the button; choosing a camera mode closes it). The 3D view always takes the whole screen. On desktop the same button collapses the sidebar and the choice is remembered (`flat.sidebarCollapsed`); the canvas resizes to the freed width.
- **Properties** become a collapsible bottom sheet that appears when something is selected, and is not shown in walk mode.
- **Touch.** Orbit: one finger rotates, two fingers pinch-zoom and pan. Top: one finger pans, two pinch-zoom (`touches` in `CameraRig`). A tap selects, a drag does not. Walk: dragging the view looks around (pointer events; iOS has no pointer lock, so pointer lock is only used with a fine pointer), move pad bottom-left, turn buttons bottom-right (56 px targets, safe-area aware), and the overlay does not capture touches elsewhere, so you can hold a button and drag with the other thumb. The canvas has `touch-action: none`, buttons `touch-action: manipulation` (no double-tap zoom), long-press callouts and text selection are disabled on the canvas and pad.
- **iOS / Android.** `viewport-fit=cover` with `env(safe-area-inset-*)` padding, `100dvh` (with a `100%` fallback), inputs at 16 px (no zoom on focus), native date and time inputs ("Exact time" next to the time slider), 44 px minimum targets.
- **Performance.** Phones (coarse pointer) and machines with at most 2 logical cores use `LOW_PROFILE` in `packages/viewer/src/perf.ts`: canvas DPR capped at 1.5 (2 on desktop), sun shadow map 1024 (2048), point-lamp maps 256 (512), area and spot 512 (1024). `?quality=low` or `?quality=high` forces a profile.

## Layout

Packages (`packages/*`, workspace names `@flat/*`; the dependency matrix is enforced by ESLint and `scripts/ci/package-graph.test.mjs`, see `docs/architecture/modules.md`):

- `packages/scene` — the root of the graph: Zod Scene schema (`*.flat.json`), validation, commands, placement, pure geometry builders (renderer-agnostic `MeshData`), collision, camera fitting. No renderer, no I/O. Conventions are documented in `src/schema.ts`.
- `packages/assets` — the shape and look of items: parametric generators, mesh catalogue and lookalike matching, product records, materials, asset loading and caches; `@flat/assets/node` reads the local pack from disk. Importing it registers the generators.
- `packages/site` — where the flat is: geodesy, BD TOPO to `SiteContext`, the fit to the host footprint, and the `pnpm site:context` generator (`@flat/site/node`). See [`packages/site/README.md`](packages/site/README.md).
- `packages/viewer` — the rendering library (react-three-fiber): shell, items, lighting, probe GI, sky, cameras; `@flat/viewer/testing` is for the web test hooks only.
- `packages/capture` — contracts for photo and plan capture (no code yet). See [`packages/capture/README.md`](packages/capture/README.md).

Apps (`apps/*`, leaves of the graph):

- `apps/web` — Vite + React shell around the viewer: editor UI, catalogue, state, Pages build.
- `apps/server` — local scene server (REST + WebSocket on loopback) and the personal-use product providers. See [`apps/server/README.md`](apps/server/README.md) and [`apps/server/src/providers/README.md`](apps/server/src/providers/README.md).
- `apps/mcp` — MCP server for assistants. See [`apps/mcp/README.md`](apps/mcp/README.md).

Elsewhere: `e2e/` (Playwright), `scripts/` (CI guards, asset and model tooling), `docs/` (`backlog` — milestones, user stories and acceptance criteria; `architecture`).
