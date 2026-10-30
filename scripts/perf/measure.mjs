#!/usr/bin/env node
/* eslint-disable no-undef, no-empty, @typescript-eslint/no-unused-vars -- Node + browser-side script, not part of the app */
/**
 * Repeatable performance harness for the viewer (Playwright, Chromium).
 *
 *   node scripts/perf/measure.mjs --dist apps/web/dist --label head-charme --gl swiftshader
 *   node scripts/perf/measure.mjs --dist .tmp/perf/wt-c146e4b/apps/web/dist --label old --scene .tmp/perf/fixtures/furnished.flat.json --gl metal
 *   node scripts/perf/measure.mjs --dist apps/web/dist --label pixel8 --caps pixel8 --device "Pixel 7" --throttle 4
 *
 * Options
 *   --dist DIR        a built apps/web (served at / by a throwaway static server on a free port; never 5173/8787)
 *   --label NAME      result file .tmp/perf/results/NAME.json (and the console summary)
 *   --gl MODE         swiftshader (default) | metal (real GPU through ANGLE/Metal) | default (Chromium's choice)
 *   --scene FILE      scene JSON loaded through the test hook (default: the app's own Charme scene)
 *   --caps PRESET     phone GPU emulation (scripts/perf/gl-caps.mjs): pixel8 | mali-lowend | webgl1 | nogl
 *   --device NAME     Playwright device descriptor (e.g. "Pixel 7")
 *   --throttle N      CPU throttling rate (CDP Emulation.setCPUThrottlingRate)
 *   --query STRING    extra query string, e.g. "quality=low&gi=off"
 *   --orbit-ms N      length of the orbit and the walk recordings (default 4000)
 *   --headed          show the browser
 *
 * Recorded: time to first draw call and to the first rAF after it, time to "scene ready" (`__flat.ready`, textures, models and
 * the light-probe bake settled), JS heap, GPU memory estimate (bytes passed to texStorage/texImage/bufferData), renderer.info
 * (draw calls, triangles, geometries, textures, programs), shader compile+link time (sum of the blocking GL calls), frame
 * interval p50/p95 and main-thread busy share while orbiting and walking, long tasks, console errors, GL/shader errors.
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium, devices } from '@playwright/test';
import { installGlCaps } from './gl-caps.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1]?.startsWith('--') || args[i + 1] === undefined ? true : args[i + 1]) : fallback;
};
const dist = resolve(String(opt('dist', 'apps/web/dist')));
const label = String(opt('label', 'run'));
const glMode = String(opt('gl', 'swiftshader'));
const scenePath = opt('scene', null);
const caps = opt('caps', null);
const deviceName = opt('device', null);
const throttle = Number(opt('throttle', 1));
const query = String(opt('query', ''));
const recordMs = Number(opt('orbit-ms', 4000));
const headed = opt('headed', false) === true;
const readyTimeout = Number(opt('ready-timeout', 240000));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.webp': 'image/webp', '.png': 'image/png', '.glb': 'model/gltf-binary', '.hdr': 'application/octet-stream', '.svg': 'image/svg+xml' };
function serve(root) {
  return new Promise((ok) => {
    const server = createServer((req, res) => {
      const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
      let file = join(root, url);
      if (!file.startsWith(root)) return void res.writeHead(403).end();
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!existsSync(file)) return void res.writeHead(404).end('not found');
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port }));
  });
}

const INSTRUMENT = () => {
  const P = (window.__perf = { t0: performance.now(), firstDraw: null, firstFrame: null, draws: 0, compileMs: 0, links: 0, texBytes: 0, texCalls: 0, bufBytes: 0, rafs: [], longTasks: [], glErrors: [], capture: false, texList: [] });
  const protos = [window.WebGL2RenderingContext?.prototype].filter(Boolean);
  const wrap = (proto, name, fn) => {
    const o = proto[name];
    if (!o) return;
    proto[name] = function (...a) {
      return fn.call(this, o, a);
    };
  };
  const bpp = (internal) => {
    const gl = WebGL2RenderingContext;
    const t = {
      [gl.RGBA32F]: 16,
      [gl.RGBA16F]: 8,
      [gl.RGB32F]: 12,
      [gl.RGB16F]: 6,
      [gl.R32F]: 4,
      [gl.R16F]: 2,
      [gl.RG16F]: 4,
      [gl.RG32F]: 8,
      [gl.R8]: 1,
      [gl.RG8]: 2,
      [gl.RGB8]: 3,
      [gl.DEPTH_COMPONENT24]: 4,
      [gl.DEPTH_COMPONENT32F]: 4,
      [gl.DEPTH_COMPONENT16]: 2,
      [gl.DEPTH24_STENCIL8]: 4,
    };
    return t[internal] ?? 4;
  };
  for (const proto of protos) {
    for (const d of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      wrap(proto, d, function (o, a) {
        P.draws++;
        P.frameDraws = (P.frameDraws ?? 0) + 1;
        if (P.firstDraw === null) P.firstDraw = performance.now() - P.t0;
        return o.apply(this, a);
      });
    }
    for (const n of ['compileShader', 'linkProgram']) {
      wrap(proto, n, function (o, a) {
        const t = performance.now();
        const r = o.apply(this, a);
        P.compileMs += performance.now() - t;
        if (n === 'linkProgram') P.links++;
        return r;
      });
    }
    wrap(proto, 'getProgramParameter', function (o, a) {
      const t = performance.now();
      const r = o.apply(this, a);
      if (a[1] === this.LINK_STATUS || a[1] === 0x91b1 /* COMPLETION_STATUS_KHR is non blocking */) {
        if (a[1] === this.LINK_STATUS) P.compileMs += performance.now() - t;
      }
      return r;
    });
    wrap(proto, 'getShaderParameter', function (o, a) {
      const t = performance.now();
      const r = o.apply(this, a);
      if (a[1] === this.COMPILE_STATUS) P.compileMs += performance.now() - t;
      return r;
    });
    wrap(proto, 'texStorage2D', function (o, a) {
      const [, levels, internal, w, h] = a;
      let bytes = 0;
      for (let l = 0; l < levels; l++) bytes += Math.max(1, w >> l) * Math.max(1, h >> l) * bpp(internal);
      const faces = a[0] === this.TEXTURE_CUBE_MAP ? 6 : 1;
      P.texBytes += bytes * faces;
      P.texList.push([Math.round((bytes * faces) / 1048576 * 10) / 10, `${w}x${h} f${internal.toString(16)} L${levels}${faces > 1 ? ' cube' : ''}`]);
      P.texCalls++;
      return o.apply(this, a);
    });
    wrap(proto, 'texStorage3D', function (o, a) {
      const [, levels, internal, w, h, d] = a;
      let bytes = 0;
      for (let l = 0; l < levels; l++) bytes += Math.max(1, w >> l) * Math.max(1, h >> l) * Math.max(1, d >> l) * bpp(internal);
      P.texBytes += bytes;
      P.texCalls++;
      return o.apply(this, a);
    });
    wrap(proto, 'texImage2D', function (o, a) {
      // (target, level, internalformat, width, height, border, format, type, data) or (..., format, type, source)
      if (a.length >= 9 && typeof a[3] === 'number' && a[1] === 0) {
        P.texBytes += a[3] * a[4] * bpp(a[2]) * 1.34;
        P.texList.push([Math.round((a[3] * a[4] * bpp(a[2]) * 1.34) / 1048576 * 10) / 10, `${a[3]}x${a[4]} img2D`]);
        P.texCalls++;
      } else if (a.length === 6 && a[1] === 0) {
        const src = a[5];
        const w = src?.width ?? src?.videoWidth ?? 0;
        const h = src?.height ?? src?.videoHeight ?? 0;
        P.texBytes += w * h * 4 * 1.34;
        P.texList.push([Math.round((w * h * 4 * 1.34) / 1048576 * 10) / 10, `${w}x${h} src2D`]);
        P.texCalls++;
      }
      return o.apply(this, a);
    });
    wrap(proto, 'bufferData', function (o, a) {
      const d = a[1];
      P.bufBytes += typeof d === 'number' ? d : (d?.byteLength ?? 0);
      return o.apply(this, a);
    });
    wrap(proto, 'renderbufferStorage', function (o, a) {
      P.texBytes += a[2] * a[3] * bpp(a[1]);
      return o.apply(this, a);
    });
    wrap(proto, 'renderbufferStorageMultisample', function (o, a) {
      P.texBytes += a[3] * a[4] * bpp(a[2]) * Math.max(1, a[1]);
      return o.apply(this, a);
    });
  }
  const tick = (t) => {
    if (P.capture) P.rafs.push([t, P.frameDraws ?? 0]);
    if ((P.frameDraws ?? 0) > 0 && P.firstFrame === null) P.firstFrame = performance.now() - P.t0;
    P.frameDraws = 0;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) P.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]);
    }).observe({ entryTypes: ['longtask'] });
  } catch {}
};

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
};

async function cdpMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

/** Frame intervals (ms) of the rAF ticks that issued draw calls, and what share of the wall time the main thread was busy. */
async function recordWindow(page, cdp, name, drive) {
  await page.evaluate(() => {
    window.__perf.rafs = [];
    window.__perf.capture = true;
  });
  const m0 = await cdpMetrics(cdp);
  const t0 = Date.now();
  await drive();
  const wall = (Date.now() - t0) / 1000;
  const m1 = await cdpMetrics(cdp);
  const rafs = await page.evaluate(() => {
    window.__perf.capture = false;
    return window.__perf.rafs;
  });
  const drawn = rafs.filter((r) => r[1] > 0).map((r) => r[0]);
  const intervals = drawn.slice(1).map((t, i) => t - drawn[i]);
  const allIntervals = rafs.slice(1).map((r, i) => r[0] - rafs[i][0]);
  return {
    name,
    seconds: Math.round(wall * 10) / 10,
    drawnFrames: drawn.length,
    fps: Math.round((drawn.length / wall) * 10) / 10,
    frameMs: { p50: pct(intervals, 50), p95: pct(intervals, 95), max: pct(intervals, 100) },
    rafMs: { p50: pct(allIntervals, 50), p95: pct(allIntervals, 95) },
    mainThreadBusy: Math.round((((m1.TaskDuration ?? 0) - (m0.TaskDuration ?? 0)) / wall) * 100),
    scriptMs: Math.round(((m1.ScriptDuration ?? 0) - (m0.ScriptDuration ?? 0)) * 1000),
    layoutMs: Math.round(((m1.LayoutDuration ?? 0) - (m0.LayoutDuration ?? 0)) * 1000),
    styleMs: Math.round(((m1.RecalcStyleDuration ?? 0) - (m0.RecalcStyleDuration ?? 0)) * 1000),
  };
}

const { server, port } = await serve(dist);
const launchArgs =
  glMode === 'metal'
    ? ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', ...(process.env.PERF_UNCAPPED ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : [])]
    : glMode === 'swiftshader'
      ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
      : [];
const browser = await chromium.launch({ headless: !headed, args: launchArgs });
const device = deviceName ? devices[deviceName] : { viewport: { width: 1280, height: 800 } };
if (deviceName && !device) throw new Error(`unknown device ${deviceName}`);
const context = await browser.newContext({ ...device });
if (caps) await installGlCaps(context, String(caps));
await context.addInitScript(INSTRUMENT);
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');
if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || (m.type() === 'warning' && /THREE|WebGL|GL_|shader/i.test(m.text()))) consoleErrors.push(`${m.type()}: ${m.text().slice(0, 600)}`);
});
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 600)));

const result = { label, dist, glMode, caps, device: deviceName, throttle, query, scene: scenePath ?? 'default(charme)' };
const navStart = Date.now();
await page.goto(`http://127.0.0.1:${port}/?test${query ? `&${query}` : ''}`, { waitUntil: 'load' });
result.loadEventMs = Date.now() - navStart;
result.glRenderer = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return 'no webgl2';
  const e = gl.getExtension('WEBGL_debug_renderer_info');
  return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown';
});

async function waitReady(timeout) {
  return page.evaluate(
    (ms) =>
      Promise.race([
        (async () => {
          while (!window.__flat) await new Promise((r) => setTimeout(r, 50));
          const t = performance.now();
          await window.__flat.ready;
          return { ok: true, ms: Math.round(performance.now() - t) };
        })(),
        new Promise((r) => setTimeout(() => r({ ok: false, ms }), ms)),
      ]),
    timeout,
  );
}

const tReady0 = Date.now();
const firstReady = await waitReady(readyTimeout);
result.sceneReady = { ...firstReady, sinceNavMs: Date.now() - navStart };
if (scenePath && firstReady.ok) {
  const json = JSON.parse(readFileSync(resolve(String(scenePath)), 'utf8'));
  const t = Date.now();
  const r = await page.evaluate(async (j) => {
    try {
      const res = await window.__flat.loadScene(j);
      await window.__flat.whenRendered();
      return { ok: res.ok };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }, json);
  result.sceneLoad = { ...r, ms: Date.now() - t };
}
result.timing = await page.evaluate(() => ({ firstDrawMs: Math.round(window.__perf.firstDraw ?? -1), firstFrameMs: Math.round(window.__perf.firstFrame ?? -1) }));

const snapshot = () =>
  page.evaluate(() => {
    const P = window.__perf;
    const s = window.__flat?.stats?.();
    const probes = window.__flat?.probes?.();
    const mem = performance.memory;
    return {
      renderer: s ? { calls: s.calls, triangles: s.triangles, geometries: s.geometries, textures: s.textures, programs: s.programs, maxTextures: s.maxTextures, dpr: s.dpr, canvas: s.canvasSize, shadowCasters: s.lights?.shadowCasters, lampLights: s.lights?.lampLights, meshes: s.meshes } : null,
      probes: probes ? { mode: probes.mode, bakes: probes.bakes, lastBakeMs: probes.lastBakeMs, probes: probes.lastBakeProbes, res: probes.res, error: probes.error } : null,
      gl: { drawCallsTotal: P.draws, shaderMs: Math.round(P.compileMs), programLinks: P.links, texMB: Math.round((P.texBytes / 1048576) * 10) / 10, texCalls: P.texCalls, bufMB: Math.round((P.bufBytes / 1048576) * 10) / 10 },
      heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
      longTasks: { count: P.longTasks.length, totalMs: P.longTasks.reduce((a, t) => a + t[1], 0), maxMs: Math.max(0, ...P.longTasks.map((t) => t[1])) },
      topTextures: P.texList.sort((x, y) => y[0] - x[0]).slice(0, 14).map((t) => `${t[0]}MB ${t[1]}`),
      glcapsLog: window.__glcapsLog ?? [],
    };
  });
result.afterLoad = await snapshot();
mkdirSync('.tmp/perf/results', { recursive: true });
await page.screenshot({ path: `.tmp/perf/results/${label}-load.png` }).catch(() => undefined);
result.cdp = await cdpMetrics(cdp).then((m) => ({ jsHeapMB: Math.round(m.JSHeapUsedSize / 1048576), nodes: m.Nodes, scriptSeconds: Math.round(m.ScriptDuration * 10) / 10, taskSeconds: Math.round(m.TaskDuration * 10) / 10 }));

if (firstReady.ok) {
  const box = await page.locator('canvas').first().boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const orbit = async () => {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    const end = Date.now() + recordMs;
    let a = 0;
    while (Date.now() < end) {
      a += 0.12;
      await page.mouse.move(cx + Math.cos(a) * box.width * 0.25, cy + Math.sin(a) * box.height * 0.12);
      await page.waitForTimeout(8);
    }
    await page.mouse.up();
    await page.waitForTimeout(400);
  };
  const profile = opt('profile', false) === true;
  if (profile) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
  }
  result.orbit = await recordWindow(page, cdp, 'orbit', orbit);
  if (profile) {
    const { profile: prof } = await cdp.send('Profiler.stop');
    const self = new Map();
    const byId = new Map(prof.nodes.map((n) => [n.id, n]));
    const dt = prof.timeDeltas;
    prof.samples.forEach((id, i) => {
      const n = byId.get(id);
      const key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`;
      self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
    });
    result.profileTop = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${Math.round(v)}ms ${k}`);
  }
  // Zoom with the wheel as well: a different code path in the camera rig.
  result.wheel = await recordWindow(page, cdp, 'wheel', async () => {
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, i % 2 ? 120 : -120);
      await page.waitForTimeout(40);
    }
  });
  if (opt('edits', false) === true) {
    // Orbit while the lighting changes (a light-probe re-bake runs in the background): the interaction a user feels after every edit.
    const box2 = await page.locator('canvas').first().boundingBox();
    result.editOrbit = await recordWindow(page, cdp, 'orbit-during-edit', async () => {
      await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
      await page.mouse.down();
      const end = Date.now() + 8000;
      let a = 0;
      let edited = false;
      while (Date.now() < end) {
        a += 0.1;
        await page.mouse.move(box2.x + box2.width / 2 + Math.cos(a) * 120, box2.y + box2.height / 2 + Math.sin(a) * 40);
        if (!edited && Date.now() > end - 7000) {
          edited = true;
          await page.evaluate(() => void window.__flat.setLighting({ time: '18:30' }));
        }
        await page.waitForTimeout(8);
      }
      await page.mouse.up();
    });
    result.editOrbit.probes = await page.evaluate(() => window.__flat.probes?.().bakes ?? null);
  }
  try {
    await page.evaluate(() => window.__flat.setView({ mode: 'walk' }));
    await page.waitForTimeout(800);
    result.walk = await recordWindow(page, cdp, 'walk', async () => {
      await page.keyboard.down('KeyW');
      await page.waitForTimeout(recordMs / 2);
      await page.keyboard.down('ArrowLeft');
      await page.waitForTimeout(recordMs / 2);
      await page.keyboard.up('ArrowLeft');
      await page.keyboard.up('KeyW');
    });
  } catch (e) {
    result.walk = { error: String(e).slice(0, 200) };
  }
}
result.final = await snapshot();
result.consoleErrors = [...new Set(consoleErrors)].slice(0, 12);
result.pageErrors = [...new Set(pageErrors)].slice(0, 12);
result.shotFile = `${label}.png`;
mkdirSync('.tmp/perf/results', { recursive: true });
await page.screenshot({ path: `.tmp/perf/results/${label}.png` }).catch(() => undefined);
writeFileSync(`.tmp/perf/results/${label}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
server.close();
