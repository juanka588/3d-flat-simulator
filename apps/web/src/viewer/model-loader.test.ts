import { describe, expect, it } from 'vitest';
import { buildGlb, sofaGlb } from './synthetic-glb';
import { parseGlb } from './model-loader';

const toBuffer = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

describe('GLB template', () => {
  it('flattens nodes to one part per material and keeps the native bounding box', async () => {
    const { value, bytes } = await parseGlb(toBuffer(sofaGlb()));
    expect(value.parts).toHaveLength(2); // fabric and legs
    expect(value.box.min[0]).toBeCloseTo(-1);
    expect(value.box.min[1]).toBeCloseTo(0);
    expect(value.box.min[2]).toBeCloseTo(-0.45);
    expect(value.box.max[0]).toBeCloseTo(1);
    expect(value.box.max[1]).toBeCloseTo(0.9);
    expect(value.triangles).toBe(6 * 12);
    expect(bytes).toBeGreaterThan(0);
    for (const p of value.parts) expect(p.geometry.getAttribute('normal')).toBeDefined();
    value.dispose();
  });

  it('rejects bytes that are not a glTF', async () => {
    await expect(parseGlb(new Uint8Array([1, 2, 3, 4]).buffer)).rejects.toBeDefined();
  });

  it('keeps a single box as one part', async () => {
    const { value } = await parseGlb(toBuffer(buildGlb([{ min: [0, 0, 0], max: [1, 2, 3] }])));
    expect(value.parts).toHaveLength(1);
    expect(value.box.max).toEqual([1, 2, 3]);
  });
});
