# M5R: rendering realism

Why: the viewer "looks like a video game instead of a realistic house upgrade plan" (flat white boxes, no reflections, no contact shadows, 2700 K lamps rendering orange). Order agreed with the user: rendering first (step 1), then the top-25 hero models in a lazy `models-hd/` folder (step 2: at most 2 MB per model, 60 MB total, CC-BY allowed with credits).

## Step 1: rendering (done)

| Story | Acceptance | Status |
|---|---|---|
| R1 PBR furniture finishes | Generator parts use semantic slots (`ITEM_SLOTS`: carcass, front, worktop, fabric, metal, ceramic, glass, wood) resolved by `ITEM_MATERIAL_SPECS` to tuned paints or CC0 library textures (oak veneer, walnut, brushed steel, quartz, woven fabric, linen). UVs are metres, so texture scale is real-world. The `finish` param gains `oak`, `white-matte`, `anthracite`, `walnut`. Four textures added through `pnpm materials:build` (licence evidence, 4.45 MiB total library). | done |
| R2 Environment light | CC0 Poly Haven interior HDRI (`small_empty_room_1`, 512x256 RGBE, 517 KB, `pnpm env:build`, served from `BASE_URL/env/`) prefiltered with PMREM into `scene.environment`. It carries 40 % of the sky's diffuse light (hemisphere keeps 60 %), so the exposure model is unchanged; intensity follows daylight and is 0 at night. Lazy chunk, off on the low profile. | done |
| R3 Contact shadows | Baked soft contact shadows under floor items (halo + tight line, weaker for items on legs) and floor/ceiling/corner creases on the inner wall faces; 2 draw calls, no per-frame cost, off on low, `?ao=off` disables. SSAO (N8AO/GTAO) was not taken: +30-45 kB gzip and a post-processing pipeline that conflicts with the demand frame loop and the constant-program rule. | done |
| R4 Bevels, reveals, handles | Boxes carry a 1.5-3 mm chamfer with blended normals (exact outer box, <= 3k triangles, deterministic), fronts sit on a dark 3 mm reveal (shadow lines in 3 mm gaps), bar handles stand off posts. Worktops stay sharp so neighbouring modules join. | done |
| R5 Soft shadows, tone, AWB | three r186 has no PCFSoft: the PCF filter now takes `shadow.radius` (3 full / 1.5 low). `?tone=agx\|aces` options (default stays Neutral: accurate finish colours). Automatic white balance moves lamp colour (and the room bounce) from 2700 K to about 4000 K in lamp-only views, scaled by the lamp share of the light. | done |

Known limits: screen-space AO inside shelves and between items is not modelled; the lamp bounce strength was reviewed and left (the orange came from the 2700 K colour, not the bounce level).

## Step 2: hero models (done, `models-hd/` tier)

| Story | Acceptance | Status |
|---|---|---|
| H1 `models-hd/` tier | Lazy folder `apps/web/public/models-hd/` (+ its own `catalog.json`, entries say `tier: "hd"`): <= 2 MiB per model, <= 40k triangles, <= 20 materials, WebP textures <= 1024 px, Meshopt, <= 60 MiB in total (now 43 models, 10.3 MiB). `check-models` checks both folders (and `dist/`) against their own budgets; `check-no-retailer` lists both catalogs. The viewer fetches the small HD catalog with the light one and a hero GLB only when an item resolves to it (`${BASE_URL}models-hd/`); `pickLookalike` gives HD models of the exact category a small bonus (the 25 % aspect rule still applies) and a model that fails to load falls back to the light tier or the generator through the existing `catalogWithout` path. | done |
| H2 Hero models | `pnpm models:hd` (`scripts/models/build-hd.mjs`, `sketchfab.mjs`, `manifest-hd.json`): Sketchfab API licence check (`cc0` / `by` only), token from `scripts/models/.env.local` (never logged, redacted in errors), sequential cached downloads in `.cache/models/sketchfab`, unit scale detected from the expected size range (or `fitMaxM`), front axis per model, `--preview` writes a 4-view sheet for the visual review. 43 models accepted, 12 rejected (reasons in the manifest). All are CC BY 4.0: credit lines in `docs/MODELS-CREDITS.md` and in the Library tab ("Model credits"). | done |
| H3 Texture LOD | 512 px by default and 1024 px near / selected / walk is **not** done: it needs a second GLB per model and a swap in `model-*.ts` (the other agent's area). HD models ship at 1024 px. | open |
| H4 Not in this step | Kitchen island (IKEA TORNVIKEN streams through the provider), TV slat panel, media wall, curtains, wall panelling, rug (parametric generators), throw blanket, BlenderKit CC0 (needs an add-on login: not downloadable without one). | open |
