import { ownerAt } from '@flat/scene';
import type { MeshData, ShellMeshes, SiteContext } from '@flat/scene';
import { BufferAttribute, BufferGeometry, Color } from 'three';

const GROUND = 'builtin:ground';

interface Merged {
  positions: Float32Array;
  indices: Uint32Array;
}

const mergedCache = new WeakMap<ShellMeshes, Merged>();

/** How far (metres) the lamp-light blockers of floors and ceilings sit beyond the surface they close. */
export const SLAB_BLOCKER_OFFSET_M = 0.02;

/**
 * A copy of a surface mesh with reversed winding, shifted by `dy` along Y. Shadow passes draw the
 * BACK faces of casters (the default `shadowSide` of a front-side material), so a floor (facing
 * up) is invisible to a lamp above it, and a ceiling (facing down) to a lamp below it. The
 * reversed copy faces away from the lamp, is drawn, and shuts the light in: without it a lamp
 * lights the ground and the roof band through the slab.
 */
function reversedSurface(m: Pick<MeshData, 'positions' | 'indices'>, dy: number): Pick<MeshData, 'positions' | 'indices'> {
  const positions = Float32Array.from(m.positions);
  for (let i = 1; i < positions.length; i += 3) positions[i] = positions[i]! + dy;
  const indices = Uint32Array.from(m.indices);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const t = indices[i + 1]!;
    indices[i + 1] = indices[i + 2]!;
    indices[i + 2] = t;
  }
  return { positions, indices };
}

/**
 * Walls, fittings and ceilings merged into one single-group, position-only geometry, plus a
 * reversed, slightly offset copy of every floor (below it) and ceiling (above it) so that lamps
 * cannot light through the slabs (see `reversedSurface`). It is drawn with an invisible material
 * and only exists to cast shadows: shadow passes draw once per material group, so the visible
 * meshes (many groups) would make every sun and lamp shadow pass expensive, and the ceilings
 * (hidden in orbit/top) must still shut the sun out of the rooms.
 */
export function shadowCasterGeometry(shell: ShellMeshes): BufferGeometry {
  let merged = mergedCache.get(shell);
  if (!merged) {
    const parts = [
      shell.walls,
      shell.fittings,
      shell.items,
      shell.ceilings,
      reversedSurface(shell.floors, -SLAB_BLOCKER_OFFSET_M),
      reversedSurface(shell.ceilings, SLAB_BLOCKER_OFFSET_M),
    ].filter((m) => m.indices.length > 0);
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

/**
 * Colours of the site context. Neighbours are neutral greys; the host building reads as a warm-grey
 * building (façade), whose lower-band top (the storey slab the flat stands on) is sand and whose
 * roof is dark slate; the ground is a green-grey, so none of them blends with another.
 */
export const CONTEXT_PALETTE = {
  neighbourWall: '#9c9ca0',
  neighbourRoof: '#85858b',
  facade: '#cbbfae',
  lowerTop: '#b8a78a',
  hostRoof: '#6b5b55',
  ground: '#7f8c6f',
} as const;

export interface ContextGeometries {
  /** Neighbouring (non-host) buildings: casts and receives shadows. Null when there are none. */
  buildings: BufferGeometry | null;
  /**
   * The host building below the flat's floor (its lower floors): the visible façade, casts and
   * receives shadows. Null when the context has no such part.
   */
  facade: BufferGeometry | null;
  /** Ground plane: receives shadows only. Null when absent. */
  ground: BufferGeometry | null;
  /**
   * The parts of the host building at or above the flat's floor (the flat's own storey around it,
   * and the storeys above). They shade the rooms, but would hide the flat from orbit and top
   * cameras, so by default they are drawn with an invisible material (shadow only), as a ghosted
   * envelope in orbit view, or solid (see ContextMesh).
   */
  canopy: BufferGeometry | null;
}

/** Ids of the host-building parts whose roof is above the flat's floor (y = 0). */
export function canopyIds(context: SiteContext): Set<string> {
  return new Set(context.buildings.filter((b) => b.host && b.base + b.height > 0.1).map((b) => b.id));
}

/** Ids of every host-building part. */
export function hostIds(context: SiteContext): Set<string> {
  return new Set(context.buildings.filter((b) => b.host).map((b) => b.id));
}

/**
 * Context MeshData split into neighbours, host façade, ground and canopy, each a single-group
 * geometry with per-vertex colours (one draw call each, and one per shadow pass). The partition
 * of triangles only decides which mesh draws them: what casts or receives a shadow is unchanged.
 */
export function contextGeometries(data: MeshData, canopy: ReadonlySet<string> = new Set(), host: ReadonlySet<string> = canopy): ContextGeometries {
  const vertexCount = data.positions.length / 3;
  if (data.indices.length === 0 || vertexCount === 0) return { buildings: null, facade: null, ground: null, canopy: null };
  const colors = new Float32Array(vertexCount * 3);
  const color = new Color();
  const groundIndices: number[] = [];
  const buildingIndices: number[] = [];
  const facadeIndices: number[] = [];
  const canopyIndices: number[] = [];
  for (const group of data.groups) {
    const isGround = group.materialId === GROUND;
    for (let i = group.start; i < group.start + group.count; i += 3) {
      const owner = ownerAt(data.owners, i / 3);
      const isHost = !isGround && !!owner && host.has(owner.entityId);
      const isCanopy = isHost && canopy.has(owner!.entityId);
      const up = data.normals[data.indices[i]! * 3 + 1]! > 0.5;
      const hex = isGround
        ? CONTEXT_PALETTE.ground
        : isHost
          ? up
            ? isCanopy
              ? CONTEXT_PALETTE.hostRoof
              : CONTEXT_PALETTE.lowerTop
            : CONTEXT_PALETTE.facade
          : up
            ? CONTEXT_PALETTE.neighbourRoof
            : CONTEXT_PALETTE.neighbourWall;
      color.set(hex);
      const target = isGround ? groundIndices : isCanopy ? canopyIndices : isHost ? facadeIndices : buildingIndices;
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
  return { buildings: build(buildingIndices), facade: build(facadeIndices), ground: build(groundIndices), canopy: build(canopyIndices) };
}

/** Height of one storey of the host building, so that the flat's floor sits on a storey line: about 3 m. */
export function storeyHeight(floorElevation: number): number {
  const n = Math.max(1, Math.round(floorElevation / 3));
  return floorElevation > 0.5 ? floorElevation / n : 3;
}

/**
 * Line segments (x1 y1 z1 x2 y2 z2 ...) of the floor lines of the host parts selected by `ids`: a
 * horizontal line along each footprint edge at every multiple of `storey` (flat floor = 0) that lies
 * strictly inside the part's height. They lie on the walls: the wall material uses a polygon offset so they win the depth test.
 */
export function floorLineSegments(context: SiteContext, ids: ReadonlySet<string>, storey: number): Float32Array {
  const out: number[] = [];
  for (const b of context.buildings) {
    if (!ids.has(b.id) || !(storey > 0.1)) continue;
    const lo = b.base + 0.15;
    const hi = b.base + b.height - 0.15;
    for (let k = Math.ceil(lo / storey); k * storey < hi; k++) {
      const y = k * storey;
      for (const loop of [b.footprint, ...(b.holes ?? [])]) {
        for (let j = 0; j < loop.length; j++) {
          const a = loop[j]!;
          const c = loop[(j + 1) % loop.length]!;
          if (Math.hypot(c[0] - a[0], c[1] - a[1]) < 1e-6) continue;
          out.push(a[0], y, a[1], c[0], y, c[1]);
        }
      }
    }
  }
  return Float32Array.from(out);
}
