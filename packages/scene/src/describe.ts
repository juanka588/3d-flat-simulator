import { ceilingMaterial, floorMaterial, roomSideFinish, wallFaceMaterial } from './geometry/materials';
import { roomWallSides, type WallSideName } from './geometry/room-sides';
import type { SiteContext } from './context/schema';
import { roomDaylightFactors, wallSideRooms } from './lighting/daylight';
import { SUN_PATCH_MIN_AREA, sunPatches, sunlightHours } from './lighting/sunpatch';
import { localDayBounds, sunAtInstant } from './lighting/sun';
import { polygonArea } from './measure';
import type { CompassPoint, RoomDescription, RoomSummary } from './mcp-types';
import type { FinishSource } from './mcp-types';
import { roomStats } from './stats';
import type { Light, Opening, Room, Scene, Vec2, Wall } from './schema';
import { wallLeftNormal, wallLength } from './schema';
import { structuralInfo } from './structural';
import { pointInPolygon } from './validate';
import type { LightingView } from './view';

/**
 * Pure read-model of the flat for the MCP read tools (M4.3, lane A). No clock, no I/O: the lighting
 * view (date) is passed in. Deterministic order: scene order for rooms, wall id then side for walls,
 * opening offset for openings. Numbers are rounded to keep the JSON small.
 */

const COMPASS: CompassPoint[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Compass point of a plan direction `[dx, dy]` (y down) given `site.northAngle` (clockwise plan-up to north). */
export function planDirectionToCompass(dir: Vec2, northAngle: number): CompassPoint {
  const heading = (Math.atan2(dir[0], -dir[1]) * 180) / Math.PI; // clockwise from plan-up
  const bearing = (((heading - northAngle) % 360) + 360) % 360;
  return COMPASS[Math.round(bearing / 45) % 8]!;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Rooms on the two faces of an opening, probed just beyond each wall face at the opening's centre. */
function openingRooms(scene: Scene, o: Opening, wall: Wall): { left?: Room; right?: Room; normal: Vec2 } {
  const len = wallLength(wall);
  const t = Math.min(len, Math.max(0, o.offset)) / len;
  const c: Vec2 = [wall.start[0] + (wall.end[0] - wall.start[0]) * t, wall.start[1] + (wall.end[1] - wall.start[1]) * t];
  const n = wallLeftNormal(wall);
  const d = wall.thickness / 2 + 0.05;
  const find = (sign: number) => {
    const p: Vec2 = [c[0] + sign * n[0] * d, c[1] + sign * n[1] * d];
    return scene.rooms.find((r) => pointInPolygon(p, r.polygon, 1e-6));
  };
  return { left: find(1), right: find(-1), normal: n };
}

function roomOpenings(scene: Scene, room: Room) {
  const walls = new Map(scene.walls.map((w) => [w.id, w]));
  const out: { opening: Opening; wall: Wall; side: WallSideName; other?: Room; outward: Vec2 }[] = [];
  for (const opening of scene.openings) {
    const wall = walls.get(opening.wallId);
    if (!wall || wallLength(wall) < 1e-9) continue;
    const { left, right, normal } = openingRooms(scene, opening, wall);
    if (left?.id === room.id && right?.id !== room.id) out.push({ opening, wall, side: 'left', other: right, outward: [-normal[0], -normal[1]] });
    else if (right?.id === room.id && left?.id !== room.id) out.push({ opening, wall, side: 'right', other: left, outward: normal });
  }
  return out.sort((a, b) => a.opening.wallId.localeCompare(b.opening.wallId) || a.opening.offset - b.opening.offset);
}

/** `list_rooms`: one cheap line per room, in scene order. */
export function listRooms(scene: Scene): RoomSummary[] {
  return scene.rooms.map((room) => {
    const ops = roomOpenings(scene, room);
    return {
      id: room.id,
      name: room.name,
      type: room.type,
      areaM2: r2(polygonArea(room.polygon)),
      wallFinish: room.wallFinish ?? null,
      floor: room.floorMaterial ?? null,
      ceiling: room.ceilingMaterial ?? null,
      windows: ops.filter((o) => o.opening.type === 'window').length,
      doors: ops.filter((o) => o.opening.type === 'door').length,
      lights: roomLights(scene, room).length,
    };
  });
}

function roomLights(scene: Scene, room: Room): Light[] {
  return scene.lights.filter((l) => (l.roomId !== undefined ? l.roomId === room.id : pointInPolygon(l.position, room.polygon, 1e-6)));
}

function finishSource(wall: Wall, side: WallSideName, room: Room, scene: Pick<Scene, 'defaults'>): FinishSource {
  if (roomSideFinish(wall, room.id, side) !== undefined) return 'room_scoped';
  if (wall.finish[side] !== undefined) return 'whole_face';
  if (room.wallFinish !== undefined) return 'room_wall_finish';
  return scene.defaults.wall !== undefined ? 'scene_default' : 'none';
}

const clock = new Map<string, Intl.DateTimeFormat>();
function localHm(instant: Date, tz: string): string {
  let f = clock.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    clock.set(tz, f);
  }
  return f.format(instant);
}

/** First and last sunlit instants (local HH:mm) of a room, using the same sampling as `sunlightHours`. */
function sunSpan(scene: Scene, date: string, roomId: string, context: SiteContext | undefined): { first: string; last: string } | null {
  const step = 10 * 60_000;
  const { start, end } = localDayBounds(date, scene.site.timezone);
  let first: Date | undefined;
  let last: Date | undefined;
  for (let t = start.getTime(); t < end.getTime(); t += step) {
    const slice = Math.min(step, end.getTime() - t);
    const sun = sunAtInstant(scene.site, new Date(t + slice / 2));
    if (!sun.isUp) continue;
    let area = 0;
    for (const p of sunPatches(scene, sun.direction, context)) if (p.roomId === roomId) area += p.area;
    if (area > SUN_PATCH_MIN_AREA) {
      first ??= new Date(t);
      last = new Date(t + slice);
    }
  }
  return first && last ? { first: localHm(first, scene.site.timezone), last: localHm(last, scene.site.timezone) } : null;
}

/**
 * `describe_room`: area, the wall faces that border the room (structural flag, effective finish and
 * where it comes from, `wallOn` = the side of the room the wall is on, shared faces), openings with compass direction, lights,
 * daylight factor and sunlight hours for `lighting.date`, items (always `[]` until M5).
 * Returns `undefined` for an unknown room (the tool maps that to `unknown_room` with
 * `nearestIds` in the hint). `opts.context` makes neighbouring buildings obstruct the sun.
 */
export function describeRoom(
  scene: Scene,
  roomId: string,
  lighting: Pick<LightingView, 'date'> & Partial<LightingView>,
  opts: { context?: SiteContext; rev?: number } = {},
): RoomDescription | undefined {
  const room = scene.rooms.find((r) => r.id === roomId);
  const stats = roomStats(scene, roomId);
  if (!room || !stats) return undefined;
  const north = scene.site.northAngle;
  const walls = new Map(scene.walls.map((w) => [w.id, w]));
  const faceRooms = wallSideRooms(scene);

  const wallDescs = roomWallSides(scene, roomId)
    .sort((a, b) => (a.wallId < b.wallId ? -1 : a.wallId > b.wallId ? 1 : a.side === b.side ? 0 : a.side === 'left' ? -1 : 1))
    .map((s) => {
      const wall = walls.get(s.wallId)!;
      const info = structuralInfo(scene, wall);
      const n = wallLeftNormal(wall);
      const into: Vec2 = s.side === 'left' ? n : [-n[0], -n[1]];
      const lengthM = (faceRooms[wall.id]?.segments ?? []).reduce((sum, seg) => sum + (seg[s.side] === roomId ? seg.to - seg.from : 0), 0);
      return {
        wallId: wall.id,
        side: s.side,
        wallOn: planDirectionToCompass([-into[0], -into[1]], north),
        lengthM: r2(lengthM),
        thicknessM: r2(wall.thickness),
        structural: info.structural,
        structuralSource: info.source,
        finish: { materialId: wallFaceMaterial(scene, wall, s.side, roomId) as string | null, source: finishSource(wall, s.side, room, scene) },
        sharedWith: s.otherRoomIds,
      };
    });

  const openings = roomOpenings(scene, room).map(({ opening: o, side, other, outward }) => {
    const swingSide = o.swing ?? 'left';
    const swing = o.type !== 'door' ? undefined : swingSide === side ? 'into this room' : other ? `into ${other.id}` : 'outward';
    return {
      id: o.id,
      type: o.type,
      wallId: o.wallId,
      compass: planDirectionToCompass(outward, north),
      widthM: r2(o.width),
      heightM: r2(o.height),
      sillM: r2(o.sill),
      leadsTo: other?.id ?? null,
      glazed: o.glazed ?? o.type === 'window',
      ...(swing ? { swing } : {}),
    };
  });

  const lights = roomLights(scene, room).map((l) => {
    const ov = lighting.lamps?.[l.id];
    return { id: l.id, type: l.type, on: ov?.on ?? l.on, lumens: Math.round(ov?.lumens ?? l.lumens), kelvin: Math.round(ov?.kelvin ?? l.kelvin) };
  });

  const df = roomDaylightFactors(scene)[roomId];
  const hours = sunlightHours(scene, lighting.date, 10, opts.context)[roomId];
  const span = hours !== undefined && hours > 0 ? sunSpan(scene, lighting.date, roomId, opts.context) : null;
  const xs = room.polygon.map((p) => p[0]);
  const ys = room.polygon.map((p) => p[1]);

  return {
    id: room.id,
    name: room.name,
    type: room.type,
    ...(opts.rev !== undefined ? { rev: opts.rev } : {}),
    areaM2: r2(stats.area),
    perimeterM: r2(stats.perimeter),
    ceilingHeightM: r2(stats.ceilingHeight ?? 0),
    bounds: [r2(Math.min(...xs)), r2(Math.min(...ys)), r2(Math.max(...xs)), r2(Math.max(...ys))],
    floor: { materialId: floorMaterial(scene, room) },
    ceiling: { materialId: room.type === 'balcony' ? null : ceilingMaterial(scene, room) },
    walls: wallDescs,
    openings,
    lights,
    daylight: {
      date: lighting.date,
      obstruction: opts.context ? 'context' : 'none',
      daylightFactorPct: df === undefined ? null : Math.round(df * 1000) / 10,
      sunlightHours: hours === undefined ? null : r2(hours),
      firstSun: span?.first ?? null,
      lastSun: span?.last ?? null,
    },
    items: [],
  };
}
