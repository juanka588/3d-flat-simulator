import { describe, expect, it } from 'vitest';
import { MAX_BOOST_LUX, adaptExposure, fieldAt, fieldFromAtlas, keyLux } from './probe-field';
import type { ProbeField } from './probe-field';
import type { ProbeLayout } from './probe-grid';

const layout: ProbeLayout = { min: [0, 0.3, 0], size: [3, 2, 3], res: [4, 3, 4], spacing: [1, 1, 1] };

/** A field with `lux` at the indoor columns of a 4 x 4 plan (columns 1..2 x 1..2 indoor). */
function field(lux: number): ProbeField {
  const indoor = new Uint8Array(16);
  const values = new Float32Array(16);
  for (const ix of [1, 2]) for (const iz of [1, 2]) {
    indoor[ix + iz * 4] = 1;
    values[ix + iz * 4] = lux;
  }
  return { layout, lux: values, indoor, mean: lux };
}

describe('fieldFromAtlas', () => {
  it('reads the L0 coefficient of sub-volume 0 and means it over the levels', () => {
    const [nx, ny, nz] = layout.res;
    const atlas = new Float32Array(nx * ny * (7 * (nz + 2)) * 4);
    // Probe (1, *, 2): c0 = (1, 1, 1) at slice 1 + 2.
    for (let iy = 0; iy < ny; iy++) atlas.set([1, 1, 1, 0], (((1 + 2) * ny + iy) * nx + 1) * 4);
    const indoor = new Uint8Array(nx * ny * nz).fill(0);
    for (let iy = 0; iy < ny; iy++) indoor[1 + 2 * nx + iy * nx * nz] = 1;
    const f = fieldFromAtlas(layout, indoor, atlas);
    expect(f.lux[1 + 2 * nx]).toBeCloseTo(0.886227, 5);
    expect(f.mean).toBeCloseTo(0.886227, 5);
    expect(f.indoor[1 + 2 * nx]).toBe(1);
    expect(f.indoor[0]).toBe(0);
  });
});

describe('fieldAt', () => {
  it('interpolates inside the rooms and is null outside them', () => {
    const f = field(100);
    expect(fieldAt(f, 1.5, 1.5)).toBeCloseTo(100);
    expect(fieldAt(f, 0.2, 0.2)).toBeNull();
    expect(fieldAt(f, 9, 9)).toBeNull();
  });
});

describe('keyLux (the exposure of the opt-in adaptive mode)', () => {
  const base = { camera: { x: 1.5, z: 1.5 }, lampLux: 0, openAirLux: 18000 };
  it('keys a daylit interior on the light it receives, not on the open air', () => {
    expect(keyLux({ ...base, field: field(2500) })).toBeCloseTo(2500);
  });
  it('never exposes more than MAX_BOOST_LUX below the open-air light, never darker than the open air', () => {
    expect(keyLux({ ...base, field: field(10) })).toBeCloseTo(18000 / MAX_BOOST_LUX);
    expect(keyLux({ ...base, field: field(1e6) })).toBe(18000);
  });
  it('leaves a lamp-lit evening exposed exactly as before (the key is the open-air total, which is the lamps)', () => {
    expect(keyLux({ field: field(40), camera: base.camera, lampLux: 80, openAirLux: 80 })).toBe(80);
  });
  it('without a field it is the open-air light', () => {
    expect(keyLux({ ...base, field: null })).toBe(18000);
  });
});

describe('adaptExposure', () => {
  it('is immediate without a time constant and eases in log space otherwise', () => {
    expect(adaptExposure(1, 4, 0.016, 0)).toBe(4);
    const step = adaptExposure(1, 4, 0.1, 0.35);
    expect(step).toBeGreaterThan(1);
    expect(step).toBeLessThan(4);
    expect(adaptExposure(1, 4, 100, 0.35)).toBe(4);
  });
});
