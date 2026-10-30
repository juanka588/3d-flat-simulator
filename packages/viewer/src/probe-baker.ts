import { Data3DTexture, FloatType, LinearFilter, Mesh, NearestFilter, OrthographicCamera, PlaneGeometry, RGBAFormat, Scene, ShaderMaterial, Vector3, WebGL3DRenderTarget, WebGLRenderTarget } from 'three';
import type { WebGLRenderer } from 'three';
import { LightProbeGridWebGL } from 'three/examples/jsm/lighting/LightProbeGridWebGL.js';
import { fieldFromAtlas, sanitizeAtlas } from './probe-field';
import type { ProbeField } from './probe-field';
import { bakeRuns, buildVisibility, hashString, probeCount, probeValidity } from './probe-grid';
import type { PlanBox, ProbeLayout, ProbeSettings, Solid, Visibility } from './probe-grid';
import { probeControls, setProbeControls, setProbeField, setProbeStats } from './probe-runtime';
import type { ProbeControls } from './probe-runtime';

/** What to bake: the state of the flat and its lights, as a key, plus how to put the three.js scene into bake state. */
export interface BakeJob {
  key: string;
  /** Open-air light (lux) the job is baked for: the displayed grid's exposure reference (see `gridLimitedExposure`). */
  keyLux: number;
  layout: ProbeLayout;
  settings: ProbeSettings;
  solids: readonly Solid[];
  boxes: readonly PlanBox[];
  /** 1 for probes that sit indoors: they are baked with their own sky brightness (`PROBE_INDOOR_SKY_GAIN`). */
  indoor: Uint8Array;
  /** Puts the scene into bake state (sky dome, ceilings, no overlays...) for probes indoors or outdoors and returns the function that undoes it. Called around every slice. */
  prepare: (indoor: boolean) => () => void;
}

interface Slot {
  grid: LightProbeGridWebGL;
  layoutKey: string;
  visSlices: number;
  /** The bake key the grid holds (null while it is being baked or never was) and the light field read from it. */
  key: string | null;
  field: ProbeField | null;
  keyLux: number | null;
}

type GridInternals = { _renderTarget: WebGL3DRenderTarget | null };

/** GPU time one slice of the bake aims at, ms: short enough that a frame can slip in between slices. */
const SLICE_TARGET_MS = 24;
const MAX_SLICE = 96;
/** Nobody orbits while an automated page (test, headless render) waits for the bake: fewer, longer slices. */
const HEADLESS_SLICE_TARGET_MS = 250;
const HEADLESS_MAX_SLICE = 512;
/** Baked grids kept besides the displayed one, so going back to a recent lighting state (a lamp toggled back) needs no bake. */
const SPARE_SLOTS = 2;

const headless = (): boolean => typeof navigator !== 'undefined' && !(typeof location !== 'undefined' && new URLSearchParams(location.search).get('bake') === 'interactive') && (navigator.webdriver === true || (typeof location !== 'undefined' && new URLSearchParams(location.search).has('test')));
/** Last pointer/wheel/key input (performance.now): a bake slice waits while the user is orbiting or walking, so interaction stays smooth. */
let lastInput = -Infinity;
let inputWatched = false;
const watchInput = (): void => {
  if (inputWatched || typeof window === 'undefined') return;
  inputWatched = true;
  for (const type of ['pointermove', 'pointerdown', 'wheel', 'keydown'] as const) window.addEventListener(type, () => void (lastInput = performance.now()), { passive: true, capture: true });
};
/** Longest a bake is held back by continuous input (ms): it must still finish eventually. */
const MAX_INPUT_HOLD_MS = 4000;
/** Quiet time after the last input before a slice may start, ms. */
const INPUT_QUIET_MS = 150;

const NEAR = 0.05;
const FAR = 120;

const layoutKeyOf = (l: ProbeLayout): string => JSON.stringify([l.min, l.size, l.res]);

/**
 * Owns the two probe grids (the displayed one and the one being baked), bakes in time slices with at most one slice in
 * flight on the GPU, and swaps when a bake is complete. The displayed grid is never touched by a bake in progress: a
 * lighting or scene change keeps the old light until the new one is ready.
 *
 * Exactly one grid is visible in the scene at any time outside a slice (inside a slice: the one being baked), so the number of
 * grids, and with it every shader program, is constant.
 */
export class ProbeBaker {
  private front: Slot | null = null;
  private spares: Slot[] = [];
  private displayedKey: string | null = null;
  private wanted: BakeJob | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private token = 0;
  private running = false;
  /** The job being baked (null when idle): a request for the same layout waits for it instead of cancelling it, so a changing light cannot starve the bake. */
  private runningJob: BakeJob | null = null;
  /** When the first request of the current burst arrived (performance.now), for the maximum wait. */
  private waitSince: number | null = null;
  private disposed = false;
  private bakes = 0;
  private sliceSize = 8;
  private readonly controls: ProbeControls;
  private readTarget: { rt: WebGLRenderTarget; key: string } | null = null;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly onPublished: () => void,
    private readonly debounceMs = 400,
    private readonly maxWaitMs = 1000,
  ) {
    this.controls = { rebake: () => this.rebake(), hash: () => this.hash() };
  }

  /** Mounts the (empty) displayed grid for `layout` so materials compile with a grid from their first frame. */
  mount(layout: ProbeLayout, solids: readonly Solid[], boxes: readonly PlanBox[]): void {
    if (this.disposed) return;
    setProbeControls(this.controls);
    if (this.front) return;
    this.front = this.makeSlot(layout, solids, boxes);
    this.front.grid.visible = true;
  }

  /** Asks for a bake of `job` (after the debounce). The same key as what is displayed or already wanted is a no-op. */
  request(job: BakeJob, immediate = false): void {
    if (this.disposed) return;
    setProbeControls(this.controls);
    if (job.key === this.wanted?.key) return;
    const cached = this.spares.find((sp) => sp.key === job.key && sp.layoutKey === layoutKeyOf(job.layout));
    if (cached) {
      // A recent state: swap it back in, nothing to bake.
      this.cancel();
      this.wanted = job;
      this.publish(cached);
      this.displayedKey = job.key;
      setProbeField(cached.field);
      setProbeStats({ pending: false, displayedKey: job.key, displayedKeyLux: cached.keyLux, wantedKey: job.key });
      this.onPublished();
      return;
    }
    if (job.key === this.displayedKey && !this.running && !this.timer) {
      this.wanted = job;
      setProbeStats({ pending: false, wantedKey: job.key });
      return;
    }
    this.wanted = job;
    if (this.running && this.runningJob && layoutKeyOf(this.runningJob.layout) === layoutKeyOf(job.layout)) {
      // The light keeps changing (the sun animates): let the running bake finish and show its grid, then bake the newest state at once.
      setProbeStats({ pending: true, wantedKey: job.key });
      return;
    }
    this.cancel();
    setProbeStats({ pending: true, wantedKey: job.key });
    // Debounce, but never wait longer than `maxWaitMs` since the first request of a burst: a changing light must still get baked.
    const now = performance.now();
    this.waitSince ??= now;
    const delay = immediate ? 0 : Math.min(this.debounceMs, Math.max(0, this.maxWaitMs - (now - this.waitSince)));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.waitSince = null;
      void this.bake(job);
    }, delay);
  }

  /** Drops the running bake and the pending timer. */
  private cancel(): void {
    this.token++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.running = false;
    this.runningJob = null;
  }

  /** Bakes the wanted state again at once (no debounce), even if it is the displayed one. Resolves when published. */
  rebake(): Promise<void> {
    const job = this.wanted;
    if (!job || this.disposed) return Promise.resolve();
    this.cancel();
    setProbeStats({ pending: true });
    return this.bake(job);
  }

  private makeSlot(layout: ProbeLayout, solids: readonly Solid[], boxes: readonly PlanBox[]): Slot {
    const max3d = (this.renderer.getContext() as WebGL2RenderingContext).getParameter(WebGL2RenderingContext.MAX_3D_TEXTURE_SIZE) as number;
    const vis = buildVisibility(layout, solids, boxes, Math.max(1, max3d - 7 * (layout.res[2] + 2)));
    const [nx, ny, nz] = layout.res;
    const grid = new LightProbeGridWebGL(layout.size[0], layout.size[1], layout.size[2], nx, ny, nz);
    grid.name = 'probe-grid';
    grid.position.set(layout.min[0] + layout.size[0] / 2, layout.min[1] + layout.size[1] / 2, layout.min[2] + layout.size[2] / 2);
    grid.updateBoundingBox();
    grid.visible = false;
    // The atlas of three's grid (7 SH sub-volumes) plus the visibility slices behind it (see probe-shader.ts).
    const rt = new WebGL3DRenderTarget(nx, ny, 7 * (nz + 2) + vis.slices, { format: RGBAFormat, type: FloatType, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false, depthBuffer: false });
    (grid as unknown as GridInternals)._renderTarget = rt;
    grid.texture = rt.texture;
    this.uploadVisibility(rt, vis, 7 * (nz + 2));
    this.scene.add(grid);
    return { grid, layoutKey: layoutKeyOf(layout), visSlices: vis.slices, key: null, field: null, keyLux: null };
  }

  private uploadVisibility(rt: WebGL3DRenderTarget, vis: Visibility, base: number): void {
    const tex = new Data3DTexture(vis.data, vis.width, vis.height, vis.slices);
    tex.format = RGBAFormat;
    tex.type = FloatType;
    tex.minFilter = NearestFilter;
    tex.magFilter = NearestFilter;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    this.renderer.initRenderTarget(rt);
    this.renderer.copyTextureToTexture(tex, rt.texture, null, new Vector3(0, 0, base));
    tex.dispose();
  }

  private async bake(job: BakeJob): Promise<void> {
    if (this.disposed) return;
    const token = ++this.token;
    this.running = true;
    this.runningJob = job;
    this.waitSince = null;
    const started = performance.now();
    try {
      const lk = layoutKeyOf(job.layout);
      // Reuse the oldest spare of this layout (its contents are overwritten); other layouts' spares are dropped.
      for (const sp of this.spares.filter((x) => x.layoutKey !== lk)) this.drop(sp);
      this.spares = this.spares.filter((x) => x.layoutKey === lk);
      let slot = this.spares.length >= SPARE_SLOTS ? this.spares[this.spares.length - 1]! : null;
      if (!slot) slot = this.makeSlot(job.layout, job.solids, job.boxes);
      else {
        this.spares = this.spares.filter((x) => x !== slot);
        slot.key = null;
        slot.keyLux = null;
        const max3d = (this.renderer.getContext() as WebGL2RenderingContext).getParameter(WebGL2RenderingContext.MAX_3D_TEXTURE_SIZE) as number;
        const vis = buildVisibility(job.layout, job.solids, job.boxes, Math.max(1, max3d - 7 * (job.layout.res[2] + 2)));
        this.uploadVisibility((slot.grid as unknown as GridInternals)._renderTarget!, vis, 7 * (job.layout.res[2] + 2));
      }
      const valid = probeValidity(job.layout, job.solids);
      const total = probeCount(job.layout);
      const runs = bakeRuns(valid, Infinity, job.indoor);
      const baked = runs.reduce((n, r) => n + r[1], 0);
      const passes = job.settings.bounces + 1;
      const quiet = headless();
      const targetMs = quiet ? HEADLESS_SLICE_TARGET_MS : SLICE_TARGET_MS;
      const maxSlice = quiet ? HEADLESS_MAX_SLICE : MAX_SLICE;
      for (let pass = 0; pass < passes; pass++) {
        for (const [start, count] of runs) {
          let at = start;
          while (at < start + count) {
            if (token !== this.token || this.disposed) return;
            const n = Math.min(this.sliceSize, start + count - at);
            if (!quiet) {
              watchInput();
              const holdFrom = performance.now();
              while (performance.now() - lastInput < INPUT_QUIET_MS && performance.now() - holdFrom < MAX_INPUT_HOLD_MS) {
                await new Promise((r) => setTimeout(r, 40));
                if (token !== this.token || this.disposed) return;
              }
            }
            const t0 = performance.now();
            this.slice(slot, job, at, n, pass, job.indoor[at] === 1);
            await this.gpuIdle();
            const ms = performance.now() - t0;
            this.sliceSize = Math.max(1, Math.min(maxSlice, Math.round(this.sliceSize * Math.min(2, Math.max(0.5, targetMs / Math.max(ms, 1))))));
            at += n;
          }
        }
      }
      if (token !== this.token || this.disposed) return;
      this.sanitize(slot);
      this.publish(slot);
      slot.key = job.key;
      slot.keyLux = job.keyLux;
      slot.field = this.readField(slot, job);
      setProbeField(slot.field);
      this.displayedKey = job.key;
      this.bakes++;
      const done = this.wanted?.key === job.key;
      setProbeStats({
        mode: 'probes',
        pending: !done,
        displayedKey: job.key,
        displayedKeyLux: job.keyLux,
        bakes: this.bakes,
        lastBakeMs: Math.round(performance.now() - started),
        lastBakeProbes: baked * passes,
        res: job.layout.res,
        spacing: job.layout.spacing,
        cube: job.settings.cube,
        bounces: job.settings.bounces,
        invalid: total - baked,
        error: null,
      });
      this.onPublished();
    } catch (error) {
      if (token === this.token) {
        console.warn('[probes] bake failed; falling back to the per-room bounce', error);
        setProbeStats({ pending: false, error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (token === this.token) {
        this.running = false;
        this.runningJob = null;
        // Requests that arrived during the bake (same layout) were deferred: bake the newest state now.
        const next = this.wanted;
        if (next && next.key !== job.key && !this.disposed && !this.timer) {
          this.wanted = null;
          this.request(next, true);
        }
      }
    }
  }

  /** NaN or Inf in the baked atlas would spread through the interpolation and tone-map to white: clean it before it is shown. */
  private sanitize(slot: Slot): void {
    const rt = (slot.grid as unknown as GridInternals)._renderTarget;
    let atlas: Float32Array | null;
    try {
      atlas = rt ? this.readAtlas(slot) : null;
    } catch {
      return; // the readback is a safety net: without it the grid is shown as baked
    }
    if (!rt || !atlas) return;
    const changed = sanitizeAtlas(atlas);
    if (changed === 0) return;
    console.warn(`[probes] ${changed} non-finite or out-of-range values in the baked atlas were sanitised`);
    const tex = new Data3DTexture(atlas, rt.width, rt.height, rt.depth);
    tex.format = RGBAFormat;
    tex.type = FloatType;
    tex.minFilter = NearestFilter;
    tex.magFilter = NearestFilter;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    this.renderer.copyTextureToTexture(tex, rt.texture, null, new Vector3(0, 0, 0));
    tex.dispose();
  }

  /** One slice: the scene in bake state, only the grid being baked visible, then everything back. */
  private slice(slot: Slot, job: BakeJob, start: number, count: number, pass: number, indoor: boolean): void {
    const undo = job.prepare(indoor);
    const front = this.front;
    const frontWasVisible = front?.grid.visible ?? false;
    try {
      if (front && front !== slot) front.grid.visible = false;
      slot.grid.visible = true;
      slot.grid.bake(this.renderer, this.scene, { cubemapSize: job.settings.cube, near: NEAR, far: FAR, start, count, pass, bounces: 0 });
    } finally {
      if (front && front !== slot) front.grid.visible = frontWasVisible;
      if (slot !== front) slot.grid.visible = false;
      undo();
    }
  }

  /** Waits until the GPU has finished what was submitted, polling a fence so the main thread stays free. */
  private async gpuIdle(): Promise<void> {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) return;
    gl.flush();
    try {
      for (;;) {
        const status = gl.clientWaitSync(sync, 0, 0);
        if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED || status === gl.WAIT_FAILED) return;
        await new Promise((r) => setTimeout(r, 2));
      }
    } finally {
      gl.deleteSync(sync);
    }
  }

  private publish(slot: Slot): void {
    const old = this.front;
    this.spares = this.spares.filter((x) => x !== slot);
    slot.grid.visible = true;
    if (old && old !== slot) {
      old.grid.visible = false;
      this.spares.unshift(old);
      while (this.spares.length > SPARE_SLOTS) this.drop(this.spares.pop()!);
    }
    this.front = slot;
  }

  private drop(slot: Slot): void {
    this.scene.remove(slot.grid);
    slot.grid.dispose();
  }

  /** The atlas of `slot` as stored on the GPU, `width x (height * depth)` RGBA floats (row `z * height + y`). */
  private readAtlas(slot: Slot): Float32Array | null {
    const rt = (slot.grid as unknown as GridInternals)._renderTarget;
    if (!rt) return null;
    const { width, height, depth } = rt;
    if (!this.readTarget || this.readTarget.key !== `${width}x${height}x${depth}`) {
      this.readTarget?.rt.dispose();
      this.readTarget = { key: `${width}x${height}x${depth}`, rt: new WebGLRenderTarget(width, height * depth, { type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false }) };
    }
    const material = new ShaderMaterial({
      uniforms: { atlas: { value: rt.texture }, size: { value: new Vector3(width, height, depth) } },
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `precision highp sampler3D; uniform sampler3D atlas; uniform vec3 size;
        void main(){ ivec2 p = ivec2(gl_FragCoord.xy); int h = int(size.y); gl_FragColor = texelFetch(atlas, ivec3(p.x, p.y % h, p.y / h), 0); }`,
      depthTest: false,
    });
    const quad = new Mesh(new PlaneGeometry(2, 2), material);
    const scene = new Scene();
    scene.add(quad);
    const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.readTarget.rt);
    this.renderer.render(scene, cam);
    const out = new Float32Array(width * height * depth * 4);
    this.renderer.readRenderTargetPixels(this.readTarget.rt, 0, 0, width, height * depth, out);
    this.renderer.setRenderTarget(previous);
    material.dispose();
    quad.geometry.dispose();
    return out;
  }

  /** The light the baked grid gives (what the opt-in adaptive exposure is keyed on), read back once per bake; null unless `?exposure=adapt`. */
  private readField(slot: Slot, job: BakeJob): ProbeField | null {
    if (typeof location === 'undefined' || new URLSearchParams(location.search).get('exposure') !== 'adapt') return null;
    const atlas = this.readAtlas(slot);
    return atlas ? fieldFromAtlas(job.layout, job.indoor, atlas) : null;
  }

  /** FNV-1a of the whole displayed atlas (spherical harmonics and visibility). Test hook. */
  hash(): string {
    const out = this.front ? this.readAtlas(this.front) : null;
    if (!out) return '';
    const bytes = new Uint8Array(out.buffer);
    let text = '';
    for (let i = 0; i < bytes.length; i += 4096) text += hashString(String.fromCharCode(...bytes.subarray(i, i + 4096)));
    return hashString(text);
  }

  /** After a lost context the GPU contents are gone: forget what is displayed so the wanted state is baked again. */
  contextRestored(): void {
    this.displayedKey = null;
    for (const sp of this.spares) sp.key = null;
    if (this.wanted) {
      const job = this.wanted;
      this.wanted = null;
      this.request(job);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.token++;
    clearTimeout(this.timer);
    for (const s of [this.front, ...this.spares]) if (s) this.drop(s);
    this.front = null;
    this.spares = [];
    this.readTarget?.rt.dispose();
    if (probeControls() === this.controls) setProbeControls(null);
    setProbeStats({ pending: false });
  }
}
