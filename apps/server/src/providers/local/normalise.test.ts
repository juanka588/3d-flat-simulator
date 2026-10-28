import { describe, expect, it } from 'vitest';
import { makeGlb } from './fixtures';
import { measureDocument, normaliseGlb, readGlb } from './normalise';

const near = (a: number, b: number, tol = 0.005) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('GLB normalisation at build time', () => {
  it('shrinks 2048 px textures to 1024, applies Meshopt and measures the browser memory before and after', async () => {
    const input = await makeGlb({ size: [0.77, 0.9, 1.26], textureSide: 2048, textures: 3 });
    const r = await normaliseGlb(input, { w: 0.77, d: 1.26, h: 0.9 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.before.maxTextureSide).toBe(2048);
    expect(r.after.maxTextureSide).toBeLessThanOrEqual(1024);
    // 3 textures of 2048 px vs 1024 px, RGBA with mipmaps: 4x less memory for the textures
    expect(r.before.textureBytes).toBeGreaterThan(3.5 * r.after.textureBytes);
    expect(r.after.decodedBytes).toBeLessThan(r.before.decodedBytes / 3);
    expect(r.bytes.byteLength).toBeLessThan(input.byteLength);
    expect(r.flags.join()).toMatch(/textures resized 2048 -> 1024/);
    const out = await readGlb(r.bytes);
    expect(out.getRoot().listExtensionsUsed().map((e) => e.extensionName)).toEqual(expect.arrayContaining(['EXT_meshopt_compression', 'KHR_mesh_quantization']));
    near(measureDocument(out).size[0], 0.77);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads Draco-compressed files (the shop ships glb_draco)', async () => {
    const input = await makeGlb({ size: [0.5, 0.5, 0.5], draco: true });
    const doc = await readGlb(input);
    expect(doc.getRoot().listExtensionsUsed().map((e) => e.extensionName)).toContain('KHR_draco_mesh_compression');
    const r = await normaliseGlb(input, { w: 0.5, d: 0.5, h: 0.5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.after.triangles).toBe(12);
  });

  it('bakes a quarter turn into the file when the model runs along the other axis', async () => {
    // listed 77 wide x 126 deep; the model is 126 along x and 77 along z
    const input = await makeGlb({ size: [1.26, 0.9, 0.77] });
    const r = await normaliseGlb(input, { w: 0.77, d: 1.26, h: 0.9 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.fit.quarterTurn).toBe(true);
    // the shipped file itself is now 77 along x: the viewer needs no turn
    const out = measureDocument(await readGlb(r.bytes));
    near(out.size[0], 0.77);
    near(out.size[2], 1.26);
    expect(r.flags.join()).toMatch(/quarter turn/);
  });

  it('keeps a 10-25% mismatch but flags it', async () => {
    const r = await normaliseGlb(await makeGlb({ size: [1.0, 0.9, 1.26] }), { w: 0.77, d: 1.26, h: 0.9 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.flags.join()).toMatch(/dims_mismatch \d+%/);
  });

  it('refuses a model that does not match the listed size, with the numbers', async () => {
    const r = await normaliseGlb(await makeGlb({ size: [2.4, 0.3, 0.3] }), { w: 0.77, d: 1.26, h: 0.9 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/do not match the listed size|lies on its side/);
  });

  it('refuses unreadable and empty files without throwing', async () => {
    const dims = { w: 1, d: 1, h: 1 };
    expect(await normaliseGlb(new Uint8Array([1, 2, 3]), dims)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a binary glTF/) });
    const good = await makeGlb({ size: [1, 1, 1] });
    const truncated = good.slice(0, 60);
    expect(await normaliseGlb(truncated, dims)).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot be parsed|unreadable/) });
    const header = new Uint8Array(20);
    header.set([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0x4a, 0x53, 0x4f, 0x4e]);
    expect((await normaliseGlb(header, dims)).ok).toBe(false);
  });

  it('can skip the optimisation and still check the fit', async () => {
    const input = await makeGlb({ size: [1, 1, 1], textureSide: 64 });
    const r = await normaliseGlb(input, { w: 1, d: 1, h: 1 }, { optimize: false });
    expect(r.ok).toBe(true);
  });
});
