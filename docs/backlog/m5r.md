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

## Step 2: hero models (next)

| Story | Acceptance |
|---|---|
| H1 `models-hd/` tier | Lazy folder, <= 2 MB per model, <= 60 MB total, KTX2 or WebP textures, loaded only for items that name a hero model; `check-models` extended. |
| H2 Top-25 hero models | The top-25 list in `docs/research/m5-modern-assets.md` section 10 (kitchen island, stools, slat wall, sofa, bed, wardrobe fronts, lamps), CC0 or CC-BY with credit lines in `docs/MODELS-CREDITS.md`. |
