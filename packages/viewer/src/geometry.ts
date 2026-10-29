import { BufferAttribute, BufferGeometry } from 'three';
import type { MeshData } from '@flat/scene';

interface VertexAttributes {
  position: BufferAttribute;
  normal: BufferAttribute;
  uv: BufferAttribute;
}

// One set of attribute objects per MeshData, so the shell geometry and entity highlights share GPU buffers.
const attributeCache = new WeakMap<MeshData, VertexAttributes>();

function attributesFor(mesh: MeshData): VertexAttributes {
  let attrs = attributeCache.get(mesh);
  if (!attrs) {
    attrs = {
      position: new BufferAttribute(mesh.positions, 3),
      normal: new BufferAttribute(mesh.normals, 3),
      uv: new BufferAttribute(mesh.uvs, 2),
    };
    attributeCache.set(mesh, attrs);
  }
  return attrs;
}

/** Turns renderer-agnostic `MeshData` into a three geometry; material group i gets materialIndex i. */
export function toBufferGeometry(mesh: MeshData): BufferGeometry {
  const attrs = attributesFor(mesh);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', attrs.position);
  geometry.setAttribute('normal', attrs.normal);
  geometry.setAttribute('uv', attrs.uv);
  // Per-room ambient texel (see room-ambient.ts), when the mesh has it.
  const uv1 = (mesh as MeshData & { uv1?: Float32Array }).uv1;
  if (uv1) geometry.setAttribute('uv1', new BufferAttribute(uv1, 2));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  mesh.groups.forEach((group, i) => geometry.addGroup(group.start, group.count, i));
  return geometry;
}

/** Index buffer holding only the triangles owned by `entityId` (empty when it owns none). */
export function ownerIndices(mesh: MeshData, entityId: string, zoneId?: string): Uint32Array {
  const ranges = mesh.owners.filter((o) => o.entityId === entityId && (zoneId === undefined || o.zoneId === zoneId));
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
export function entityGeometry(mesh: MeshData, entityId: string, zoneId?: string): BufferGeometry | null {
  const indices = ownerIndices(mesh, entityId, zoneId);
  if (indices.length === 0) return null;
  const attrs = attributesFor(mesh);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', attrs.position);
  geometry.setAttribute('normal', attrs.normal);
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}
