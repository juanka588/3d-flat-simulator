import { BufferAttribute, BufferGeometry } from 'three';
import type { MeshData } from '@flat/scene';

/** Turns renderer-agnostic `MeshData` into a three geometry; material group i gets materialIndex i. */
export function toBufferGeometry(mesh: MeshData): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(mesh.uvs, 2));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  mesh.groups.forEach((group, i) => geometry.addGroup(group.start, group.count, i));
  return geometry;
}

/** Index buffer holding only the triangles owned by `entityId` (empty when it owns none). */
export function ownerIndices(mesh: MeshData, entityId: string): Uint32Array {
  const ranges = mesh.owners.filter((o) => o.entityId === entityId);
  const total = ranges.reduce((sum, o) => sum + o.count, 0);
  const out = new Uint32Array(total * 3);
  let at = 0;
  for (const o of ranges) {
    const chunk = mesh.indices.subarray(o.start * 3, (o.start + o.count) * 3);
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Geometry sharing the mesh's vertex data but drawing only one entity's triangles; null if none. */
export function entityGeometry(mesh: MeshData, entityId: string): BufferGeometry | null {
  const indices = ownerIndices(mesh, entityId);
  if (indices.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}
