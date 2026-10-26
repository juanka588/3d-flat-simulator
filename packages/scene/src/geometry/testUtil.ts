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
