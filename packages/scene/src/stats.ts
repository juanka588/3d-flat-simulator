import { ceilingMaterial, floorMaterial, wallFaceMaterial } from './geometry/materials';
import { wallSideRooms } from './lighting/daylight';
import { roomBoundaryWalls, roomCeilingHeight } from './geometry/floors';
import { polygonArea } from './measure';
import type { Opening, Scene } from './schema';
import { wallLength } from './schema';
import { distanceToSegment } from './validate';

export interface SideValues<T> {
  left: T;
  right: T;
}

export interface WallStats {
  id: string;
  /** Centreline length in m (before junction mitring). */
  length: number;
  thickness: number;
  height: number;
  /** length * height, per side, in m². */
  grossArea: SideValues<number>;
  /** Gross area minus the openings, per side, in m². */
  netArea: SideValues<number>;
  /**
   * Material id per side at mid-span: own side finish, else the finish of the room on that
   * face, else scene default, else builtin. When `mixed` is true the side has several
   * materials along it; see `faces`.
   */
  finish: SideValues<string>;
  /** True for a side whose material changes along the wall (a room-scoped finish on a shared side). */
  mixed: SideValues<boolean>;
  /** Per stretch of each side: metres from the wall start, the room on that face, and its material. */
  faces: SideValues<{ from: number; to: number; roomId?: string; material: string }[]>;
  openings: Opening[];
}

/** Properties of a wall for the selection panel. `undefined` for an unknown id. */
export function wallStats(scene: Scene, wallId: string): WallStats | undefined {
  const wall = scene.walls.find((w) => w.id === wallId);
  if (!wall) return undefined;
  const length = wallLength(wall);
  const gross = length * wall.height;
  const openings = scene.openings.filter((o) => o.wallId === wall.id);
  const holes = openings.reduce((sum, o) => sum + o.width * o.height, 0);
  const net = Math.max(0, gross - holes);
  const rooms = wallSideRooms(scene)[wall.id];
  const faces = (side: 'left' | 'right') => {
    const out: { from: number; to: number; roomId?: string; material: string }[] = [];
    for (const seg of rooms?.segments ?? []) {
      const material = wallFaceMaterial(scene, wall, side, seg[side]);
      const last = out[out.length - 1];
      if (last && last.material === material && last.roomId === seg[side]) last.to = seg.to;
      else out.push({ from: seg.from, to: seg.to, ...(seg[side] ? { roomId: seg[side] } : {}), material });
    }
    return out.length ? out : [{ from: 0, to: length, material: wallFaceMaterial(scene, wall, side, undefined) }];
  };
  const mid = (side: 'left' | 'right') => wallFaceMaterial(scene, wall, side, rooms?.[side]);
  const mixed = (side: 'left' | 'right') => new Set(faces(side).map((f) => f.material)).size > 1;
  return {
    id: wall.id,
    length,
    thickness: wall.thickness,
    height: wall.height,
    grossArea: { left: gross, right: gross },
    netArea: { left: net, right: net },
    finish: { left: mid('left'), right: mid('right') },
    mixed: { left: mixed('left'), right: mixed('right') },
    faces: { left: faces('left'), right: faces('right') },
    openings,
  };
}

export interface RoomStats {
  id: string;
  name: string;
  /** Polygon area in m² (net when the polygon follows inner wall faces). */
  area: number;
  perimeter: number;
  floorMaterial: string;
  /** `null` for balconies, which have no ceiling. */
  ceilingMaterial: string | null;
  /** `null` for balconies without an explicit `ceilingHeight`. */
  ceilingHeight: number | null;
  /** Walls running along the room's edges. */
  wallIds: string[];
  /** Openings whose centre lies on the room's boundary. */
  openings: Opening[];
}

/** Properties of a room for the selection panel. `undefined` for an unknown id. */
export function roomStats(scene: Scene, roomId: string): RoomStats | undefined {
  const room = scene.rooms.find((r) => r.id === roomId);
  if (!room) return undefined;
  const n = room.polygon.length;
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const a = room.polygon[i]!;
    const b = room.polygon[(i + 1) % n]!;
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const walls = roomBoundaryWalls(scene, room);
  const openings = scene.openings.filter((o) => {
    const wall = walls.find((w) => w.id === o.wallId);
    if (!wall) return false;
    const len = wallLength(wall);
    const t = o.offset / len;
    const centre: [number, number] = [
      wall.start[0] + (wall.end[0] - wall.start[0]) * t,
      wall.start[1] + (wall.end[1] - wall.start[1]) * t,
    ];
    // The centre may sit up to half a wall thickness from the room edge, plus slack.
    return room.polygon.some(
      (a, i) => distanceToSegment(centre, a, room.polygon[(i + 1) % n]!) <= wall.thickness / 2 + 0.02,
    );
  });
  const balcony = room.type === 'balcony';
  return {
    id: room.id,
    name: room.name,
    area: polygonArea(room.polygon),
    perimeter,
    floorMaterial: floorMaterial(scene, room),
    ceilingMaterial: balcony ? null : ceilingMaterial(scene, room),
    ceilingHeight: balcony ? (room.ceilingHeight ?? null) : roomCeilingHeight(scene, room),
    wallIds: walls.map((w) => w.id),
    openings,
  };
}
