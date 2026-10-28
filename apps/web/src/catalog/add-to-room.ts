import { solvePlacement } from '@flat/scene';
import type { Placement, Room, Scene } from '@flat/scene';
import type { ProductRecord } from '@flat/assets';
import type { Selection } from '../viewer/view-types';
import { committedScene, useSceneStore } from '../state/sceneStore';
import { useViewStore } from '../state/viewStore';
import { flashNotice } from './catalogStore';
import { placeFromSource } from './placement';
import type { PlaceSource } from './place';

/** The room "Add to room" targets: the selected room (floor / ceiling) or the room of the selected item, else the first real room. */
export function targetRoom(scene: Scene, selection: Selection | null): Room | undefined {
  if (selection?.kind === 'floor' || selection?.kind === 'ceiling') return scene.rooms.find((r) => r.id === selection.entityId) ?? undefined;
  if (selection?.kind === 'item') {
    const roomId = scene.items.find((i) => i.id === selection.entityId)?.roomId;
    const room = scene.rooms.find((r) => r.id === roomId);
    if (room) return room;
  }
  return scene.rooms.find((r) => r.type !== 'balcony') ?? scene.rooms[0];
}

export type AddSolution = { ok: true; placement: Placement } | { ok: false; message: string };

/**
 * Where "Add to room" puts a source, by the placement solver: centred in the room for floor and ceiling mounts,
 * against the first wall of the room that works for wall mounts. When the first choice is refused, the solver's best
 * alternative is taken; when there is none, its reason is returned.
 */
export function solveForRoom(scene: Scene, source: PlaceSource, room: Room): AddSolution {
  const base = {
    roomId: room.id,
    dims: source.dims,
    mount: source.mount,
    ...(source.mount !== 'floor' ? { elevation: source.elevation } : {}),
    ...(source.weightKg !== undefined ? { weightKg: source.weightKg } : {}),
  };
  const relations =
    source.mount === 'wall'
      ? scene.walls.map((w) => ({ kind: 'against_wall' as const, wallId: w.id, roomId: room.id }))
      : [{ kind: 'centered_in' as const, roomId: room.id }];
  let alternative: Placement | undefined;
  let reason = 'there is no free spot';
  for (const relation of relations) {
    const r = solvePlacement(scene, { ...base, relation });
    if (r.ok) return { ok: true, placement: r.placement };
    alternative ??= r.candidates[0];
    reason = r.violations[0]?.message ?? reason;
  }
  return alternative ? { ok: true, placement: alternative } : { ok: false, message: reason };
}

/**
 * The keyboard / button path of the catalog: places a card's item in the target room through the solver, with no
 * pointer involved, then selects it. Tells the user where it went or why not.
 */
export async function addToRoom(source: PlaceSource, getRecord?: () => Promise<ProductRecord>): Promise<boolean> {
  const scene = committedScene(useSceneStore.getState());
  if (!scene) return false;
  const room = targetRoom(scene, useViewStore.getState().selection);
  if (!room) {
    flashNotice(`Can't place ${source.label}: the flat has no room yet.`);
    return false;
  }
  const solved = solveForRoom(scene, source, room);
  if (!solved.ok) {
    flashNotice(`Can't place ${source.label} in ${room.name}: ${solved.message}`);
    return false;
  }
  const p = solved.placement;
  const ok = await placeFromSource(source, { position: p.position, rotation: p.rotation, elevation: p.elevation }, p.roomId, getRecord, p.relation);
  if (ok) flashNotice(`Added ${source.label} to ${room.name}.`);
  return ok;
}
