# 3D Flat Simulator

Blueprint → 3D flat in the browser, with sun and lamp lighting; later furnished by an LLM through an MCP server.

```sh
npx pnpm@10 install
npx pnpm@10 dev      # web app on http://localhost:5173
npx pnpm@10 check    # lint + typecheck + tests
```

- `packages/scene` — Zod Scene schema (`*.flat.json`), validation, measurements. Conventions are documented in `src/schema.ts`.
- `apps/web` — Vite + React viewer.
