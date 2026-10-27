import type { MaterialGroup, MeshData, Owner, OwnerKind, WallFace } from './types';

export type Vec3 = [number, number, number];

interface Tri {
  a: number;
  b: number;
  c: number;
  materialId: string;
  owner: OwnerKey;
}

interface OwnerKey {
  kind: OwnerKind;
  entityId: string;
  face?: WallFace;
  zoneId?: string;
}

/**
 * Accumulates triangles tagged with a material and an owner, then emits a `MeshData` whose
 * index buffer is sorted by material (one draw group per material) and whose owner table
 * maps every triangle back to its scene entity.
 */
export class MeshBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private uvs: number[] = [];
  private tris: Tri[] = [];

  /** Adds a vertex and returns its index. */
  vertex(position: Vec3, normal: Vec3, uv: [number, number]): number {
    this.positions.push(...position);
    this.normals.push(...normal);
    this.uvs.push(...uv);
    return this.positions.length / 3 - 1;
  }

  triangle(a: number, b: number, c: number, materialId: string, owner: OwnerKey): void {
    this.tris.push({ a, b, c, materialId, owner });
  }

  /**
   * Adds a planar quad `p0 p1 p2 p3` (counter-clockwise seen from the side `normal` points to)
   * with per-corner uvs.
   */
  quad(
    corners: [Vec3, Vec3, Vec3, Vec3],
    normal: Vec3,
    uvs: [[number, number], [number, number], [number, number], [number, number]],
    materialId: string,
    owner: OwnerKey,
  ): void {
    const [i0, i1, i2, i3] = corners.map((p, k) => this.vertex(p, normal, uvs[k]!)) as [number, number, number, number];
    this.triangle(i0, i1, i2, materialId, owner);
    this.triangle(i0, i2, i3, materialId, owner);
  }

  get triangleCount(): number {
    return this.tris.length;
  }

  build(): MeshData {
    // Sort by material, then by owner so each owner's triangles are contiguous within a group.
    const ownerKey = (o: OwnerKey) => `${o.kind}\u0000${o.entityId}\u0000${o.face ?? ''}\u0000${o.zoneId ?? ''}`;
    const sorted = [...this.tris].sort(
      (x, y) => cmp(x.materialId, y.materialId) || cmp(ownerKey(x.owner), ownerKey(y.owner)),
    );

    const indices = new Uint32Array(sorted.length * 3);
    const groups: MaterialGroup[] = [];
    const owners: Owner[] = [];
    sorted.forEach((t, i) => {
      indices.set([t.a, t.b, t.c], i * 3);
      const lastGroup = groups[groups.length - 1];
      if (lastGroup && lastGroup.materialId === t.materialId) lastGroup.count += 3;
      else groups.push({ start: i * 3, count: 3, materialId: t.materialId });

      const lastOwner = owners[owners.length - 1];
      if (
        lastOwner &&
        lastOwner.kind === t.owner.kind &&
        lastOwner.entityId === t.owner.entityId &&
        lastOwner.face === t.owner.face &&
        lastOwner.zoneId === t.owner.zoneId
      ) {
        lastOwner.count += 1;
      } else {
        owners.push({ start: i, count: 1, ...t.owner });
      }
    });

    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      indices,
      groups,
      owners,
    };
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function emptyMesh(): MeshData {
  return new MeshBuilder().build();
}

/** Finds the owner of a triangle (binary search over the sorted owner table). */
export function ownerAt(owners: readonly Owner[], triangleIndex: number): Owner | undefined {
  let lo = 0;
  let hi = owners.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const o = owners[mid]!;
    if (triangleIndex < o.start) hi = mid - 1;
    else if (triangleIndex >= o.start + o.count) lo = mid + 1;
    else return o;
  }
  return undefined;
}
