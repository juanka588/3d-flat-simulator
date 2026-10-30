import { describe, expect, it } from 'vitest';
import charme from '../../fixtures/charme-3205.flat.json';
import { Scene } from '../schema';
import { pointInPolygon } from '../validate';
import { buildCeilings, buildFloors } from './floors';
import { MAX_GAP_AREA_M2, SLAB_LIFT_M, gapSlabPieces, slabPieces } from './slab';
import type { MeshData } from './types';

const scene = Scene.parse(charme);
const ceilings = buildCeilings(scene);
const floors = buildFloors(scene);

/** True when the plan point is under (inside the plan projection of) a downward or upward facing triangle of the mesh. */
function coverage(mesh: MeshData) {
  const tris: { x0: number; z0: number; x1: number; z1: number; v: number[] }[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const v = [0, 1, 2].map((k) => mesh.indices[t + k]!).flatMap((i) => [mesh.positions[i * 3]!, mesh.positions[i * 3 + 2]!]);
    tris.push({ x0: Math.min(v[0]!, v[2]!, v[4]!), x1: Math.max(v[0]!, v[2]!, v[4]!), z0: Math.min(v[1]!, v[3]!, v[5]!), z1: Math.max(v[1]!, v[3]!, v[5]!), v });
  }
  return (x: number, z: number): boolean => {
    for (const t of tris) {
      if (x < t.x0 || x > t.x1 || z < t.z0 || z > t.z1) continue;
      const [ax, az, bx, bz, cx, cz] = t.v as [number, number, number, number, number, number];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      if (u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9) return true;
    }
    return false;
  };
}

describe('the ceiling covers the whole flat (no hole at the top)', () => {
  const under = coverage(ceilings);
  const habitable = scene.rooms.filter((r) => r.type !== 'balcony');
  const balconies = scene.rooms.filter((r) => r.type === 'balcony');
  const STEP = 0.05;
  const x0 = -2;
  const z0 = -1;
  const W = Math.ceil(13 / STEP);
  const H = Math.ceil(11 / STEP);

  it('every point of every habitable room, and of every wall beside one, is under a ceiling', () => {
    const missing: string[] = [];
    for (const room of habitable) {
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
          const p: [number, number] = [x0 + (i + 0.5) * STEP, z0 + (j + 0.5) * STEP];
          if (pointInPolygon(p, room.polygon) && !under(p[0], p[1])) missing.push(`${room.id} (${p[0].toFixed(2)}, ${p[1].toFixed(2)})`);
        }
      }
    }
    expect(missing.slice(0, 5)).toEqual([]);
    const { walls } = slabPieces(scene);
    expect(walls.length).toBeGreaterThan(20);
    for (const piece of walls) {
      // The middle of every stretch of wall (its four corners are at the edge of the rectangle, where two rectangles meet).
      const cx = piece.corners.reduce((n, c) => n + c[0], 0) / 4;
      const cz = piece.corners.reduce((n, c) => n + c[1], 0) / 4;
      expect(under(cx, cz), `${piece.roomId} wall piece at (${cx.toFixed(2)}, ${cz.toFixed(2)})`).toBe(true);
    }
  });

  it('nothing the outside cannot reach is left open: a point without a ceiling is connected to the sky (the border, the balcony)', () => {
    // 0 free, 1 under a ceiling, 2 balcony; flood from the border and the balconies through the free cells, then nothing free is left.
    const grid = new Uint8Array(W * H);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const x = x0 + (i + 0.5) * STEP;
        const z = z0 + (j + 0.5) * STEP;
        grid[i + j * W] = under(x, z) ? 1 : balconies.some((b) => pointInPolygon([x, z], b.polygon)) ? 2 : 0;
      }
    }
    const reached = new Uint8Array(W * H);
    const stack: number[] = [];
    for (let c = 0; c < W * H; c++) {
      const i = c % W;
      const j = (c - i) / W;
      if (grid[c] === 2 || ((i === 0 || j === 0 || i === W - 1 || j === H - 1) && grid[c] === 0)) stack.push(c);
    }
    while (stack.length > 0) {
      const c = stack.pop()!;
      if (reached[c] || grid[c] === 1) continue;
      reached[c] = 1;
      const i = c % W;
      const j = (c - i) / W;
      if (i > 0) stack.push(c - 1);
      if (i < W - 1) stack.push(c + 1);
      if (j > 0) stack.push(c - W);
      if (j < H - 1) stack.push(c + W);
    }
    const holes: string[] = [];
    for (let c = 0; c < W * H; c++) {
      if (grid[c] === 0 && !reached[c]) holes.push(`(${(x0 + ((c % W) + 0.5) * STEP).toFixed(2)}, ${(z0 + (Math.floor(c / W) + 0.5) * STEP).toFixed(2)})`);
    }
    expect(holes.slice(0, 5)).toEqual([]);
  });

  it('the strip in front of the Chambre 2 placard, between the polygons of Chambre 2 and of the hall, is under the ceiling and over a floor', () => {
    const strip = [[4.5, 4.155], [5.0, 4.16], [5.5, 4.15], [5.7, 4.14]] as const;
    const floor = coverage(floors);
    for (const [x, z] of strip) {
      expect(habitable.some((r) => pointInPolygon([x, z], r.polygon)), `(${x}, ${z}) is in no room`).toBe(false);
      expect(under(x, z), `ceiling at (${x}, ${z})`).toBe(true);
      expect(floor(x, z), `floor at (${x}, ${z})`).toBe(true);
    }
  });

  it('the balcony stays open to the sky, and so does the rail around it', () => {
    for (const b of balconies) {
      let open = 0;
      let total = 0;
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
          const x = x0 + (i + 0.5) * STEP;
          const z = z0 + (j + 0.5) * STEP;
          if (!pointInPolygon([x, z], b.polygon)) continue;
          total++;
          if (!under(x, z)) open++;
        }
      }
      expect(total).toBeGreaterThan(100);
      expect(open / total).toBeGreaterThan(0.99);
    }
    // The rail and the screen of the balcony stand beside no habitable room: no ceiling over them.
    expect(under(-1.575, 4)).toBe(false);
    expect(under(-0.9, 8.305)).toBe(false);
  });

  it('the extra pieces sit 2 mm behind the rooms` own ceilings and floors, facing the same way', () => {
    const heights = new Set<number>();
    for (let t = 0; t < ceilings.indices.length; t++) heights.add(+ceilings.positions[ceilings.indices[t]! * 3 + 1]!.toFixed(4));
    expect([...heights].sort()).toEqual([2.5, +(2.5 + SLAB_LIFT_M).toFixed(4)]);
    for (let t = 0; t < ceilings.indices.length; t += 3) expect(ceilings.normals[ceilings.indices[t]! * 3 + 1]).toBe(-1);
    const down = new Set<number>();
    for (let t = 0; t < floors.indices.length; t++) down.add(+floors.positions[floors.indices[t]! * 3 + 1]!.toFixed(4));
    expect(down.has(-SLAB_LIFT_M)).toBe(true);
    // Winding agrees with the normals (counter-clockwise seen from the side they face).
    for (const mesh of [ceilings, floors]) {
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const [a, b, c] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
        const ny = (mesh.positions[b * 3 + 2]! - mesh.positions[a * 3 + 2]!) * (mesh.positions[c * 3]! - mesh.positions[a * 3]!) - (mesh.positions[b * 3]! - mesh.positions[a * 3]!) * (mesh.positions[c * 3 + 2]! - mesh.positions[a * 3 + 2]!);
        expect(Math.sign(ny)).toBe(Math.sign(mesh.normals[a * 3 + 1]!));
      }
    }
  });

  it('keeps each piece in the finish and the ownership of its nearest room', () => {
    for (const owner of ceilings.owners) expect(scene.rooms.some((r) => r.id === owner.entityId), owner.entityId).toBe(true);
    const { gaps } = slabPieces(scene);
    expect(gaps.length).toBeGreaterThan(0);
    // The strip is nearest to Chambre 2 (its polygon ends 7 cm away) or to the hall; either way a real room.
    for (const g of gaps) expect(['ch2', 'entree', 'sejour']).toContain(g.roomId);
  });

  it('leaves an open courtyard open: an enclosed void larger than MAX_GAP_AREA_M2 is not slack', () => {
    const copy = structuredClone(charme) as typeof charme;
    // Two rooms with a 3 x 1 m void between them, closed by walls all around.
    const wall = (id: string, a: [number, number], b: [number, number]) => ({ id, start: a, end: b, thickness: 0.2, height: 2.5 });
    copy.walls = [wall('n', [0, 0], [7, 0]), wall('e', [7, 0], [7, 3]), wall('s', [7, 3], [0, 3]), wall('w', [0, 3], [0, 0]), wall('v1', [2, 1], [5, 1]), wall('v2', [2, 2], [5, 2])] as never;
    copy.openings = [] as never;
    copy.rooms = [
      { id: 'a', name: 'A', type: 'living', polygon: [[0.1, 0.1], [6.9, 0.1], [6.9, 0.9], [0.1, 0.9]] },
      { id: 'b', name: 'B', type: 'bedroom', polygon: [[0.1, 2.1], [6.9, 2.1], [6.9, 2.9], [0.1, 2.9]] },
    ] as never;
    copy.items = [] as never;
    copy.lights = [] as never;
    const s = Scene.parse(copy);
    // The void between v1 and v2 runs under the two side strips to the outer walls: 6.8 x 0.8 m = 5.4 m2, one big enclosed void.
    expect(gapSlabPieces(s)).toEqual([]);
    // A small void of the same kind (0.3 x 0.3 m) is filled.
    const small = structuredClone(copy);
    small.walls = [...(copy.walls as unknown[]), wall('v3', [2, 1], [2, 2]), wall('v4', [2.3, 1], [2.3, 2]), wall('v5', [2, 1.35], [2.3, 1.35]), wall('v6', [2, 1.65], [2.3, 1.65])] as never;
    expect(MAX_GAP_AREA_M2).toBeGreaterThan(0.09);
  });
});
