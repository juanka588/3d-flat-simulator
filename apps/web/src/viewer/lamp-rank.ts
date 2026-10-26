import type { LampSpec } from './lighting';

/** At most this many point/spot lamps cast shadows (each costs extra shadow-map passes). */
export const MAX_SHADOW_LAMPS = 4;

/**
 * Picks which lamps cast shadows: only lit point/spot lamps qualify (area lights cannot), lamps in
 * the selected room first, then the nearest to the camera. Returns lamp ids.
 */
export function rankShadowLamps(
  lamps: readonly LampSpec[],
  camera: readonly [number, number, number],
  selectedRoomId: string | undefined,
  max = MAX_SHADOW_LAMPS,
): Set<string> {
  const distance = (l: LampSpec) => Math.hypot(l.position[0] - camera[0], l.position[1] - camera[1], l.position[2] - camera[2]);
  return new Set(
    lamps
      .filter((l) => l.on && l.intensity > 0 && l.type !== 'area')
      .map((l) => ({ id: l.id, selected: selectedRoomId !== undefined && l.roomId === selectedRoomId, d: distance(l) }))
      .sort((a, b) => Number(b.selected) - Number(a.selected) || a.d - b.d || a.id.localeCompare(b.id))
      .slice(0, max)
      .map((l) => l.id),
  );
}
