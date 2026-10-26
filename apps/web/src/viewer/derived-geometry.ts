import { ownerAt } from '@flat/scene';
import type { MeshData, ShellMeshes, SiteContext } from '@flat/scene';
import { BufferAttribute, BufferGeometry, Color } from 'three';

interface Merged {
  positions: Float32Array;
  indices: Uint32Array;
}

const mergedCache = new WeakMap<ShellMeshes, Merged>();

/**
 * Walls, fittings and ceilings merged into one single-group, position-only geometry. It is drawn
 * with an invisible material and only exists to cast shadows: shadow passes draw once per material
 * group, so the visible meshes (many groups) would make every sun and lamp shadow pass expensive,
 * and the ceilings (hidden in orbit/top) must still shut the sun out of the rooms.
 */
export function shadowCasterGeometry(shell: ShellMeshes): BufferGeometry {
  let merged = mergedCache.get(shell);
  if (!merged) {
    const parts = [shell.walls, shell.fittings, shell.ceilings].filter((m) => m.indices.length > 0);
    const vertexCount = parts.reduce((n, m) => n + m.positions.length, 0);
    const indexCount = parts.reduce((n, m) => n + m.indices.length, 0);
    const positions = new Float32Array(vertexCount);
    const indices = new Uint32Array(indexCount);
    let vAt = 0;
    let iAt = 0;
    for (const m of parts) {
      positions.set(m.positions, vAt);
      const base = vAt / 3;
      for (let i = 0; i < m.indices.length; i++) indices[iAt + i] = m.indices[i]! + base;
      vAt += m.positions.length;
      iAt += m.indices.length;
    }
    merged = { positions, indices };
    mergedCache.set(shell, merged);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(merged.positions, 3));
  geometry.setIndex(new BufferAttribute(merged.indices, 1));
  return geometry;
}

/** Neutral greys of the site context, by built-in material id. */
const CONTEXT_COLORS: Record<string, string> = {
  'builtin:context-building': '#9c9ca0',
  'builtin:context-host': '#b2b2b6',
  'builtin:ground': '#6f6f6c',
};
const GROUND = 'builtin:ground';

export interface ContextGeometries {
  /** Extruded buildings: casts and receives shadows. Null when there are none. */
  buildings: BufferGeometry | null;
  /** Ground plane: receives shadows only. Null when absent. */
  ground: BufferGeometry | null;
  /**
   * The parts of the host building at or above the flat's floor. They shade the rooms, but would
   * hide the flat from orbit and top cameras (a cut-away view), so they are drawn with an
   * invisible material (shadow only). The part below the floor stays visible.
   */
  canopy: BufferGeometry | null;
}

/** Ids of the host-building parts whose roof is above the flat's floor (y = 0). */
export function canopyIds(context: SiteContext): Set<string> {
  return new Set(context.buildings.filter((b) => b.host && b.base + b.height > 0.1).map((b) => b.id));
}

/**
 * Context MeshData split into buildings, ground and canopy, each a single-group geometry with
 * per-vertex grey colours (one draw call each, and one per shadow pass).
 */
export function contextGeometries(data: MeshData, canopy: ReadonlySet<string> = new Set()): ContextGeometries {
  const vertexCount = data.positions.length / 3;
  if (data.indices.length === 0 || vertexCount === 0) return { buildings: null, ground: null, canopy: null };
  const colors = new Float32Array(vertexCount * 3);
  const color = new Color();
  const groundIndices: number[] = [];
  const buildingIndices: number[] = [];
  const canopyIndices: number[] = [];
  for (const group of data.groups) {
    color.set(CONTEXT_COLORS[group.materialId] ?? CONTEXT_COLORS['builtin:context-building']!);
    const isGround = group.materialId === GROUND;
    for (let i = group.start; i < group.start + group.count; i += 3) {
      const owner = ownerAt(data.owners, i / 3);
      const target = isGround ? groundIndices : owner && canopy.has(owner.entityId) ? canopyIndices : buildingIndices;
      for (let k = 0; k < 3; k++) {
        const v = data.indices[i + k]!;
        colors[v * 3] = color.r;
        colors[v * 3 + 1] = color.g;
        colors[v * 3 + 2] = color.b;
        target.push(v);
      }
    }
  }
  const position = new BufferAttribute(data.positions, 3);
  const normal = new BufferAttribute(data.normals, 3);
  const colorAttr = new BufferAttribute(colors, 3);
  const build = (indices: number[]): BufferGeometry | null => {
    if (indices.length === 0) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', position);
    g.setAttribute('normal', normal);
    g.setAttribute('color', colorAttr);
    g.setIndex(new BufferAttribute(Uint32Array.from(indices), 1));
    return g;
  };
  return { buildings: build(buildingIndices), ground: build(groundIndices), canopy: build(canopyIndices) };
}
