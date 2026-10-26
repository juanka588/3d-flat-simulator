export type V3 = [number, number, number];

export interface SunShadowFit {
  /** Light position (shadow camera origin). */
  position: V3;
  /** Point the light looks at. */
  target: V3;
  /** Camera up vector; differs from +Y only for a (near-)vertical sun. */
  up: V3;
  left: number;
  right: number;
  top: number;
  bottom: number;
  near: number;
  far: number;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * Fits an orthographic shadow frustum for a directional light. The sideways extent covers the
 * `receivers` only (a caster can only shadow what lies on the same light ray, so it projects inside
 * that area), the depth range covers `receivers` and all `casters`, so nothing between the sun and
 * the receivers is clipped. `direction` points from the scene towards the sun.
 */
export function fitSunShadow(direction: V3, receivers: readonly V3[], casters: readonly V3[], margin = 0.5): SunShadowFit | null {
  if (receivers.length === 0) return null;
  const dir = norm(direction);
  const up: V3 = Math.abs(dir[1]) > 0.999 ? [0, 0, -1] : [0, 1, 0];
  const right = norm(cross(up, dir));
  const cameraUp = cross(dir, right);

  // Origin: centre of the receivers' bounding box.
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of receivers) for (let i = 0; i < 3; i++) {
    lo[i] = Math.min(lo[i]!, p[i]!);
    hi[i] = Math.max(hi[i]!, p[i]!);
  }
  const origin: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let minD = Infinity, maxD = -Infinity;
  const rel: V3 = [0, 0, 0];
  const extend = (p: V3, sideways: boolean) => {
    rel[0] = p[0] - origin[0];
    rel[1] = p[1] - origin[1];
    rel[2] = p[2] - origin[2];
    if (sideways) {
      const x = dot(rel, right);
      const y = dot(rel, cameraUp);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const d = dot(rel, dir);
    minD = Math.min(minD, d);
    maxD = Math.max(maxD, d);
  };
  for (const p of receivers) extend(p, true);
  for (const p of casters) extend(p, false);

  const distance = maxD + margin;
  return {
    position: [origin[0] + dir[0] * distance, origin[1] + dir[1] * distance, origin[2] + dir[2] * distance],
    target: origin,
    up,
    left: minX - margin,
    right: maxX + margin,
    bottom: minY - margin,
    top: maxY + margin,
    near: 0.1,
    far: distance - minD + margin,
  };
}
