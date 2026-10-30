import type { Room, Scene, Vec2 } from './schema';
import { polygonArea } from './measure';

/**
 * Finds the parts of a room polygon that are walled off from the rest of that room and open onto another
 * room (a cupboard recess drawn inside the neighbouring room's outline, like the TE cupboard of the Charme
 * flat), and the two outlines that fix it. Everything is exact on the "compressed grid": the distinct x and y
 * of every room vertex and wall face cut the plan into cells, and each cell is either wall, free, or in some
 * room. Only axis-aligned walls and rooms take part; others are ignored (the check stays silent for them).
 */

export interface ForeignRecess {
  roomId: string;
  /** The room the recess opens onto. */
  ontoRoomId: string;
  /** Area of the recess floor (walls excluded), m². */
  area: number;
  /** Outline of `roomId` without the recess and the wall cells around it; absent when it cannot be built exactly. */
  carved?: Vec2[];
  /** Outline of `ontoRoomId` with the recess added; absent when it cannot be built exactly. */
  grown?: Vec2[];
}

/** Recesses smaller than this floor area are ignored, m². */
export const RECESS_MIN_AREA = 0.03;
/** The recess must open onto another room over at least this much area, m². */
const ONTO_MIN_AREA = 0.1;
/** Largest gap (unassigned cells between the recess and the room it opens onto) that is added with it, m². */
const CHANNEL_MAX_AREA = 0.5;
/** Free cells of the carve rectangle that may belong to neither the recess nor a wall (corner slivers), m². */
const SLIVER_AREA = 0.002;
const MAX_CELLS = 250_000;
const KEY = 1e6;

const key = (v: number) => Math.round(v * KEY);

function axisAligned(a: Vec2, b: Vec2): boolean {
  return Math.abs(a[0] - b[0]) < 1e-9 || Math.abs(a[1] - b[1]) < 1e-9;
}

function rectilinear(polygon: readonly Vec2[]): boolean {
  return polygon.every((p, i) => axisAligned(p, polygon[(i + 1) % polygon.length]!));
}

function insideEvenOdd(x: number, y: number, polygon: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

interface Grid {
  xs: number[];
  ys: number[];
  nx: number;
  ny: number;
  wall: Uint8Array;
  /** Wall rectangles as inclusive-exclusive cell index ranges, with their thickness. */
  rects: { i0: number; i1: number; j0: number; j1: number; thickness: number }[];
  /** Per room (index into `rooms`), 1 where the cell centre is inside its polygon. */
  inRoom: Uint8Array[];
  area: (c: number) => number;
}

function axisValues(values: Iterable<number>): number[] {
  const byKey = new Map<number, number>();
  for (const v of values) if (!byKey.has(key(v))) byKey.set(key(v), v);
  return [...byKey.values()].sort((p, q) => p - q);
}

function buildGrid(scene: Scene, rooms: readonly Room[]): Grid | undefined {
  const rects: [number, number, number, number][] = [];
  for (const w of scene.walls) {
    const half = w.thickness / 2;
    if (Math.abs(w.start[0] - w.end[0]) < 1e-9) {
      rects.push([w.start[0] - half, Math.min(w.start[1], w.end[1]), w.start[0] + half, Math.max(w.start[1], w.end[1])]);
    } else if (Math.abs(w.start[1] - w.end[1]) < 1e-9) {
      rects.push([Math.min(w.start[0], w.end[0]), w.start[1] - half, Math.max(w.start[0], w.end[0]), w.start[1] + half]);
    }
  }
  const xs = axisValues([...rooms.flatMap((r) => r.polygon.map((p) => p[0])), ...rects.flatMap((r) => [r[0], r[2]])]);
  const ys = axisValues([...rooms.flatMap((r) => r.polygon.map((p) => p[1])), ...rects.flatMap((r) => [r[1], r[3]])]);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  if (nx < 1 || ny < 1 || nx * ny > MAX_CELLS) return undefined;
  const xi = new Map(xs.map((v, i) => [key(v), i]));
  const yi = new Map(ys.map((v, i) => [key(v), i]));
  const wall = new Uint8Array(nx * ny);
  const cellRects: Grid['rects'] = [];
  for (const [x0, y0, x1, y1] of rects) {
    const r = { i0: xi.get(key(x0))!, i1: xi.get(key(x1))!, j0: yi.get(key(y0))!, j1: yi.get(key(y1))!, thickness: Math.min(x1 - x0, y1 - y0) };
    cellRects.push(r);
    for (let j = r.j0; j < r.j1; j++) {
      for (let i = r.i0; i < r.i1; i++) wall[j * nx + i] = 1;
    }
  }
  const inRoom = rooms.map((room) => {
    const cells = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      const cy = (ys[j]! + ys[j + 1]!) / 2;
      for (let i = 0; i < nx; i++) {
        if (insideEvenOdd((xs[i]! + xs[i + 1]!) / 2, cy, room.polygon)) cells[j * nx + i] = 1;
      }
    }
    return cells;
  });
  return { xs, ys, nx, ny, wall, rects: cellRects, inRoom, area: (c) => (xs[(c % nx) + 1]! - xs[c % nx]!) * (ys[Math.floor(c / nx) + 1]! - ys[Math.floor(c / nx)]!) };
}

function neighbours(g: Grid, c: number): number[] {
  const i = c % g.nx;
  const j = Math.floor(c / g.nx);
  const out: number[] = [];
  if (i > 0) out.push(c - 1);
  if (i < g.nx - 1) out.push(c + 1);
  if (j > 0) out.push(c - g.nx);
  if (j < g.ny - 1) out.push(c + g.nx);
  return out;
}

function neighbours8(g: Grid, c: number): number[] {
  const i = c % g.nx;
  const j = Math.floor(c / g.nx);
  const out: number[] = [];
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      if ((di || dj) && i + di >= 0 && i + di < g.nx && j + dj >= 0 && j + dj < g.ny) out.push((j + dj) * g.nx + i + di);
    }
  }
  return out;
}

/** Cells reachable from `seeds` through cells where `allow` holds (4-connected). */
function flood(g: Grid, seeds: Iterable<number>, allow: (c: number) => boolean): Set<number> {
  const seen = new Set<number>();
  const stack: number[] = [];
  for (const s of seeds) {
    seen.add(s);
    stack.push(s);
  }
  while (stack.length) {
    const c = stack.pop()!;
    for (const n of neighbours(g, c)) {
      if (!seen.has(n) && allow(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return seen;
}

const sumArea = (g: Grid, cells: Iterable<number>) => {
  let a = 0;
  for (const c of cells) a += g.area(c);
  return a;
};

/**
 * Outline of a set of cells as one polygon, or undefined when it has holes, several parts, or touches itself at a
 * corner. Collinear vertices are removed; the winding follows `like` (the polygon being replaced).
 */
function trace(g: Grid, cells: ReadonlySet<number>, like: readonly Vec2[]): Vec2[] | undefined {
  // Directed boundary edges with the cell on the left (counter-clockwise in math axes), between lattice points.
  const next = new Map<number, number[]>();
  const point = (i: number, j: number) => j * (g.nx + 1) + i;
  const add = (from: number, to: number) => next.set(from, [...(next.get(from) ?? []), to]);
  const has = (i: number, j: number) => i >= 0 && j >= 0 && i < g.nx && j < g.ny && cells.has(j * g.nx + i);
  for (const c of cells) {
    const i = c % g.nx;
    const j = Math.floor(c / g.nx);
    if (!has(i, j - 1)) add(point(i, j), point(i + 1, j));
    if (!has(i + 1, j)) add(point(i + 1, j), point(i + 1, j + 1));
    if (!has(i, j + 1)) add(point(i + 1, j + 1), point(i, j + 1));
    if (!has(i - 1, j)) add(point(i, j + 1), point(i, j));
  }
  if (next.size === 0) return undefined;
  for (const outs of next.values()) if (outs.length !== 1) return undefined;
  const start = next.keys().next().value!;
  const loop: number[] = [];
  let at = start;
  do {
    loop.push(at);
    at = next.get(at)![0]!;
  } while (at !== start && loop.length <= next.size);
  if (loop.length !== next.size) return undefined; // more than one loop: holes or several parts
  const xy = (p: number): Vec2 => [Math.round(g.xs[p % (g.nx + 1)]! * 1e6) / 1e6, Math.round(g.ys[Math.floor(p / (g.nx + 1))]! * 1e6) / 1e6];
  const pts = loop.map(xy);
  const clean = pts.filter((p, i) => {
    const a = pts[(i + pts.length - 1) % pts.length]!;
    const b = pts[(i + 1) % pts.length]!;
    return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
  });
  if (clean.length < 4) return undefined;
  const signed = (poly: readonly Vec2[]) => poly.reduce((s, p, i) => s + (p[0] * poly[(i + 1) % poly.length]![1] - poly[(i + 1) % poly.length]![0] * p[1]), 0);
  return signed(clean) * signed(like) < 0 ? clean.reverse() : clean;
}

export function findForeignRecesses(scene: Scene): ForeignRecess[] {
  const rooms = scene.rooms.filter((r) => rectilinear(r.polygon) && polygonArea(r.polygon) > 0);
  if (rooms.length < 2) return [];
  const g = buildGrid(scene, rooms);
  if (!g) return [];
  const total = g.nx * g.ny;
  const found: ForeignRecess[] = [];
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri]!;
    // A closet inside a bedroom is part of the bedroom's official area (placard), so it is not a foreign recess.
    if (room.type === 'bedroom') continue;
    const mine = g.inRoom[ri]!;
    const freeInRoom: number[] = [];
    for (let c = 0; c < total; c++) if (mine[c] && !g.wall[c]) freeInRoom.push(c);
    // Free parts of the room, cut by walls.
    const parts: Set<number>[] = [];
    const taken = new Set<number>();
    for (const c of freeInRoom) {
      if (taken.has(c)) continue;
      const part = flood(g, [c], (n) => mine[n] === 1 && g.wall[n] === 0);
      part.forEach((n) => taken.add(n));
      parts.push(part);
    }
    if (parts.length < 2) continue;
    parts.sort((p, q) => sumArea(g, q) - sumArea(g, p));
    const main = parts[0]!;
    for (const pocket of parts.slice(1)) {
      const area = sumArea(g, pocket);
      if (area < RECESS_MIN_AREA) continue;
      const reach = flood(g, pocket, (n) => g.wall[n] === 0);
      if ([...main].some((c) => reach.has(c))) continue; // joined to the main part around the walls: an ordinary L-shaped room
      const open = openOnto(g, ri, pocket, rooms);
      if (!open || open.area < ONTO_MIN_AREA) continue;
      found.push({ roomId: room.id, ontoRoomId: rooms[open.room]!.id, area, ...outlines(g, ri, open.room, pocket, open.channel, rooms) });
    }
  }
  return found;
}

/** The room the pocket opens onto: the other room that borders the pocket (or the gap between it and the rooms) over the most area. */
function openOnto(g: Grid, ri: number, pocket: ReadonlySet<number>, rooms: readonly Room[]): { room: number; area: number; channel: Set<number> } | undefined {
  const anyRoom = (c: number) => g.inRoom.some((cells) => cells[c] === 1);
  // Gap between the pocket and the other room: free cells that belong to no room, in the strip the pocket opens along.
  const box = bounds(g, pocket);
  const opening = { up: 0, down: 0, left: 0, right: 0 };
  for (const c of pocket) {
    for (const n of neighbours(g, c)) {
      if (pocket.has(n) || g.wall[n] || anyRoom(n)) continue;
      const i = n % g.nx;
      const j = Math.floor(n / g.nx);
      // Width of the opening towards this side.
      const horizontal = g.xs[(c % g.nx) + 1]! - g.xs[c % g.nx]!;
      const vertical = g.ys[Math.floor(c / g.nx) + 1]! - g.ys[Math.floor(c / g.nx)]!;
      if (j < box.minJ) opening.up += horizontal;
      else if (j > box.maxJ) opening.down += horizontal;
      else if (i < box.minI) opening.left += vertical;
      else if (i > box.maxI) opening.right += vertical;
    }
  }
  // A slot narrower than 5 cm is a crack, not the way out.
  const strip = new Set((Object.keys(opening) as (keyof typeof opening)[]).filter((k) => opening[k] >= 0.05));
  const inStrip = (c: number) => {
    const i = c % g.nx;
    const j = Math.floor(c / g.nx);
    const across = i >= box.minI && i <= box.maxI;
    const along = j >= box.minJ && j <= box.maxJ;
    return (across && ((strip.has('up') && j < box.minJ) || (strip.has('down') && j > box.maxJ))) || (along && ((strip.has('left') && i < box.minI) || (strip.has('right') && i > box.maxI)));
  };
  const channel = flood(g, pocket, (c) => pocket.has(c) || (g.wall[c] === 0 && !anyRoom(c) && inStrip(c)));
  let best = -1;
  let bestArea = 0;
  for (let oi = 0; oi < rooms.length; oi++) {
    if (oi === ri) continue;
    const seen = new Set<number>();
    for (const c of channel) for (const n of neighbours(g, c)) if (g.inRoom[oi]![n] === 1 && g.wall[n] === 0) seen.add(n);
    const area = sumArea(g, seen);
    if (area > bestArea) {
      best = oi;
      bestArea = area;
    }
  }
  return best < 0 ? undefined : { room: best, area: bestArea, channel };
}

function bounds(g: Grid, cells: Iterable<number>) {
  const b = { minI: Infinity, maxI: -Infinity, minJ: Infinity, maxJ: -Infinity };
  for (const c of cells) {
    b.minI = Math.min(b.minI, c % g.nx);
    b.maxI = Math.max(b.maxI, c % g.nx);
    b.minJ = Math.min(b.minJ, Math.floor(c / g.nx));
    b.maxJ = Math.max(b.maxJ, Math.floor(c / g.nx));
  }
  return b;
}

function outlines(g: Grid, ri: number, oi: number, pocket: ReadonlySet<number>, channel: ReadonlySet<number>, rooms: readonly Room[]): { carved?: Vec2[]; grown?: Vec2[] } {
  const mine = g.inRoom[ri]!;
  if (sumArea(g, [...channel].filter((c) => !pocket.has(c))) > CHANNEL_MAX_AREA) return {};

  // The walls around the pocket go with it (their cells inside this room, near the pocket), so the outline follows their far faces.
  const carve = new Set(pocket);
  const pb = bounds(g, pocket);
  const touching = new Set<number>();
  for (const c of pocket) for (const n of neighbours8(g, c)) if (mine[n] && g.wall[n]) touching.add(n);
  for (const r of g.rects) {
    let adjacent = false;
    for (const c of touching) {
      const i = c % g.nx;
      const j = Math.floor(c / g.nx);
      if (i >= r.i0 && i < r.i1 && j >= r.j0 && j < r.j1) adjacent = true;
    }
    if (!adjacent) continue;
    const reachX = [g.xs[pb.minI]! - r.thickness - 1e-9, g.xs[pb.maxI + 1]! + r.thickness + 1e-9];
    const reachY = [g.ys[pb.minJ]! - r.thickness - 1e-9, g.ys[pb.maxJ + 1]! + r.thickness + 1e-9];
    for (let j = r.j0; j < r.j1; j++) {
      for (let i = r.i0; i < r.i1; i++) {
        const c = j * g.nx + i;
        if (!mine[c]) continue;
        const cx = (g.xs[i]! + g.xs[i + 1]!) / 2;
        const cy = (g.ys[j]! + g.ys[j + 1]!) / 2;
        if (cx >= reachX[0]! && cx <= reachX[1]! && cy >= reachY[0]! && cy <= reachY[1]!) carve.add(c);
      }
    }
  }
  const cb = bounds(g, carve);
  const minI = cb.minI, maxI = cb.maxI, minJ = cb.minJ, maxJ = cb.maxJ;
  const box = new Set<number>();
  let stray = 0;
  for (let j = minJ; j <= maxJ; j++) {
    for (let i = minI; i <= maxI; i++) {
      const c = j * g.nx + i;
      if (!mine[c]) continue;
      box.add(c);
      if (!g.wall[c] && !pocket.has(c)) stray += g.area(c);
    }
  }
  const carved = trace(g, new Set([...Array(g.nx * g.ny).keys()].filter((c) => mine[c] && !(stray <= SLIVER_AREA ? box.has(c) : carve.has(c)))), rooms[ri]!.polygon);
  const ontoCells = new Set([...Array(g.nx * g.ny).keys()].filter((c) => g.inRoom[oi]![c] === 1));
  for (const c of channel) ontoCells.add(c);
  const grown = trace(g, ontoCells, rooms[oi]!.polygon);
  return { ...(carved ? { carved } : {}), ...(grown ? { grown } : {}) };
}
