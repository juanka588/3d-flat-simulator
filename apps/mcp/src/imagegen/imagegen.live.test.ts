import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalSidecarProvider } from './localSidecar';

/**
 * Opt-in live test: IMAGEGEN_LIVE=1. Generates ONE 512x384 image with Qwen + canny ControlNet from a fixture edge image
 * through the real sidecar. Uses IMAGEGEN_URL when set; otherwise starts its own sidecar on a free port (IMAGEGEN_LIVE_PORT,
 * default 18790) from tools/imagegen with `uv run`, never the shared services on 8787 / 5173. The models must be in the
 * sidecar's cache (`pnpm imagegen:setup`, or IMAGEGEN_HF_HOME): nothing is downloaded.
 */
const live = process.env.IMAGEGEN_LIVE === '1';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');

describe.skipIf(!live)('live: Qwen canny at 512 px', () => {
  let child: ChildProcess | undefined;
  let url = process.env.IMAGEGEN_URL ?? '';

  beforeAll(async () => {
    if (url) return;
    const port = Number(process.env.IMAGEGEN_LIVE_PORT ?? 18790);
    url = `http://127.0.0.1:${port}`;
    child = spawn('uv', ['run', '--directory', join(repo, 'tools/imagegen'), '--extra', 'mflux', 'python', '-m', 'imagegen', 'serve', '--port', String(port)], { env: { ...process.env, IMAGEGEN_PORT: String(port) }, stdio: ['ignore', 'ignore', 'inherit'] });
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${url}/health`)).ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('sidecar did not start');
  }, 90_000);

  afterAll(() => {
    child?.kill('SIGTERM');
  });

  it('turns the fixture edges into an image', async () => {
    const p = new LocalSidecarProvider({ url, token: process.env.IMAGEGEN_TOKEN, outDir: join(repo, '.tmp/imagegen/out'), pollIntervalMs: 3000 });
    const health = await p.health();
    expect(health, health.reason).toMatchObject({ ok: true });
    const edges = readFileSync(join(here, 'fixtures/room-edges-512x384.png')).toString('base64');
    const t0 = Date.now();
    const s = await p.generate(
      {
        prompt: 'Professional interior design photograph of a bathroom, scandinavian style, white tiles, oak vanity with a basin and a mirror, a bathtub, soft daylight, photorealistic.',
        negativePrompt: 'sofa, bed, text, watermark',
        seed: 1,
        n: 1,
        width: 512,
        height: 384,
        controls: [{ type: 'canny', image: { provenance: 'pass', data: edges, mimeType: 'image/png' }, strength: 1.0 }],
      },
      { waitMs: 540_000 },
    );
    const seconds = (Date.now() - t0) / 1000;
    console.warn(`live generate: ${seconds.toFixed(0)} s wall, sidecar reports ${JSON.stringify(s.images.map((i) => ({ seconds: i.seconds, peakGb: i.peakGb })))}`);
    expect(s.error).toBeUndefined();
    expect(s.status).toBe('done');
    expect(s.images).toHaveLength(1);
    const img = s.images[0]!;
    expect(existsSync(img.path)).toBe(true);
    expect(statSync(img.path).size).toBeGreaterThan(10_000);
    expect(readFileSync(img.path).subarray(0, 4).toString('hex')).toBe('89504e47');
  }, 600_000);
});
