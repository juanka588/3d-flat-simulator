# M6 research: ray tracing and GI libraries instead of more lighting hacks

Question: "Are there libs that compute the ray tracing and lights, so we avoid overloading the project?"
Date of research: 2026-10-28. Repo at three r186.1, WebGLRenderer, react-three-fiber 9, drei 10.
Status: research only, nothing in the app changed. Throwaway spike lives in `/tmp/rt-spike/` (not in the repo).

How to read the evidence: **[measured]** = I ran it in this session; **[source]** = read in the installed
package or npm registry; **[memory]** = background knowledge I did not re-verify (treat as a lead, not a fact).

## 1. What we hack today (the thing to shrink)

| Hack | Where | What it fakes | Approx. size |
| --- | --- | --- | --- |
| Per-room lamp bounce (emissive texture per room) | `lighting.ts` `roomLampBounce` + `room-ambient.ts` + `FlatCanvas.tsx` + `materials.ts` | lamp inter-reflection (indirect diffuse) | ~35 + 202 + ~30 + ~40 lines, `room-ambient.test.ts` 89 |
| Per-room sky ambient through `aoMap`, `roomDaylightFactors` | `room-ambient.ts`, `@flat/scene` | sky light reaching a room through windows | (shared with above) |
| AWB (lamp kelvin pulled to ~4300 K) | `lighting.ts` | perceptual white balance of a camera/eye, NOT GI | ~25 lines |
| Lamp shadow budget (`RESERVED_TEXTURE_UNITS = 9`, 7 lamps max on 16 units) | `perf.ts`, `Lamps.tsx`, `lamp-shadow.ts` | direct-light visibility | ~65 + bias maths |
| Creases and contact shadows | `contact-shadows.ts` (352) + `ContactShadows.tsx` (84) | ambient occlusion at < 10 cm | 436 lines |
| Ambient split hemisphere / env map / `AMBIENT_FRACTION`... | `lighting.ts`, `environment.ts` | sky dome irradiance | ~100 |

A real GI solution can replace the first two rows (about 400 lines with tests) and relax the third. It can NOT
replace AWB (that is a camera model) and, with probes, it does not remove contact/crease AO.

## 2. Findings that change the picture (all verified)

1. **three r186 already ships a light-probe grid for WebGLRenderer** [source]: `three/addons/lighting/LightProbeGridWebGL.js`
   (L2 spherical-harmonic irradiance probes, GPU bake with zero CPU readback, optional extra bounces, one `sampler3D`
   in the material shader via `USE_LIGHT_PROBES_GRID`, wired into `WebGLRenderer`/`lights_fragment_begin`). The WebGPU twin is
   `LightProbeGrid.js`. This is exactly "irradiance volume", no new dependency, +5 kB gzip [measured with esbuild: 133.1 -> 138.3 kB gz over a bare WebGLRenderer].
2. **`three-gpu-pathtracer` 0.0.27 (2026-10-08) is now WebGPU-first** [source]: its README says "The project requires WebGPU", the
   `WebGLPathTracer` class logs "deprecated and will be removed in a future release", and `@react-three/gpu-pathtracer` 0.3.2 (2025-07) pins
   `three-gpu-pathtracer@0.0.23` (stale, do not use). The WebGL class still ran on r186 in my spike [measured].
3. **Headless Chromium from Playwright exposes a WebGPU adapter backed by SwiftShader** [measured: `navigator.gpu.requestAdapter()` returns
   vendor google / arch swiftshader, 1 GiB storage buffers] when the page is served from localhost. So a WebGPU path tracer can in principle
   run in `render_view`; I did not run it (see section 5).
4. **No shadow atlas in three r186**, WebGPU or WebGL [source: grep of `src/nodes/lighting`]: WebGPU `PointShadowNode` uses one `CubeDepthTexture` per
   light. WebGPU's default `maxSampledTexturesPerShaderStage` is 16 [memory], but `WebGPURenderer` accepts `requiredLimits` [source: `WebGPUBackend.js`]
   so a device can ask for more when the adapter offers it. Moving to WebGPU therefore relaxes the 16-unit limit only on adapters that allow it, and costs a full material rewrite (below).
5. **Most "real-time GI" libraries are dead or incompatible**: `realism-effects` last release 2023-05 [source]; `@react-three/lightmap` 0.0.8 from 2022-01 [source];
   `postprocessing` 6.39.5 peers `three >=0.168 <0.187`, so it blocks the r187 upgrade [source].

## 3. Comparison table

Sizes are minified+gzip, measured with esbuild on a bare entry unless marked otherwise. "SwiftShader" = our headless renderer.

| Option | Version / date | Licence | three r186 | Backend | Real-time? | Replaces our hacks? | gzip add | SwiftShader / headless | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **three `LightProbeGridWebGL`** | in r186 | MIT | native | WebGL2 | bake 4-15 s on M4 Max (3.3k probes), then free at runtime | yes: lamp bounce, sky-through-window, `aoMap` hack | +5 kB [measured] | works, bake ~12 s at 1 m spacing, ~75 s at 0.5 m / cube 16 [measured] | **top pick for (a)** |
| three `ProgressiveLightMap` (+GPU) | in r186 examples | MIT | native | WebGL / WebGPU | bake | partly (needs a unique-UV atlas for merged meshes) | small | untested | tier (c), later |
| three TSL `SSGINode`, `GTAONode`, `SSRNode`, `TRAANode`, `DenoiseNode` | in r186 | MIT | native | **WebGPURenderer only** | yes, screen space | AO yes; GI only for what is on screen (no off-screen lamps) | n/a (new renderer ~ +140 kB gz for `three/webgpu`) | WebGPU on SwiftShader adapter exists, slow, unverified | no: forces a NodeMaterial rewrite |
| three `vxgi` (voxel cone tracing) | in r186 examples | MIT | native | WebGPU | yes, heavy | yes in principle | n/a | no | experimental, no |
| three `RectAreaLight` | core | MIT | native | WebGL2 + WebGPU | yes | no shadows, no occlusion, light leaks through walls (why we dropped it, `docs/photometry.md`) | 0 | works | no |
| **`three-gpu-pathtracer`** WebGL class | 0.0.27, 2026-10-08, deprecated class | MIT | peer `three >=0.185`, ran on 186.1 [measured] | WebGL2 | progressive | everything (unbiased), but needs scene conversion | +10 kB gz [measured 133.1 -> 142.8], + `three-mesh-bvh` 0.9.16 | **~4.2 s/sample at 1024x768, +34 s shader compile** [measured] | usable today, short-lived |
| `three-gpu-pathtracer` `WebGPUPathTracer` | 0.0.27 | MIT | needs `three/webgpu` build | WebGPU compute (wavefront + megakernel), OIDN denoise, FSR upscale | progressive | everything | ~275 kB gz whole bundle incl. `three/webgpu` [measured] | adapter exists (swiftshader); not run | the right long-term photo mode |
| `@react-three/gpu-pathtracer` | 0.3.2, 2025-07 | MIT | pins `three-gpu-pathtracer@0.0.23` | WebGL | progressive | n/a | n/a | n/a | skip (stale wrapper, 42 kB) |
| `n8ao` (+ `postprocessing`) | 2.0.1 (2026-08) / 6.39.5 (2026-09) | ISC / Zlib | `postprocessing` peer `<0.187` | WebGL2 | yes (AO only) | replaces crease/contact hack (436 lines) | +30-45 kB gz (from M5R notes) | works but pipeline conflicts with the demand frame loop and constant-program rule (M5R R3) | optional, photo mode only |
| `realism-effects` (SSGI, TRAA, motion blur) | 1.1.2, 2023-05 | MIT | peer `three >=0.148`, unmaintained | WebGL2 | yes | screen-space only | n/a | n/a | no (abandoned) |
| `@react-three/lightmap` | 0.0.8, 2022-01 | MIT | peer `three >=0.128`, unmaintained | WebGL | bake | partly | n/a | n/a | no |
| Blender Cycles headless | external binary | GPL (separate process is fine) | n/a | CPU/GPU | offline | reference quality | 0 in the app | CPU only, needs Blender install and a GLB export | tier (b) server-side option |
| Babylon.js 9.32.1 | 2026-10 | Apache-2.0 | n/a | WebGL2 / WebGPU | yes | has IBL shadows and reflective-shadow-map GI [memory] | 72 MB unpacked, full engine | n/a | comparison only, a rewrite |
| PlayCanvas 2.23.3 | 2026-10 | MIT | n/a | WebGL2 / WebGPU | bake + clustered lights with shadow atlas [memory] | `Lightmapper` bakes direct+bounce | full engine | n/a | comparison only, a rewrite |

## 4. Code-size estimate (lines, this repo)

| Change | Added | Removed | Notes |
| --- | --- | --- | --- |
| Probe-grid GI (tier a) | ~120 (`ProbeGI.tsx` mount + bake scheduler) + ~80 pure (`probe-grid.ts`: bounds, spacing, bake key) + ~60 tests | ~350 (`room-ambient.ts` 202 + test 89, `roomLampBounce`, FlatCanvas/materials plumbing) | contact/crease code stays (probes do not do < 10 cm AO) |
| PT photo mode, WebGL class (b, web) | ~150 (`PhotoMode.tsx`: scene filter, unit calibration, progressive loop, denoise) | 0 | lazy chunk |
| PT photo mode in `render_view` | ~100 (`apps/mcp` render options + page hook) | 0 | `quality: 'photo'`, `samples`, timeout |
| Lightmaps per scene state (c) | ~400 (UV atlas via `xatlas-web`, bake, per-lamp layers, blend) | maybe lamp shadow code | biggest, last |
| Replace with WebGPURenderer + TSL | rewrite of materials.ts, SkyDome, shell materials, room-ambient, contact shadows | n/a | not recommended |

## 5. Spike results (`/tmp/rt-spike/`, throwaway)

Setup: a Vite dev server (config in `/tmp/rt-spike/vite.config.mjs`, root `apps/web`, no repo file touched) serving the real viewer with the
Charme fixture; Playwright drives it (`drive.mjs`, `probes.mjs`); scene and renderer are captured through `window.__THREE_DEVTOOLS__`;
same camera (living room, eye height 1.55 m, 1024x768) for the app render and for the experiments. M4 Max for "GPU" runs (ANGLE/Metal in bundled Chromium);
SwiftShader flags identical to `playwright.config.ts`.

### 5.1 Probe grid (`LightProbeGridWebGL`): works and is the headline result

Evening scene, three lamps on. I removed the emissive room-bounce (the hack) and baked a grid over the flat (12.3 x 2.8 x 8.6 m).
Images: `evening-gpu-probes-noBounce.png` (no bounce, dark ceiling and walls) and `evening-gpu-probes-withProbes.png` (probes only)
against `evening-gpu-before.png` (current app with the hack).
The probe image is very close to the current image: warm ceiling glow, walls lit by bounce, a natural gradient, no per-room textures.

| Probes | Spacing / cube / bounces | Bake (GPU, M4 Max) | Bake (SwiftShader) |
| --- | --- | --- | --- |
| 13x4x10 = 520 | 1.0 m / 8 / 0 | not run | 12.5 s first (shader compile), 4.3 s rebake |
| 26x7x18 = 3,276 | 0.5 m / 8 / 0 | 6-10 s | not run |
| 26x7x18 = 3,276 | 0.5 m / 16 / 1 | 7-15 s | 74 s (rebake 75 s) |
| 50x12x35 = 21,000 | 0.25 m / 16 / 1 | 46 s | not run |

Timings are noisy (shader compile in the first bake, other jobs on the machine). Not tested: light leaking into the neighbouring room (see risks), daylight (sun + sky) scenes, glTF items.

### 5.2 `three-gpu-pathtracer` WebGL class: runs, fast on a GPU, but my hookup was NOT radiometrically correct

Measured, trustworthy:

| Where | 1024x768 | Time |
| --- | --- | --- |
| M4 Max (WebGL, ANGLE/Metal) | per sample | **~84 ms** (about 12 spp/s); shader compile + BVH ~0.3 s setup + ~0.7 s first frame |
| M4 Max | 256 spp / 512 spp / 1024 spp | **~22 s / ~46 s / ~86 s** |
| SwiftShader | per sample | **~4.2 s**, plus **~34 s** one-off shader compile (1 spp = 38 s, 3 spp = 47 s) |
| SwiftShader | 64 spp / 256 spp | extrapolated **~5 min / ~18 min** (not run) |
| SwiftShader at 512x384 | 16 spp | 37 s total |

So a GPU laptop gets a clean (256+ spp) image in about 20-45 s; SwiftShader cannot reach a clean 1024x768 in any sensible `render_view` time.

NOT trustworthy (do not judge quality from the saved PT PNGs): with a quick hookup the mean radiance of the accumulation target grew with the sample count
(0.008 at 16 spp, 0.24 at 128 spp, same scene), so the images are either too dark (low spp) or white (high spp). Likely causes (not isolated):
(1) light-unit mismatch (lamp intensities had to be scaled by ~1/300 to look plausible, i.e. the pathtracer's point/spot units are not three's candela after our exposure handling),
(2) the app's materials (merged meshes with material groups, per-room `uv1` textures, emissive-as-bounce, `onBeforeCompile` hacks) do not convert cleanly (walls took the wood texture, the floor went mirror-black in some runs),
(3) accumulation interplay with the app's frame loop or the deprecated WebGL class on ANGLE/Metal. A proper PoC must use a clean conversion (section 7).
Saved for reference: `/tmp/rt-spike/ls-0.0015.png`, `ls-0.002.png`, `evening-swiftshader-pt-16spp.png`, `evening-gpu-pt-*.png`.

Before images: `/tmp/rt-spike/evening-gpu-before.png`, `evening-swiftshader-before.png`, `day-gpu-before.png`.

## 6. Recommendation, in tiers

### (a) Real-time default that replaces the bounce hacks: baked `LightProbeGridWebGL`

- Bake an SH probe grid from the real lights (shadowed point/spot lamps, sun, SkyDome seen through windows), apply it as indirect diffuse. It subsumes
  `roomLampBounce`, the per-room emissive bounce, and the `aoMap`/`roomDaylightFactors` sky hack: windows pass sky light naturally, windowless rooms are dark, lamps bounce locally.
- Keep: direct shadows (shadow maps, still limited by texture units), AWB (camera model), contact shadows and creases (probes at 0.25-0.5 m cannot produce < 10 cm AO), environment map for reflections.
- Texture units: the grid is one `sampler3D`; the removed room-ambient `aoMap` frees one, so `RESERVED_TEXTURE_UNITS` stays 9 net. Lamp shadow budget (7 on 16-unit GPUs) is unchanged: **probes do not lift the shadow limit.**
- Interaction model: bake on scene or lighting-state change, debounced; show the previous grid while baking. Sun animation cannot rebake per frame (4-15 s), so during animation keep the last bake and the hemisphere term, rebake on settle.
- Phase 2 idea (unverified): bake one grid per lamp and combine linearly on the CPU (irradiance is linear in light), making lamp toggle and dimming instant. Needs a readback of the 3D target; check feasibility first.

Why not the alternatives: WebGPU TSL SSGI/GTAO is screen space (no light from lamps behind the camera) and demands a WebGPURenderer migration that rewrites every custom shader and material hook; `realism-effects` is dead.

### (b) Photo mode: progressive path tracing

- **Web, on a GPU**: lazy chunk, "Photo" button, progressive accumulation with a visible sample counter, stop at N spp, OIDN or three-gpu-pathtracer's denoise for the last mile.
  Today: `WebGLPathTracer` works on r186 (deprecated class, +10 kB gz). Target: `WebGPUPathTracer` (WebGPU only; Chrome/Edge today, Safari recent). Expect 1024x768, 256 spp in about 20-45 s on a laptop GPU (my M4 Max WebGL numbers; an integrated GPU will be 3-10x slower, estimate).
  Because path tracing handles all lights unshadowed by texture units, the 16-unit shadow budget does not apply in this mode.
- **MCP `render_view` under SwiftShader**: not viable at full size (about 4 s per sample at 1024x768 plus 34 s compile). Options, best first:
  1. `FLAT_RENDER_CHANNEL=chrome` (installed Chrome with a real GPU) gives the GPU numbers above; document it as the way to get `quality: 'photo'`.
  2. SwiftShader at 640x480 with 32-64 spp plus a denoiser: roughly 1.6 s/sample, so 1-2 minutes plus compile (estimate from the measured per-pixel rate); opt-in, long timeout, queued by the existing render queue.
  3. Blender Cycles headless from a GLB export (CPU, OIDN) for reference-quality stills; needs Blender installed, so it belongs behind an env flag. Time not measured (estimate 30-90 s at 128 spp).
  4. A small seeded CPU path tracer on `three-mesh-bvh` in Node: fully deterministic, no GPU, a few hundred lines; speed not measured.
- Do not use `@react-three/gpu-pathtracer` (pins an ancient core).

### (c) Precomputed lightmaps per scene state

- Only after (a). Probes give smooth diffuse GI; lightmaps add sharp indirect shadows and soft lamp shadows without shadow maps (which would lift the 16-unit lamp limit for baked lamps).
- Costs: a unique-UV atlas for the merged `walls`/`floors`/`ceilings` meshes (our `uv1` is a per-room texel row, not an atlas; `xatlas-web` is the usual tool), a per-lamp layer set blended on toggle (2^9 lamp states are impossible to bake), and a bake service (reuse the path tracer from (b) offline). Estimated ~400 lines. three's `ProgressiveLightMap` is a possible start but is an example, not a supported API.

## 7. Proof-of-concept plans for the top two

### PoC 1: probe-grid GI (tier a)

Files:
- new `apps/web/src/viewer/probe-grid.ts` (pure): grid bounds from rooms + balcony, spacing from a budget (`<= ~4k probes`), `bakeKey(scene, lamps on/off + intensities, sun bucket)`. Unit-tested.
- new `apps/web/src/viewer/ProbeGI.tsx`: mounts the grid in the three scene, bakes in an effect, registers the work with `textureCache.track` so `whenRendered` waits for it.
- `LightingRig.tsx`: render `<ProbeGI/>`; drop the bounce inputs.
- `FlatCanvas.tsx`, `materials.ts`, `room-ambient.ts`: remove roomLampBounce, `roomBounce` emissive map and the `aoMap` ambient; keep `?ao=off` semantics for contact shadows.
- `perf.ts`: `probes: { spacing, cube, bounces }` per profile (off on low); `RESERVED_TEXTURE_UNITS` unchanged if the aoMap is removed in the same change.
- `lighting.ts`: remove `roomLampBounce` and `LAMP_BOUNCE_ALBEDO`; keep AWB.
- `docs/photometry.md`: replace the "Grids and lamp bounce" paragraph and the per-room sky ambient section.

Risks:
- **Light leaking through thin walls.** One grid is shared by every material, and with several grids `WebGLRenderer.findLightProbeGrid` selects by the object's origin [source], not per fragment. Our walls/floors are single merged meshes, so per-room grids do not work unless those meshes are split per room. Mitigation: 0.25-0.5 m spacing, the half-probe normal offset three already applies, and wall thickness aware sampling; verify with the existing `PROBE_GAP_M` style e2e probes on WC/SDB (dark rooms next to lit ones).
- Bake latency (4-15 s on a fast GPU, up to 75 s on SwiftShader at 0.5 m / 16 / 1 bounce): choose the profile by device, show the old grid while baking.
- Daylight: sun-lit patches need to be in the bake; sun animation rebakes on settle only.
- Streamed glTF materials already use 9 reserved units; the bake draws them through a cube camera, so check compile on a 16-unit device.
- Looks change: bounce colour and level will differ from the hand-tuned emissive (AWB interplay), so the golden-image tests and the lighting e2e thresholds need a deliberate update.

Deterministic tests:
- Pure maths in `probe-grid.ts` (bounds, counts, key) with vitest, no GL.
- e2e on SwiftShader as today: bake is deterministic on the same renderer; assert luma at probe points with tolerances (like `meanLuma` in `lighting.e2e.ts`): lit room bounce > 0 near the lamp wall, windowless room stays dark at noon, and no leak (dark point 5 cm behind a wall of a lit room).
- Test hook `bakeStats()` (count, ms, key) and a `?probes=off` flag, mirroring `?ao=off`.
- Use a coarse bake (1 m, cube 8, 0 bounces: 4-12 s on SwiftShader) in CI; full quality only in a nightly job.

### PoC 2: path-traced photo mode (tier b)

Files:
- new `apps/web/src/viewer/photo/PhotoMode.tsx` (lazy chunk): `buildPhotoScene(threeScene)` clones the scene and converts materials, `PhotoControls` (spp, stop, save PNG).
- new `apps/web/src/viewer/photo/photo-scene.ts` (pure where possible): drop `sky`, `shadow-casters`, `floor-contact`, `wall-creases` and any non-Standard material (all of these made `setScene` throw or pollute the render in my spike), zero the bounce emissive, convert each `MeshStandardMaterial` to a plain PBR material with real maps, build a physical environment (gradient from `skyState` for the sky; the app's PMREM texture is not usable by the tracer), and a lumen-to-tracer-unit calibration constant derived from one test lamp.
- `apps/mcp/src/render/pageSession.ts` + `render` tool schema: optional `quality: 'photo'`, `samples`, `maxSeconds`; `window.__flat.photo({samples})` returns a PNG; refuse or downscale on SwiftShader unless `FLAT_RENDER_CHANNEL=chrome`.
- `packages/scene`: no change (photometry stays pure).

Risks:
- **Unit calibration** (my spike needed ~1/300 on lamp intensity and the accumulation grew with samples, section 5.2): write a one-lamp test room first and match its lux to the analytic value from `docs/photometry.md` before any scene work.
- The deprecated WebGL class may be removed; target `WebGPUPathTracer` as soon as the WebGPU adapter is reliable in our headless setup (adapter exists under SwiftShader; correctness and speed unmeasured).
- Streamed provider models and instancing (`items`) need verification in the tracer; glass (transmission) cost.
- Time budget under SwiftShader (section 6b); queue and timeout handling in the render service.

Deterministic tests:
- No pixel goldens for path-traced output (GPU-dependent noise). Test: (1) a pure unit test of the lumen-to-tracer conversion, (2) a one-lamp room at fixed spp whose mean radiance matches the analytic expectation within a wide tolerance, run under SwiftShader at tiny size (64x48, 8 spp), (3) the render tool contract (parameters, refusal on SwiftShader, timeout), (4) a convergence check: mean luma at 16 spp vs 32 spp agree within noise (it caught the bug in 5.2).
- Seed: reset the tracer before each capture; compare statistics, not pixels.

## 8. Decision summary

1. Do tier (a) first: it is native three, +5 kB, removes the most hack code, and my spike reproduced the current look without the emissive bounce.
2. Add tier (b) as an opt-in "Photo" mode and a `render_view quality: 'photo'` that requires a real GPU (`FLAT_RENDER_CHANNEL=chrome`); do not promise it under SwiftShader.
3. Defer lightmaps (c) until probe leakage or missing sharp indirect shadows is a user-visible problem.
4. Do not migrate to WebGPURenderer/TSL for GI alone; revisit when WebGPU is the default for the audience and the NodeMaterial rewrite is otherwise justified.
