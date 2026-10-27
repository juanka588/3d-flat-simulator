import { ownerAt, pointInPolygon, roomDaylightFactors, wallLeftNormal, wallSideRooms } from '@flat/scene';
import type { MeshData, Scene, WallSideRooms } from '@flat/scene';
import { DataTexture, DataUtils, HalfFloatType, NearestFilter, RGBAFormat, RedFormat, UnsignedByteType } from 'three';

/** A face whose normal is less horizontal than this (tops, undersides) belongs to no room. */
const MIN_HORIZONTAL = 0.5;

type SceneRooms = Pick<Scene, 'rooms' | 'walls' | 'openings'> & { items?: Scene['items'] };

/**
 * Per-room ambient (sky) light, applied through the materials' `aoMap`.
 *
 * three.js multiplies only the *indirect diffuse* light by the ambient-occlusion map: that is the
 * hemisphere light here, and neither the sun nor any lamp. So a texture with one texel per room
 * (the room's daylight factor; one extra texel, 1, for "no room") darkens the sky ambient of a
 * windowless room and leaves lamps and the sun untouched. The shell meshes carry a `uv1`
 * attribute that points every vertex at its room's texel (`texture.channel = 1`).
 */
export interface RoomAmbient {
  texture: DataTexture;
  /**
   * Per-room lamp bounce, the same texel layout as `texture` (see `RoomBounce`). Rendered as the materials' `emissiveMap`:
   * unlike `aoMap` it is not tied to the sky light, so a lamp lights its room's walls and ceiling even at night.
   */
  bounce: RoomBounce;
  /** Texel index of a room id; `none` is the texel of faces that belong to no room. */
  indexOf: (roomId: string) => number;
  /** Texel index of the furniture standing in a room (full sky like `none`, but the room's lamp bounce). */
  itemIndexOf: (roomId: string) => number;
  /** Rooms on the two faces of every wall (`wallSideRooms`). */
  sides: Record<string, WallSideRooms>;
  none: number;
  /** Texels in the layout: rooms, `none`, then one per room for its furniture. */
  texels: number;
  dispose: () => void;
}

/** Lamp bounce of the rooms: `set` writes the radiance (E / pi, linear RGB) of every room's surfaces. */
export interface RoomBounce {
  texture: DataTexture;
  /** `bounce[roomId]`: mean inter-reflected illuminance `lux` and lamp `color`; absent rooms get none. */
  set: (bounce: Record<string, { lux: number; color: [number, number, number] }>) => void;
}

export function createRoomAmbient(scene: Scene): RoomAmbient {
  const factors = roomDaylightFactors(scene);
  const ids = scene.rooms.map((r) => r.id);
  const n = ids.length;
  const texels = 2 * n + 1;
  const data = new Uint8Array(texels).fill(255); // `none` and furniture: full sky
  ids.forEach((id, i) => {
    const f = factors[id] ?? 1;
    data[i] = Math.round(Math.max(0, Math.min(1, f)) * 255);
  });
  const texture = new DataTexture(data, texels, 1, RedFormat, UnsignedByteType);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.channel = 1;
  texture.needsUpdate = true;
  const index = new Map(ids.map((id, i) => [id, i]));

  // Lamp bounce: RGBA half floats (radiance can exceed 1), same layout and uv channel.
  const halves = new Uint16Array(texels * 4);
  const bounceTexture = new DataTexture(halves, texels, 1, RGBAFormat, HalfFloatType);
  bounceTexture.magFilter = NearestFilter;
  bounceTexture.minFilter = NearestFilter;
  bounceTexture.generateMipmaps = false;
  bounceTexture.channel = 1;
  bounceTexture.needsUpdate = true;
  const bounce: RoomBounce = {
    texture: bounceTexture,
    set(values) {
      halves.fill(0);
      const alpha = DataUtils.toHalfFloat(1);
      for (let t = 0; t < texels; t++) halves[t * 4 + 3] = alpha;
      for (const [id, v] of Object.entries(values)) {
        const i = index.get(id);
        if (i === undefined) continue;
        const radiance = v.lux / Math.PI; // reflected by the surface's own colour (the material's emissive colour)
        for (const t of [i, n + 1 + i]) for (let k = 0; k < 3; k++) halves[t * 4 + k] = DataUtils.toHalfFloat(Math.min(radiance * v.color[k]!, 60000));
      }
      bounceTexture.needsUpdate = true;
    },
  };
  bounce.set({});

  return {
    texture,
    bounce,
    indexOf: (id) => index.get(id) ?? n,
    itemIndexOf: (id) => (index.has(id) ? n + 1 + index.get(id)! : n),
    sides: wallSideRooms(scene),
    none: n,
    texels,
    dispose: () => {
      texture.dispose();
      bounceTexture.dispose();
    },
  };
}

/** MeshData whose vertices also carry `uv1`: the texel of the room each belongs to. Same triangles, same order. */
export interface RoomMeshData extends MeshData {
  uv1: Float32Array;
}

const cache = new WeakMap<MeshData, WeakMap<RoomAmbient, RoomMeshData>>();

/**
 * Adds the room-texel `uv1` attribute to a mesh. Floors and ceilings belong to their room, the
 * left/right face of a wall to the room on that face (`wallSideRooms`, per stretch of wall), and
 * a fitting's vertical faces to the room they look at; tops, ends, jambs, undersides and faces
 * looking outside belong to no room (full sky).
 * A vertex shared by triangles of different rooms is duplicated, so triangle indices and
 * `owners` (picking) stay valid.
 */
export function withRoomAmbient(mesh: MeshData, scene: SceneRooms, ambient: RoomAmbient): RoomMeshData {
  let byAmbient = cache.get(mesh);
  if (!byAmbient) cache.set(mesh, (byAmbient = new WeakMap()));
  let out = byAmbient.get(ambient);
  if (!out) byAmbient.set(ambient, (out = build(mesh, scene, ambient)));
  return out;
}

function build(mesh: MeshData, scene: SceneRooms, ambient: RoomAmbient): RoomMeshData {
  const vertexCount = mesh.positions.length / 3;
  const triangles = mesh.indices.length / 3;
  const texel = new Int32Array(vertexCount).fill(-1);
  const extra: { source: number; texel: number }[] = [];
  const split = new Map<number, number>(); // key = vertex * (rooms + 1) + texel
  const stride = ambient.texels;
  const indices = Uint32Array.from(mesh.indices);
  const p = mesh.positions;
  const n = mesh.normals;
  const wallsById = new Map(scene.walls.map((w) => [w.id, w]));
  const itemsById = new Map((scene.items ?? []).map((i) => [i.id, i]));
  const openingWall = new Map(scene.openings.map((o) => [o.id, o.wallId]));
  const wallOf = (kind: 'wall' | 'opening', id: string) => wallsById.get(kind === 'wall' ? id : (openingWall.get(id) ?? ''));

  for (let t = 0; t < triangles; t++) {
    const owner = ownerAt(mesh.owners, t);
    let room = ambient.none;
    if (owner?.kind === 'floor' || owner?.kind === 'ceiling') room = ambient.indexOf(owner.entityId);
    else if (owner?.kind === 'item') {
      const item = itemsById.get(owner.entityId);
      const itemRoom = item ? (item.roomId ?? scene.rooms.find((r) => pointInPolygon(item.position, r.polygon))?.id) : undefined;
      if (itemRoom !== undefined) room = ambient.itemIndexOf(itemRoom);
    }
    else if (owner && (owner.kind === 'wall' || owner.kind === 'opening')) {
      const a = mesh.indices[t * 3]!;
      const b = mesh.indices[t * 3 + 1]!;
      const c = mesh.indices[t * 3 + 2]!;
      const wall = wallOf(owner.kind, owner.entityId);
      const nx = n[a * 3]!;
      const nz = n[a * 3 + 2]!;
      if (wall && Math.hypot(nx, nz) >= MIN_HORIZONTAL && (owner.kind === 'opening' || owner.face === 'left' || owner.face === 'right')) {
        const cx = (p[a * 3]! + p[b * 3]! + p[c * 3]!) / 3;
        const cz = (p[a * 3 + 2]! + p[b * 3 + 2]! + p[c * 3 + 2]!) / 3;
        const len = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
        const along = ((cx - wall.start[0]) * (wall.end[0] - wall.start[0]) + (cz - wall.start[1]) * (wall.end[1] - wall.start[1])) / (len || 1);
        const left = owner.kind === 'wall' ? owner.face === 'left' : nx * wallLeftNormal(wall)[0] + nz * wallLeftNormal(wall)[1] > 0;
        const entry = ambient.sides[wall.id];
        const segment = entry?.segments.find((s) => along >= s.from - 1e-6 && along <= s.to + 1e-6);
        const id = segment ? (left ? segment.left : segment.right) : left ? entry?.left : entry?.right;
        if (id) room = ambient.indexOf(id);
      }
    }
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k]!;
      if (texel[v] === -1) texel[v] = room;
      else if (texel[v] !== room) {
        const key = v * stride + room;
        let copy = split.get(key);
        if (copy === undefined) {
          copy = vertexCount + extra.length;
          extra.push({ source: v, texel: room });
          split.set(key, copy);
        }
        indices[t * 3 + k] = copy;
      }
    }
  }

  const total = vertexCount + extra.length;
  const grow = (src: Float32Array, size: number) => {
    const dst = new Float32Array(total * size);
    dst.set(src);
    extra.forEach((e, i) => {
      for (let k = 0; k < size; k++) dst[(vertexCount + i) * size + k] = src[e.source * size + k]!;
    });
    return dst;
  };
  const uv1 = new Float32Array(total * 2);
  const setTexel = (vertex: number, room: number) => {
    uv1[vertex * 2] = (room + 0.5) / ambient.texels;
    uv1[vertex * 2 + 1] = 0.5;
  };
  for (let v = 0; v < vertexCount; v++) setTexel(v, texel[v] === -1 ? ambient.none : texel[v]!);
  extra.forEach((e, i) => setTexel(vertexCount + i, e.texel));
  return { ...mesh, positions: grow(mesh.positions, 3), normals: grow(mesh.normals, 3), uvs: grow(mesh.uvs, 2), indices, uv1 };
}
