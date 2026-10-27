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

`pnpm mcp:demo` runs an automated LLM twin of the demo (needs `ANTHROPIC_API_KEY`; `-- --dry` tests the harness without a key).

## Walk camera

- **Eye height** = person height - 11 cm (the eyes sit below the top of the head): 1.55 m for the default 166 cm person. "Person height" (120-210 cm) is in the sidebar, applies live and is stored in localStorage (`flat.personHeightCm`); it is view state, not part of the Scene.
- **Field of view.** Things looked "small" mostly because of the old 70 degree *vertical* fov (about 100 degrees across on a 16:10 window: a fisheye look). The walk camera now uses 50 degrees vertical on landscape/square screens (a normal lens, about 78 degrees across at 16:10). On portrait screens (aspect < 1) 50 degrees vertical would be a keyhole, so the vertical fov is derived from a 75 degree horizontal fov, capped at 100 degrees vertical (a 390x844 phone gets 100 degrees vertical, about 57 across). Helpers and tests: `viewer/walk-camera.ts`.

## Phones and tablets

The layout switches to the mobile one when the viewport is narrower than 768 px or the primary pointer is coarse (`ui/useMobileLayout.ts`, styles under `.app.mobile`).

- **Menu.** The sidebar is a drawer opened by the menu button (top-left; `aria-expanded`, focus moves into the drawer, Esc or a tap on the backdrop closes it and focus returns to the button; choosing a camera mode closes it). The 3D view always takes the whole screen. On desktop the same button collapses the sidebar and the choice is remembered (`flat.sidebarCollapsed`); the canvas resizes to the freed width.
- **Properties** become a collapsible bottom sheet that appears when something is selected, and is not shown in walk mode.
- **Touch.** Orbit: one finger rotates, two fingers pinch-zoom and pan. Top: one finger pans, two pinch-zoom (`touches` in `CameraRig`). A tap selects, a drag does not. Walk: dragging the view looks around (pointer events; iOS has no pointer lock, so pointer lock is only used with a fine pointer), move pad bottom-left, turn buttons bottom-right (56 px targets, safe-area aware), and the overlay does not capture touches elsewhere, so you can hold a button and drag with the other thumb. The canvas has `touch-action: none`, buttons `touch-action: manipulation` (no double-tap zoom), long-press callouts and text selection are disabled on the canvas and pad.
- **iOS / Android.** `viewport-fit=cover` with `env(safe-area-inset-*)` padding, `100dvh` (with a `100%` fallback), inputs at 16 px (no zoom on focus), native date and time inputs ("Exact time" next to the time slider), 44 px minimum targets.
- **Performance.** Phones (coarse pointer) and machines with at most 2 logical cores use `LOW_PROFILE` in `viewer/perf.ts`: canvas DPR capped at 1.5 (2 on desktop), sun shadow map 1024 (2048), point-lamp maps 256 (512), area and spot 512 (1024). `?quality=low` or `?quality=high` forces a profile.

## Layout

- `packages/scene` — Zod Scene schema (`*.flat.json`), validation, pure geometry builders (renderer-agnostic `MeshData`), collision, camera fitting. Conventions are documented in `src/schema.ts`.
- `apps/web` — Vite + React + react-three-fiber viewer.
- `docs/backlog` — milestones, user stories and acceptance criteria.
