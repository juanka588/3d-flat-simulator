# Next session: where we stopped (2026-10-28 evening)

## In flight when we stopped
- **Refactor V7 and V8 (`@flat/viewer` package)** was running in an agent worktree under `.claude/worktrees/agent-a8d88725…`
  (branch `worktree-agent-a8d88725dabd08689`).
  - First check whether it finished: `git -C .claude/worktrees/agent-a8d88725dabd08689 status`, and `modules.md`
    marked V7/V8 done.
  - If it finished, run the gates and merge: `CI=1 pnpm check`, the web build with `check-no-retailer --worktree`,
    the bundle within ±1 kB of 581.96 kB, a single three.js `REVISION` in dist, `CI=1 E2E_STATIC=only`, and
    `MCP_RENDER=1 pnpm test:render`.
  - If it didn't finish, restart V7/V8 from main using the brief in `docs/architecture/modules.md` §4.

## Remaining refactor (docs/architecture/modules.md)
1. **V7/V8:** `@flat/viewer` (above).
2. **Step 11, cleanup:**
   - drop the scene `test/generators.setup.ts` exception;
   - drop the `importNames` rules, since the symbols no longer exist in scene;
   - drop the `tools/site-context` shim and `packages/site/legacy/`;
   - tighten the package-graph test;
   - update the README "Layout" and the provider README links.
3. **Reuse for the home-management / Home Assistant project (§8):**
   - **P12:** library builds (tsup or `vite --lib`) for scene, assets and viewer, a `development` export condition,
     changesets, and a `pnpm pack` consumer smoke test in CI;
   - **P13:** `@flat/scene/live` (`LiveEntityState`, `Bindings`, `applyLiveState`), and the viewer `liveState`,
     `bindings`, markers and overlays, plus a `/?live=demo` route;
   - **P14:** the `<flat-viewer>` custom element (`@flat/viewer/element`) and an HA-style Lit card example;
   - **P15:** API reports (api-extractor) and a docs page "Embedding the viewer";
   - also add the hover and fly-to interaction API (see the V6 record: no `onHover` yet).

## Other open items
- **Lighting:** probes run on real GPUs only. Software GL (CI, MCP, e2e) keeps the legacy per-room path, so the
  legacy code can't be removed yet. Optional: `?exposure=adapt` eye adaptation (opt-in, burns out orbit/top
  ground). Photo-mode path tracer (spike option b) not started.
- **CI:** green. Nightly runs e2e on 8 shards, single worker, low quality; mcp-nightly renders serially. Known
  local-only flakes under load: `static.e2e.ts:110` (autosave) and some `viewer`/`walk-comfort` navigation
  timeouts. A warm render on the runner still takes about 6 s (not explained).
- **Style prompts:** the library is done (`apps/mcp/styles/`, `docs/styles.md`). `--style`, `--team` and `--variants`
  were validated with `--dry` only. **The user asked not to run team/variant sessions yet.**
- **Local IKEA catalogue:** built (400 products, 275 with 3D) in the gitignored `apps/server/local-assets/ikea-fr/`.
  Refresh with `pnpm catalog:build --refresh-prices`.
- **Backlog after the refactor:** M5R leftovers (textured soft-item generators: rugs, cushions, throws, curtains;
  texture LOD; a real-GPU check in CI), then M6 (blueprint image → Scene JSON; cadastre footprint as a constraint),
  M7 (inspiration image → descriptors), M8 (autonomous variants, which the style/team runner prepares), and M9 (budget).

## Local environment notes
- The user's scene server is on 127.0.0.1:8787 (with the local catalogue plus IKEA live) and the web dev server on
  :5173. Agents must never stop them (see `CLAUDE.md`). Restart the scene server after pulling schema changes.
- The scratch folder is `.tmp/` (TMPDIR is set in `.claude/settings.local.json`). Use the `ci-fixer` agent for CI.
