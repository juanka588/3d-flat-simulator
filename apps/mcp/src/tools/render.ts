import { CameraPose, LightingView, PresetName, RENDER_LIMITS, type RenderSpecInput, type Scene } from '@flat/scene';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { toolError, toolOk } from '../errors';
import { RenderError, sharedMcpRenderer } from '../render';
import { READ, fetchScene, parseArgs } from './common';
import type { RenderMeta, Renderer, ToolContext, ToolDef } from './registry';

/**
 * `render_view` (M4.10): draws the flat with the warm headless viewer and returns an image. The heavy
 * lifting (pose presets, lighting layers, the browser) is in `../render`; this file is the tool
 * surface plus `renderForWrite`, the path of the `render` argument of write tools.
 *
 * Uses `ctx.renderer` when the host installed one; otherwise the process-wide `McpRenderer` over
 * `ctx.flat` (lazy: Playwright is only imported at the first render).
 */

/** What `render_view` returns in `structuredContent`: `RenderResult` (with the real mime type) plus what the model needs to read the picture. */
export type RenderViewResult = RenderMeta & {
  ok: true;
  /** One entry per image, in order: the main image, then (with compare) the "before" image. */
  images: { label: 'image' | 'after' | 'before'; rev: number }[];
};

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

export const RenderViewArgs = z.strictObject({
  view: z.enum(['room', 'walk', 'top', 'orbit', 'flat']).default('room').describe('room: roomId from above; walk: eye level in roomId; top: plan; orbit/flat: whole flat, 45 degrees.'),
  roomId: z.string().min(1).max(64).optional().describe('Required for room and walk.'),
  facing: z.union([z.string().min(1).max(64), z.number().min(-360).max(360)]).optional().describe('walk: compass point, degrees from plan-up, or wall/opening id. Default: room centre.'),
  pose: CameraPose.optional().describe('Explicit camera; replaces view, roomId, facing.'),
  date: LightingView.shape.date.optional().describe('YYYY-MM-DD. Default: session date, else 2026-06-21.'),
  time: LightingView.shape.time.optional().describe('HH:mm.'),
  preset: PresetName.optional().describe('day: 12:00, lamps off. evening: 20:00 21 Dec. night: 23:00. Applied before date, time, lamps.'),
  lamps: LightingView.shape.lamps.optional().describe('Per-light overrides by id.'),
  exposureEV: LightingView.shape.exposureEV.optional().describe('EV stops, -6 to 6.'),
  size: z.strictObject({ width: z.number().int().min(64).max(4096), height: z.number().int().min(64).max(4096) }).optional().describe(`Pixels. Default ${RENDER_LIMITS.defaultWidth}x${RENDER_LIMITS.defaultHeight}; long edge max ${RENDER_LIMITS.maxEdgePx}.`),
  format: z.enum(['png', 'jpeg']).default('png').describe('png (default) or jpeg.'),
  waitForModelsS: z.number().min(0).max(300).optional().describe('Seconds to wait for downloading shop models (default 40).'),
  compare: z.enum(['before_after']).optional().describe('Also return the previous render_view as a second image.'),
});
export type RenderViewArgs = z.infer<typeof RenderViewArgs>;

function inputSchema(): Record<string, unknown> {
  const raw = z.toJSONSchema(RenderViewArgs, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = raw;
  void _drop;
  return rest;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

type ServiceResult = Awaited<ReturnType<Renderer['render']>>;
type Call = Renderer['render'];

function renderCall(ctx: ToolContext): Call {
  const r: Renderer = ctx.renderer ?? sharedMcpRenderer(ctx.flat, { webUrl: ctx.config.webUrl, renderChannel: ctx.config.renderChannel, log: ctx.config.log });
  return (spec, opts) => r.render(spec, opts);
}

const rateLimited = (ctx: ToolContext): CallToolResult | undefined => {
  const t = ctx.session.renders.take();
  return t.ok ? undefined : toolError('rate_limited', `more than ${ctx.limits.rendersPerMinute} renders per minute`, `Wait ${t.retryAfterMs} ms and retry; renders are slow, so check several changes with one.`, { retryAfterMs: t.retryAfterMs });
};

const failure = (e: unknown): CallToolResult => {
  if (e instanceof RenderError) return e.result ?? toolError(e.code, e.message, e.hint);
  const code = (e as { code?: string } | null)?.code === 'render_timeout' ? 'render_timeout' : 'render_unavailable';
  return toolError(code, e instanceof Error ? e.message : String(e));
};

/** The attribution line as a text item next to the image(s), when the meta carries one. */
export const captionContent = (meta: { caption?: string | undefined }): CallToolResult['content'] => (meta.caption ? [{ type: 'text', text: meta.caption }] : []);

function assemble(r: ServiceResult): { structured: RenderViewResult; content: CallToolResult['content'] } {
  const meta = r.meta;
  const images: RenderViewResult['images'] = r.before
    ? [
        { label: 'after', rev: meta.rev },
        { label: 'before', rev: meta.compare?.beforeRev ?? meta.rev },
      ]
    : [{ label: 'image', rev: meta.rev }];
  const structured: RenderViewResult = { ok: true, ...meta, images };
  const content: CallToolResult['content'] = [{ type: 'image', data: r.image, mimeType: r.mimeType }, ...(r.before ? [{ type: 'image' as const, data: r.before.image, mimeType: r.before.mimeType }] : []), ...captionContent(meta)];
  return { structured, content };
}

function toSpec(a: RenderViewArgs): RenderSpecInput {
  const { format: _f, waitForModelsS: _w, view, ...rest } = a;
  void _f;
  void _w;
  return { ...rest, view: view === 'flat' ? 'orbit' : view } as RenderSpecInput;
}

async function renderView(ctx: ToolContext, args: Record<string, unknown>): Promise<CallToolResult> {
  const a = parseArgs(RenderViewArgs, args);
  if (!a.ok) return a.result;
  const limited = rateLimited(ctx);
  if (limited) return limited;
  try {
    const r = await renderCall(ctx)(toSpec(a.data), { format: a.data.format, session: ctx.session, ...(a.data.waitForModelsS !== undefined ? { modelWaitMs: a.data.waitForModelsS * 1000 } : {}) });
    const { structured, content } = assemble(r);
    return toolOk(structured as unknown as Record<string, unknown>, content);
  } catch (e) {
    return failure(e);
  }
}

export type RenderForWrite = { ok: true; content: CallToolResult['content']; meta: RenderViewResult } | { ok: false; result: CallToolResult };

/**
 * The `render` argument of a write tool: `spec` is `true` (the whole flat, orbit) or `render_view`
 * arguments. Without `scene` it draws the committed flat (fetched fresh, so it includes the write just
 * made). With `scene` (a preview state; nothing committed) it draws that state, and with
 * `compare: 'before_after'` the second image is the committed flat. Counts as one render for the rate limit.
 */
export async function renderForWrite(ctx: ToolContext, spec: true | Record<string, unknown>, scene?: Scene): Promise<RenderForWrite> {
  const a = parseArgs(RenderViewArgs, spec === true ? { view: 'orbit' } : spec);
  if (!a.ok) return a;
  const limited = rateLimited(ctx);
  if (limited) return { ok: false, result: limited };
  try {
    let opts: NonNullable<Parameters<Call>[1]> = { format: a.data.format, session: ctx.session, ...(a.data.waitForModelsS !== undefined ? { modelWaitMs: a.data.waitForModelsS * 1000 } : {}) };
    if (scene) {
      const sc = await fetchScene(ctx);
      if (!sc.ok) return sc;
      opts = { ...opts, scene: { epoch: sc.data.epoch, rev: sc.data.rev, scene } };
    }
    const r = await renderCall(ctx)(toSpec(a.data), opts);
    const { structured, content } = assemble(r);
    return { ok: true, content, meta: structured };
  } catch (e) {
    return { ok: false, result: failure(e) };
  }
}

// ---------------------------------------------------------------------------------------------
// render_passes (CG1)
// ---------------------------------------------------------------------------------------------

const PASS_KINDS = ['color', 'depth', 'depthVis', 'normals', 'ids', 'instances', 'edges', 'edgesItems'] as const;
const INLINE_KINDS = ['color', 'depthVis', 'normals', 'ids', 'edges'] as const;
/** Longest edge of an image returned inline (saved files may be as large as the render limits allow). */
const INLINE_MAX_EDGE = 768;
const INLINE_DEFAULT = { width: 768, height: 576 };
const MAX_INLINE_LEGEND = 60;

export const RenderPassesArgs = RenderViewArgs.pick({ view: true, roomId: true, facing: true, pose: true, size: true }).extend({
  kinds: z.array(z.enum(PASS_KINDS)).min(1).optional().describe('color depth depthVis normals ids instances edges edgesItems. Default: color depthVis normals ids edges (all with saveTo).'),
  saveTo: z.string().min(1).optional().describe('Directory under the working dir; writes files, returns paths.'),
});
export type RenderPassesArgs = z.infer<typeof RenderPassesArgs>;

function passesSchema(): Record<string, unknown> {
  const raw = z.toJSONSchema(RenderPassesArgs, { io: 'input', unrepresentable: 'any' }) as { properties: Record<string, Record<string, unknown>> } & Record<string, unknown>;
  const { $schema: _drop, ...rest } = raw;
  void _drop;
  // The camera arguments are those of render_view: spell them once there, not twice in tools/list (token budget).
  const same = { description: 'As render_view.' };
  const properties = { ...raw.properties, roomId: { type: 'string', ...same }, facing: { ...same }, pose: { type: 'object', ...same }, size: { type: 'object', ...same }, view: { type: 'string', ...same } };
  const kinds = (properties as Record<string, { items?: unknown }>)['kinds'];
  if (kinds?.items) kinds.items = { type: 'string' };
  return { ...rest, properties };
}

async function renderPassesTool(ctx: ToolContext, args: Record<string, unknown>): Promise<CallToolResult> {
  const a = parseArgs(RenderPassesArgs, args);
  if (!a.ok) return a.result;
  let dir: string | undefined;
  if (a.data.saveTo) {
    dir = resolve(process.cwd(), a.data.saveTo);
    const rel = relative(process.cwd(), dir);
    if (rel.startsWith('..') || isAbsolute(rel)) return toolError('invalid_command', 'saveTo must be inside the working directory', `Use a relative path such as ".tmp/passes/sejour". Working directory: ${process.cwd()}`);
  }
  const limited = rateLimited(ctx);
  if (limited) return limited;
  const kinds = a.data.kinds ?? (dir ? [...PASS_KINDS] : [...INLINE_KINDS]);
  const { kinds: _k, saveTo: _s, ...rest } = a.data;
  void _k;
  void _s;
  const warnings: string[] = [];
  let size = rest.size;
  if (!dir) {
    const cur = size ?? INLINE_DEFAULT;
    const long = Math.max(cur.width, cur.height);
    if (!size || long > INLINE_MAX_EDGE) {
      const k = Math.min(1, INLINE_MAX_EDGE / long);
      const capped = { width: Math.round(cur.width * k), height: Math.round(cur.height * k) };
      if (size) warnings.push(`size reduced to ${capped.width}x${capped.height} for inline images; use saveTo for larger passes`);
      size = capped;
    }
  }
  try {
    const spec = toSpec({ ...rest, ...(size ? { size } : {}), format: 'png' } as RenderViewArgs);
    const r = await renderCall(ctx)(spec, { format: 'png', session: ctx.session, passes: { kinds } });
    const p = r.passes;
    if (!p) return toolError('render_unavailable', 'this renderer does not support passes', 'Rebuild the web app (pnpm mcp:setup) so the viewer test hook has passes().');
    const meta = r.meta;
    warnings.push(...meta.warnings);
    const instances = p.legend?.instances ?? [];
    const legend = p.legend ? { classes: p.legend.classes, instances: dir ? instances : instances.slice(0, MAX_INLINE_LEGEND), unclassified: p.legend.unclassified } : undefined;
    if (!dir && instances.length > MAX_INLINE_LEGEND) warnings.push(`legend lists only ${MAX_INLINE_LEGEND} of the ${instances.length}; use saveTo for all`);
    const structured: Record<string, unknown> = { ok: true, view: meta.view, ...(meta.roomId ? { roomId: meta.roomId } : {}), rev: meta.rev, size: p.size, kinds, camera: p.camera, depth: p.depth, ...(legend ? { legend } : {}), edges: p.edges, warnings };
    if (dir) {
      await mkdir(dir, { recursive: true });
      const files: Record<string, string> = {};
      for (const [k, url] of Object.entries(p.images)) {
        const file = resolve(dir, `${k}.png`);
        await writeFile(file, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
        files[k] = file;
      }
      await writeFile(resolve(dir, 'camera.json'), JSON.stringify(p.camera, null, 1));
      await writeFile(resolve(dir, 'legend.json'), JSON.stringify({ ...p.legend, depth: p.depth, edges: p.edges }, null, 1));
      files['camera'] = resolve(dir, 'camera.json');
      files['legend'] = resolve(dir, 'legend.json');
      return toolOk({ ...structured, files }, [{ type: 'text', text: `Saved ${Object.keys(p.images).join(', ')} + camera.json + legend.json to ${dir}` }, ...captionContent(meta)]);
    }
    const content: CallToolResult['content'] = [];
    for (const [k, url] of Object.entries(p.images)) {
      content.push({ type: 'text', text: k });
      content.push({ type: 'image', data: url.slice(url.indexOf(',') + 1), mimeType: 'image/png' });
    }
    return toolOk(structured, [...content, ...captionContent(meta)]);
  } catch (e) {
    return failure(e);
  }
}

export function renderTools(): ToolDef[] {
  return [
    {
      name: 'render_view',
      title: 'Render the flat',
      description:
        'Render the flat to an image (PNG or JPEG): room overview, walk (eye level), top plan or orbit. Light: date/time, preset (day, evening, night), lamps; default: session lighting, else noon 21 June.',
      inputSchema: inputSchema(),
      annotations: { ...READ, title: 'Render the flat' },
      group: 'render',
      mutatesScene: false,
      handler: renderView,
    },
    {
      name: 'render_passes',
      description:
        'Control images of a render_view camera: clean colour, depth (16-bit mm PNG), normals, ids (class mask), instances (entity mask + legend), edges (structure only), edgesItems, camera JSON. Inline images max 768 px; saveTo: full-size files.',
      inputSchema: passesSchema(),
      annotations: READ,
      group: 'render',
      mutatesScene: false,
      handler: renderPassesTool,
    },
  ];
}
