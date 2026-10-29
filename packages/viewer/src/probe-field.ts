import { probeIndex } from './probe-grid';
import type { ProbeLayout } from './probe-grid';

/**
 * The light the baked probes give, as one number per probe column: what exposure is keyed on (eye adaptation).
 * Irradiance E (lux, luminance) of a probe is the mean over all normals, `0.886227 x` its L0 coefficient.
 */
export interface ProbeField {
  layout: ProbeLayout;
  /** Mean irradiance (lux) of the three levels per plan column `ix + iz * nx`. */
  lux: Float32Array;
  /** 1 for columns inside a habitable room (not a wall, the balcony or outdoors). */
  indoor: Uint8Array;
  /** Mean of `lux` over the indoor columns: the flat-wide interior level (0 without indoor probes). */
  mean: number;
}

/** Most the key may fall below the open-air light (the exposure rises by this to the power 0.7: about 5x). */
export const MAX_BOOST_LUX = 10;

/** Luminance of linear RGB (Rec. 709). */
const lum = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * The field from the atlas read back as `width x (height * depth)` RGBA floats (row `z * height + y`): sub-volume 0 of the
 * atlas holds `(c0.rgb, c1.r)` at slice `1 + iz` (one padding slice in front).
 */
export function fieldFromAtlas(layout: ProbeLayout, indoor: Uint8Array, atlas: Float32Array): ProbeField {
  const [nx, ny, nz] = layout.res;
  const lux = new Float32Array(nx * nz);
  const columns = new Uint8Array(nx * nz);
  let sum = 0;
  let n = 0;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      let e = 0;
      for (let iy = 0; iy < ny; iy++) {
        const at = (((1 + iz) * ny + iy) * nx + ix) * 4;
        e += 0.886227 * lum(atlas[at]!, atlas[at + 1]!, atlas[at + 2]!);
      }
      const column = ix + iz * nx;
      lux[column] = e / ny;
      columns[column] = indoor[probeIndex(layout, ix, 0, iz)]!;
      if (columns[column]) {
        sum += lux[column]!;
        n++;
      }
    }
  }
  return { layout, lux, indoor: columns, mean: n > 0 ? sum / n : 0 };
}

/** Irradiance (lux) at a plan point: bilinear over the indoor columns around it; null when the point is not indoors (or outside the grid). */
export function fieldAt(field: ProbeField, x: number, z: number): number | null {
  const { layout } = field;
  const [nx, , nz] = layout.res;
  const gx = (x - layout.min[0]) / layout.spacing[0];
  const gz = (z - layout.min[2]) / layout.spacing[2];
  if (gx < 0 || gz < 0 || gx > nx - 1 || gz > nz - 1) return null;
  const ix = Math.min(nx - 2, Math.floor(gx));
  const iz = Math.min(nz - 2, Math.floor(gz));
  const fx = gx - ix;
  const fz = gz - iz;
  let total = 0;
  let weight = 0;
  let indoorWeight = 0;
  for (const [dx, dz, w] of [[0, 0, (1 - fx) * (1 - fz)], [1, 0, fx * (1 - fz)], [0, 1, (1 - fx) * fz], [1, 1, fx * fz]] as const) {
    const column = ix + dx + (iz + dz) * nx;
    if (!field.indoor[column]) continue;
    total += field.lux[column]! * w;
    weight += w;
    indoorWeight += w;
  }
  // Mostly outside the rooms (a wall line, the balcony): not an interior point.
  return indoorWeight >= 0.5 ? total / weight : null;
}

/**
 * Illuminance (lux) the exposure is keyed on. Inside a room (walk and room views) it is the probes' level at the camera, in the
 * orbit and top views the flat-wide interior mean; lamps add their mean flux density on top (their direct light is not in the
 * probes). Never above the open-air total the exposure was keyed on before probes, never below the lamps alone, so a lamp-lit
 * evening is exposed exactly as before while a daylit interior is exposed for what it receives, as an eye or a camera adapts.
 */
export function keyLux(input: { field: ProbeField | null; camera: { x: number; z: number } | null; lampLux: number; openAirLux: number }): number {
  const { field, camera, lampLux, openAirLux } = input;
  if (!field || field.mean <= 0) return openAirLux;
  const local = camera ? fieldAt(field, camera.x, camera.z) : null;
  // Never exposed for more than the flat-wide level: a dark windowless room (bathroom) stays dark when the camera is in it.
  const probes = Math.max(local ?? 0, field.mean);
  // ...and never more than MAX_BOOST x the open-air exposure's light, so the ground outside does not burn out in the top and orbit views.
  return Math.min(openAirLux, Math.max(lampLux, probes + lampLux, openAirLux / MAX_BOOST_LUX));
}

/** One step of the adaptation of `current` to `target` exposure, in log space, `dt` seconds with time constant `tau`; instant for `tau <= 0`. */
export function adaptExposure(current: number, target: number, dt: number, tau: number): number {
  if (tau <= 0 || !(current > 0) || !(dt > 0)) return target;
  const k = 1 - Math.exp(-dt / tau);
  const next = Math.exp(Math.log(current) + (Math.log(target) - Math.log(current)) * k);
  return Math.abs(Math.log(next / target)) < 0.002 ? target : next;
}
