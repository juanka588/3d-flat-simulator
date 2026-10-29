# CG — Close the gap (2026-10-29)

Problem: LLM designs are valid (real products, clean layouts) but look poor next to ChatGPT-style interior images; the model designs blind (no target, no product photos, no quality signal).

User decisions: pluggable image provider, local Flux first; asset gaps → search harder (text + image similarity), tune parametric generators, gap report (no image-to-3D for now); final output = honest 3D render **and** a labelled photoreal visualisation; team/variant/CG end-to-end runs only when the user asks.

Status: CG0 spike done; CG1 to CG4 implemented (CG4: `record_reference`, `match_reference`, `gap_report`, descriptor-driven generators, concept items); CG5 implemented (`score_against_reference`, critic role, prompt `close_the_gap`, sidecar `/aesthetic`); CG7 runner implemented (`design-flat.mjs --close-gap`, validated with `--dry` only; the real run waits for the user).

### The loop (per room, orchestrated by a new MCP prompt `close_the_gap {roomId, styleId, iterations}`)
1. **Intent.** Run `describe_room` plus the style file; the lead writes a short design brief.
2. **Control passes** of the current room from 1–2 fixed cameras: depth, normals, edge/line art, an **ID/segmentation
   mask** (walls, floor, ceiling, windows, doors, locked fittings, items) and camera intrinsics.
3. **Reference images.** The image provider gets the control passes (depth plus canny ControlNet) and the style prompt,
   and returns K candidates. The model judges them with a rubric and keeps one target. Its walls, windows and doors
   match ours because they are conditioned on our depth and edges.
4. **Descriptors.** The model reads the target and lists the items it contains (category, shape, colour, material,
   approx size), the palette and the materials. Positions come from the target pixels unprojected with our depth and
   intrinsics.
5. **Match.**
   - Text search in the local catalogue and HD library.
   - **Image similarity:** CLIP embeddings of catalogue photos and HD thumbnails against crops of the target.
   - The model now **sees product photos** (thumbnails in `search_products`, a `photo` option on `get_product`;
     personal-use, local only).
   - **Parametric generators gain params from the descriptors** (bathtub shape oval/rect/freestanding, feet, colours;
     sofa arm and leg styles; etc.).
6. **Apply** through the existing write tools.
7. **Compare and score** the same camera against the target:
   - **metrics:** palette ΔE (k-means), per-category segmentation IoU between the target's estimated layout and ours,
     CLIP image similarity, an aesthetic score;
   - **a VLM critic rubric:** palette, materials, key items present, composition, lighting mood, clutter;
   - output: an actionable diff list.
   Iterate until the score improves by less than ε or N iterations.
8. **Gap report.** Target items with no adequate asset, with the closest real alternative and the reason (shape,
   colour, size).
9. **Final outputs:**
   - the honest render (probe GI);
   - **photo mode** (path tracer, real GPU);
   - a **"visualisation"** img2img pass over our render at low strength, labelled as such.
   - plus the BOM and the gap report.

### Stories
| Id | Story | Key files |
|---|---|---|
| CG0 | Spike: local image provider on this Mac (FLUX.1 + depth/canny ControlNet, or FLUX.1 Kontext for render→photo edits, via `mflux`/MLX or diffusers MPS). Measure quality, time and RAM on 3 rooms; pick the default model and settings. Note: FLUX.1-dev is non-commercial (fine for personal use). | `.tmp/cg-spike/` |
| CG1 | Render passes: depth, normals, ID mask, edges and intrinsics JSON from the test hook; MCP tool `render_passes`; an unproject helper (pixel+depth → plan coords). Deterministic. | `packages/viewer` (passes), `apps/web/src/testHook.ts`, `apps/mcp/src/render/*`, `apps/mcp/src/tools/render.ts` |
| CG2 | `ImageProvider` interface (`generate({prompt, controls, seed, n})`, `edit({image, prompt, strength})`) plus a **local sidecar** (`tools/imagegen/`, Python via `uv`, a localhost HTTP service with lazy model download into a gitignored cache). API providers (OpenAI, Gemini) are stubs behind the same interface, opt-in by env key. MCP tool `generate_reference`. Images stay local. | `tools/imagegen/`, `apps/mcp/src/tools/reference.ts` |
| CG3 | The model sees assets: product and HD thumbnails as image content (size-capped) in `search_products` / `get_product {photo}` / `search_assets`; a local CLIP index (`open_clip` in the sidecar) over catalogue photos (gitignored) and HD thumbnails (committed); a `match_crop` tool. | `apps/mcp/src/tools/products.ts`, `apps/mcp/src/flatApi.ts`, `tools/imagegen/` |
| CG4 | Descriptor schema (reuse the M7 `DesignDescriptor` shape, zod, in `apps/mcp/styles` or `packages/scene/live`-free location), matcher (text plus CLIP), parametric generator param extensions starting with the bathroom, sofa, bed, rug, curtains, and the **gap report**. | `packages/assets/src/generators/*`, `apps/mcp/src/tools/*` |
| CG5 | Scoring: `score_against_reference` (palette ΔE, IoU, CLIP, aesthetic) plus the critic rubric prompt; an iteration controller in the prompt with stop criteria; per-iteration renders and scores saved. | `apps/mcp/src/tools/score.ts`, `apps/mcp/styles/roles/critic.md` |
| CG6 | Photo outputs: path-tracer photo mode (`three-gpu-pathtracer`; first calibrate a one-lamp room radiometrically, per research doc §7 PoC 2), real GPU only; plus the img2img "visualisation" pass through the provider, watermarked/labelled. | `packages/viewer/src/photo/*`, `apps/mcp/src/tools/render.ts` |
| CG7 | End-to-end: `design-flat.mjs --close-gap --style X --rooms sejour,sdb,ch1`, with before/after contact sheets, score curves and gap reports. Run on 2 styles × 3 rooms; the user rates against the current baseline and against ChatGPT-style images. **Run only when the user asks** (same rule as team/variant sessions). | `scripts/mcp-demo/design-flat.mjs` |
| CG8 | Style features the first French Parisian run could not express: wall panelling (boiserie: bevelled frames laid out around doors, windows and locked fittings; dado rail) per wall side or room, a ceiling cornice per room (`wall_set_finish` / `room_set_wall_finish`: `panelling`, `panelColour`, `corniceMm`), and herringbone / chevron parquet as a paint material `pattern` (`material_define`, `plankWidthMm`; procedural map at world scale, floor zones included). Mouldings live in the wall mesh and share the wall material, so tone on tone adds no draw call. | `packages/scene/src/geometry/panelling.ts`, `packages/viewer/src/parquet-texture.ts`, `apps/web/src/ui/FinishExtras.tsx`, `e2e/panelling.e2e.ts` |

Order: CG0 → (CG1 ∥ CG2) → CG3 → CG4 → CG5 → CG6 → CG7. CG0 decides whether the local model is good enough. If it isn't,
the plan falls back to an API provider behind the same interface, once the user provides a key.

### Constraints carried over
- Real products only in the scene; generated imagery is never an asset and always labelled.
- IKEA photos and models are personal use, local only, never committed or published, and never sent to external APIs
  (API providers receive only our own renders, and only when enabled).
- Scratch goes in `.tmp/`; never touch 8787/5173; agents in worktrees; the lead merges.
- The MCP tools/list budget test (≤ 22k tokens) still applies. Image-returning tools must cap size and count.
