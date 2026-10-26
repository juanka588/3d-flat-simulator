# 3D Flat Simulator

Blueprint → 3D flat in the browser, with sun and lamp lighting; later furnished by an LLM through an MCP server.

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

## Layout

- `packages/scene` — Zod Scene schema (`*.flat.json`), validation, pure geometry builders (renderer-agnostic `MeshData`), collision, camera fitting. Conventions are documented in `src/schema.ts`.
- `apps/web` — Vite + React + react-three-fiber viewer.
- `docs/backlog` — milestones, user stories and acceptance criteria.
