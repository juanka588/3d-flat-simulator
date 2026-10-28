import { describe, it } from 'vitest';
import { renderTools } from '../tools/render';
import { BrowserRenderer, DEFAULT_DIST } from './browserRenderer';
import { apply, startFlatServer, toolContext } from './harness';
import { McpRenderer } from './service';
import { startStaticServer } from './staticServer';

/**
 * Render latency on the Charme fixture at 1024x768 (software WebGL). Slow; runs with `MCP_RENDER=1`
 * and prints p50/p95 of: cold (browser start + page load + first render), warm with no change
 * (same scene rev), warm with a reload (the scene changed). Targets: cold <= 8 s, warm p50 <= 1.5 s.
 * It asserts only generous ceilings (the hard timeout), the numbers are for the record.
 */

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]!;
const fmt = (name: string, xs: number[]) => `${name.padEnd(22)} n=${String(xs.length).padStart(2)}  p50=${(pct(xs, 50) / 1000).toFixed(2)} s  p95=${(pct(xs, 95) / 1000).toFixed(2)} s  max=${(Math.max(...xs) / 1000).toFixed(2)} s`;

describe.runIf(process.env.MCP_RENDER)('render latency (Charme, 1024x768)', () => {
  it('cold, warm without change, warm with reload', async () => {
    const user = await startStaticServer(DEFAULT_DIST);
    const srv = await startFlatServer(new URL(user.url).origin);
    const tool = renderTools()[0]!;
    const time = async (ctx: ReturnType<typeof toolContext>, args: Record<string, unknown>) => {
      const t = performance.now();
      const r = await tool.handler(ctx, args);
      if (r.isError) throw new Error(JSON.stringify(r.content));
      return performance.now() - t;
    };
    try {
      const cold: number[] = [];
      // Informational numbers only: fewer samples on CI, where every software-GL render costs seconds.
      const COLD = process.env.CI ? 2 : 5;
      const WARM = process.env.CI ? 10 : 20;
      const RELOAD = process.env.CI ? 6 : 12;
      for (let i = 0; i < COLD; i++) {
        const b = new BrowserRenderer();
        const ctx = toolContext(srv.flat, { renderer: new McpRenderer(srv.flat, b) });
        cold.push(await time(ctx, { view: 'room', roomId: 'sejour' }));
        if (i === COLD - 1) {
          const warm: number[] = [];
          const views = [{ view: 'room', roomId: 'sejour' }, { view: 'walk', roomId: 'sejour', facing: 'N' }, { view: 'top' }, { view: 'orbit' }, { view: 'walk', roomId: 'ch1', preset: 'evening' }];
          for (let k = 0; k < WARM; k++) warm.push(await time(ctx, views[k % views.length]!));
          const reload: number[] = [];
          for (let k = 0; k < RELOAD; k++) {
            await apply(srv.flat, { type: 'light.update', id: 'l-ch2', patch: { lumens: 500 + k } });
            reload.push(await time(ctx, views[k % views.length]!));
          }
          console.warn(['', fmt('cold', cold), fmt('warm, no change', warm), fmt('warm, scene reload', reload)].join('\n'));
          await b.close();
          break;
        }
        await b.close();
      }
    } finally {
      await srv.stop();
      await user.close();
    }
  }, 300_000);
});
