import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CameraPose, RoomType } from '@flat/scene';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolError, toolOk } from '../errors';
import { ControlsUnavailableError, ImageProviderError, buildReferencePrompt, fidelityRef, scoreFidelity, type Fidelity, type FidelityRef, buildVisualisationPrompt, getControlImageSource, getImageProvider, passControlSource, unavailableControls, type GeneratedImage, type JobStatus } from '../imagegen';
import { RenderError, resolvePose, sharedMcpRenderer } from '../render';
import { blockoutScene } from '../reference/blockout';
import { findView, layoutIntent, roomViews, type ViewSpec } from '../reference/views';
import { StyleError, findStyle } from '../styles';
import { READ, fetchScene, parseArgs } from './common';
import type { Renderer, ToolContext, ToolDef } from './registry';

/**
 * `generate_reference` (CG2): a photoreal image of a room from OUR geometry, made by the image provider.
 *  - `reference`: text-to-image conditioned on structural edges of the room camera (canny from the CG1 render passes), so
 *    walls, windows and doors match ours. The model uses it as a design target; it is not a render of the flat.
 *  - `visualisation`: a klein edit of our clean colour render. Pretty, but it may move things: never used for geometry.
 * A generation takes about 90 s per image: the call waits `waitS`, then returns the `jobId` to collect with another call.
 */

/** Strength of the depth+edges blend (spike: 0.8 keeps the layout without overriding the style). */
const BLEND_STRENGTH = 0.8;
/** How a placeholder role reads in the image prompt. */
const BLOCK_WORDS: Readonly<Record<string, string>> = {
  sofa: 'a sofa facing the TV wall',
  'coffee table': 'a low coffee table in front of it',
  rug: 'a rug under them',
  'media unit': 'a low media unit under the TV',
  bed: 'a bed with its headboard on the wall',
  'main piece': 'one large seat against the wall',
};
const SIZE = { width: 1024, height: 768 } as const;
const MAX_PREVIEW_B64 = 700_000;
const REFERENCE_LABEL = 'REFERENCE IMAGE (AI-generated target for the design; not a render of this flat, not a product, never an asset).';
const VISUALISATION_LABEL = 'VISUALISATION (AI-edited from our render; furniture, windows and proportions may differ from the honest 3D render).';

export const GenerateReferenceArgs = z.strictObject({
  roomId: z.string().min(1).max(64).optional(),
  styleId: z.string().min(1).max(40).optional(),
  mode: z.enum(['reference', 'visualisation']).default('reference'),
  facing: z.union([z.string().min(1).max(64), z.number().min(-360).max(360)]).optional().describe('As in render_view (walk camera).'),
  view: z.string().min(1).max(40).optional().describe('View id from describe_room.'),
  layout: z.string().min(1).max(500).optional().describe('Layout in words; default: the room\'s intent.'),
  blockout: z.boolean().default(true).describe('Draw the intended layout as placeholder volumes in the control image (scratch copy, scene untouched).'),
  n: z.number().int().min(1).max(4).default(1),
  seed: z.number().int().min(0).max(4294967295).optional(),
  waitS: z.number().min(0).max(300).default(45),
  jobId: z.string().min(1).max(64).optional(),
});
export type GenerateReferenceArgs = z.infer<typeof GenerateReferenceArgs>;

function inputSchema(): Record<string, unknown> {
  const raw = z.toJSONSchema(GenerateReferenceArgs, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = raw;
  void _drop;
  return rest;
}

/** What a job was asked for, kept so a later `jobId` call can label its result. */
export interface JobMeta {
  mode: 'reference' | 'visualisation';
  roomId: string;
  styleId: string;
  roomType: RoomType;
  prompt: string;
  negativePrompt: string;
  seed: number;
  /** The camera of the room view the image was made from (reference mode): the depth of the same pose gives the positions. */
  pose?: CameraPose;
  /** Named view (describe_room views) and its zone and weight, when the image was made for one. */
  view?: string;
  zone?: string;
  weight?: number;
  layout?: string;
  /** Roles drawn as placeholders in the control image (a scratch scene; the flat has none of them). */
  blockout?: string[];
  /** Why fewer candidates than asked were made (time budget, slow machine). */
  budgetNote?: string;
}
const jobs = new Map<string, JobMeta>();
/** Per job: what the generated images are checked against (the ids and edge passes of the control camera). */
const checks = new Map<string, FidelityRef>();
const countedJobs = new Set<string>();
/** What a job was asked for (this process only); `record_reference` uses its room and camera. */
export const getJobMeta = (id: string): JobMeta | undefined => jobs.get(id);
export const SIZE_OF_REFERENCE = SIZE;
const remember = (id: string, m: JobMeta) => {
  jobs.set(id, m);
  if (jobs.size > 50) {
    const old = jobs.keys().next().value as string;
    jobs.delete(old);
    checks.delete(old);
  }
};

// -- time budget of the reference phase ------------------------------------------------------------------------------------------

/** About how long one image takes on the Mac backend (Qwen + canny, 1024x768, 8 steps). */
export const EXPECTED_S_PER_IMAGE = 90;
const refClock: { firstAt: number | undefined; seconds: number; images: number } = { firstAt: undefined, seconds: 0, images: 0 };
export const resetReferenceClock = (): void => {
  Object.assign(refClock, { firstAt: undefined, seconds: 0, images: 0 });
};

/**
 * The runner (or the user) sets `FLAT_REFERENCE_BUDGET_S`, the time the reference phase may take from the first `generate_reference`
 * of this process. The second real run spent its whole hour on references and scored nothing. So: past 40% of the budget, or when
 * images come out more than 3x slower than expected (the machine is swapping), more candidates are cut to one; past the budget no
 * new reference is started and the model is told to score what it has.
 */
export function referenceBudget(n: number, env: Record<string, string | undefined> = process.env, now = Date.now()): { n: number; note?: string; refuse?: string } {
  const budget = Number(env['FLAT_REFERENCE_BUDGET_S']);
  if (!Number.isFinite(budget) || budget <= 0) return { n };
  refClock.firstAt ??= now;
  const elapsed = (now - refClock.firstAt) / 1000;
  if (elapsed >= budget) return { n, refuse: `the reference time budget (${Math.round(budget / 60)} min) is used up: no more reference images. Record and score the ones you have (at least one scored iteration is required), then finish.` };
  const avg = refClock.images ? refClock.seconds / refClock.images : 0;
  if (n > 1 && (elapsed >= 0.4 * budget || avg >= 3 * EXPECTED_S_PER_IMAGE)) {
    return { n: 1, note: `n reduced to 1: ${avg >= 3 * EXPECTED_S_PER_IMAGE ? `images take ${Math.round(avg)} s each (expected ${EXPECTED_S_PER_IMAGE} s), the machine is slow` : `${Math.round(elapsed / 60)} of ${Math.round(budget / 60)} reference minutes are used`}` };
  }
  return { n };
}

function providerFailure(e: unknown): CallToolResult {
  if (e instanceof ControlsUnavailableError) return toolError('not_implemented', e.message, 'Use mode "visualisation" (needs only a render), or wait for the render_passes tool; describe_room and render_view still work.');
  if (e instanceof ImageProviderError) {
    switch (e.code) {
      case 'invalid_request':
        return toolError('invalid_command', e.message);
      case 'job_not_found':
        return toolError('unknown_entity', e.message, 'The jobId is unknown (the image service restarted or the id is wrong); start a new generate_reference.');
      case 'not_implemented':
        return toolError('not_implemented', e.message);
      case 'provider_failed':
        return toolError('render_failed', e.message, 'The image service failed; check its log (pnpm imagegen) and retry once.');
      default:
        return toolError('render_unavailable', e.message, 'The image service is not available. Start it with `pnpm imagegen` (Mac) or the Docker image (NVIDIA), set IMAGEGEN_URL if it runs elsewhere, or continue without reference images.');
    }
  }
  if (e instanceof RenderError) return e.result ?? toolError(e.code, e.message, e.hint);
  return toolError('internal_error', e instanceof Error ? e.message : String(e));
}

function rateLimited(ctx: ToolContext): CallToolResult | undefined {
  const t = ctx.session.renders.take();
  return t.ok ? undefined : toolError('rate_limited', `more than ${ctx.limits.rendersPerMinute} renders per minute`, `Wait ${t.retryAfterMs} ms and retry.`, { retryAfterMs: t.retryAfterMs });
}

/**
 * The design runner sets FLAT_DESIGN_OUT (a trusted operator setting): every finished image is copied to `references/` with its
 * prompt, so the run folder holds the candidates, the chosen target and the labelled visualisation. Never fails the call.
 */
function saveForRunner(status: JobStatus, meta: JobMeta | undefined): void {
  const out = process.env['FLAT_DESIGN_OUT'];
  if (!out || status.status !== 'done') return;
  try {
    const dir = join(resolve(out), 'references');
    mkdirSync(dir, { recursive: true });
    const mode = meta?.mode ?? 'reference';
    const files = status.images.map((img, i) => {
      const file = join(dir, `${mode}-${status.jobId}-${i}.png`);
      if (existsSync(img.path)) copyFileSync(img.path, file);
      return { file, seed: img.seed, seconds: img.seconds };
    });
    const { pose: _pose, ...shown } = meta ?? ({} as Partial<JobMeta>);
    void _pose;
    writeFileSync(join(dir, `${mode}-${status.jobId}.json`), `${JSON.stringify({ jobId: status.jobId, mode, ...shown, images: files }, null, 2)}\n`);
  } catch {
    // saving is a convenience of the runner
  }
}

interface Filtered {
  kept: GeneratedImage[];
  rejected: { seed: number; path: string; fidelity: number; reasons: string[] }[];
  scores: Map<string, Fidelity>;
  note?: string;
}

/**
 * The automatic candidate filter: images whose ceiling is not pale or that ignore the drawing's edges are dropped (the model
 * never sees them). When every candidate fails the best one is kept with a warning, so a call never returns nothing.
 * Images that cannot be read (not a PNG, file gone) pass unchecked.
 */
function filterCandidates(images: GeneratedImage[], ref: FidelityRef | undefined): Filtered {
  const scores = new Map<string, Fidelity>();
  if (!ref) return { kept: images, rejected: [], scores };
  for (const img of images) {
    try {
      const bytes = existsSync(img.path) ? readFileSync(img.path) : img.preview?.mimeType === 'image/png' ? Buffer.from(img.preview.data, 'base64') : undefined;
      if (bytes) scores.set(img.path, scoreFidelity(bytes, ref));
    } catch {
      // unreadable image: not judged
    }
  }
  const failed = images.filter((i) => scores.get(i.path)?.ok === false);
  if (!failed.length) return { kept: images, rejected: [], scores };
  let kept = images.filter((i) => !failed.includes(i));
  let rejected = failed;
  let note = `${failed.length} candidate(s) dropped by the fidelity filter (ceiling or edges do not follow the drawing); pass another seed for more.`;
  if (!kept.length) {
    const best = [...failed].sort((a, b) => scores.get(b.path)!.score - scores.get(a.path)!.score)[0]!;
    kept = [best];
    rejected = failed.filter((i) => i !== best);
    note = `WARNING: every candidate failed the fidelity filter (${scores.get(best.path)!.reasons.join('; ')}); the best is returned. Retry with another seed before using it as a target.`;
  }
  return { kept, rejected: rejected.map((i) => ({ seed: i.seed, path: i.path, fidelity: scores.get(i.path)!.score, reasons: scores.get(i.path)!.reasons })), scores, note };
}

function resultFor(status: JobStatus, meta: JobMeta | undefined, providerId: string): CallToolResult {
  const label = meta?.mode === 'visualisation' ? VISUALISATION_LABEL : REFERENCE_LABEL;
  const { pose: _pose, ...shownMeta } = meta ?? ({} as Partial<JobMeta>);
  void _pose;
  const base = { provider: providerId, jobId: status.jobId, ...shownMeta };
  if (status.status === 'error') return toolError('render_failed', status.error ?? 'image generation failed', 'Retry once with another seed; if it keeps failing check the image service log.');
  if (status.status === 'cancelled') return toolError('render_failed', 'the image job was cancelled', 'Start a new generate_reference.');
  if (status.status !== 'done') {
    return toolOk({
      ok: true,
      status: status.status,
      progress: Math.round(status.progress * 100) / 100,
      ...(status.queuePosition ? { queuePosition: status.queuePosition } : {}),
      ...base,
      next: `Not finished (about 90 s per reference image). Call generate_reference {"jobId":"${status.jobId}"} again to collect it.`,
    });
  }
  const all: GeneratedImage[] = status.images.slice(0, 4);
  const filtered = filterCandidates(all, checks.get(status.jobId));
  const images = filtered.kept;
  saveForRunner(status, meta);
  // wall time per image, for the budget and for a loud warning when the machine is swapping
  const perImage = images.length ? images.reduce((a, i) => a + i.seconds, 0) / images.length : 0;
  if (!countedJobs.has(status.jobId) && images.length) {
    countedJobs.add(status.jobId);
    refClock.seconds += images.reduce((a, i) => a + i.seconds, 0);
    refClock.images += images.length;
  }
  const slow = perImage > 3 * EXPECTED_S_PER_IMAGE ? `SLOW: ${Math.round(perImage)} s per image against about ${EXPECTED_S_PER_IMAGE} s expected (more than 3x). The machine is probably swapping: ${(status.warnings ?? []).join('; ') || 'close other apps, check the image service memory in /health'}.` : undefined;
  const report = { ...(status.timings ? { timings: status.timings } : {}), ...(slow ? { slow } : {}), ...(status.warnings?.length ? { sidecarWarnings: status.warnings } : {}) };
  const content: CallToolResult['content'] = [];
  const skipped: string[] = [];
  for (const img of images) {
    if (img.preview && img.preview.data.length <= MAX_PREVIEW_B64) {
      content.push({ type: 'image', data: img.preview.data, mimeType: img.preview.mimeType });
      content.push({ type: 'text', text: `${label} seed ${img.seed}` });
    } else skipped.push(img.path);
  }
  return toolOk(
    {
      ok: true,
      status: 'done',
      label,
      kind: meta?.mode ?? 'reference',
      ...base,
      images: images.map((i) => ({ path: i.path, seed: i.seed, seconds: i.seconds, ...(filtered.scores.has(i.path) ? { fidelity: filtered.scores.get(i.path)!.score } : {}), ...(i.peakGb != null ? { peakGb: i.peakGb } : {}), ...(i.loadS !== undefined ? { loadS: i.loadS } : {}), ...(i.stepsS !== undefined ? { stepsS: i.stepsS } : {}) })),
      ...report,
      ...(filtered.rejected.length ? { rejected: filtered.rejected, note: filtered.note } : {}),
      ...(skipped.length ? { note: `no preview for ${skipped.length} image(s) (too large or unavailable); open the files at "path"` } : {}),
    },
    content,
  );
}

async function colourRender(ctx: ToolContext, a: GenerateReferenceArgs, pose?: CameraPose): Promise<{ data: string; mimeType: 'image/png' | 'image/jpeg' }> {
  const r: Renderer = ctx.renderer ?? sharedMcpRenderer(ctx.flat, { webUrl: ctx.config.webUrl, renderChannel: ctx.config.renderChannel, log: ctx.config.log });
  const out = await r.render({ view: 'walk', roomId: a.roomId!, ...(pose ? { pose } : a.facing !== undefined ? { facing: a.facing as never } : {}), size: { ...SIZE } }, { format: 'png', session: ctx.session });
  return { data: out.image, mimeType: out.mimeType };
}

async function generateReference(ctx: ToolContext, args: Record<string, unknown>): Promise<CallToolResult> {
  const p = parseArgs(GenerateReferenceArgs, args);
  if (!p.ok) return p.result;
  const a = p.data;
  const provider = getImageProvider();
  const waitMs = a.waitS * 1000;

  try {
    if (a.jobId) return resultFor(await provider.poll(a.jobId, { waitMs }), jobs.get(a.jobId), provider.id);

    if (!a.roomId || !a.styleId) return toolError('invalid_command', 'roomId and styleId are required (or jobId to collect a result)', undefined, { errors: [{ code: 'invalid_command', path: a.roomId ? 'styleId' : 'roomId', message: 'required' }] });
    let style;
    try {
      style = findStyle(a.styleId);
    } catch (e) {
      if (e instanceof StyleError) return toolError('invalid_command', e.message, 'Call list_styles for the style ids.', { errors: [{ code: 'invalid_command', path: 'styleId', message: e.message }] });
      throw e;
    }
    const sc = await fetchScene(ctx);
    if (!sc.ok) return sc.result;
    const scene = sc.data.scene;
    const room = scene.rooms.find((r) => r.id === a.roomId);
    if (!room) return toolError('unknown_room', `no room "${a.roomId}"`);
    let spec: ViewSpec | undefined;
    if (a.view) {
      const views = roomViews(scene, a.roomId);
      spec = findView(views, a.view);
      if (!spec) return toolError('unknown_entity', `no view "${a.view}" in room "${a.roomId}"`, `Views: ${views.map((v) => v.id).join(', ')} (describe_room lists them).`);
    }
    const pose: CameraPose = spec?.pose ?? resolvePose(scene, { view: 'walk', roomId: a.roomId, facing: a.facing }, SIZE.width / SIZE.height).pose;
    const viewMeta = spec ? { view: spec.id, zone: spec.zone, weight: spec.weight } : {};
    const limited = rateLimited(ctx);
    if (limited) return limited;
    const seed = a.seed ?? 1;

    if (a.mode === 'visualisation') {
      const built = buildVisualisationPrompt(style.meta, room.type);
      const image = await colourRender(ctx, a, spec?.pose);
      const status = await provider.edit({ image: { provenance: 'render', ...image }, prompt: built.prompt, seed, strength: 0.5, model: 'klein-edit' }, { waitMs });
      const meta: JobMeta = { mode: 'visualisation', roomId: a.roomId, styleId: a.styleId, roomType: room.type, prompt: built.prompt, negativePrompt: built.negativePrompt, seed, ...viewMeta };
      remember(status.jobId, meta);
      return resultFor(status, meta, provider.id);
    }

    // The layout is decided from the room, before the image: the prompt states it, the camera only shows it. The intended
    // pieces are also drawn as placeholder volumes in a scratch copy of the scene, so the control image carries them too.
    const intent = spec ? layoutIntent(scene, a.roomId, spec.zone) : undefined;
    const block = a.blockout && intent && !a.layout ? blockoutScene(scene, a.roomId, intent) : undefined;
    const blockText = block ? ` Furniture as blocked out in the control drawing: ${block.placed.map((r) => BLOCK_WORDS[r] ?? `a ${r}`).join(', ')}.` : '';
    const layout = a.layout ?? (intent ? `${block ? '' : intent.promptText}${blockText}`.trim() || undefined : undefined);
    const built = buildReferencePrompt(style.meta, room.type, { zone: spec?.zone === 'kitchen' ? 'kitchen' : undefined, kitchenVisible: spec ? spec.zone !== 'kitchen' && spec.sees.includes('kitchen') : false, viewHint: spec?.promptHint, layout });
    // A source installed with setControlImageSource wins (tests); otherwise the CG1 render passes of this server's renderer.
    const source = getControlImageSource();
    const ctrl = await (source === unavailableControls ? passControlSource(ctx.renderer ?? sharedMcpRenderer(ctx.flat, { webUrl: ctx.config.webUrl, renderChannel: ctx.config.renderChannel, log: ctx.config.log })) : source).getControlImages({ scene, roomId: a.roomId, pose, size: { ...SIZE }, ...(block ? { blockout: block.scene } : {}) });
    const budget = referenceBudget(a.n);
    if (budget.refuse) return toolError('rate_limited', budget.refuse, 'Call record_reference and score_against_reference with the references you already have.');
    // The blend (depth + edges) when the passes could draw the placeholders; otherwise the structural edges as before.
    const control = ctrl.blend ? { type: 'depth' as const, image: ctrl.blend, strength: BLEND_STRENGTH } : { type: 'canny' as const, image: ctrl.canny, strength: 1.0 };
    const status = await provider.generate(
      { prompt: built.prompt, negativePrompt: built.negativePrompt, seed, n: budget.n, width: SIZE.width, height: SIZE.height, model: 'qwen-cn', controls: [control] },
      { waitMs },
    );
    if (ctrl.check) {
      try {
        checks.set(status.jobId, fidelityRef(ctrl.check.ids.data, ctrl.check.edges.data));
      } catch {
        // no check data: the filter is off for this job
      }
    }
    const meta: JobMeta = { mode: 'reference', roomId: a.roomId, styleId: a.styleId, roomType: room.type, prompt: built.prompt, negativePrompt: built.negativePrompt, seed, pose, ...viewMeta, ...(layout ? { layout } : {}), ...(block ? { blockout: block.placed } : {}), ...(budget.note ? { budgetNote: budget.note } : {}) };
    remember(status.jobId, meta);
    return resultFor(status, meta, provider.id);
  } catch (e) {
    return providerFailure(e);
  }
}

export function referenceTools(): ToolDef[] {
  return [
    {
      name: 'generate_reference',
      description:
        'AI image of a room in a style. reference: photoreal target that follows our walls, windows and doors. visualisation: photo-style edit of our render. Labelled, never an asset. ~90 s per image: if not done after waitS, call again with jobId.',
      inputSchema: inputSchema(),
      annotations: { ...READ, idempotentHint: false},
      group: 'render',
      mutatesScene: false,
      handler: generateReference,
    },
  ];
}
