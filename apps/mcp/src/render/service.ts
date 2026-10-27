import { z } from 'zod';
import { DEFAULT_LIGHTING, RENDER_LIMITS, RenderSpec, type LightingView, type RenderSpecInput, type SceneResponse } from '@flat/scene';
import { apiFailure } from '../errors';
import type { FlatApi } from '../flatApi';
import type { McpSession, RenderMeta, Renderer } from '../tools/registry';
import { RenderError } from './errors';
import { BrowserRenderer, clampSize, sharedRenderer, type RendererOptions } from './browserRenderer';
import { effectiveSessionLighting } from '../readModel';
import { resolveLighting, resolvePose } from './resolve';

/**
 * The MCP-facing render service: implements the `Renderer` of `tools/registry.ts` on top of the warm
 * browser (`BrowserRenderer`). It resolves the spec (camera presets, lighting layers), fetches the scene
 * from the scene server unless a preview scene is given, and draws.
 *
 * Beyond the interface it understands `opts.format` (png | jpeg), `opts.session` (the MCP session whose
 * `set_sun_time` lighting sits under the call's own) and returns lamps lit, sun and warnings in `meta`. Rate limiting is the caller's job.
 */

/**
 * `RenderSpec` as the service accepts it: `facing` may also name a wall or opening of the room (the
 * camera presets resolve it), and `view` may be `flat` (an alias of `orbit`).
 */
const ServiceSpec = RenderSpec.extend({
  view: z.enum(['room', 'walk', 'top', 'orbit', 'flat']).default('room'),
  facing: z.union([z.string().min(1).max(64), z.number().min(-360).max(360)]).optional(),
});

export interface McpRenderResult {
  image: string;
  mimeType: 'image/png' | 'image/jpeg';
  meta: RenderMeta;
  before?: { image: string; mimeType: 'image/png' | 'image/jpeg' };
}

type Opts = { scene?: SceneResponse; format?: 'png' | 'jpeg'; session?: Pick<McpSession, 'lighting' | 'lampMode' | 'lastRenderedRev'> };

export class McpRenderer implements Renderer {
  private readonly lastScene = new WeakMap<object, SceneResponse>();
  private readonly defaultKey = {};

  constructor(
    private readonly flat: FlatApi,
    readonly browser: BrowserRenderer,
    private readonly defaultSession?: Pick<McpSession, 'lighting' | 'lampMode' | 'lastRenderedRev'>,
  ) {}

  async render(specInput: RenderSpecInput, opts: Opts = {}): Promise<McpRenderResult> {
    const parsed = ServiceSpec.safeParse(specInput);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('/')}: ${i.message}`).join('; ');
      throw new RenderError('invalid_command', msg);
    }
    const spec = parsed.data;
    const session = opts.session ?? this.defaultSession;
    const key = session ?? this.defaultKey;

    let current: SceneResponse;
    if (opts.scene) current = opts.scene;
    else {
      const r = await this.flat.getScene();
      if (!r.ok) {
        const result = apiFailure(r);
        throw new RenderError('server_unreachable', 'cannot read the scene', undefined, result);
      }
      current = r.data;
    }
    const preview = opts.scene !== undefined;
    const scene = current.scene;

    const warnings: string[] = [];
    const asked = spec.size ?? { width: RENDER_LIMITS.defaultWidth, height: RENDER_LIMITS.defaultHeight };
    const size = clampSize(asked);
    if (size.clamped) warnings.push(`size clamped from ${asked.width}x${asked.height} to ${size.width}x${size.height} (long edge at most ${RENDER_LIMITS.maxEdgePx})`);
    const { pose, view } = resolvePose(scene, spec, size.width / size.height);
    // The session's lighting under the call's own: date, time, sun, exposure, and the lamp mode applied to the scene's CURRENT lights.
    const base: LightingView = session ? effectiveSessionLighting(session, scene) : ({ ...DEFAULT_LIGHTING } as LightingView);
    const lighting = resolveLighting(scene, base, spec);
    for (const id of Object.keys(lighting.lamps)) if (!scene.lights.some((l) => l.id === id)) warnings.push(`unknown lamp id "${id}" ignored (lights: ${scene.lights.map((l) => l.id).join(', ')})`);

    const req = { pose, lighting, size: { width: size.width, height: size.height }, format: opts.format ?? ('png' as const) };
    const main = await this.browser.render({ ...req, scene: current, preview });
    let before: McpRenderResult['before'];
    let compare: { beforeRev: number } | undefined;
    if (spec.compare) {
      const earlier = preview ? await this.committed() : this.lastScene.get(key);
      if (!earlier) warnings.push('compare: there is no earlier render in this session, so only one image is returned; render again after changing the flat');
      else {
        if (!preview && earlier.epoch === current.epoch && earlier.rev === current.rev) warnings.push('compare: the flat has not changed since the previous render; the two images are identical');
        const b = await this.browser.render({ ...req, scene: earlier, preview: false });
        before = { image: b.data.toString('base64'), mimeType: b.mimeType };
        compare = { beforeRev: earlier.rev };
      }
    }
    if (!preview) {
      this.lastScene.set(key, current);
      if (session) session.lastRenderedRev = current.rev;
    }

    const sun = main.sun.available
      ? { available: true, isUp: main.sun.isUp!, azimuthDeg: Math.round(main.sun.azimuthDeg!), elevationDeg: Math.round(main.sun.altitudeDeg! * 10) / 10 }
      : { available: false };
    if (lighting.sunEnabled && main.sun.available && main.sun.isUp === false) {
      warnings.push('sun below horizon at this time: the flat is lit only by lamps and the sky glow');
      if (main.lampsLit.length === 0) warnings.push('no lamp is lit and the sun is down: expect a very dark image; use preset "evening" or lamps');
    }
    if (preview) warnings.push('this is a PREVIEW of an uncommitted change; the flat has not been modified');

    return {
      image: main.data.toString('base64'),
      mimeType: main.mimeType,
      meta: {
        mimeType: main.mimeType,
        width: main.width,
        height: main.height,
        epoch: current.epoch,
        rev: current.rev,
        view,
        ...(spec.roomId ? { roomId: spec.roomId } : {}),
        pose,
        lighting,
        renderMs: main.renderMs,
        warm: main.warm,
        ...(compare ? { compare } : {}),
        lampsLit: main.lampsLit,
        sun,
        warnings,
      },
      ...(before ? { before } : {}),
    };
  }

  /** The server's current scene (the "before" of a preview). */
  private async committed(): Promise<SceneResponse | undefined> {
    const r = await this.flat.getScene();
    return r.ok ? r.data : undefined;
  }

  close(): Promise<void> {
    return this.browser.close();
  }
}

const shared = new WeakMap<FlatApi, McpRenderer>();

/** The renderer used when the host did not install one: one per `FlatApi`, sharing the process's warm browser. */
export function sharedMcpRenderer(flat: FlatApi, config: RendererOptions & { renderChannel?: 'chrome' | undefined }): McpRenderer {
  let r = shared.get(flat);
  if (!r) {
    r = new McpRenderer(flat, sharedBrowser(config));
    shared.set(flat, r);
  }
  return r;
}

function sharedBrowser(config: RendererOptions & { renderChannel?: 'chrome' | undefined }): BrowserRenderer {
  return sharedRenderer({ webUrl: config.webUrl, renderChannel: config.renderChannel ?? config.channel, log: config.log });
}
