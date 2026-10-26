import earcut from 'earcut';
import { MeshBuilder, emptyMesh } from '../geometry/builder';
import type { MeshData } from '../geometry/types';
import type { Vec2 } from '../schema';
import type { ContextBuilding, SiteContext } from './schema';

/** Material ids used by context meshes (the viewer maps these to its own look). */
export const CONTEXT_MATERIALS = {
  building: 'builtin:context-building',
  host: 'builtin:context-host',
  ground: 'builtin:ground',
} as const;

export interface ContextMeshOptions {
  /** Ground plane margin around the context bounds, metres. Default 50. */
  groundMargin?: number;
}

/** Bases within this distance of the lowest base count as sitting on the ground. */
const GROUND_EPS = 0.01;

function dedupe(ring: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) out.push([p[0], p[1]]);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first && last && Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1e-6) out.pop();
  return out;
}

/** Shoelace area in plan coordinates (y down): positive when the ring runs clockwise on screen. */
function planArea(ring: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Caps the outer ring (with optional hole rings) at height `y`, triangulated with earcut. */
function addCap(
  builder: MeshBuilder,
  ring: readonly Vec2[],
  holes: readonly (readonly Vec2[])[],
  y: number,
  up: boolean,
  materialId: string,
  entityId: string,
): void {
  const pts: Vec2[] = [...ring];
  const holeStarts: number[] = [];
  for (const h of holes) {
    holeStarts.push(pts.length);
    pts.push(...h);
  }
  const tris = earcut(
    pts.flatMap((p) => [p[0], p[1]]),
    holeStarts,
  );
  const normal: [number, number, number] = [0, up ? 1 : -1, 0];
  const base = pts.map((p) => builder.vertex([p[0], y, p[1]], normal, [p[0], p[1]]));
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i]!;
    let b = tris[i + 1]!;
    let c = tris[i + 2]!;
    const pa = pts[a]!;
    const pb = pts[b]!;
    const pc = pts[c]!;
    // y component of (b - a) x (c - a) in world space (plan y is world z).
    const ny = (pb[1] - pa[1]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[1] - pa[1]);
    if (ny === 0) continue;
    if (up !== ny > 0) [b, c] = [c, b];
    builder.triangle(base[a]!, base[b]!, base[c]!, materialId, { kind: 'context', entityId });
  }
}

/**
 * Extruded context buildings plus a ground plane; owners `{kind:'context', entityId}`.
 *
 * Each building is extruded from `base` to `base + height`: outward-facing walls (one quad
 * per footprint edge) and a flat roof triangulated with earcut, so concave footprints work.
 * Optional `holes` (inner rings) are cut out of the roof/underside and get inward-facing walls.
 * A building whose base is above the lowest base in the context (for example the part of
 * the host building above the flat's storey) also gets a downward-facing underside, so it
 * is closed when seen from below. Footprints sit in plan coordinates (x, y down) and are
 * mapped to world as (x, height, y), like the rest of the scene.
 *
 * The ground is one quad at the lowest base covering all footprints plus a margin, owned
 * by `entityId: 'ground'`. Materials: `builtin:context-building`, `builtin:context-host`
 * (buildings with `host: true`) and `builtin:ground`.
 *
 * The flat's own volume is NOT carved out here: the generator (`tools/site-context`) splits
 * the host building into bands (below the flat, the flat's storey minus the flat's
 * bounding rectangle, above the flat), each a normal context building with `host: true`.
 */
export function buildContextMeshes(context: SiteContext, options: ContextMeshOptions = {}): MeshData {
  const margin = options.groundMargin ?? 50;
  const builder = new MeshBuilder();
  const rings: { building: ContextBuilding; ring: Vec2[]; holes: Vec2[][] }[] = [];
  for (const building of context.buildings) {
    const ring = dedupe(building.footprint);
    if (ring.length < 3 || Math.abs(planArea(ring)) < 1e-9) continue;
    // Normalise to clockwise-on-screen (positive planArea) so the outward normal is (dy, -dx).
    if (planArea(ring) < 0) ring.reverse();
    // Holes run the opposite way (negative planArea), so the same (dz, -dx) normal points into the hole.
    const holes: Vec2[][] = [];
    for (const h of building.holes ?? []) {
      const hr = dedupe(h);
      if (hr.length < 3 || Math.abs(planArea(hr)) < 1e-9) continue;
      if (planArea(hr) > 0) hr.reverse();
      holes.push(hr);
    }
    rings.push({ building, ring, holes });
  }
  if (rings.length === 0) return emptyMesh();

  const groundY = Math.min(...rings.map((r) => r.building.base));
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;

  for (const { building, ring, holes } of rings) {
    const material = building.host ? CONTEXT_MATERIALS.host : CONTEXT_MATERIALS.building;
    const owner = { kind: 'context' as const, entityId: building.id };
    const y0 = building.base;
    const y1 = building.base + building.height;
    for (const loop of [ring, ...holes]) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i]!;
        const b = loop[(i + 1) % loop.length]!;
        if (loop === ring) {
          minX = Math.min(minX, a[0]);
          maxX = Math.max(maxX, a[0]);
          minZ = Math.min(minZ, a[1]);
          maxZ = Math.max(maxZ, a[1]);
        }
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const len = Math.hypot(dx, dz);
        if (len < 1e-9) continue;
        const normal: [number, number, number] = [dz / len, 0, -dx / len];
        builder.quad(
          [
            [a[0], y0, a[1]],
            [a[0], y1, a[1]],
            [b[0], y1, b[1]],
            [b[0], y0, b[1]],
          ],
          normal,
          [
            [0, 0],
            [0, building.height],
            [len, building.height],
            [len, 0],
          ],
          material,
          owner,
        );
      }
    }
    addCap(builder, ring, holes, y1, true, material, building.id);
    if (y0 > groundY + GROUND_EPS) addCap(builder, ring, holes, y0, false, material, building.id);
  }

  const x0 = minX - margin;
  const x1 = maxX + margin;
  const z0 = minZ - margin;
  const z1 = maxZ + margin;
  builder.quad(
    [
      [x0, groundY, z0],
      [x0, groundY, z1],
      [x1, groundY, z1],
      [x1, groundY, z0],
    ],
    [0, 1, 0],
    [
      [x0, z0],
      [x0, z1],
      [x1, z1],
      [x1, z0],
    ],
    CONTEXT_MATERIALS.ground,
    { kind: 'context', entityId: 'ground' },
  );
  return builder.build();
}
