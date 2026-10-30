import { ownerAt, wallExposure, wallLeftNormal, wallLength, wallSideRooms } from '@flat/scene';
import type { MeshData, Scene, ShellMeshes, SiteContext } from '@flat/scene';
import { BufferAttribute, BufferGeometry, Color } from 'three';
import type { Object3D } from 'three';

const GROUND = 'builtin:ground';

interface Merged {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Item materials that are see-through glass: they cast no shadow (the bath screen would otherwise darken the tub like a wall). */
const NO_SHADOW_MATERIALS: ReadonlySet<string> = new Set(['builtin:furniture-glass-clear']);

/** The triangles of `m` that do not use a no-shadow material (the mesh itself when it has none). */
function castingPart(m: MeshData): Pick<MeshData, 'positions' | 'indices'> {
  if (!m.groups.some((g) => NO_SHADOW_MATERIALS.has(g.materialId))) return m;
  const kept: number[] = [];
  for (const g of m.groups) {
    if (NO_SHADOW_MATERIALS.has(g.materialId)) continue;
    for (let i = g.start; i < g.start + g.count; i++) kept.push(m.indices[i]!);
  }
  return { positions: m.positions, indices: Uint32Array.from(kept) };
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
      castingPart(shell.items),
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

/** How far (metres) the ceilings of the closed casters are lifted: more than the sun's depth bias seen along a ray at low elevation, so the top of every wall under the roof is in shadow. */
export const CEILING_CASTER_LIFT_M = 0.02;

/** How far (metres) the walls of the closed casters are swollen: less than the depth bias of the sun (15 mm) and of the lamps (20 mm), so the lit faces of a wall still count as lit, more than the float noise of two walls meeting. */
export const CLOSED_CASTER_SWELL_M = 0.004;

/**
 * The walls and ceilings once more, as closed solids for every shadow: drawn from BOTH sides (the mesh is shadowed with `DoubleSide`),
 * the walls swollen by `CLOSED_CASTER_SWELL_M` and the ceilings lifted by `CEILING_CASTER_LIFT_M`. A shadow pass draws back faces and rasterizes every mesh on its own, which left two kinds of hairline of
 * direct sun in a closed room: (1) a ray that goes through a wall before it reaches the surface beside it stored the wall's own exit
 * face, just in front of that surface and inside the depth bias; (2) where two walls (or a wall and the ceiling) meet flush, their
 * edges are rasterized separately and a 1 px crack between them lets the sun slide through along the joint. With the entry faces
 * drawn and every solid overlapping its neighbours by a few mm, nothing lets light in along a joint. The lit faces of the walls
 * stay lit: they sit a few mm behind the swollen entry face, well inside the biases (see `sunShadowBias`, `LAMP_SHADOW_BIAS_M`).
 *
 * Swelling moves every vertex along the area-weighted mean of the normals of the faces that share its position (welded to 0.1 mm),
 * so a box stays closed.
 */
export function closedCasterGeometry(shell: Pick<ShellMeshes, 'walls' | 'ceilings'>, extra: BufferGeometry | null = null, swell = CLOSED_CASTER_SWELL_M, lift = CEILING_CASTER_LIFT_M): BufferGeometry {
  const parts = [shell.walls, shell.ceilings].filter((m) => m.indices.length > 0);
  const wallVertices = shell.walls.indices.length > 0 ? shell.walls.positions.length / 3 : 0;
  const vertexCount = parts.reduce((n, m) => n + m.positions.length / 3, 0);
  const positions = new Float32Array(vertexCount * 3);
  const sums = new Map<string, [number, number, number]>();
  const keys: string[] = [];
  let at = 0;
  for (const m of parts) {
    const n = m.positions.length / 3;
    for (let v = 0; v < n; v++) {
      const x = m.positions[v * 3]!;
      const y = m.positions[v * 3 + 1]!;
      const z = m.positions[v * 3 + 2]!;
      positions[(at + v) * 3] = x;
      positions[(at + v) * 3 + 1] = y;
      positions[(at + v) * 3 + 2] = z;
      keys.push(`${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`);
    }
    // Each triangle adds its area-weighted face normal (the cross product) to the vertices it uses.
    for (let t = 0; t + 2 < m.indices.length; t += 3) {
      const [a, b, c] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
      const ux = m.positions[b * 3]! - m.positions[a * 3]!;
      const uy = m.positions[b * 3 + 1]! - m.positions[a * 3 + 1]!;
      const uz = m.positions[b * 3 + 2]! - m.positions[a * 3 + 2]!;
      const vx = m.positions[c * 3]! - m.positions[a * 3]!;
      const vy = m.positions[c * 3 + 1]! - m.positions[a * 3 + 1]!;
      const vz = m.positions[c * 3 + 2]! - m.positions[a * 3 + 2]!;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (const i of [a, b, c]) {
        const key = keys[at + i]!;
        const sum = sums.get(key) ?? [0, 0, 0];
        sum[0] += nx;
        sum[1] += ny;
        sum[2] += nz;
        sums.set(key, sum);
      }
    }
    at += n;
  }
  // The ceilings are lifted, not swollen: a wall's top few mm sit under the roof, and a caster that close in front of them (inside the depth bias) would leave them lit.
  for (let v = wallVertices; v < vertexCount; v++) positions[v * 3 + 1] = positions[v * 3 + 1]! + lift;
  for (let v = 0; v < wallVertices; v++) {
    const sum = sums.get(keys[v]!);
    if (!sum) continue;
    const len = Math.hypot(sum[0], sum[1], sum[2]);
    if (!(len > 1e-12)) continue;
    positions[v * 3] = positions[v * 3]! + (sum[0] / len) * swell;
    positions[v * 3 + 1] = positions[v * 3 + 1]! + (sum[1] / len) * swell;
    positions[v * 3 + 2] = positions[v * 3 + 2]! + (sum[2] / len) * swell;
  }
  const indexCount = parts.reduce((n, m) => n + m.indices.length, 0);
  const indices = new Uint32Array(indexCount);
  let iAt = 0;
  let base = 0;
  for (const m of parts) {
    for (let i = 0; i < m.indices.length; i++) indices[iAt + i] = m.indices[i]! + base;
    iAt += m.indices.length;
    base += m.positions.length / 3;
  }
  // `extra` (the recess behind the front door) joins as it is, so the sun's pass costs one draw call for all of it.
  const ePos = extra ? (extra.getAttribute('position').array as Float32Array) : new Float32Array(0);
  const eIdx = extra?.getIndex();
  const allPositions = new Float32Array(positions.length + ePos.length);
  allPositions.set(positions);
  allPositions.set(ePos, positions.length);
  const allIndices = new Uint32Array(indices.length + (eIdx?.count ?? 0));
  allIndices.set(indices);
  for (let i = 0; i < (eIdx?.count ?? 0); i++) allIndices[indices.length + i] = eIdx!.getX(i) + positions.length / 3;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(allPositions, 3));
  geometry.setIndex(new BufferAttribute(allIndices, 1));
  return geometry;
}

/**
 * Makes a caster mesh draw in the sun's shadow pass only (the sun is the one orthographic shadow camera). The lamps' passes get an
 * empty draw range: no draw call, and their shadows keep the back faces of the plain casters, which keep lit walls lit.
 */
export function sunShadowOnly(mesh: Object3D | null): void {
  if (!mesh) return;
  mesh.onBeforeShadow = (_renderer, _scene, _camera, shadowCamera, geometry) => {
    geometry.setDrawRange(0, (shadowCamera as { isOrthographicCamera?: boolean }).isOrthographicCamera ? Infinity : 0);
  };
}

/** Depth (metres) of the dark recess behind an opening in a party wall: deeper than a door leaf is wide, so an open leaf stays inside. */
export const PARTY_RECESS_DEPTH_M = 1.2;

/**
 * Ids of the walls whose openings lead to the landing, the stairwell or a neighbour instead of the open air (`wallExposure`).
 */
export function partyWallIds(scene: Pick<Scene, 'walls' | 'rooms' | 'openings' | 'materials'>): Set<string> {
  const exposure = wallExposure(scene as Scene);
  return new Set(Object.entries(exposure).filter(([, e]) => e === 'party').map(([id]) => id));
}

/**
 * What lies behind a door in a party wall (the flat's front door): a closed recess, dark inside, instead of the sky and the ground
 * the model would show there. Without it the sun and the sky come through the front door as through an open window, and the hall
 * is lit by a landing that is, in the real building, an enclosed stairwell. Five faces (back, two sides, top, bottom) facing
 * INTO the box, so they are seen from the door and shut the sun out, and are invisible (culled) from outside, where nothing
 * is drawn: the orbit view shows no stub. Position-only geometry plus normals; null when no party wall has an opening.
 */
export function partyRecessGeometry(scene: Pick<Scene, 'walls' | 'rooms' | 'openings' | 'materials'>, depth = PARTY_RECESS_DEPTH_M): BufferGeometry | null {
  const party = partyWallIds(scene);
  if (party.size === 0) return null;
  const walls = new Map(scene.walls.map((w) => [w.id, w]));
  const sides = wallSideRooms(scene as Scene);
  const rooms = new Map(scene.rooms.map((r) => [r.id, r]));
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[]) => {
    const base = positions.length / 3;
    for (const p of [a, b, c, d]) {
      positions.push(p[0]!, p[1]!, p[2]!);
      normals.push(n[0]!, n[1]!, n[2]!);
    }
    // The winding is fixed up so the face looks along `n`.
    const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const cross = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    if (cross[0]! * n[0]! + cross[1]! * n[1]! + cross[2]! * n[2]! >= 0) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  for (const o of scene.openings) {
    const wall = walls.get(o.wallId);
    if (!wall || !party.has(wall.id) || o.type === 'window') continue;
    const len = wallLength(wall);
    if (len < 1e-9) continue;
    const at = Math.min(len, Math.max(0, o.offset));
    const segment = sides[wall.id]?.segments.find((s) => at >= s.from - 1e-6 && at <= s.to + 1e-6);
    const indoor = (id: string | undefined) => !!id && rooms.get(id)?.type !== 'balcony';
    // The outside is the face with no room on it, the room the other one.
    const outLeft = !segment?.left && indoor(segment?.right);
    const outRight = !segment?.right && indoor(segment?.left);
    if (!outLeft && !outRight) continue;
    const n = wallLeftNormal(wall);
    const out: [number, number] = outLeft ? n : [-n[0], -n[1]];
    const ux = (wall.end[0] - wall.start[0]) / len;
    const uz = (wall.end[1] - wall.start[1]) / len;
    const hw = Math.min(o.width, len) / 2;
    const y0 = Math.max(0, o.sill);
    const y1 = Math.min(wall.height, o.sill + o.height);
    const cx = wall.start[0] + ux * at;
    const cz = wall.start[1] + uz * at;
    const near = wall.thickness / 2 - 0.01;
    const far = wall.thickness / 2 + depth;
    const pt = (lateral: number, dist: number, y: number): number[] => [cx + ux * lateral + out[0] * dist, y, cz + uz * lateral + out[1] * dist];
    // Inward normals: back faces the door (-out), sides face each other, top faces down, bottom up.
    quad(pt(-hw, far, y0), pt(hw, far, y0), pt(hw, far, y1), pt(-hw, far, y1), [-out[0], 0, -out[1]]);
    quad(pt(-hw, near, y0), pt(-hw, far, y0), pt(-hw, far, y1), pt(-hw, near, y1), [ux, 0, uz]);
    quad(pt(hw, near, y0), pt(hw, far, y0), pt(hw, far, y1), pt(hw, near, y1), [-ux, 0, -uz]);
    quad(pt(-hw, near, y1), pt(hw, near, y1), pt(hw, far, y1), pt(-hw, far, y1), [0, -1, 0]);
    quad(pt(-hw, near, y0), pt(hw, near, y0), pt(hw, far, y0), pt(-hw, far, y0), [0, 1, 0]);
  }
  if (indices.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(Float32Array.from(normals), 3));
  geometry.setIndex(new BufferAttribute(Uint32Array.from(indices), 1));
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
