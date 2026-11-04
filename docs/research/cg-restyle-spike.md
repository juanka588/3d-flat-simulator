# CG restyle spike: turning our render into a photoreal image that keeps the room

Status: measured on 7 views of the user's flat (living room x2, kitchen, bathroom doorway, WC, two bedrooms). Numbers and descriptions
only: the renders and every generated image are personal and stay in the gitignored `.tmp/` (never commit them).

Question: which way of restyling our honest render (walls, openings and proportions are right, finish is flat) gives an image that is
photoreal **and** still the same room, so that the descriptor and match steps of "close the gap" can trust it?

## Method

### Inputs (from `render_passes` / `pnpm mcp:views-sheet`, per view)
- the plain render, the **depth** pass (bright = near), the **edge** pass (black structural lines on white) and the **id/layout** pass
  (palette: ceiling, glass, door);
- the **control blend** for ControlNet (`apps/mcp/src/imagegen/controlBlend.ts`; `imagegen.eval inputs` writes the same): inverse depth
  at 55 % brightness with the edges drawn white, 2 px wide. Canny alone lets the model invent the ceiling, depth alone paints floor
  material on it; the blend keeps shapes and depth order;
- a prompt per view: style, the room, an explicit list of the openings ("exactly these, no others"), a stated ceiling height (2.5 m,
  about 1.6 doors) and what the building is (modern, not Haussmann).

### Score (`tools/imagegen/eval`, all metrics 0..1, higher is better, `score` = mean of the available ones)
| metric | what it measures |
|---|---|
| depth | Spearman of Depth Anything V2-small disparity of the image against our depth pass |
| edges | recall of our edge pixels: share with a strong image gradient (top 10 %) within 8 px at 1024 px width |
| ceiling | IoU of the UperNet ConvNeXt-S "ceiling" mask with the ceiling of our id pass |
| open_rec | CLIP zero-shot on a crop of every expected opening: window or door must beat plain wall |
| extra | 1 / (1 + n), n = window/door blobs of the image touching none of our openings |
| door_h | views with a plain door under a visible ceiling: (ceiling edge to door foot) / door height against ours (room height drift) |
| aspect | 1 - 5 x deviation from the render's aspect (4:3) |

Models (read from the Hugging Face cards): Depth Anything V2-small Apache-2.0; UperNet ConvNeXt-S MIT (trained on ADE20K, scoring only);
open_clip ViT-B-32 laion2b MIT. Offline by default, cache from `IMAGEGEN_HF_HOME`. The score is a **screen, not a judge**: it catches
drift (rooms stretched, openings added or lost, a different ceiling), not taste. Every decision below was also checked by eye on the
contact sheets.

### Tool
```sh
pnpm imagegen:eval -- inputs   --views V --out IN                       # base/depth/edges/control per view (write prompt.txt next to them)
pnpm imagegen:eval -- generate --method qwen-cn|qwen21-edit|klein --inputs IN --out OUT --seeds 3205,4242 [--dry]
pnpm imagegen:eval -- score    --render R --edges E --depth D --ids I --image X [--json]
pnpm imagegen:eval -- sheet    --views V --columns qwen=OUT,nano=NANO --out SHEETS --score --cache scores.json
```
`generate` runs the sidecar's mflux commands (same argv builder, offline, memory guard that aborts when the model would page; `--force`
to override). Results resume: existing images are skipped. `imagegen:test` covers the maths with synthetic images (no model).

## Results (mean over the 7 views)

| method | mean score | notes |
|---|---|---|
| Nano Banana v1 (single render + short prompt) | 0.72 | first spike, short prompt |
| Nano Banana v2 (v2 input set and prompt rules, Gemini app, manual) | 0.89 | best manual route |
| Qwen-Image-2.1-Turbo + Fun-Controlnet-Union, depth + edges blend, 2 seeds | 0.88 to 0.90 | local, about the sidecar's `qwen-cn` model |
| Qwen-Image-2.1 edit (render + edges + depth as three source images), 1 seed | 0.91 | 0.3 extra openings per view on average |
| FLUX.2-klein-4B edit | not kept | hallucinated openings |
| Qwen-Image-Edit-2509 q3 (community quantisation, 24.7 GB) | none | noise with mflux 0.24; q4 and above exceed the 25 GB memory cap |

### Findings
1. Saying "Haussmann" (or any grand-period word) in a prompt re-proportions rooms: higher ceilings, taller windows, cornices. Describe
   the building as modern and state the ceiling height instead.
2. A single flat render is weak structure for an edit model: it copies the flatness or ignores the geometry. Edges + depth +
   an explicit opening list fix most drift (Nano v1 to v2: 0.72 to 0.89 without changing the model).
3. Windowless rooms (WC, bathroom, interior kitchen) tempt every model to add a window; say "no window" in the prompt and put
   "window, extra window, additional window" in the negative prompt; the extra-openings count is the metric to watch.
4. Door height against the visible ceiling is the cheapest detector of a room that grew taller.
5. Seed matters per view (a bad seed can add an opening): take 2 seeds per view and keep the better score.

### Decision
- **Default: local Qwen ControlNet with the depth + edges blend, 2 seeds** (3205, 4242) per view, the better score kept. It runs on the
  user's Mac through the sidecar (about 90 s per image, peak 38 GB), nothing leaves the machine.
- **Alternative: Qwen-Image-2.1 edit** (same mean or slightly higher, fewer extra openings, one more model to keep in the cache).
- **Manual fallback: Nano Banana v2** (Gemini app), with the v2 input set below.
- Not used: klein edit (hallucinated openings), Qwen-Image-Edit-2509 (does not fit or run on this setup).

## Manual fallback (Nano Banana v2 in the Gemini app)
For each view upload, in this order, and paste the generated prompt:
1. **image 1**: our render (colour and furniture);
2. **image 2**: the edge pass (the lines to trace);
3. **image 3**: the depth pass (near = bright);
4. **image 4** (optional): the labelled colour map with the size of each opening.

Prompt rules (v2): state the shared block once (geometry, what the images are, "trace image 2 exactly"); list the room and
**exactly** the openings with their sizes and say there are no others; give the ceiling as 2.5 m, about 1.6 door heights; describe
the building as modern, never by a period; name the style and materials; no people or text; ask for the photograph only. One view per
chat, 4:3 landscape. Save results with the view name, then score and sheet them like any other column (`--columns nano=DIR`).
The prompts come from the reference prompt builder (`generate_reference` dry output), so they stay in sync with the descriptors.
