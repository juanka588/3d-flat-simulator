import {
  CameraPose,
  CompassPoint,
  LightingView,
  UnknownFacingError,
  UnknownRoomError,
  applyPreset,
  orbitPose,
  roomOverviewPose,
  roomWallSides,
  topPose,
  walkPoseInRoom,
  type PresetName,
  type Scene,
} from '@flat/scene';
import { toolError } from '../errors';
import { RenderError } from './errors';

/**
 * Pure resolution of a render call: which room, which camera, which lighting. Failures throw
 * `RenderError` carrying the ready-made tool error (`unknown_room` with the nearest ids, a bad `facing`
 * with the room's walls and openings listed).
 */

export interface PoseRequest {
  view: 'room' | 'walk' | 'top' | 'orbit' | 'flat';
  roomId?: string | undefined;
  facing?: string | number | undefined;
  pose?: CameraPose | undefined;
}

export interface LightingRequest {
  date?: string | undefined;
  time?: string | undefined;
  preset?: PresetName | undefined;
  lamps?: LightingView['lamps'] | undefined;
  exposureEV?: number | undefined;
}

/** Ids closest to `q` (substring first, then edit distance), at most `n`. */
export function nearestIds(ids: readonly string[], q: string, n = 3): string[] {
  const lq = q.toLowerCase();
  const dist = (a: string, b: string) => {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return row[b.length]!;
  };
  return [...ids]
    .map((id) => ({ id, score: id.toLowerCase().includes(lq) || lq.includes(id.toLowerCase()) ? -1 : dist(id.toLowerCase(), lq) }))
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
    .slice(0, n)
    .map((x) => x.id);
}

function unknownRoom(scene: Scene, roomId: string): RenderError {
  const ids = scene.rooms.map((r) => r.id);
  const near = nearestIds(ids, roomId);
  const message = `no room "${roomId}"`;
  const hint = `Did you mean ${near.map((i) => `"${i}"`).join(', ')}? Rooms: ${ids.join(', ')}.`;
  return new RenderError('unknown_room', message, hint, toolError('unknown_room', message, hint, { errors: [{ code: 'unknown_room', path: 'roomId', message, hint: `nearest ids: ${near.join(', ')}` }] }));
}

/** Walls (and the openings in them) that face into the room: what `facing` may name. */
function roomTargets(scene: Scene, roomId: string): { walls: string[]; openings: string[] } {
  const walls = [...new Set(roomWallSides(scene, roomId).map((s) => s.wallId))];
  const openings = scene.openings.filter((o) => walls.includes(o.wallId)).map((o) => o.id);
  return { walls, openings };
}

function facingError(scene: Scene, roomId: string, message: string): RenderError {
  const { walls, openings } = roomTargets(scene, roomId);
  const hint = `facing must be a compass point (N NE E SE S SW W NW), degrees, or one of this room's walls [${walls.join(', ')}] or openings [${openings.join(', ')}].`;
  return new RenderError('invalid_command', message, hint, toolError('invalid_command', message, hint, { errors: [{ code: 'invalid_command', path: 'facing', message, hint: `walls of ${roomId}: ${walls.join(', ')}; openings: ${openings.join(', ')}` }] }));
}

const COMPASS = new Set<string>(CompassPoint.options);

/** The camera for a call; throws `RenderError`. */
export function resolvePose(scene: Scene, a: PoseRequest, aspect: number): { pose: CameraPose; view: 'room' | 'walk' | 'top' | 'orbit' } {
  const view = a.view === 'flat' ? 'orbit' : a.view;
  if (a.roomId !== undefined && !scene.rooms.some((r) => r.id === a.roomId)) throw unknownRoom(scene, a.roomId);
  if (a.pose) return { pose: a.pose, view };
  if ((view === 'room' || view === 'walk') && a.roomId === undefined) {
    const message = `view "${view}" needs roomId`;
    const hint = 'Call list_rooms for the ids, or use view "top" / "orbit" for the whole flat.';
    throw new RenderError('invalid_command', message, hint, toolError('invalid_command', message, hint, { errors: [{ code: 'invalid_command', path: 'roomId', message: 'required for room and walk views' }] }));
  }
  try {
    switch (view) {
      case 'room':
        return { view, pose: roomOverviewPose(scene, a.roomId!, { aspect }) };
      case 'walk': {
        const f = a.facing;
        if (typeof f === 'string' && !COMPASS.has(f)) {
          const { walls, openings } = roomTargets(scene, a.roomId!);
          if (!walls.includes(f) && !openings.includes(f)) throw facingError(scene, a.roomId!, `"${f}" is not a wall or opening of room "${a.roomId}"`);
        }
        return { view, pose: walkPoseInRoom(scene, a.roomId!, f === undefined ? {} : { facing: f }) };
      }
      case 'top':
        return { view, pose: topPose(scene, { ...(a.roomId ? { roomId: a.roomId } : {}), aspect }) };
      case 'orbit':
        return { view, pose: orbitPose(scene, { ...(a.roomId ? { roomId: a.roomId } : {}), aspect }) };
    }
  } catch (e) {
    if (e instanceof RenderError) throw e;
    if (e instanceof UnknownRoomError) throw unknownRoom(scene, e.roomId);
    if (e instanceof UnknownFacingError) throw facingError(scene, a.roomId ?? '', e.message);
    throw e;
  }
}

/** The lighting a call draws: `base` (session / default) < preset < date, time, lamps, exposure; throws `RenderError`. */
export function resolveLighting(scene: Scene, base: LightingView, a: LightingRequest): LightingView {
  let l = base;
  if (a.preset) l = applyPreset(l, a.preset, scene.site, scene.lights);
  if (a.date) l = { ...l, date: a.date };
  if (a.time) l = { ...l, time: a.time };
  if (a.exposureEV !== undefined) l = { ...l, exposureEV: a.exposureEV };
  if (a.lamps) {
    const lamps = { ...l.lamps };
    for (const [id, o] of Object.entries(a.lamps)) lamps[id] = { ...lamps[id], ...o };
    l = { ...l, lamps };
  }
  const v = LightingView.safeParse(l);
  if (!v.success) {
    const message = v.error.issues.map((i) => `${i.path.join('/')}: ${i.message}`).join('; ');
    throw new RenderError('invalid_command', message, undefined, toolError('invalid_command', message));
  }
  return v.data;
}
