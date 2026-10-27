import { describe, expect, it } from 'vitest';
import { MockFlatApi } from '../testing/mockFlatApi';
import { toolContext } from './harness';
import { BrowserRenderer, BUILD_HINT } from './browserRenderer';
import { McpRenderer } from './service';
import { clampSize } from './browserRenderer';
import { nearestIds } from './resolve';
import { renderTools, renderForWrite } from '../tools/render';
import { allTools } from '../tools';

/** Fast tests of the render tool that never start a browser (and never import playwright). */

const tool = renderTools()[0]!;
const data = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, any>;

function ctxWith(distDir: string) {
  const flat = new MockFlatApi();
  const browser = new BrowserRenderer({ distDir });
  return { flat, browser, ctx: toolContext(flat, { renderer: new McpRenderer(flat, browser) }) };
}

describe('render_view without a browser', () => {
  it('is advertised with an object schema and read-only annotations', () => {
    expect(tool.inputSchema.type).toBe('object');
    expect(Object.keys(tool.inputSchema.properties as object)).toEqual(expect.arrayContaining(['view', 'roomId', 'facing', 'pose', 'date', 'time', 'preset', 'lamps', 'exposureEV', 'size', 'format', 'compare']));
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.mutatesScene).toBe(false);
    expect(allTools().filter((t) => t.name === 'render_view')).toHaveLength(1);
  });

  it('a missing dist is render_unavailable with the build hint', async () => {
    const { ctx, browser } = ctxWith('/nonexistent/flat-dist');
    const r = await tool.handler(ctx, { view: 'top' });
    expect(r.isError).toBe(true);
    expect(data(r)).toMatchObject({ code: 'render_unavailable' });
    expect(data(r).hint).toContain('BASE_PATH=/ pnpm --filter @flat/web build');
    expect(BUILD_HINT).toContain('BASE_PATH=/ pnpm --filter @flat/web build');
    expect(browser.stats.launches).toBe(0);
  });

  it('unknown_room is reported with the nearest ids before any browser work', async () => {
    const { ctx } = ctxWith('/nonexistent/flat-dist');
    const r = await tool.handler(ctx, { view: 'walk', roomId: 'sejoure' });
    expect(data(r).code).toBe('unknown_room');
    expect(data(r).hint).toContain('"sejour"');
  });

  it('validates arguments (strict) and needs roomId for room and walk', async () => {
    const { ctx } = ctxWith('/nonexistent/flat-dist');
    expect(data(await tool.handler(ctx, { view: 'room' })).code).toBe('invalid_command');
    expect(data(await tool.handler(ctx, { view: 'top', bogus: 1 })).code).toBe('invalid_command');
    expect(data(await tool.handler(ctx, { view: 'top', size: { width: 10, height: 10 } })).code).toBe('invalid_command');
    expect(data(await tool.handler(ctx, { view: 'walk', roomId: 'ch1', facing: 'not-a-wall' })).hint).toMatch(/walls \[/);
  });

  it('counts against the render rate limit', async () => {
    const { ctx } = ctxWith('/nonexistent/flat-dist');
    ctx.limits = { ...ctx.limits, rendersPerMinute: 1 };
    ctx.session.renders = new (ctx.session.renders.constructor as new (n: number, now: () => number) => typeof ctx.session.renders)(1, () => 0);
    await tool.handler(ctx, { view: 'top' });
    expect(data(await tool.handler(ctx, { view: 'top' })).code).toBe('rate_limited');
  });

  it('renderForWrite reports the same failures', async () => {
    const { ctx } = ctxWith('/nonexistent/flat-dist');
    const r = await renderForWrite(ctx, true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(data(r.result).code).toBe('render_unavailable');
  });

  it('server_unreachable surfaces when the scene cannot be read', async () => {
    const { ctx, flat } = ctxWith('/nonexistent/flat-dist');
    flat.down = true;
    expect(data(await tool.handler(ctx, { view: 'top' })).code).toBe('server_unreachable');
  });
});

describe('render lighting follows the session lamp mode', () => {
  /** A browser stand-in that records what it was asked to draw. */
  function recording() {
    const drawn: Array<{ lamps: Record<string, { on?: boolean }> }> = [];
    const browser = {
      render: async (req: { lighting: { lamps: Record<string, { on?: boolean }> } }) => {
        drawn.push(req.lighting);
        return { data: Buffer.from('x'), mimeType: 'image/png' as const, width: 64, height: 64, renderMs: 1, warm: true, sceneLoaded: true, sun: { available: false }, lampsLit: [], appliedPose: null, pixels: { stddev: 50, mean: 100, colors: 100, topShare: 0.2, pixels: 1 } };
      },
    } as unknown as BrowserRenderer;
    return { browser, drawn };
  }
  const setSun = allTools().find((t) => t.name === 'set_sun_time')!;
  const addLight = allTools().find((t) => t.name === 'light_add')!;

  it('after an evening preset (allOn) a light added later is drawn on; set_sun_time lamps "scene" follows the flat again', async () => {
    const flat = new MockFlatApi();
    const { browser, drawn } = recording();
    const ctx = toolContext(flat, { renderer: new McpRenderer(flat, browser) });
    expect((await setSun.handler(ctx, { preset: 'evening' })).isError).toBeFalsy();
    expect(ctx.session.lampMode).toBe('allOn');
    const added = await addLight.handler(ctx, { light: { type: 'point', position: [2.5, 1.8], elevation: 2.4, lumens: 800, kelvin: 2700, on: false } });
    expect(added.isError, JSON.stringify(added.content)).toBeFalsy();
    const ids = ((await flat.getScene()) as { data: { scene: { lights: { id: string }[] } } }).data.scene.lights.map((l) => l.id);

    expect((await tool.handler(ctx, { view: 'top' })).isError).toBeFalsy();
    for (const id of ids) expect(drawn[0]!.lamps[id], id).toMatchObject({ on: true });

    await setSun.handler(ctx, { lamps: 'scene' });
    expect((await tool.handler(ctx, { view: 'top' })).isError).toBeFalsy();
    expect(drawn[1]!.lamps).toEqual({});
  });
});

describe('helpers', () => {
  it('clamps the long edge to 1568 keeping the aspect', () => {
    expect(clampSize({ width: 1024, height: 768 })).toMatchObject({ width: 1024, height: 768, clamped: false });
    expect(clampSize({ width: 4000, height: 2000 })).toMatchObject({ width: 1568, height: 784, clamped: true });
    expect(clampSize({ width: 1000, height: 3136 })).toMatchObject({ width: 500, height: 1568 });
  });
  it('nearestIds ranks substrings and close spellings first', () => {
    expect(nearestIds(['sejour', 'ch1', 'ch2', 'wc'], 'sejoure')[0]).toBe('sejour');
    expect(nearestIds(['sejour', 'ch1', 'ch2', 'wc'], 'ch')).toEqual(expect.arrayContaining(['ch1', 'ch2']));
  });
});
