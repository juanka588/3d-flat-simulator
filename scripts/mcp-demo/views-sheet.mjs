/* global process, console, fetch, setTimeout, Buffer */
/**
 * Contact sheet of the derived camera views of every room of the Charme fixture (or `--rooms a,b`): one row per room, one tile per
 * view, captioned with the room, the view id, its field of view and what it sees. Uses the same MCP tools as the close-gap runner
 * (`describe_room {plan:true}` for the views, `render_view` for the picture), on a throw-away scene server.
 *
 *   pnpm mcp:views-sheet [--out .tmp/views-sheet] [--rooms all|wc,sdb,...] [--size 640x480] [--scene file.flat.json]
 *
 * Needs the built viewer (`pnpm mcp:setup`) or FLAT_WEB_URL. Writes <out>/views-contact-sheet.png, <out>/<room>/<view>.png and
 * <out>/views.json (poses and the visibility checks of each view).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT, connectLikeClaudeCode, startServer } from './lib.mjs';
import { contactSheetRows } from './close-gap.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const out = resolve(arg('out', join(ROOT, '.tmp/views-sheet')));
const sceneFile = resolve(arg('scene', join(ROOT, 'packages/scene/fixtures/charme-3205.flat.json')));
const [W, H] = arg('size', '640x480').split('x').map(Number);
const wanted = arg('rooms', 'all');

const textOf = (r) => (r.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
mkdirSync(out, { recursive: true });
const dataDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'flat-views-'));
const server = await startServer(dataDir, { FLAT_PROVIDERS: 'mock', FLAT_ENV_FILE: '/dev/null' });
let reader;
try {
  const put = await fetch(`${server.url}/api/scene`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: readFileSync(sceneFile, 'utf8') });
  if (!put.ok) throw new Error(`could not load the scene: ${put.status}`);
  reader = await connectLikeClaudeCode({ serverUrl: server.url, clientName: 'views-sheet', env: { IMAGE_PROVIDER: 'fake', FLAT_RENDER_WAIT_SIDECAR: '0' } });
  const call = (name, a) => reader.client.callTool({ name, arguments: a }, { timeout: 300_000 });
  const summary = await call('get_scene_summary', {});
  const rooms = (summary.structuredContent?.rooms ?? []).map((r) => r.id);
  const ids = wanted === 'all' ? rooms : wanted.split(',');
  const report = {};
  const rows = [];
  for (const roomId of ids) {
    const planRes = await call('describe_room', { roomId, plan: true });
    const views = planRes.structuredContent?.views ?? [];
    report[roomId] = views;
    const tiles = [];
    for (const v of views) {
      const pose = { mode: 'walk', position: v.eye, eyeHeight: 1.55, headingDeg: v.headingDeg, pitchDeg: 0, fovDeg: v.fovDeg };
      let r;
      for (let t = 0; t < 8; t++) {
        r = await call('render_view', { view: 'walk', roomId, pose, preset: 'day', size: { width: W, height: H }, waitForModelsS: 60 });
        if (r.structuredContent?.code !== 'rate_limited') break;
        await new Promise((ok) => setTimeout(ok, (r.structuredContent.retryAfterMs ?? 3000) + 300));
      }
      const img = (r.content ?? []).find((p) => p.type === 'image');
      const file = join(out, roomId, `${v.id}.png`);
      if (img) {
        mkdirSync(join(out, roomId), { recursive: true });
        writeFileSync(file, Buffer.from(img.data, 'base64'));
      } else console.log(`[${roomId}/${v.id}] render failed: ${textOf(r).slice(0, 200)}`);
      const seen = v.sees?.length ? ` sees ${v.sees.join(',')}` : '';
      const vis = v.checks ? ` ${v.checks.ok ? 'OK' : 'FALLBACK'}${v.checks.seen?.length ? ` [${v.checks.seen.join(',')}]` : ''}` : '';
      tiles.push({ label: `${roomId}: ${v.id}${v.hero ? ' (hero)' : ''}`, sub: `fov ${v.fovDeg}${vis || seen}`.slice(0, 48), img: img ? file : undefined });
      console.log(`${roomId}/${v.id}: eye ${v.eye} heading ${v.headingDeg} fov ${v.fovDeg}${v.checks ? ` checks ${JSON.stringify(v.checks)}` : ''}`);
    }
    if (tiles.length) rows.push({ tiles });
  }
  await contactSheetRows({ rows, file: join(out, 'views-contact-sheet.png') });
  writeFileSync(join(out, 'views.json'), JSON.stringify(report, null, 2));
  console.log(`saved ${join(out, 'views-contact-sheet.png')}`);
} finally {
  await reader?.close().catch(() => {});
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
