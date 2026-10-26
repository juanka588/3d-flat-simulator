import { describe, expect, it } from 'vitest';
import charme from '../fixtures/charme-3205.flat.json';
import { distanceToObstacle, findSpawn, isPassable, resolveMove, wallObstacles, type Obstacle } from './collision';
import { parseScene } from './parse';
import type { Scene } from './schema';
import { pointInPolygon } from './validate';

function load(input: unknown): Scene {
  const r = parseScene(input);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.scene;
}
const scene = load(charme);

/** Vertical wall at x = 5, 7 cm thick, spanning y 0..10. */
const thin: Obstacle[] = [{ wallId: 't', a: [5, 0], b: [5, 10], halfThickness: 0.035 }];

describe('isPassable', () => {
  it('lets low doors and passages through but blocks windows and high sills', () => {
    expect(isPassable({ type: 'door', sill: 0, height: 2.04 })).toBe(true);
    expect(isPassable({ type: 'door', sill: 0.15, height: 2.05 })).toBe(true);
    expect(isPassable({ type: 'passage', sill: 0, height: 2 })).toBe(true);
    expect(isPassable({ type: 'window', sill: 0, height: 2.2 })).toBe(false);
    expect(isPassable({ type: 'door', sill: 0.3, height: 2 })).toBe(false);
    expect(isPassable({ type: 'door', sill: 0, height: 1.7 })).toBe(false);
  });
});

describe('wallObstacles', () => {
  it('cuts passable openings out of walls and keeps windows solid', () => {
    const north = wallObstacles(scene).filter((o) => o.wallId === 'w-north');
    expect(north).toHaveLength(1); // windows only
    const alcove = wallObstacles(scene).filter((o) => o.wallId === 'w-alcove');
    // door-alcove spans 0.07..0.87: solid [0, 0.07] and [0.87, L]
    expect(alcove).toHaveLength(2);
    expect(Math.hypot(alcove[0]!.b[0] - alcove[0]!.a[0], alcove[0]!.b[1] - alcove[0]!.a[1])).toBeCloseTo(0.07, 9);
    expect(alcove[1]!.a[0]).toBeCloseTo(0.87, 9);
    expect(alcove[1]!.halfThickness).toBeCloseTo(0.035, 9);
  });
  it('covers the whole wall minus the door width', () => {
    const total = wallObstacles(scene)
      .filter((o) => o.wallId === 'w-ch2-south')
      .reduce((s, o) => s + Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]), 0);
    expect(total).toBeCloseTo(2.77 - 0.8, 9);
  });
});

describe('resolveMove', () => {
  it('moves freely in open space', () => {
    const r = resolveMove([1, 1], [0.5, 0.2], thin);
    expect(r.position[0]).toBeCloseTo(1.5, 12);
    expect(r.position[1]).toBeCloseTo(1.2, 12);
    expect(r.collided).toBe(false);
  });

  it('stops at the wall face', () => {
    const r = resolveMove([4, 5], [0.9, 0], thin, 0.25);
    expect(r.position[0]).toBeCloseTo(5 - 0.035 - 0.25, 6);
    expect(r.collided).toBe(true);
  });

  it('does not tunnel through a 7 cm wall at 5 m/s with dt = 0.1 (from either side)', () => {
    for (const [from, dir] of [[4.6, 1], [5.4, -1]] as const) {
      let p: [number, number] = [from, 5];
      for (let i = 0; i < 20; i++) p = resolveMove(p, [dir * 5 * 0.1, 0], thin).position;
      expect(dir > 0 ? p[0] < 5 : p[0] > 5).toBe(true);
    }
  });

  it('slides along the wall when moving diagonally', () => {
    const r = resolveMove([4.5, 2], [0.5, 1], thin);
    expect(r.position[0]).toBeLessThanOrEqual(5 - 0.035 - 0.25 + 1e-9);
    expect(r.position[1]).toBeCloseTo(3, 2);
  });

  it('slides without losing tangential speed at a 45 degree wall', () => {
    const diag: Obstacle[] = [{ wallId: 'd', a: [0, 0], b: [10, 10], halfThickness: 0.05 }];
    const start: [number, number] = [4, 6]; // below-left of the diagonal... (x < y)
    const r = resolveMove(start, [1, 0], diag);
    // heading +x against the wall: ends up displaced along the wall direction
    expect(r.position[0]).toBeGreaterThan(4.3);
    expect(distanceToObstacle(r.position, diag[0]!)).toBeGreaterThanOrEqual(0.25 - 1e-9);
  });

  it('is stable in a corner', () => {
    const corner: Obstacle[] = [
      { wallId: 'a', a: [5, 0], b: [5, 10], halfThickness: 0.05 },
      { wallId: 'b', a: [0, 5], b: [10, 5], halfThickness: 0.05 },
    ];
    const r = resolveMove([4, 4], [3, 3], corner);
    expect(r.position[0]).toBeCloseTo(5 - 0.05 - 0.25, 3);
    expect(r.position[1]).toBeCloseTo(5 - 0.05 - 0.25, 3);
  });

  it('pushes out a start position inside a wall', () => {
    const r = resolveMove([5, 5], [0, 0], thin);
    expect(distanceToObstacle(r.position, thin[0]!)).toBeGreaterThanOrEqual(0.25 - 1e-9);
  });

  it('walks through the Charme entrance door but not through the adjacent wall', () => {
    const obstacles = wallObstacles(scene);
    // w-landing runs along y = 6.115; door-entry spans x 7.78..6.88 +- (offset .955 from x=8.735, width .9)
    const doorX = 8.735 - 0.955;
    const through = resolveMove([doorX, 5.6], [0, 1.2], obstacles);
    expect(through.position[1]).toBeCloseTo(6.8, 6);
    expect(through.collided).toBe(false);
    const blocked = resolveMove([doorX + 0.9, 5.6], [0, 1.2], obstacles); // beside the door, into the wall
    expect(blocked.position[1]).toBeLessThan(6.115);
  });

  it('blocks windows', () => {
    // win-ch2 on w-north spans x 5.65..6.55 (offset 7.7 - 1.6 shift). Walk north into it.
    const obstacles = wallObstacles(scene);
    const x = -1.6 + 7.7;
    const r = resolveMove([x, 1], [0, -2], obstacles);
    expect(r.position[1]).toBeGreaterThan(0.2); // stopped at the north wall inner face + radius
  });
});

describe('findSpawn', () => {
  const radius = 0.25;
  it('picks the entrance hall in Charme with clearance from every wall', () => {
    const spawn = findSpawn(scene, radius)!;
    expect(spawn.roomId).toBe('entree');
    const room = scene.rooms.find((r) => r.id === 'entree')!;
    expect(pointInPolygon(spawn.position, room.polygon)).toBe(true);
    for (const o of wallObstacles(scene)) expect(distanceToObstacle(spawn.position, o)).toBeGreaterThanOrEqual(radius);
  });

  it('falls back to the living room without a hallway, then to anything', () => {
    const noHall = { ...scene, rooms: scene.rooms.filter((r) => r.type !== 'hallway') };
    expect(findSpawn(noHall)!.roomId).toBe('sejour');
    const onlyBalcony = { ...scene, rooms: scene.rooms.filter((r) => r.type === 'balcony') };
    expect(findSpawn(onlyBalcony)!.roomId).toBe('balcon');
  });

  it('skips rooms too small for the body and returns null if none fit', () => {
    const tiny = { ...scene, rooms: [{ ...scene.rooms.find((r) => r.id === 'wc')!, polygon: [[0, 0], [0.3, 0], [0.3, 0.3], [0, 0.3]] as [number, number][] }] };
    expect(findSpawn(tiny)).toBeNull();
  });

  it('every spawnable Charme room yields a valid point', () => {
    for (const room of scene.rooms) {
      const s = findSpawn({ ...scene, rooms: [room] });
      expect(s, room.id).not.toBeNull();
    }
  });
});
