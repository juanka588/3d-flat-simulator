/* global process */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { briefBlock, briefFor, memoryPreflight, missingRequirements, parseBrief, parseRequire, parseRoomSpec, parseViewsArg, pickBest, publishScene, referenceImagesByView, referenceTiming, renderWithRetry, requirementsFor, selectViews } from './close-gap.mjs';

describe('close-gap runner: memory, timing and render retries', () => {
  const mem = (over) => ({ memory: { availableGb: 50, swapUsedGb: 0, pressure: 'normal', ...over }, queue: { queued: 0, running: null } });

  it('memory preflight: fine, tight (warns), hopeless (refuses unless forced), unknown', () => {
    expect(memoryPreflight(mem())).toEqual({ problems: [], warnings: [] });
    const tight = memoryPreflight(mem({ availableGb: 40 }));
    expect(tight.problems).toEqual([]);
    expect(tight.warnings.join()).toMatch(/Tight memory/);
    const bad = memoryPreflight(mem({ availableGb: 15, swapUsedGb: 10.6 }));
    expect(bad.problems.join()).toMatch(/Not enough free memory.*--force-memory/);
    const forced = memoryPreflight(mem({ availableGb: 15 }), { force: true });
    expect(forced.problems).toEqual([]);
    expect(forced.warnings.join()).toMatch(/going on anyway/);
    expect(memoryPreflight(mem({ pressure: 'critical' })).problems).toHaveLength(1);
    expect(memoryPreflight(mem({ swapUsedGb: 10.6, availableGb: 46 })).warnings.join()).toMatch(/swap is in use/);
    expect(memoryPreflight({ queue: { running: 'abc' } }).warnings.join()).toMatch(/does not report its memory/);
    expect(memoryPreflight({ ...mem(), queue: { queued: 0, running: 'abc' } }).warnings.join()).toMatch(/busy with another job/);
  });

  it('times generate_reference and shouts when an image takes more than 3x the expected 90 s', () => {
    const ok = referenceTiming(JSON.stringify({ images: [{ seconds: 92, loadS: 20, stepsS: 60 }], timings: { runS: 95 } }), 100_000);
    expect(ok).toMatchObject({ images: 1, perImageS: 92, wallS: 100, loadS: 20, stepsS: 60 });
    expect(ok.message).toBeUndefined();
    const slow = referenceTiming(`${JSON.stringify({ images: [{ seconds: 600 }, { seconds: 700 }], sidecarWarnings: ['swap'] })}\nREFERENCE IMAGE`, 1_300_000);
    expect(slow.perImageS).toBe(650);
    expect(slow.message).toMatch(/650 s per image against about 90 s expected \(7\.2x\).*swap/);
    expect(referenceTiming('not json', 1)).toBeUndefined();
  });

  it('a render that times out or hits the rate limit is retried, and only a persistent failure is returned', async () => {
    const waits = [];
    const sleepFn = async (ms) => void waits.push(ms);
    const img = { content: [{ type: 'image', data: 'x' }] };
    const replies = [{ isError: true, structuredContent: { code: 'rate_limited', retryAfterMs: 2000 } }, { isError: true, structuredContent: { code: 'render_timeout' } }, img];
    const r = await renderWithRetry(async () => replies.shift(), {}, { sleepFn });
    expect(r).toBe(img);
    expect(waits).toEqual([2300, 10_000]);
    const always = { isError: true, structuredContent: { code: 'render_timeout' } };
    let calls = 0;
    const failed = await renderWithRetry(async () => (calls++, always), {}, { sleepFn, max: 3 });
    expect(failed).toBe(always);
    expect(calls).toBe(3);
    // an error that is not transient is not retried
    let n = 0;
    await renderWithRetry(async () => (n++, { isError: true, structuredContent: { code: 'unknown_room' } }), {}, { sleepFn });
    expect(n).toBe(1);
  });

  it('partial runs: reference images are found per view', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'refs-test-'));
    writeFileSync(join(dir, 'reference-0123456789abcdef.json'), JSON.stringify({ view: 'media', images: [{ file: '/x/a.png' }] }));
    writeFileSync(join(dir, 'reference-fedcba9876543210.json'), JSON.stringify({ view: 'wide', images: [{ file: '/x/b.png' }] }));
    writeFileSync(join(dir, 'visualisation-0123456789abcdef.json'), JSON.stringify({ view: 'media', images: [{ file: '/x/v.png' }] }));
    expect(referenceImagesByView(dir)).toEqual({ media: '/x/a.png', wide: '/x/b.png' });
    expect(referenceImagesByView(join(dir, 'nope'))).toEqual({});
  });
});

describe('close-gap runner helpers', () => {
  it('parses room and room:zone specs', () => {
    expect(parseRoomSpec('sdb')).toEqual({ roomId: 'sdb' });
    expect(parseRoomSpec(' sejour:kitchen ')).toEqual({ roomId: 'sejour', zone: 'kitchen' });
    expect(() => parseRoomSpec('a:b:c')).toThrow(/room or room:zone/);
    expect(() => parseRoomSpec(':x')).toThrow();
  });

  it('parses --views as a count per zone or a list of ids', () => {
    expect(parseViewsArg(undefined)).toBeUndefined();
    expect(parseViewsArg('2')).toBe(2);
    expect(parseViewsArg('media, wide')).toEqual(['media', 'wide']);
  });

  const views = [
    { id: 'media', zone: 'living' },
    { id: 'windows', zone: 'living' },
    { id: 'wide', zone: 'living' },
    { id: 'kitchen', zone: 'kitchen' },
    { id: 'kitchen-side', zone: 'kitchen' },
  ];
  it('selects the views of a zone, by count or by id, in the asked order', () => {
    expect(selectViews(views, { zone: 'kitchen' }).map((v) => v.id)).toEqual(['kitchen', 'kitchen-side']);
    expect(selectViews(views, {}).length).toBe(5);
    expect(selectViews(views, { spec: 1 }).map((v) => v.id)).toEqual(['media', 'kitchen']);
    expect(selectViews(views, { zone: 'living', spec: ['wide', 'media'] }).map((v) => v.id)).toEqual(['wide', 'media']);
    expect(() => selectViews(views, { zone: 'living', spec: ['kitchen'] })).toThrow(/no view kitchen in zone living. Views: media, windows, wide/);
  });

  it('picks the best scored iteration (earliest on a tie) and flags a worse last one', () => {
    const it = (name, overall) => ({ name, overall });
    expect(pickBest([])).toMatchObject({ best: undefined, regressed: false });
    expect(pickBest([it('a', 0.5), it('b', 0.6), it('c', 0.55)])).toMatchObject({ best: { name: 'b' }, last: { name: 'c' }, regressed: true });
    expect(pickBest([it('a', 0.5), it('b', 0.6)])).toMatchObject({ best: { name: 'b' }, regressed: false });
    expect(pickBest([it('a', 0.6), it('b', 0.6)]).best.name).toBe('a');
    expect(pickBest([it('a', null), it('b', 0.2)]).best.name).toBe('b');
  });

  it('--require: target=provider:sku, repeatable or comma separated; bad forms are refused', () => {
    expect(parseRequire(['ch1=ikea-fr:89094948', 'sejour:kitchen=ikea-fr:97531943,sdb=mock:X1'])).toEqual([
      { target: 'ch1', productId: 'ikea-fr:89094948', provider: 'ikea-fr', sku: '89094948' },
      { target: 'sejour:kitchen', productId: 'ikea-fr:97531943', provider: 'ikea-fr', sku: '97531943' },
      { target: 'sdb', productId: 'mock:X1', provider: 'mock', sku: 'X1' },
    ]);
    expect(parseRequire(undefined)).toEqual([]);
    expect(() => parseRequire(['ch1'])).toThrow(/target=productId/);
    expect(() => parseRequire(['ch1=89094948'])).toThrow(/provider:sku/);
    expect(() => parseRequire(['a:b:c=ikea-fr:1'])).toThrow(/room or room:zone/);
    const reqs = parseRequire(['sejour:kitchen=ikea-fr:97531943', 'ch1=ikea-fr:89094948', 'sejour=ikea-fr:5']);
    expect(requirementsFor(reqs, { roomId: 'sejour', zone: 'kitchen' }).map((r) => r.sku)).toEqual(['97531943', '5']);
    expect(requirementsFor(reqs, { roomId: 'sejour', zone: 'living' }).map((r) => r.sku)).toEqual(['5']);
    expect(requirementsFor(reqs, { roomId: 'ch1' }).map((r) => r.sku)).toEqual(['89094948']);
    expect(requirementsFor(reqs, { roomId: 'wc' })).toEqual([]);
  });

  it('a brief file: the text before the first heading is for everybody, a heading names the targets it is for', () => {
    const brief = parseBrief('Warm Parisian palette.\n\n## sejour:living\nOak slat TV wall.\n\n## sdb, wc\nNo window: lamps on.\n\n## sejour\nKitchen grey fronts.\n\n## all rooms\nReal products only.');
    expect(briefFor(brief, { roomId: 'sejour', zone: 'living' })).toBe('Warm Parisian palette.\n\nReal products only.\n\nOak slat TV wall.\n\nKitchen grey fronts.');
    expect(briefFor(brief, { roomId: 'sejour', zone: 'kitchen' })).toBe('Warm Parisian palette.\n\nReal products only.\n\nKitchen grey fronts.');
    expect(briefFor(brief, { roomId: 'wc' })).toBe('Warm Parisian palette.\n\nReal products only.\n\nNo window: lamps on.');
    expect(briefFor(brief, { roomId: 'ch1' })).toBe('Warm Parisian palette.\n\nReal products only.');
    expect(briefFor(undefined, { roomId: 'ch1' })).toBe('');
    expect(parseBrief('').general).toBe('');
  });

  it('the prompt block says the required products are mandatory and how to get them; nothing when there is neither', () => {
    expect(briefBlock({ brief: '', required: [] })).toBe('');
    const b = briefBlock({ brief: 'Use oak.', required: parseRequire(['ch1=ikea-fr:89094948']) });
    expect(b).toMatch(/BRIEF FROM THE LEAD/);
    expect(b).toMatch(/Use oak\./);
    expect(b).toMatch(/MANDATORY PRODUCTS/);
    expect(b).toMatch(/ikea-fr:89094948/);
    expect(b).toMatch(/get_product \{"productId":"ikea-fr:89094948"\}/);
    expect(b).toMatch(/never swap it/);
  });

  it('the final scene is checked for the mandatory products (productRef or product snapshot)', () => {
    const reqs = parseRequire(['ch1=ikea-fr:89094948', 'sejour:kitchen=ikea-fr:97531943']);
    const scene = { items: [{ id: 'a', productRef: { provider: 'ikea-fr', sku: '89094948' } }, { id: 'b', product: { provider: 'ikea-fr', sku: '111' } }] };
    expect(missingRequirements(scene, reqs).map((r) => r.productId)).toEqual(['ikea-fr:97531943']);
    expect(missingRequirements(JSON.stringify({ items: [] }), reqs)).toHaveLength(2);
    expect(missingRequirements({ items: [{ productRef: { provider: 'ikea-fr', sku: '97531943' } }] }, [])).toEqual([]);
  });

  it('publish: reads and saves the current scene of the server, then PUTs the new one', async () => {
    const seen = [];
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(req.method === 'GET' ? JSON.stringify({ epoch: 'e', rev: 3, scene: { name: 'old scene' } }) : JSON.stringify({ ok: true }));
      });
    });
    await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'publish-test-'));
    try {
      const r = await publishScene({ url: `http://127.0.0.1:${srv.address().port}/anything`, scene: '{"name":"new scene"}\n', outDir: dir });
      expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /api/scene', 'PUT /api/scene']);
      expect(seen[1].body).toBe('{"name":"new scene"}\n');
      expect(JSON.parse(readFileSync(r.backup, 'utf8'))).toEqual({ name: 'old scene' });
      expect(readdirSync(dir)).toHaveLength(1);
    } finally {
      await new Promise((ok) => srv.close(ok));
    }
  });

  it('publish: a failing PUT is an error after the backup was saved', async () => {
    const srv = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(req.method === 'GET' ? 200 : 422, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.method === 'GET' ? { scene: {} } : { ok: false }));
      });
    });
    await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'publish-test-'));
    try {
      await expect(publishScene({ url: `http://127.0.0.1:${srv.address().port}`, scene: '{}', outDir: dir })).rejects.toThrow(/HTTP 422/);
      expect(readdirSync(dir)).toHaveLength(1);
    } finally {
      await new Promise((ok) => srv.close(ok));
    }
  });
});
