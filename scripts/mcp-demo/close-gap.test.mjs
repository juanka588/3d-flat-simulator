/* global process */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRoomSpec, parseViewsArg, pickBest, publishScene, selectViews } from './close-gap.mjs';

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
