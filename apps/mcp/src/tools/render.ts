import { CameraPose, LightingView, PresetName, RENDER_LIMITS, type RenderSpecInput, type Scene } from '@flat/scene';
import type { CallToolResult } from '@modelcontextprotocol/server';
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
  view: z.enum(['room', 'walk', 'top', 'orbit', 'flat']).default('room').describe('room: overview of roomId from above; walk: eye level standing in roomId; top: plan view of the flat (or roomId); orbit or flat: the whole flat (or roomId) from 45 degrees.'),
  roomId: z.string().min(1).max(64).optional().describe('Required for room and walk. For top and orbit it frames just that room. See list_rooms.'),
  facing: z.union([z.string().min(1).max(64), z.number().min(-360).max(360)]).optional().describe('walk only: a compass point N NE E SE S SW W NW (true north), degrees clockwise from plan-up, or the id of a wall or opening of that room to look at (e.g. "door-balcony-sejour"). Default: the room centre.'),
  pose: CameraPose.optional().describe('Advanced: an explicit camera; replaces view/roomId/facing for placement.'),
  date: LightingView.shape.date.optional().describe('Local date YYYY-MM-DD at the flat. Default: the session date (set_sun_time), else 2026-06-21.'),
  time: LightingView.shape.time.optional().describe('Local time HH:mm at the flat.'),
  preset: PresetName.optional().describe('day: 12:00 sun, lamps off. evening: 20:00 on 21 Dec, lamps on. night: 23:00 no sun, lamps on. Applied before date, time and lamps.'),
  lamps: LightingView.shape.lamps.optional().describe('Per-lamp overrides keyed by light id, e.g. {"l-sejour":{"on":true,"kelvin":2700}}.'),
  exposureEV: LightingView.shape.exposureEV.optional().describe('Exposure compensation in EV stops, -6 to 6.'),
  size: z.strictObject({ width: z.number().int().min(64).max(4096), height: z.number().int().min(64).max(4096) }).optional().describe(`Pixels. Default ${RENDER_LIMITS.defaultWidth}x${RENDER_LIMITS.defaultHeight}; the long edge is clamped to ${RENDER_LIMITS.maxEdgePx}.`),
  format: z.enum(['png', 'jpeg']).default('png').describe('png (lossless, default) or jpeg (quality 80, smaller).'),
  compare: z.enum(['before_after']).optional().describe('Also return the flat as it was at the previous render_view of this session, as a second image (same camera and lighting).'),
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
  const { format: _f, view, ...rest } = a;
  void _f;
  return { ...rest, view: view === 'flat' ? 'orbit' : view } as RenderSpecInput;
}

async function renderView(ctx: ToolContext, args: Record<string, unknown>): Promise<CallToolResult> {
  const a = parseArgs(RenderViewArgs, args);
  if (!a.ok) return a.result;
  const limited = rateLimited(ctx);
  if (limited) return limited;
  try {
    const r = await renderCall(ctx)(toSpec(a.data), { format: a.data.format, session: ctx.session });
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
    let opts: NonNullable<Parameters<Call>[1]> = { format: a.data.format, session: ctx.session };
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

export function renderTools(): ToolDef[] {
  return [
    {
      name: 'render_view',
      title: 'Render the flat',
      description:
        'Render the flat to an image (PNG, or JPEG) to see a change or answer a question about the light: view "room" (overview of one room), "walk" (standing in a room at eye level, optionally facing a compass point, wall or opening), "top" (plan) or "orbit" (the whole flat from above). Choose the time of day with date/time or preset (day, evening, night) and lamps; defaults to the session lighting (set_sun_time), else noon on 21 June. compare: "before_after" adds the previous render of this session as a second image. Takes a few seconds; the first call starts a browser.',
      inputSchema: inputSchema(),
      annotations: { ...READ, title: 'Render the flat' },
      group: 'render',
      mutatesScene: false,
      handler: renderView,
    },
  ];
}
