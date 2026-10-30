import type { Room, Scene, Vec2 } from '../schema';
import { wallLength } from '../schema';
import { wallSideRooms } from '../lighting/daylight';

/**
 * The continuous slab of the flat. Ceilings (and floors) are built per room polygon, which leaves the strips that belong to no room:
 * the top of every wall, and whatever the polygons and the walls leave between them (a placard front, a recess, a slack of a few
 * cm). The sun and the sky come in through every one of them. The slab closes them: the footprint of the flat is the union of the
 * habitable rooms and of the walls that stand beside them, closed to the outer perimeter (a gap the outside cannot reach is inside
 * the flat), and every part of it that no room ceiling covers gets a piece of ceiling. The balcony is outdoors and stays open.
 *
 * The pieces carry the room they are nearest to (their finish, their picking, their sky ambient) and sit `SLAB_LIFT_M` away
 * from the room surfaces, so where they overlap a room ceiling or floor the room's own surface is the nearer one.
 */

/** How far (metres) the slab pieces sit behind the room surfaces they overlap (above the ceilings, below the floors). */
export const SLAB_LIFT_M = 0.002;
/** Resolution (metres) of the raster that finds the gaps. */
const CELL_M = 0.02;
/** Most cells of that raster; a very large plan is rasterized more coarsely. */
const MAX_CELLS = 4_000_000;
/** An enclosed gap larger than this (m2) is a courtyard or a shaft, not slack in the drawing: it is left open. */
export const MAX_GAP_AREA_M2 = 2;

export interface SlabPiece {
  /** Axis-aligned or oriented rectangle, four corners in order, plan coordinates. */
  corners: [Vec2, Vec2, Vec2, Vec2];
  /** The room whose finish and ownership the piece takes. */
  roomId: string;
}

const isHabitable = (r: Room) => r.type !== 'balcony';

/** Rectangle of a stretch of wall (from, to along the centreline) with its ends extended by half the thickness, so walls meeting at a corner leave no gap. */
function stretchCorners(wall: Scene['walls'][number], from: number, to: number): [Vec2, Vec2, Vec2, Vec2] {
  const len = wallLength(wall);
  const ux = (wall.end[0] - wall.start[0]) / len;
  const uz = (wall.end[1] - wall.start[1]) / len;
  const h = wall.thickness / 2;
  const a = from - h;
  const b = to + h;
  const at = (s: number, d: number): Vec2 => [wall.start[0] + ux * s - uz * d, wall.start[1] + uz * s + ux * d];
  return [at(a, -h), at(b, -h), at(b, h), at(a, h)];
}

/**
 * The stretches of the walls that stand beside a habitable room (a room on either face), as rectangles with the room each takes.
 * A wall around the balcony (the rail, the screen) or the part of a facade wall that runs past the flat has no habitable room beside
 * it and is not part of the slab. Consecutive stretches are merged, and a gap of less than 30 cm between two of them is bridged.
 */
export function wallSlabPieces(scene: Pick<Scene, 'walls' | 'rooms' | 'openings' | 'materials'>): SlabPiece[] {
  const habitable = new Set(scene.rooms.filter(isHabitable).map((r) => r.id));
  const sides = wallSideRooms(scene as Scene);
  const out: SlabPiece[] = [];
  for (const wall of scene.walls) {
    if (wallLength(wall) < 1e-6) continue;
    const runs: { from: number; to: number; roomId: string }[] = [];
    for (const s of sides[wall.id]?.segments ?? []) {
      const roomId = [s.left, s.right].find((id): id is string => id !== undefined && habitable.has(id));
      if (!roomId) continue;
      const last = runs[runs.length - 1];
      if (last && s.from - last.to < 0.3) last.to = s.to;
      else runs.push({ from: s.from, to: s.to, roomId });
    }
    for (const r of runs) out.push({ corners: stretchCorners(wall, r.from, r.to), roomId: r.roomId });
  }
  return out;
}

/** Scanline fill (even-odd, cell centres) of a polygon into `grid` with `value`. */
function fillPolygon(grid: Uint8Array, w: number, h: number, x0: number, z0: number, cell: number, polygon: readonly Vec2[], value: number): void {
  if (polygon.length < 3) return;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const p of polygon) {
    zMin = Math.min(zMin, p[1]);
    zMax = Math.max(zMax, p[1]);
  }
  const j0 = Math.max(0, Math.floor((zMin - z0) / cell));
  const j1 = Math.min(h - 1, Math.ceil((zMax - z0) / cell));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const z = z0 + (j + 0.5) * cell;
    xs.length = 0;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!;
      const b = polygon[(i + 1) % polygon.length]!;
      if (a[1] > z === b[1] > z) continue;
      xs.push(a[0] + ((z - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k]! - x0) / cell - 0.5));
      const i1 = Math.min(w - 1, Math.floor((xs[k + 1]! - x0) / cell - 0.5));
      for (let i = i0; i <= i1; i++) grid[i + j * w] = value;
    }
  }
}

/** Distance (metres) from a point to a polygon outline. */
function distanceToPolygon(p: Vec2, polygon: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz)));
  }
  return best;
}

/**
 * The parts of the flat's footprint that neither a habitable room nor a wall beside one covers and the outside cannot reach (the
 * balcony counts as outside): a placard front between two polygons, a recess, a slack. Found on a raster of the plan, flood-filled
 * from its border and from the balconies; each enclosed gap of at most `MAX_GAP_AREA_M2` becomes rectangles, grown by one cell so
 * they overlap what they join, each taking the nearest habitable room.
 */
export function gapSlabPieces(scene: Pick<Scene, 'walls' | 'rooms' | 'openings' | 'materials'>, covering: readonly SlabPiece[] = wallSlabPieces(scene)): SlabPiece[] {
  const rooms = scene.rooms.filter(isHabitable);
  if (rooms.length === 0) return [];
  let xMin = Infinity;
  let zMin = Infinity;
  let xMax = -Infinity;
  let zMax = -Infinity;
  const take = (p: Vec2) => {
    xMin = Math.min(xMin, p[0]);
    xMax = Math.max(xMax, p[0]);
    zMin = Math.min(zMin, p[1]);
    zMax = Math.max(zMax, p[1]);
  };
  for (const r of scene.rooms) r.polygon.forEach(take);
  for (const p of covering) p.corners.forEach(take);
  if (!(xMax > xMin) || !(zMax > zMin)) return [];
  const margin = 0.5;
  xMin -= margin;
  zMin -= margin;
  xMax += margin;
  zMax += margin;
  let cell = CELL_M;
  while (((xMax - xMin) / cell) * ((zMax - zMin) / cell) > MAX_CELLS) cell *= 1.5;
  const w = Math.ceil((xMax - xMin) / cell);
  const h = Math.ceil((zMax - zMin) / cell);
  // 0 free, 1 covered by a room or a wall beside one, 2 balcony.
  const grid = new Uint8Array(w * h);
  for (const r of scene.rooms) if (!isHabitable(r)) fillPolygon(grid, w, h, xMin, zMin, cell, r.polygon, 2);
  for (const r of rooms) fillPolygon(grid, w, h, xMin, zMin, cell, r.polygon, 1);
  for (const p of covering) fillPolygon(grid, w, h, xMin, zMin, cell, p.corners, 1);

  // Flood fill the outside: the border of the raster and the balconies, through free cells.
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let c = 0; c < w * h; c++) {
    const i = c % w;
    const j = (c - i) / w;
    if (grid[c] === 2 || ((i === 0 || j === 0 || i === w - 1 || j === h - 1) && grid[c] !== 1)) stack.push(c);
  }
  while (stack.length > 0) {
    const c = stack.pop()!;
    if (outside[c] || grid[c] === 1) continue;
    outside[c] = 1;
    const i = c % w;
    const j = (c - i) / w;
    if (i > 0) stack.push(c - 1);
    if (i < w - 1) stack.push(c + 1);
    if (j > 0) stack.push(c - w);
    if (j < h - 1) stack.push(c + w);
  }

  // Enclosed free cells, grouped in connected gaps.
  const out: SlabPiece[] = [];
  const label = new Int32Array(w * h);
  let labels = 0;
  for (let start = 0; start < w * h; start++) {
    if (grid[start] !== 0 || outside[start] || label[start]) continue;
    labels++;
    const cells: number[] = [];
    const todo = [start];
    while (todo.length > 0) {
      const c = todo.pop()!;
      if (label[c] || grid[c] !== 0 || outside[c]) continue;
      label[c] = labels;
      cells.push(c);
      const i = c % w;
      const j = (c - i) / w;
      if (i > 0) todo.push(c - 1);
      if (i < w - 1) todo.push(c + 1);
      if (j > 0) todo.push(c - w);
      if (j < h - 1) todo.push(c + w);
    }
    if (cells.length * cell * cell > MAX_GAP_AREA_M2) continue;
    // Row runs, merged downwards when a run repeats exactly in the next row: a few rectangles per gap.
    const rows = new Map<number, [number, number][]>();
    for (const c of cells.sort((p, q) => p - q)) {
      const i = c % w;
      const j = (c - i) / w;
      const row = rows.get(j) ?? [];
      const last = row[row.length - 1];
      if (last && last[1] === i - 1) last[1] = i;
      else row.push([i, i]);
      rows.set(j, row);
    }
    const open = new Map<string, { i0: number; i1: number; j0: number; j1: number }>();
    const rects: { i0: number; i1: number; j0: number; j1: number }[] = [];
    for (const j of [...rows.keys()].sort((p, q) => p - q)) {
      const keep = new Map<string, { i0: number; i1: number; j0: number; j1: number }>();
      for (const [i0, i1] of rows.get(j)!) {
        const key = `${i0}:${i1}`;
        const above = open.get(key);
        if (above && above.j1 === j - 1) {
          above.j1 = j;
          keep.set(key, above);
          open.delete(key);
        } else {
          const rect = { i0, i1, j0: j, j1: j };
          rects.push(rect);
          keep.set(key, rect);
        }
      }
      open.clear();
      for (const [k, v] of keep) open.set(k, v);
    }
    for (const r of rects) {
      // Grown by one cell on every side so the piece overlaps the room or the wall it joins.
      const a = xMin + (r.i0 - 1) * cell;
      const b = xMin + (r.i1 + 2) * cell;
      const c = zMin + (r.j0 - 1) * cell;
      const d = zMin + (r.j1 + 2) * cell;
      const centre: Vec2 = [(a + b) / 2, (c + d) / 2];
      let nearest = rooms[0]!;
      let nearestD = Infinity;
      for (const room of rooms) {
        const dist = distanceToPolygon(centre, room.polygon);
        if (dist < nearestD) {
          nearestD = dist;
          nearest = room;
        }
      }
      out.push({ corners: [[a, c], [b, c], [b, d], [a, d]], roomId: nearest.id });
    }
  }
  return out;
}

/** Every extra piece of the slab: the walls beside a habitable room and the enclosed gaps. */
export function slabPieces(scene: Pick<Scene, 'walls' | 'rooms' | 'openings' | 'materials'>): { walls: SlabPiece[]; gaps: SlabPiece[] } {
  let found = cache.get(scene);
  if (!found) {
    const walls = wallSlabPieces(scene);
    cache.set(scene, (found = { walls, gaps: gapSlabPieces(scene, walls) }));
  }
  return found;
}

/** Scenes are immutable values: the ceilings and the floors of one scene share its slab. */
const cache = new WeakMap<object, { walls: SlabPiece[]; gaps: SlabPiece[] }>();
