import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { FakeImageProvider, setImageProvider } from './imagegen';
import { connect, json } from './testing/inproc';

/** CG1: the `render_passes` tool over a fake renderer (the real one is exercised in render/render.test.ts with MCP_RENDER=1). */

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHlGPSwAAAABJRU5ErkJggg==';
const url = `data:image/png;base64,${PNG_B64}`;
const instances = Array.from({ length: 80 }, (_, i) => ({ color: [i, 0, 0], hex: '#000000', class: 'item', kind: 'item', id: `i${i}`, pixels: 5 }));

function fake(calls: { spec: unknown; opts: { passes?: { kinds?: string[] } } }[]) {
  return {
    async render(spec: unknown, opts: { passes?: { kinds?: string[] } }) {
      calls.push({ spec, opts });
      const kinds = opts.passes?.kinds ?? [];
      return {
        image: PNG_B64,
        mimeType: 'image/png' as const,
        meta: { rev: 3, view: 'room', roomId: 'sejour', warnings: [], width: 768, height: 576 } as never,
        passes: {
          size: { width: 768, height: 576 },
          images: Object.fromEntries(kinds.map((k) => [k, url])),
          camera: { type: 'perspective', fovDeg: 60 },
          depth: { encoding: 'png16-gray', unitM: 0.001 },
          legend: { classes: [{ class: 'wall' }], instances, unclassified: [] },
          edges: { source: 'depth and normals' },
          ms: 5,
        },
      };
    },
  };
}

describe('render_passes', () => {
  const dir = mkdtempSync(join(process.cwd(), '.tmp-passes-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('takes the camera arguments of render_view, returns capped images with the legend and camera', async () => {
    const calls: Parameters<typeof fake>[0] = [];
    const { client } = await connect({}, undefined, { renderer: fake(calls) as never });
    const r = await client.callTool({ name: 'render_passes', arguments: { view: 'walk', roomId: 'sejour', facing: 'N', size: { width: 2000, height: 1000 } } });
    expect(r.isError).toBeFalsy();
    expect(calls[0]!.spec).toMatchObject({ view: 'walk', roomId: 'sejour', facing: 'N', size: { width: 768, height: 384 } });
    expect(calls[0]!.opts.passes!.kinds).toEqual(['color', 'depthVis', 'normals', 'ids', 'edges']);
    const content = r.content as { type: string }[];
    expect(content.filter((c) => c.type === 'image')).toHaveLength(5);
    const out = json(r);
    expect(out).toMatchObject({ ok: true, camera: { type: 'perspective' }, depth: { unitM: 0.001 } });
    expect(out.legend.instances).toHaveLength(60);
    expect(out.warnings.join(' ')).toMatch(/size reduced/);
  });

  it('saveTo writes the files and returns paths instead of images', async () => {
    const calls: Parameters<typeof fake>[0] = [];
    const { client } = await connect({}, undefined, { renderer: fake(calls) as never });
    const rel = dir.slice(process.cwd().length + 1);
    const r = await client.callTool({ name: 'render_passes', arguments: { roomId: 'sejour', kinds: ['depth', 'ids'], saveTo: rel } });
    expect(r.isError).toBeFalsy();
    expect((r.content as { type: string }[]).some((c) => c.type === 'image')).toBe(false);
    const out = json(r);
    expect(out.files.depth).toBe(join(dir, 'depth.png'));
    expect(existsSync(out.files.ids)).toBe(true);
    expect(readFileSync(out.files.depth).subarray(1, 4).toString()).toBe('PNG');
    expect(JSON.parse(readFileSync(out.files.camera, 'utf8'))).toMatchObject({ type: 'perspective' });
    expect(JSON.parse(readFileSync(out.files.legend, 'utf8')).instances).toHaveLength(80);
    expect(calls[0]!.opts.passes!.kinds).toEqual(['depth', 'ids']);
  });

  it('refuses a saveTo outside the working directory and unknown kinds', async () => {
    const { client } = await connect({}, undefined, { renderer: fake([]) as never });
    expect(json(await client.callTool({ name: 'render_passes', arguments: { saveTo: '../elsewhere' } })).code).toBe('invalid_command');
    expect(json(await client.callTool({ name: 'render_passes', arguments: { kinds: ['sepia'] } })).code).toBe('invalid_command');
  });
});

describe('generate_reference gets its control images from the render passes', () => {
  afterEach(() => setImageProvider(undefined));

  it('reference mode sends the structural edges of the room camera as the canny control', async () => {
    const calls: Parameters<typeof fake>[0] = [];
    const provider = new FakeImageProvider();
    setImageProvider(provider);
    const { client } = await connect({}, undefined, { renderer: fake(calls) as never });
    const r = await client.callTool({ name: 'generate_reference', arguments: { roomId: 'sdb', styleId: 'japandi', seed: 3 } });
    expect(r.isError, JSON.stringify(r.content[0])).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.spec).toMatchObject({ view: 'walk', roomId: 'sdb', size: { width: 1024, height: 768 } });
    expect(calls[0]!.opts.passes!.kinds).toEqual(['edges', 'depthVis', 'ids']);
    expect(provider.generated).toHaveLength(1);
    const control = provider.generated[0]!.controls[0]!;
    expect(control).toMatchObject({ type: 'canny', strength: 1, image: { provenance: 'pass', mimeType: 'image/png', data: PNG_B64 } });
  });

  it('says so when the renderer cannot draw passes', async () => {
    setImageProvider(new FakeImageProvider());
    const noPasses = { async render() { return { image: PNG_B64, mimeType: 'image/png' as const, meta: { warnings: [] } as never }; } };
    const { client } = await connect({}, undefined, { renderer: noPasses as never });
    const r = await client.callTool({ name: 'generate_reference', arguments: { roomId: 'sdb', styleId: 'japandi' } });
    expect(r.isError).toBe(true);
    expect(json(r).code).toBe('not_implemented');
  });
});
