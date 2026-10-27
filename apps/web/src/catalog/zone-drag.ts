import type { Vec2 } from '@flat/scene';
import { committedScene, useSceneStore } from '../state/sceneStore';
import { floorPointAt, setViewerControlsEnabled } from './placement';
import { dragZoneCorner, zoneCommand } from './zones';

/**
 * Drag of one corner handle of the selected floor zone. Every step shows the edit as a preview (applied to the
 * committed scene, snapped to the 5 cm grid and clamped inside the room by `dragZoneCorner`); the release commits it
 * as ONE history entry, Escape drops it. Alt turns the grid off.
 */
interface ZoneDrag {
  roomId: string;
  zoneId: string;
  polygon: Vec2[];
  corner: number;
  stop: () => void;
}

let drag: ZoneDrag | null = null;

export const isZoneDragging = (): boolean => drag !== null;

/** The drag in progress, for the test hook. */
export function zoneDragState(): { roomId: string; zoneId: string; corner: number } | null {
  return drag ? { roomId: drag.roomId, zoneId: drag.zoneId, corner: drag.corner } : null;
}

export function endZoneDrag(commit: boolean): void {
  const d = drag;
  if (!d) return;
  drag = null;
  d.stop();
  const store = useSceneStore.getState();
  if (commit) store.commitPreview();
  else store.cancelPreview();
  setViewerControlsEnabled(true);
}

export function startZoneCornerDrag(roomId: string, zoneId: string, corner: number): void {
  endZoneDrag(false);
  const scene = committedScene(useSceneStore.getState());
  const room = scene?.rooms.find((r) => r.id === roomId);
  const zone = room?.floorZones?.find((z) => z.id === zoneId);
  if (!scene || !room || !zone) return;
  const d: ZoneDrag = { roomId, zoneId, polygon: zone.polygon.map((p): Vec2 => [p[0], p[1]]), corner, stop: () => undefined };
  const label = `Resize floor zone ${zone.name ?? zone.id}`;
  const move = (e: PointerEvent) => {
    const now = committedScene(useSceneStore.getState());
    const r = now?.rooms.find((x) => x.id === roomId);
    const z = r?.floorZones?.find((x) => x.id === zoneId);
    const at = floorPointAt(e.clientX, e.clientY);
    if (!r || !z || !at) return;
    const next = dragZoneCorner(r, zoneId, d.polygon, d.corner, at, !e.altKey);
    d.polygon = next.polygon;
    d.corner = next.corner;
    useSceneStore.getState().preview(zoneCommand(roomId, z, next.polygon), { coalesceKey: `zone:${roomId}/${zoneId}`, label });
  };
  const up = (e: PointerEvent) => {
    move(e);
    endZoneDrag(true);
  };
  const cancel = () => endZoneDrag(false);
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      endZoneDrag(false);
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key, true);
  d.stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key, true);
  };
  drag = d;
  setViewerControlsEnabled(false);
}
