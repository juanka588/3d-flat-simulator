import type { Room, Scene, Vec2 } from './schema';

/** Absolute polygon area (shoelace formula), in m². */
export function polygonArea(polygon: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i]!;
    const [x2, y2] = polygon[(i + 1) % polygon.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

export function roomArea(room: Pick<Room, 'polygon'>): number {
  return polygonArea(room.polygon);
}

export function polygonCentroid(polygon: readonly Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const [px, py] of polygon) {
    x += px;
    y += py;
  }
  return [x / polygon.length, y / polygon.length];
}

export interface Bounds {
  min: Vec2;
  max: Vec2;
}

/** Plan-space bounding box of all walls. */
export function sceneBounds(scene: Pick<Scene, 'walls'>): Bounds {
  const xs = scene.walls.flatMap((w) => [w.start[0], w.end[0]]);
  const ys = scene.walls.flatMap((w) => [w.start[1], w.end[1]]);
  return { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
}

export interface SceneSummary {
  name: string;
  totalArea: number;
  rooms: { id: string; name: string; type: Room['type']; area: number }[];
  wallCount: number;
  doorCount: number;
  windowCount: number;
  lightCount: number;
  itemCount: number;
}

/** Compact overview of a flat, also intended as the basis of the MCP `get_scene_summary` tool. */
export function summarizeScene(scene: Scene): SceneSummary {
  const rooms = scene.rooms.map((r) => ({ id: r.id, name: r.name, type: r.type, area: roomArea(r) }));
  return {
    name: scene.name,
    totalArea: rooms.reduce((sum, r) => sum + r.area, 0),
    rooms,
    wallCount: scene.walls.length,
    doorCount: scene.openings.filter((o) => o.type === 'door').length,
    windowCount: scene.openings.filter((o) => o.type === 'window').length,
    lightCount: scene.lights.length,
    itemCount: scene.items.length,
  };
}
