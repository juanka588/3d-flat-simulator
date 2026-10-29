/**
 * Structural edges from geometry only: depth discontinuities and normal discontinuities, thinned and linked the way
 * Canny does (non-maximum suppression, then hysteresis). The inputs are the depth and view-space normal passes, never the
 * colour image, so textures (parquet seams, tile joints, wood grain) cannot produce an edge.
 *
 * Depth is tested on 1/depth: it is an affine function of the pixel position on any plane, so its second difference is
 * about zero on a wall or floor seen at any angle and large only at a step (silhouette) or a kink.
 */

export interface EdgeParams {
  /** Relative second difference of 1/depth above which a pixel is a depth edge. */
  depthRel: number;
  /** Angle between the normals of neighbouring pixels above which a pixel is a crease. */
  normalDeg: number;
  /** Weak edges (this fraction of the threshold or more) are kept when they touch a strong one. */
  weakFraction: number;
  /** Line width in pixels (1 = a thin line). */
  thickness: number;
}

export const DEFAULT_EDGE_PARAMS: EdgeParams = { depthRel: 0.02, normalDeg: 30, weakFraction: 0.6, thickness: 1 };

/**
 * @param depth metres per pixel, 0 where nothing was drawn
 * @param normals RGB bytes per pixel (`n * 0.5 + 0.5`), only read where depth > 0
 * @returns one byte per pixel: 255 on an edge, 0 elsewhere
 */
export function detectEdges(depth: Float32Array, normals: Uint8Array, width: number, height: number, params: Partial<EdgeParams> = {}): Uint8Array {
  const p = { ...DEFAULT_EDGE_PARAMS, ...params };
  const n = width * height;
  const inv = new Float32Array(n);
  for (let i = 0; i < n; i++) inv[i] = depth[i]! > 0 ? 1 / depth[i]! : 0;
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  const nz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!(depth[i]! > 0)) continue;
    const x = (normals[i * 3]! / 255) * 2 - 1;
    const y = (normals[i * 3 + 1]! / 255) * 2 - 1;
    const z = (normals[i * 3 + 2]! / 255) * 2 - 1;
    const len = Math.hypot(x, y, z) || 1;
    nx[i] = x / len;
    ny[i] = y / len;
    nz[i] = z / len;
  }
  const normalThreshold = 1 - Math.cos((p.normalDeg * Math.PI) / 180);

  // Strength field, 1 = exactly at a threshold.
  const s = new Float32Array(n);
  const DIRS: [number, number][] = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      let depthStrength = 0;
      for (const [dx, dy] of DIRS) {
        const a = inv[i - dy * width - dx]!;
        const b = inv[i + dy * width + dx]!;
        const c = inv[i]!;
        const scale = Math.max(a, b, c);
        if (scale > 0) depthStrength = Math.max(depthStrength, Math.abs(a + b - 2 * c) / scale);
      }
      let normalStrength = 0;
      if (depth[i]! > 0) {
        for (const j of [i - 1, i + 1, i - width, i + width]) {
          if (!(depth[j]! > 0)) continue;
          normalStrength = Math.max(normalStrength, 1 - (nx[i]! * nx[j]! + ny[i]! * ny[j]! + nz[i]! * nz[j]!));
        }
      }
      s[i] = Math.max(depthStrength / p.depthRel, normalStrength / normalThreshold);
    }
  }

  // Non-maximum suppression across the line (either axis), keeping candidates above the weak threshold.
  const weak = p.weakFraction;
  const kind = new Uint8Array(n); // 0 none, 1 weak, 2 strong
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = s[i]!;
      if (v < weak) continue;
      const maxX = v > s[i - 1]! && v >= s[i + 1]!;
      const maxY = v > s[i - width]! && v >= s[i + width]!;
      if (maxX || maxY) kind[i] = v >= 1 ? 2 : 1;
    }
  }

  // Hysteresis: weak candidates survive when 8-connected to a strong one.
  const out = new Uint8Array(n);
  const stack: number[] = [];
  for (let i = 0; i < n; i++) if (kind[i] === 2) {
    out[i] = 255;
    stack.push(i);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width;
    const y = (i - x) / width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const j = yy * width + xx;
        if (kind[j] === 1 && out[j] === 0) {
          out[j] = 255;
          stack.push(j);
        }
      }
    }
  }
  return dilate(out, width, height, Math.max(1, Math.round(p.thickness)) - 1);
}

/** Grows the lines by `radius` pixels (square structuring element). */
export function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  let cur = mask;
  for (let r = 0; r < radius; r++) {
    const next = new Uint8Array(cur.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let on = 0;
        for (let dy = -1; dy <= 1 && !on; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < width && yy < height && cur[yy * width + xx]) {
              on = 255;
              break;
            }
          }
        }
        next[y * width + x] = on;
      }
    }
    cur = next;
  }
  return cur;
}
