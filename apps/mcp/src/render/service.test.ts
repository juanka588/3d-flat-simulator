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
