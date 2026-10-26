import { describe, expect, it } from 'vitest';
import charme from '../fixtures/charme-3205.flat.json';
import {
  DEFAULT_RADIUS,
  distanceToObstacle,
  findSpawn,
  insideFlat,
  isPassable,
  resolveMove,
  resolveWalk,
  walkObstacles,
  wallObstacles,
  type Obstacle,
} from './collision';
import { polygonCentroid } from './measure';
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

describe('findSpawn: bounded work', () => {
  const room = (id: string, poly: [number, number][]) => ({
    id,
    name: id,
    type: 'living' as const,
    polygon: poly,
  });
  const withRooms = (rooms: ReturnType<typeof room>[]) => ({ ...scene, rooms, walls: scene.walls.slice(0, 1), openings: [] });

  it('handles a room drawn in millimetres quickly', () => {
    const mm = withRooms([room('mm', [[0, 0], [4000, 0], [4000, 3000], [0, 3000]])]);
    const t0 = performance.now();
    const s = findSpawn(mm);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(s?.roomId).toBe('mm');
  });

  it('terminates for coordinates around 1e17, where x + 0.1 === x', () => {
    const far = withRooms([room('far', [[1e17, 1e17], [1e17 + 1e4, 1e17], [1e17 + 1e4, 1e17 + 1e4], [1e17, 1e17 + 1e4]])]);
    expect(findSpawn(far)).toBeNull();
  });

  it('skips rooms with non-finite or enormous extents', () => {
    const bad = withRooms([
      room('inf', [[0, 0], [Infinity, 0], [Infinity, 1], [0, 1]]),
      room('huge', [[0, 0], [1e12, 0], [1e12, 1e12], [0, 1e12]]),
    ]);
    expect(findSpawn(bad)).toBeNull();
  });
});

describe('Charme reachability', () => {
  const obstacles = wallObstacles(scene);
  const radius = DEFAULT_RADIUS;
  const step = 0.1;
  const xs = scene.rooms.flatMap((r) => r.polygon.map((p) => p[0]));
  const ys = scene.rooms.flatMap((r) => r.polygon.map((p) => p[1]));
  const x0 = Math.min(...xs) - 1;
  const y0 = Math.min(...ys) - 1;
  const nx = Math.ceil((Math.max(...xs) + 1 - x0) / step);
  const ny = Math.ceil((Math.max(...ys) + 1 - y0) / step);
  const free = (i: number, j: number) => {
    if (i < 0 || j < 0 || i > nx || j > ny) return false;
    const p: [number, number] = [x0 + i * step, y0 + j * step];
    return obstacles.every((o) => distanceToObstacle(p, o) >= radius);
  };
  const cell = (p: [number, number]): [number, number] => [Math.round((p[0] - x0) / step), Math.round((p[1] - y0) / step)];

  function flood(start: [number, number]): Set<number> {
    const [si, sj] = cell(start);
    const seen = new Set<number>([si * (ny + 1) + sj]);
    const queue: [number, number][] = [[si, sj]];
    while (queue.length) {
      const [i, j] = queue.pop()!;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const a = i + di;
        const b = j + dj;
        const key = a * (ny + 1) + b;
        if (seen.has(key) || !free(a, b)) continue;
        seen.add(key);
        queue.push([a, b]);
      }
    }
    return seen;
  }

  /** A free cell near the room centroid (the centroid itself may sit on a fixture-free but tight spot). */
  const reachable = (reach: Set<number>, p: [number, number]) => {
    const [ci, cj] = cell(p);
    for (let di = -3; di <= 3; di++) {
      for (let dj = -3; dj <= 3; dj++) {
        if (reach.has((ci + di) * (ny + 1) + cj + dj)) return true;
      }
    }
    return false;
  };

  it('reaches every room centroid from the spawn, balcony included (sill 0.15 <= 0.2)', () => {
    const spawn = findSpawn(scene)!;
    const reach = flood(spawn.position);
    for (const room of scene.rooms) {
      expect(reachable(reach, polygonCentroid(room.polygon)), room.id).toBe(true);
    }
  });

  it('needs the doors: with every door and passage made solid the flat falls apart', () => {
    const solid = wallObstacles({ ...scene, openings: [] });
    const spawn = findSpawn(scene)!;
    const [si, sj] = cell(spawn.position);
    const seen = new Set<number>([si * (ny + 1) + sj]);
    const queue: [number, number][] = [[si, sj]];
    const freeSolid = (i: number, j: number) => {
      if (i < 0 || j < 0 || i > nx || j > ny) return false;
      const p: [number, number] = [x0 + i * step, y0 + j * step];
      return solid.every((o) => distanceToObstacle(p, o) >= radius);
    };
    while (queue.length) {
      const [i, j] = queue.pop()!;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const key = (i + di) * (ny + 1) + j + dj;
        if (seen.has(key) || !freeSolid(i + di, j + dj)) continue;
        seen.add(key);
        queue.push([i + di, j + dj]);
      }
    }
    const unreachable = scene.rooms.filter((r) => !reachable(seen, polygonCentroid(r.polygon)));
    expect(unreachable.length).toBeGreaterThan(0);
  });

  it('walks from the spawn to a room centroid with resolveMove without being blocked', () => {
    const spawn = findSpawn(scene)!;
    const target = polygonCentroid(scene.rooms.find((r) => r.id === 'sejour')!.polygon);
    // Straight line may clip a wall; route through the entrance door on the way.
    const door = [8.735 - 0.955, 6.115 - 0.6] as [number, number];
    let p = spawn.position;
    for (const goal of [[door[0], spawn.position[1]], door, target] as [number, number][]) {
      for (let k = 0; k < 40; k++) {
        const d: [number, number] = [goal[0] - p[0], goal[1] - p[1]];
        const len = Math.hypot(d[0], d[1]);
        if (len < 0.05) break;
        p = resolveMove(p, [(d[0] / len) * Math.min(len, 0.2), (d[1] / len) * Math.min(len, 0.2)], obstacles).position;
      }
    }
    expect(Math.hypot(p[0] - target[0], p[1] - target[1])).toBeLessThan(0.5);
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

describe('staying inside the flat', () => {
  const inside = insideFlat(scene);
  const obstacles = walkObstacles(scene);
  const walk = (from: [number, number], delta: [number, number], obs = obstacles) => resolveWalk(inside, from, delta, obs);
  const doorX = 8.735 - 0.955; // door-entry centre on w-landing (y = 6.115)

  it('is true in every room and false in the stairwell, on the street side and past the balcony', () => {
    for (const room of scene.rooms) expect(inside(polygonCentroid(room.polygon)), room.id).toBe(true);
    expect(inside([doorX, 6.6])).toBe(false);
    expect(inside([20, 20])).toBe(false);
    expect(inside([-1.7, 4])).toBe(false);
  });

  it('only treats interior doors as walkable: the entry door leads outside', () => {
    // w-landing has no gap in walking obstacles, but has one in the plain wall footprints.
    expect(walkObstacles(scene).filter((o) => o.wallId === 'w-landing')).toHaveLength(1);
    expect(wallObstacles(scene).filter((o) => o.wallId === 'w-landing')).toHaveLength(2);
  });

  it('stops at the entry door when walking into it from the entree', () => {
    const r = walk([doorX, 5], [0, 3]);
    expect(r.collided).toBe(true);
    expect(r.position[1]).toBeLessThanOrEqual(6.03);
    expect(r.position[1]).toBeGreaterThan(5.7);
    expect(inside(r.position)).toBe(true);
  });

  it('stops at the entry door even if the door gap were not an obstacle (region test alone)', () => {
    const r = walk([doorX, 5], [0, 3], wallObstacles(scene));
    expect(r.position[1]).toBeLessThanOrEqual(6.03 + 1e-6);
    expect(inside(r.position)).toBe(true);
  });

  it('slides along the boundary instead of sticking', () => {
    const r = walk([doorX, 5.7], [1, 1]); // against the landing wall, heading east
    expect(r.position[0]).toBeGreaterThan(doorX + 0.5);
    expect(inside(r.position)).toBe(true);
  });

  it('walks through every interior door in both directions', () => {
    const interior = scene.openings.filter((o) => isPassable(o) && o.id !== 'door-entry');
    expect(interior.map((o) => o.id).sort()).toEqual(
      ['door-alcove', 'door-balcony-cuisine', 'door-balcony-sejour', 'door-ch1', 'door-ch2', 'door-sdb', 'door-sejour-entree', 'door-wc'],
    );
    for (const o of interior) {
      const wall = scene.walls.find((w) => w.id === o.wallId)!;
      const len = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
      const dx = (wall.end[0] - wall.start[0]) / len;
      const dy = (wall.end[1] - wall.start[1]) / len;
      const c: [number, number] = [wall.start[0] + dx * o.offset, wall.start[1] + dy * o.offset];
      for (const sign of [1, -1]) {
        const from: [number, number] = [c[0] - sign * -dy * 0.7, c[1] - sign * dx * 0.7];
        const r = walk(from, [sign * -dy * 1.4, sign * dx * 1.4]);
        expect(Math.hypot(r.position[0] - (c[0] + sign * -dy * 0.7), r.position[1] - (c[1] + sign * dx * 0.7)), `${o.id} ${sign}`).toBeLessThan(0.02);
        expect(inside(r.position), o.id).toBe(true);
      }
    }
  });

  it('reaches the balcony through the French doors but not beyond its railing', () => {
    const y = 8.38 - 4.83; // door-balcony-sejour
    const through = walk([1, y], [-2, 0]);
    expect(through.position[0]).toBeCloseTo(-1, 6);
    expect(inside(through.position)).toBe(true);
    const far = walk([-1, y], [-5, 0]);
    expect(far.position[0]).toBeGreaterThanOrEqual(-1.55); // railing outer face
    expect(far.position[0]).toBeLessThan(-1.2);
    // Without the railing obstacle the region test still holds the line at the balcony's outer edge.
    const edge = walk([-1, y], [-5, 0], []);
    expect(edge.position[0]).toBeGreaterThanOrEqual(-1.55 - 1e-6);
    expect(edge.position[0]).toBeLessThan(-1.5);
    // North and south ends of the balcony.
    for (const dy of [-20, 20]) {
      const r = walk([-1, y], [0, dy], []);
      expect(r.position[1]).toBeGreaterThanOrEqual(-1e-6);
      expect(r.position[1]).toBeLessThanOrEqual(8.28 + 1e-6);
    }
  });

  it('cannot tunnel out at high speed, in one jump or in per-frame steps', () => {
    const starts: [number, number][] = [[doorX, 5], [2, 7.3], [-1, 3.55], [9, 5], [8, 2]];
    for (const from of starts) {
      for (const dir of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7]] as const) {
        const jump = walk(from, [dir[0] * 60, dir[1] * 60]);
        expect(inside(jump.position), `jump ${from} ${dir}`).toBe(true);
        let p = from;
        for (let i = 0; i < 40; i++) p = walk(p, [dir[0] * 5 * 0.1 * 4, dir[1] * 5 * 0.1 * 4]).position;
        expect(inside(p), `steps ${from} ${dir}`).toBe(true);
      }
    }
  });
});
