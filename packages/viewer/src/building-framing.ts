import { sceneBounds3 } from '@flat/scene';
import type { Scene, SiteContext } from '@flat/scene';

/** How the default orbit camera is adjusted so that the building under the flat shows. */
export interface BuildingFraming {
  /** Camera azimuth (degrees clockwise on the plan from plan-up), looking at the facade nearest to the flat. */
  azimuthDeg: number;
  elevationDeg: number;
  /** Metres below the flat's floor that the framing includes, so the top of the lower floors is in view. */
  belowReach: number;
}

/** Facades farther than this (metres) from the flat's centre do not steer the camera. */
const MAX_FACADE_DISTANCE_M = 20;
const FRAMING_ELEVATION_DEG = 40;
/** At most this much of the building below is brought into the framing. */
const MAX_BELOW_REACH_M = 4;

function nearestOnSegment(p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): [number, number] {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2));
  return [a[0] + dx * t, a[1] + dz * t];
}

/**
 * Default orbit framing for a flat that stands in a building: the flat stays the focus, the camera
 * looks at the facade nearest to the flat (so the lower floors are in view) and the framing reaches a
 * little below the floor. Null when there is no host building below the flat, or none close enough
 * (the plain south-east framing then applies).
 */
export function buildingFraming(scene: Scene, context: SiteContext | null): BuildingFraming | null {
  if (!context || scene.site.floorElevation <= 0.5) return null;
  const below = context.buildings.filter((b) => b.host && b.base < -0.5 && b.base + b.height <= 0.1);
  if (below.length === 0) return null;
  const bounds = sceneBounds3(scene);
  const c: [number, number] = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
  // Every footprint edge near the flat contributes its length times how squarely it faces a candidate
  // camera direction (outward normal . direction to the camera), weighted down with its distance.
  const candidates = Array.from({ length: 24 }, (_, i) => i * 15);
  const score = new Array<number>(candidates.length).fill(0);
  let nearest = Infinity;
  for (const b of below) {
    const ring = b.footprint;
    let area2 = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      area2 += p[0] * q[1] - q[0] * p[1];
    }
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const e = ring[(i + 1) % ring.length]!;
      const len = Math.hypot(e[0] - a[0], e[1] - a[1]);
      if (len < 1e-6) continue;
      const near = nearestOnSegment(c, a, e);
      const d = Math.max(Math.hypot(near[0] - c[0], near[1] - c[1]), 0.5);
      nearest = Math.min(nearest, d);
      if (d > MAX_FACADE_DISTANCE_M) continue;
      // Outward normal: (dz, -dx) on a ring that runs clockwise on the plan page (positive shoelace sum with y down), else the other way.
      const sign = area2 > 0 ? 1 : -1;
      const nx = (sign * (e[1] - a[1])) / len;
      const nz = (sign * -(e[0] - a[0])) / len;
      const weight = len / (1 + d / 5);
      candidates.forEach((az, k) => {
        const r = (az * Math.PI) / 180;
        // Direction from the target towards the camera on the plan (see orbitPosition): (sin az, -cos az).
        const facing = nx * Math.sin(r) + nz * -Math.cos(r);
        if (facing > 0) score[k] = score[k]! + weight * facing;
      });
    }
  }
  if (!Number.isFinite(nearest) || nearest > MAX_FACADE_DISTANCE_M) return null;
  let best = 0;
  score.forEach((v, k) => {
    if (v > score[best]!) best = k;
  });
  if (score[best]! <= 0) return null;
  const azimuthDeg = candidates[best]!;
  return { azimuthDeg, elevationDeg: FRAMING_ELEVATION_DEG, belowReach: Math.min(scene.site.floorElevation, MAX_BELOW_REACH_M) };
}
