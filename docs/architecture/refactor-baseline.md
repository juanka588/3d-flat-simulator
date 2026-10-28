# Module refactor: baselines (step 0)

Recorded on 2026-10-28 at `b73c0ad` plus the step 0 changes (ESLint blocks, package-graph test, `resolve.dedupe`; no source code changed), on a shared, heavily loaded laptop (load average 8 to 47 during the runs). Every later step of `modules.md` section 4 compares against these numbers. The plan says the bundle baseline is **not** re-recorded for this refactor.

## Bundle (gzip, `scripts/ci/bundle-size.mjs`, `BASE_PATH=/3d-flat-simulator/`)

| | bytes | kB |
|---|---|---|
| JS | 568 496 | 568.50 |
| CSS | 5 478 | 5.48 |

Identical with and without `resolve.dedupe` (byte for byte), so the setting costs nothing today. The gate (`bundle-baseline.json`, M3 baseline 550 367 / 5 249 with budgets +30 000 / +5 000) is green: +18.13 kB JS, +0.23 kB CSS. A refactor step must stay within +/-1 kB of the numbers above.

## Unit tests (`pnpm test`, vitest projects `scene`, `web`, `server`, `mcp`, `scripts`)

- After step 0: **163 files passed, 3 skipped (166); 2016 tests passed, 19 skipped (2035).**
- Step 0 added 40 tests: 22 in `lint-boundary.test.mjs` (5 before, 27 now), 12 in `package-graph.test.mjs`, 1 export snapshot. So the figure before step 0 was 2000 (derived).
- Known timing flakes under load (not related to the refactor, both pass alone): `scene` `placement/solve.test.ts` ("a solve on Charme takes under 50 ms", "is deterministic (20 runs)"; the solver has a wall-clock budget) and `server` `durability.test.ts` ("expected 5 to be less than 5" ms).

## `@flat/scene` public runtime exports

- 427 names. The snapshot lives in `packages/scene/src/__snapshots__/exports.test.ts.snap`, produced by `packages/scene/src/exports.test.ts` (`Object.keys` of the barrel, sorted).
- Types are erased and are not in the list; `tsc` covers them. Step A1 must leave the snapshot unchanged; A4 changes it on purpose (the asset names leave the root barrel) and updates it in the same commit.

## e2e (Playwright, software WebGL)

Ports used: `E2E_PORT=5391`, `E2E_STATIC_PORT=4391` (never 5173/8787).

**`E2E_STATIC=only` (project `static`): 9 of 9 pass** (`static.e2e.ts` 5, `static-library.e2e.ts` 3, `static-products.e2e.ts` 1; 45 s). Stable.

**Project `chromium`** (185 tests, `E2E_STATIC=skip`). Best of several runs, 3 workers: 168 pass, 1 skipped (`finishes.e2e.ts:386` mobile bottom sheet), 16 fail. Per spec file, passed / failed:

| spec | pass | fail | spec | pass | fail |
|---|---|---|---|---|---|
| camera-pose | 15 | 4 | pov | 9 | 0 |
| catalog | 6 | 0 | room-finishes | 4 | 0 |
| commands | 11 | 3 (3 of the 11 pass only intermittently) | smoke | 8 | 0 |
| finishes | 10 | 0 | sun-leak | 6 | 0 |
| floor-zones | 3 | 0 | sync | 7 | 0 |
| furnish | 1 | 1 | textures | 9 | 0 |
| items-models | 10 | 1 | timezone | 1 | 0 |
| items-persistence | 5 | 0 | ui-models | 1 | 0 |
| items | 4 | 0 | ui-products | 4 | 0 |
| lamps-grid | 2 | 0 | viewer-resilience | 1 | 0 |
| layout | 2 | 3 | viewer | 14 | 1 |
| lighting | 30 | 0 | walk-comfort | 3 | 0 |
| local-catalog | 2 | 1 | mcp-live | 0 | 2 |

**The 16 tests that fail in this environment** (they fail the same way with `resolve.dedupe` removed, so they predate step 0; a refactor step must not add to this list, and a step that fixes one should remove it here):

- `camera-pose.e2e.ts`: 231 (`?test&w=&h=&dpr=`), 345, 380, 400 (view channel);
- `commands.e2e.ts`: 104, 122, 135 (a page reload or fresh `goto` after seeding storage never reaches `__flat.ready`; 90, 153 and 199 fail intermittently for the same reason);
- `layout.e2e.ts`: 11, 58, 67;
- `furnish.e2e.ts:54` (pixel delta behind the bed is 3 to 4 levels above the "less than 4" limit under swiftshader);
- `items-models.e2e.ts:128` (placeholder-while-loading, 5 s predicate);
- `local-catalog.e2e.ts:134` (needs the local IKEA catalogue, which is not in a worktree);
- `mcp-live.e2e.ts`: 72, 122;
- `viewer.e2e.ts:225` (walk-controls overlay "ZQSD" label, keyboard-layout dependent).

Load-dependent flakes seen in single runs (all pass on rerun): `sun-leak`, `textures`, `smoke`, `walk-comfort`, `lighting:397/517`, `pov:64`, `viewer-resilience`, `sync:290`, `room-finishes:184`.

The mobile projects (`mobile-iphone`, `mobile-pixel`) were not run in step 0.

## `render_view` latency (`MCP_RENDER=1`, `latency.test.ts`, Charme 1024x768, after `BASE_PATH=/ pnpm --filter @flat/web build`)

Measured at load average about 13, so the cold figure is pessimistic.

| | n | p50 | p95 | max |
|---|---|---|---|---|
| cold (browser start + load + first render) | 5 | 15.80 s | 16.15 s | 16.15 s |
| warm, no change | 20 | 0.95 s | 1.19 s | 1.29 s |
| warm, scene reload | 12 | 1.54 s | 1.82 s | 1.82 s |

Targets in the test: cold <= 8 s, warm p50 <= 1.5 s. Warm is within target; cold is not on this loaded machine. Compare later steps (R) against the warm figures first.

`pnpm test:render` as a whole: 17 of 19 pass; the two failures are both in `render.test.ts` and are cold-start timing tests ("a hard timeout becomes render_timeout ...", "a cold start gets the longer cold budget ..."), which depend on the browser starting inside a fixed budget and fail on this loaded machine.
