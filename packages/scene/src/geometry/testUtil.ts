import { parseScene } from '../parse';
import type { Scene, SceneInput } from '../schema';
import type { MeshData } from './types';

/** Test helper: builds a validated scene from a few walls and openings. */
export function makeScene(
  walls: SceneInput['walls'],
  openings: NonNullable<SceneInput['openings']> = [],
  extra: Partial<SceneInput> = {},
): Scene {
  const result = parseScene({
    version: 1,
    name: 'test',
    site: { latitude: 48.8, longitude: 2.3 },
    walls,
    openings,
    ...extra,
  });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.scene;
}

export interface Tri {
  p: [number[], number[], number[]];
  area: number;
  /** Unnormalised geometric normal direction (unit), from winding. */
  n: number[];
}

/** Triangles of the owner-table entries matching `pick`. */
export function triangles(mesh: MeshData, pick: (o: MeshData['owners'][number]) => boolean = () => true): Tri[] {
  const out: Tri[] = [];
  for (const o of mesh.owners) {
    if (!pick(o)) continue;
    for (let t = o.start; t < o.start + o.count; t++) {
      const ids = [mesh.indices[t * 3]!, mesh.indices[t * 3 + 1]!, mesh.indices[t * 3 + 2]!];
      const p = ids.map((i) => [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!]) as Tri['p'];
      const u = p[1].map((v, k) => v - p[0][k]!);
      const w = p[2].map((v, k) => v - p[0][k]!);
      const c = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
      const len = Math.hypot(...c);
      out.push({ p, area: len / 2, n: c.map((v) => v / (len || 1)) });
    }
  }
  return out;
}

export function bounds(tris: Tri[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) {
    for (const p of t.p) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, p[k]!);
        max[k] = Math.max(max[k]!, p[k]!);
      }
    }
  }
  return { min, max };
}

/**
 * For every triangle whose normal is within the cone of `normal`, the ratio du / d(position . dir)
 * along each edge that moves along `dir`. A ratio of 1 means u grows with `dir` at 1 unit per
 * metre. `dir` is the viewer's right when looking at a face with the given normal.
 */
export function uRatios(mesh: MeshData, normal: number[], dir: number[]): number[] {
  const out: number[] = [];
  const tris = triangles(mesh);
  tris.forEach((tri, t) => {
    if (tri.n[0]! * normal[0]! + tri.n[1]! * normal[1]! + tri.n[2]! * normal[2]! < 0.99) return;
    const ids = [0, 1, 2].map((k) => mesh.indices[t * 3 + k]!);
    for (let a = 0; a < 3; a++) {
      const b = (a + 1) % 3;
      const dp = [0, 1, 2].map((k) => mesh.positions[ids[b]! * 3 + k]! - mesh.positions[ids[a]! * 3 + k]!);
      const along = dp[0]! * dir[0]! + dp[1]! * dir[1]! + dp[2]! * dir[2]!;
      if (Math.abs(along) < 1e-6) continue;
      out.push((mesh.uvs[ids[b]! * 2]! - mesh.uvs[ids[a]! * 2]!) / along);
    }
  });
  return out;
}

/** Triangles drawn with `materialId` whose owner matches `pick` (an owner entry may span materials). */
export function materialTriangles(
  mesh: MeshData,
  materialId: string,
  pick: (o: MeshData['owners'][number]) => boolean = () => true,
): Tri[] {
  const all = triangles(mesh);
  const out: Tri[] = [];
  for (const g of mesh.groups) {
    if (g.materialId !== materialId) continue;
    for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) {
      const owner = mesh.owners.find((o) => o.start <= t && t < o.start + o.count)!;
      if (pick(owner)) out.push(all[t]!);
    }
  }
  return out;
}
