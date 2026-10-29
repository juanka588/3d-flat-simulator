# Image sidecar (CG2)

A small HTTP service that makes the reference and visualisation images for the `generate_reference` MCP tool. One API, two backends:

| Backend | Runs on | How | Models |
|---|---|---|---|
| `mflux` (default) | Apple silicon Mac, native | one `mflux` process per image | Qwen-Image-2.1-Turbo + Fun-Controlnet-Union (canny), FLUX.2-klein-4B (edit) |
| `diffusers` | NVIDIA GPU, in Docker (Windows Docker Desktop + WSL2, or Linux) | pipelines kept resident in the process | Qwen-Image + InstantX ControlNet-Union + Lightning 8-step LoRA, FLUX.2-klein-4B (edit) |

Docker on macOS cannot reach the Metal GPU, so the Mac uses the native backend. Everything below the API (requests, responses, seeds, queue) is the same on both; the differences in output are listed under "Differences between the backends".

Images and the model cache stay on your machine. The sidecar never uploads anything.

## API (localhost, port 8790)

All bodies are JSON. Errors are `{ok:false, code, message, field?}`.

- `GET /health` -> `{ready, version, backend, models:[{id, downloaded, loaded, sizeGb, licence}], memGb, maxSide, queue, downloadsAllowed, gpu?, settings?, fit?, warnings?}`. On the `diffusers` backend: `gpu` (name, VRAM, compute capability, torch/CUDA), `settings` (profile, precision, offload), `fit` (estimated peak VRAM per model) and `warnings` when the profile is estimated not to fit the detected VRAM.
- `POST /generate` `{prompt, negativePrompt?, seed, n=1 (1..4), width=1024, height=768, model:"qwen-cn", controls:[{type:"canny"|"depth", image, strength}], steps?}` -> `202 {jobId}`. Exactly one control (the Qwen CLI takes one). Image `i` uses seed `seed + i`. `image` is a path under an allowed root, or base64 PNG/JPEG (optionally a `data:` URL).
- `POST /edit` `{image, prompt, seed, strength, model:"klein-edit", width?, height?}` -> `202 {jobId}`. Size defaults to the source image. `strength` (0..1) is recorded; the klein CLI has no img2img strength, so the prompt decides how much changes.
- `GET /jobs/:id` -> `{jobId, status: queued|running|done|error|cancelled, progress, images:[{path, seed, seconds, peakGb}], queuePosition?, notes?, error?}`.
- `GET /jobs/:id/images/:n[?maxSide=768]` -> the PNG (or a JPEG no larger than `maxSide`, for the model to look at). The TypeScript client uses this to fetch results from a sidecar on another machine.
- `DELETE /jobs/:id` -> cancels a queued or running job, or forgets a finished one.

Jobs run strictly one at a time, first in first out (a generation peaks at 38 GB on a 64 GB Mac). Sizes: multiples of 32, 256 to `IMAGEGEN_MAX_SIDE` (at most 1536), at most 1536x1152 pixels.

### Similarity index (CG3)

`match_crop` finds real products and library models that look like a crop of a reference image. The sidecar embeds pictures with **open_clip `ViT-B-32` / `laion2b_s34b_b79k`** (151M parameters, 512-d, 0.6 GB; code MIT, weights repo `laion/CLIP-ViT-B-32-laion2B-s34B-b79K` is **MIT**, read from its Hugging Face card) on MPS, CUDA or CPU. Needs the `clip` extra (`pnpm imagegen` and `imagegen:setup` include it; the Docker image too) and the weights in the cache (`pnpm imagegen:index --download` fetches only these, once; `check --download` fetches every model, 60 GB or more).

- `POST /embed {images?:[path|base64|{jobId,index}], texts?:[...]}` -> `{model, dim, images:[[...]], texts:[[...]]}` (at most 64 items).
- `POST /index/build {source:"catalog"|"hd"}` -> `{count, model, seconds, bytes, path}`. `catalog` embeds `apps/server/local-assets/ikea-fr/photos/*` into `clip-index.json` + `clip-index.bin` next to them (gitignored, denied by `check-no-retailer`; derived from retailer photos, so it never leaves that folder). `hd` embeds the committed thumbnails of the CC0/CC-BY library into `.tmp/imagegen/index/hd-clip-index.*`: derived and tied to the model version, rebuilt in under a second, so it is not committed. `pnpm imagegen:index [--source ...]` does the same without the server. Vectors are L2-normalised float32 in the `.bin`; items and metadata (id, name, price, dims, category, has3d) in the `.json`; search is plain Python, no numpy.
- `POST /index/query {image?:path|base64|{jobId,index}, box?:[x0,y0,x1,y1], mask?:path, maskColor?:[r,g,b], background?:"plain"|"border", text?, topK=5 (1..20), source?:"catalog"|"hd"|"all", filters?:{category?, maxPrice?}}` -> `{results:[{id, kind:"product"|"asset", score, name, price?, currency?, category?, dims?, has3d}], missing?, prep}`. Image and text vectors are averaged when both are given. Errors: `index_missing`, `index_stale` (built with another model), `model_missing` (409).
- **Crop and mask.** Product photos are objects on white, so the crop is put on a white square: `box` crops; with `mask` (a CG1 instance-id image of our own render, plus the object's colour in `maskColor`) everything outside the object is whitened; `background:"border"` whitens pixels close to the border colour (a saliency heuristic for a reference crop; in the live test it helped nothing, the default `plain` is better); otherwise the crop is padded as is.

Costs measured on an M4 Max (MPS): 400 catalogue photos in 12 s (912 kB), 84 library thumbnails in 0.4 s (189 kB). Library thumbnails are renders and score higher than photos of similar things; compare scores within a kind first.

Live check (opt-in, needs the weights and the local catalogue; prints the top 5 for crops of the CG0 bathroom image):

```sh
IMAGEGEN_LIVE=1 uv run --directory tools/imagegen --extra clip python -m unittest tests.test_clip_live -v
```

### Safety

- Binds `127.0.0.1` (the Docker image binds `0.0.0.0` inside the container; compose publishes it on `127.0.0.1` only).
- `Host` must be localhost / 127.0.0.1 / [::1] (or an address in `IMAGEGEN_ALLOWED_HOSTS`): no DNS rebinding. A request carrying `Origin` is refused unless it is in `IMAGEGEN_ALLOWED_ORIGINS` (empty by default; the MCP server sends no `Origin`). POST bodies must be `application/json`.
- Optional `IMAGEGEN_TOKEN`: every request then needs `Authorization: Bearer <token>`. The token is never logged or returned.
- No shell: mflux is started with an argument list; the prompt is passed as one `--prompt=...` item and cannot become an option. Image paths must resolve under `IMAGEGEN_INPUT_ROOTS` (the repo by default) and be PNG/JPEG files; uploads are written under `.tmp/imagegen/in`.
- Models are never downloaded implicitly: jobs run with `HF_HUB_OFFLINE=1` unless started with `--download` / `IMAGEGEN_ALLOW_DOWNLOAD=true`.

## Mac (native, mflux)

```sh
pnpm imagegen:setup             # uv sync (mflux 0.24.0 in tools/imagegen/.venv) + checks which models are in the cache. Downloads nothing.
pnpm imagegen:setup --download  # also downloads the missing models (about 62 GB, see below)
pnpm imagegen                   # starts the sidecar on 127.0.0.1:8790 (IMAGEGEN_PORT or --port to change it)
pnpm imagegen:test              # Python unit tests (stdlib only: no model, no GPU)
```

Needs [uv](https://docs.astral.sh/uv/). Python 3.12, Apple silicon.

**Disk and RAM.** Qwen path about 39 GB (Qwen-Image-2.1-Turbo 32 GB + ControlNet 7 GB), klein about 23 GB: **about 62 GB** for both; an extra 44 GB if you keep the CG0 Z-Image/Kontext caches (delete them). Peak memory per job measured in CG0 on an M4 Max, 64 GB: Qwen+canny 38 GB, klein 25 GB. One job at a time; do not run two sidecars. Speed (1024x768): Qwen+canny about 90 s per image (8 steps, `-q 8`), klein edit about 30 s.

**Cache.** Default `<repo>/.tmp/imagegen/hf-cache` (gitignored). To reuse the CG0 spike cache without downloading 60 GB:

```sh
ln -sfn /path/to/main-checkout/.tmp/cg-spike/hf-cache .tmp/imagegen/hf-cache     # or
IMAGEGEN_HF_HOME=/path/to/main-checkout/.tmp/cg-spike/hf-cache pnpm imagegen
```

**Live test** (opt-in, loads the real model, about 1 to 2 minutes):

```sh
IMAGEGEN_LIVE=1 npx -y pnpm@10.34.7 exec vitest run --project mcp apps/mcp/src/imagegen/imagegen.live.test.ts
```

It starts its own sidecar on port 18790 (or uses `IMAGEGEN_URL`), sends one 512x384 fixture edge image through Qwen + canny and checks the PNG.

## Windows / NVIDIA (Docker Desktop + WSL2)

Target: Windows 11, **RTX 5070 (12 GB, Blackwell sm_120)**, 64 GB RAM. Everything here is **written but not yet run on a GPU**: the author has a Mac. The first run on the card is the test; `docker compose run --rm imagegen preflight` is the first step, and numbers marked "estimate" are not measurements.

### Prerequisites

1. NVIDIA driver 570 or newer **with WSL2 CUDA support** (a normal Windows Game Ready / Studio driver includes it; do not install a Linux driver inside WSL). RTX 50-series needs CUDA 12.8, hence a recent driver.
2. Docker Desktop with the **WSL2 backend** (Settings > General > "Use the WSL 2 based engine"). GPU support needs no extra toolkit on Docker Desktop.
3. Give the WSL VM enough memory. WSL2 defaults to 50 % of host RAM and a small swap. Create `%UserProfile%\.wslconfig`, then run `wsl --shutdown` and restart Docker Desktop:

   ```ini
   [wsl2]
   memory=48GB
   swap=16GB
   ```

   With 64 GB of host RAM that leaves 16 GB for Windows. The 12 GB profile wants about 40 GB (see below).
4. Check that containers see the GPU:

   ```sh
   docker run --rm --gpus all nvidia/cuda:12.8.1-base-ubuntu24.04 nvidia-smi
   ```

   It must print the RTX 5070. If it does not, fix this before anything else.

### First run

```sh
cd tools/imagegen
copy .env.example .env          # PROFILE=rtx-12gb is the default; edit .env for other cards
docker compose build
docker compose run --rm imagegen preflight           # GPU, torch kernels for sm_120, profile, estimated VRAM
docker compose run --rm -e IMAGEGEN_ALLOW_DOWNLOAD=true imagegen check --download   # one-time model download into the "models" volume
docker compose up
```

`preflight` prints the GPU name, VRAM, compute capability (`sm_120` on a 5070) and the torch build, and **fails clearly** if torch has no kernels for the card (needs torch 2.7 or newer with cu128 wheels; the image pins torch 2.8.0 + CUDA 12.8) or if the container sees no GPU.

**Download size** (bf16 weights in the Hugging Face cache, quantised on load): Qwen-Image about 57 GB, InstantX ControlNet-Union about 4 GB, Lightning LoRA 1.7 GB, FLUX.2-klein-4B about 23 GB: **about 85 GB** in the `models` volume. It persists outside the image (`HF_HOME=/models`), so rebuilding the image does not download again. To keep the cache on another drive use a bind mount instead of the named volume in `compose.yaml` (`D:/hf-cache:/models`). The Docker image itself is about 18 GB unpacked (torch and the CUDA libraries). A `HF_TOKEN` is optional and not needed for these repos; it is never logged.

### Using it

The sidecar listens on `127.0.0.1:8790` of the Windows host. The MCP server (`apps/mcp`) talks to whichever backend is behind `IMAGEGEN_URL`:

```sh
# MCP server on the same Windows machine: nothing to set (default http://127.0.0.1:8790)
# MCP server elsewhere (the Mac): see "LAN access" below, then
IMAGEGEN_URL=http://<windows-host>:8790 IMAGEGEN_TOKEN=<token> pnpm mcp
```

`/health` shows the GPU, the profile in force and whether it fits.

### VRAM to settings (estimates, unmeasured)

`PROFILE` in `.env` picks a row; any `IMAGEGEN_*` knob overrides it. Without `PROFILE` the profile is chosen from the detected VRAM. Qwen-Image is about 20B parameters (bf16 about 41 GB for the transformer alone), so everything below 48 GB quantises or offloads. nf4 = bitsandbytes 4-bit (supports Blackwell from 0.45.x; 0.50 is locked); fp8 = diffusers layer-wise fp8 storage with bf16 compute (no extra library).

| VRAM | Profile | Qwen-Image (qwen-cn) | klein edit | Max side | Est. peak VRAM (qwen) | Est. system RAM | Est. time / image (qwen, 1024x768, 8 steps) |
|---|---|---|---|---|---|---|---|
| 8 GB | `rtx-8gb` | nf4, sequential offload | bf16, sequential | 768 | about 5 GB | 32 GB | 2 to 5 min |
| **12 GB** | **`rtx-12gb`** | **nf4, sequential offload** | **bf16, model offload** | **1024** | **about 6 GB** | **32 GB (40 GB for headroom)** | **1.5 to 4 min** |
| 16 GB | `rtx-16gb` | nf4, sequential offload | bf16, model offload | 1280 | about 6 GB | 32 GB | 1.5 to 4 min |
| 24 GB | `rtx-24gb` | nf4, model offload | bf16, none | 1536 | about 17 GB | 32 GB | 40 to 90 s |
| 48 GB | `rtx-48gb` | fp8, model offload | bf16, none | 1536 | about 32 GB | 56 GB | 20 to 40 s |
| 80 GB | `rtx-80gb` | bf16, none | bf16, none | 1536 | about 68 GB | 64 GB (load only) | 10 to 20 s |

Reading the 12 GB row (RTX 5070): the nf4 transformer alone is about 11.5 GB, which does not fit next to activations and the CUDA context, so plain model offload is estimated at about 16 GB and would run out of memory. The profile therefore streams layers (sequential offload): the nf4 text encoder (5.5 GB) and nf4 ControlNet (2 GB) stream through the same mechanism. That keeps peak VRAM around 6 GB but moves about 11 GB over PCIe every step; with the 8-step Lightning LoRA and CFG off (one forward per step) this is slow but tolerable. **Time is an estimate, unmeasured.** A Core i5 makes the CPU-side hooks and the transfers slower than a high-end CPU, so read the upper end of the range. If you have headroom, try `IMAGEGEN_CPU_OFFLOAD=model` (faster, may run out of memory) and watch `/health` (`peakGb` in job results shows the real peak). klein-edit is the fast option on this card: bf16 weights are about 8 GB (transformer) and 8 GB (text encoder), and model offload keeps one on the GPU at a time (about 10 GB estimated); expect roughly 10 to 30 s per image (estimate).

System RAM: the offloaded weights live in RAM, and the bf16 shards pass through it on load. The 12 GB profile wants about 32 GB plus the OS; with 64 GB host RAM and `memory=48GB` for the WSL VM there is room. Without the `.wslconfig` change WSL2 caps the VM at 32 GB on a 64 GB host, which is borderline.

### Knobs (`.env`)

| Variable | Values | Meaning |
|---|---|---|
| `PROFILE` | `rtx-8gb` ... `rtx-80gb` | preset, see the table |
| `IMAGEGEN_PRECISION` | `bf16`, `fp8`, `nf4` | Qwen-Image transformer precision |
| `IMAGEGEN_CPU_OFFLOAD` | `false`, `true`, `model`, `sequential` | `true` is the lightest offload that is likely to fit |
| `IMAGEGEN_MAX_SIDE` | 256 to 2048 | longest edge accepted; the default size shrinks to fit |
| `IMAGEGEN_STEPS` | 1 to 50 | default steps for qwen-cn (8 with the LoRA, 30 without) |
| `IMAGEGEN_LIGHTNING` | `true`, `false` | the 8-step Lightning LoRA |
| `HF_TOKEN` | optional | Hugging Face token, never logged |
| `IMAGEGEN_ALLOWED_ORIGINS` | comma list | browser origins allowed to call the API (none by default) |
| `IMAGEGEN_ALLOWED_HOSTS`, `IMAGEGEN_PUBLISH`, `IMAGEGEN_TOKEN` | see "LAN access" | off by default |

### LAN access (off by default)

By default compose publishes `127.0.0.1:8790`, so only the Windows host itself can call the sidecar. To use it from the Mac:

1. Set all three in `.env`: `IMAGEGEN_PUBLISH=0.0.0.0` (or the Windows machine's LAN address), `IMAGEGEN_ALLOWED_HOSTS=<that LAN address or host name>` (the `Host` header the Mac will send; anything else is refused), and `IMAGEGEN_TOKEN=<a long random string>`. The sidecar prints a warning when it is reachable beyond localhost without a token.
2. Allow the port through the Windows firewall for the **private** profile only, from your Mac's address if you can.
3. On the Mac: `IMAGEGEN_URL=http://<address>:8790 IMAGEGEN_TOKEN=<same token>`.

The traffic is plain HTTP, so use a trusted home network, or a VPN / SSH tunnel (`ssh -L 8790:127.0.0.1:8790 user@windows`, then keep `IMAGEGEN_URL=http://127.0.0.1:8790` and nothing needs publishing). Control images and results are the only payloads; no scene data is sent. Do not forward the port from the internet. `IMAGEGEN_ALLOWED_ORIGINS` is only for web pages calling the API from a browser; the MCP server does not need it.

## Licences

| Model | Licence | Source of the statement |
|---|---|---|
| Qwen/Qwen-Image-2.1-Turbo, Qwen/Qwen-Image | Apache-2.0 | repo metadata as read in CG0; the local cache holds no LICENSE file, so **re-check the model card** before any non-personal use |
| **alibaba-pai/Qwen-Image-2.1-Fun-Controlnet-Union** (mflux backend) | **Qwen RESEARCH LICENSE (`license: other`, non-commercial: "research or evaluation purposes only")** | verified from the `LICENSE` and card in the local cache. **Not Apache-2.0**, unlike the CG0 note. Redistribution needs the licence text and the attribution notice in `LICENSE`. |
| black-forest-labs/FLUX.2-klein-4B | Apache-2.0 (the 9B variant is not) | CG0 repo metadata; re-check the card |
| InstantX/Qwen-Image-ControlNet-Union (diffusers backend) | **not verified**: check the model card before use | not read yet |
| lightx2v/Qwen-Image-Lightning (LoRA) | **not verified**: check the model card before use | not read yet |

Practical meaning: this repo is personal use; nothing from these models is committed, and generated images are never assets (the MCP tool labels them). The ControlNet's non-commercial licence only matters if this project is ever used commercially or the weights are redistributed.

## Differences between the backends

The API, seeds (`seed + i` per image) and prompts are identical. The output is **not** identical:

- **Different models.** mflux runs Qwen-Image-2.1-Turbo with the Fun-Controlnet-Union (what CG0 measured). The Fun checkpoint is in VideoX-Fun format, which diffusers 0.42 cannot load (it has `QwenImage21Pipeline` for text-to-image but no 2.1 ControlNet). The CUDA backend therefore uses **Qwen-Image 1.0 + InstantX ControlNet-Union** (`QwenImageControlNetPipeline`) with the 8-step Lightning LoRA as the stand-in for Turbo. Edge fidelity and style will differ; the CG0 alignment numbers do **not** apply to it until measured.
- **Seeds are not comparable across backends** (MLX vs PyTorch noise). Within one backend a seed is repeatable (the CUDA backend draws noise on the CPU, so it is also independent of the VRAM profile).
- **Quantisation differs** (mflux `-q 8`; CUDA nf4/fp8 per profile), so equal settings give slightly different pictures.
- klein-edit is the same model on both; in both, `strength` is recorded but not used.
- Progress and cancel: the CUDA backend reports per-step progress and cancels within a step; mflux reports per image and cancels by killing the process.
- The CUDA backend returns `peakGb` from `torch.cuda.max_memory_allocated`, mflux from `/usr/bin/time -l`.

## Tests and CI

- Python (`pnpm imagegen:test`, `tests/test_imagegen.py`): request validation, argv building and injection, FIFO order and cancel, the HTTP guards (host, origin, token), profiles and the VRAM estimate. Needs uv but no model and no GPU. CI runs it in its own job (`imagegen`); it is **not** part of `pnpm check`, which must keep working on machines without uv.
- TypeScript (`pnpm test`): provider, prompts and the `generate_reference` tool with `FakeImageProvider`.
- Docker: `docker build tools/imagegen` is build-only in CI (manual dispatch: the image is large). Built and `preflight`-checked on linux/amd64 without a GPU during CG2 (it reports "no GPU" cleanly).
- Live: see "Live test" above (`IMAGEGEN_LIVE=1`).
