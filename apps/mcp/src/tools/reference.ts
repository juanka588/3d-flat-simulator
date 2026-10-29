import type { RoomType } from '@flat/scene';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolError, toolOk } from '../errors';
import { ControlsUnavailableError, ImageProviderError, buildReferencePrompt, buildVisualisationPrompt, getControlImageSource, getImageProvider, type GeneratedImage, type JobStatus } from '../imagegen';
import { RenderError, resolvePose, sharedMcpRenderer } from '../render';
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

const SIZE = { width: 1024, height: 768 } as const;
const MAX_PREVIEW_B64 = 700_000;
const REFERENCE_LABEL = 'REFERENCE IMAGE (AI-generated target for the design; not a render of this flat, not a product, never an asset).';
const VISUALISATION_LABEL = 'VISUALISATION (AI-edited from our render; furniture, windows and proportions may differ from the honest 3D render).';

export const GenerateReferenceArgs = z.strictObject({
  roomId: z.string().min(1).max(64).optional().describe('Required unless jobId.'),
  styleId: z.string().min(1).max(40).optional().describe('Required unless jobId.'),
  mode: z.enum(['reference', 'visualisation']).default('reference'),
  facing: z.union([z.string().min(1).max(64), z.number().min(-360).max(360)]).optional().describe('As in render_view (walk camera).'),
  n: z.number().int().min(1).max(4).default(1).describe('reference only.'),
  seed: z.number().int().min(0).max(4294967295).optional(),
  waitS: z.number().min(0).max(300).default(45),
  jobId: z.string().min(1).max(64).optional().describe('Collect a job that was still running.'),
});
export type GenerateReferenceArgs = z.infer<typeof GenerateReferenceArgs>;

function inputSchema(): Record<string, unknown> {
  const raw = z.toJSONSchema(GenerateReferenceArgs, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = raw;
  void _drop;
  return rest;
}

/** What a job was asked for, kept so a later `jobId` call can label its result. */
interface JobMeta {
  mode: 'reference' | 'visualisation';
  roomId: string;
  styleId: string;
  roomType: RoomType;
  prompt: string;
  negativePrompt: string;
  seed: number;
}
const jobs = new Map<string, JobMeta>();
const remember = (id: string, m: JobMeta) => {
  jobs.set(id, m);
  if (jobs.size > 50) jobs.delete(jobs.keys().next().value as string);
};

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

function resultFor(status: JobStatus, meta: JobMeta | undefined, providerId: string): CallToolResult {
  const label = meta?.mode === 'visualisation' ? VISUALISATION_LABEL : REFERENCE_LABEL;
  const base = { provider: providerId, jobId: status.jobId, ...(meta ?? {}) };
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
  const images: GeneratedImage[] = status.images.slice(0, 4);
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
      images: images.map((i) => ({ path: i.path, seed: i.seed, seconds: i.seconds, ...(i.peakGb != null ? { peakGb: i.peakGb } : {}) })),
      ...(skipped.length ? { note: `no preview for ${skipped.length} image(s) (too large or unavailable); open the files at "path"` } : {}),
    },
    content,
  );
}

async function colourRender(ctx: ToolContext, a: GenerateReferenceArgs): Promise<{ data: string; mimeType: 'image/png' | 'image/jpeg' }> {
  const r: Renderer = ctx.renderer ?? sharedMcpRenderer(ctx.flat, { webUrl: ctx.config.webUrl, renderChannel: ctx.config.renderChannel, log: ctx.config.log });
  const out = await r.render({ view: 'walk', roomId: a.roomId!, ...(a.facing !== undefined ? { facing: a.facing as never } : {}), size: { ...SIZE } }, { format: 'png', session: ctx.session });
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
    const { pose } = resolvePose(scene, { view: 'walk', roomId: a.roomId, facing: a.facing }, SIZE.width / SIZE.height);
    if (!room) return toolError('unknown_room', `no room "${a.roomId}"`);
    const limited = rateLimited(ctx);
    if (limited) return limited;
    const seed = a.seed ?? 1;

    if (a.mode === 'visualisation') {
      const built = buildVisualisationPrompt(style.meta, room.type);
      const image = await colourRender(ctx, a);
      const status = await provider.edit({ image: { provenance: 'render', ...image }, prompt: built.prompt, seed, strength: 0.5, model: 'klein-edit' }, { waitMs });
      const meta: JobMeta = { mode: 'visualisation', roomId: a.roomId, styleId: a.styleId, roomType: room.type, prompt: built.prompt, negativePrompt: built.negativePrompt, seed };
      remember(status.jobId, meta);
      return resultFor(status, meta, provider.id);
    }

    const built = buildReferencePrompt(style.meta, room.type);
    const ctrl = await getControlImageSource().getControlImages({ scene, roomId: a.roomId, pose, size: { ...SIZE } });
    const status = await provider.generate(
      { prompt: built.prompt, negativePrompt: built.negativePrompt, seed, n: a.n, width: SIZE.width, height: SIZE.height, model: 'qwen-cn', controls: [{ type: 'canny', image: ctrl.canny, strength: 1.0 }] },
      { waitMs },
    );
    const meta: JobMeta = { mode: 'reference', roomId: a.roomId, styleId: a.styleId, roomType: room.type, prompt: built.prompt, negativePrompt: built.negativePrompt, seed };
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
      title: 'Generate a reference image',
      description:
        'AI image of a room in a style (eye-level view). reference: photoreal target that follows our walls, windows and doors; pick real products to match it. visualisation: photo-style edit of our current render. Labelled, never an asset. About 90 s per reference image: if not done after waitS you get a jobId; call again with it.',
      inputSchema: inputSchema(),
      annotations: { ...READ, idempotentHint: false, title: 'Generate a reference image' },
      group: 'render',
      mutatesScene: false,
      handler: generateReference,
    },
  ];
}
