import { WALK_CLEARANCE_M } from '../assets/builtin';
import type { Opening, Vec2 } from '../schema';
import { distanceToSegment, pointInPolygon } from '../validate';
import { violation, type LayoutContext, type RoomInfo } from './constraints';
import { insideConvex, overlaps, type Bounds, type ItemBox } from './footprint';
import { isEntryDoor, openingFrame } from './swing';
import { WALKWAY_MIN_ENTRY_M, WALKWAY_MIN_M, type Violation } from './types';

/**
 * Walkway rule (D7): the doors of a room must be linked by a path at least `WALKWAY_MIN_M` wide (0.9 m when
 * the flat entry is involved). The floor is rasterised at 5 cm; a cell is walkable when its centre is inside
 * the room and under no blocking item; the walkable area is eroded by half the width (0.4 m) and the doors
 * must stay connected through the eroded area. Computed with an exact squared-distance transform, then a
 * widest-path search (union-find over cells by decreasing clearance), so the width reported is the narrowest
 * point of the widest route.
 *
 * A 5 cm raster cannot tell 0.79 m from 0.80 m (an even number of free cells loses a cell), so the raster width
 * is only a screen: a width within `REFINE_BAND_M` of the minimum is measured again where the route is
 * narrowest, with exact point-to-polygon distances on a 1 mm grid (exact for diagonals too).
 *
 * A room with ONE door has no route between doors. There the rule is: the strip in front of the door (door
 * wide, `ACCESS_DEPTH_M` deep) is free, and the floor stays in one piece at about 0.5 m of width -- the door
 * reaches `REACH_SHARE_MIN` of the floor that is wide enough to stand on, and the front of each window.
 */

export const RASTER_STEP_M = 0.05;
/** Tolerance of the exact width measurement (item poses are stored to 0.1 mm; 5 mm also absorbs the 1 mm search grid). */
const WIDTH_SLACK_M = 0.005;
/** Two analyses of the same room that differ by less than this are the same walkway (baseline comparison). */
const BASELINE_SLACK_M = 0.02;
/** Raster widths this close to the minimum are measured again exactly. */
const REFINE_BAND_M = 0.1;
/** Clearance (half the width) of the floor a person can stand on: about a 0.5 m wide path. */
const CONNECT_CLEARANCE_M = 0.25;
/** Share of the standable floor a one-door room must keep connected to its door. */
const REACH_SHARE_MIN = 0.8;
/** Windows are reached from this far in front of them, looking this far around. */
const WINDOW_REACH_M = 0.3;
/** Cells of the narrowest stretch of a route measured exactly. */
const MAX_EXACT_CELLS = 10;
/** Search radius around a door's inside point for the cell with the most room around it. */
const ACCESS_SEARCH_M = 0.2;
/** How far inside the room, from the wall face, the access point of a door lies. */
const ACCESS_DEPTH_M = 0.45;
/** Ceiling-hung items clear the walker above this height. */
const HEAD_CLEARANCE_M = 1.9;
/** Cells with less clearance than this (half of a 0.4 m path) are not used to connect doors. */
const MIN_ACTIVE_M = 0.2;

export interface DoorRef {
  openingId: string;
  entry: boolean;
  /** Nominal inside point, ACCESS_DEPTH_M from the wall face. */
  access: Vec2;
  /** The strip in front of the door that must stay free: door wide (less 1 cm a side), ACCESS_DEPTH_M deep. */
  strip: Vec2[];
  width: number;
}

export interface WalkwayAnalysis {
  /** Free floor in m2 (walkable cells, before erosion). */
  freeAreaM2: number;
  /** Narrowest width of the widest route linking the doors, in metres (undefined for a room with no door). */
  minWidthM?: number;
  /** One-door rooms: how much of the standable floor the door reaches (0..1; 0 when its strip is blocked). */
  reach?: number;
  violation?: Violation;
}

/** Does the box get in the way of someone walking? Floor coverings and things hung high do not. */
export function blocksWalking(b: Pick<ItemBox, 'flat' | 'mount' | 'bottom'>): boolean {
  if (b.flat) return false;
  if (b.mount === 'wall') return b.bottom < WALK_CLEARANCE_M;
  if (b.mount === 'ceiling') return b.bottom < HEAD_CLEARANCE_M;
  return true;
}

const doorCache = new WeakMap<LayoutContext, Map<string, DoorRef[]>>();

/** The doors and passages of a room, entry door first, then in scene order. */
export function roomDoors(ctx: LayoutContext, roomId: string): DoorRef[] {
  let byRoom = doorCache.get(ctx);
  if (!byRoom) {
    byRoom = new Map();
    doorCache.set(ctx, byRoom);
  }
  const hit = byRoom.get(roomId);
  if (hit) return hit;
  const out: DoorRef[] = [];
  for (const o of ctx.scene.openings as Opening[]) {
    if (o.type === 'window') continue;
    const f = openingFrame(ctx.scene, o);
    if (!f) continue;
    let n: Vec2 | undefined;
    if (f.leftRoom?.id === roomId && f.rightRoom?.id !== roomId) n = f.left;
    else if (f.rightRoom?.id === roomId && f.leftRoom?.id !== roomId) n = [-f.left[0], -f.left[1]];
    if (!n) continue;
    const t = f.wall.thickness / 2;
    const k = t + ACCESS_DEPTH_M;
    const half = Math.max(0.05, o.width / 2 - 0.01);
    const at = (along: number, out: number): Vec2 => [f.centre[0] + f.dir[0] * along + n[0] * out, f.centre[1] + f.dir[1] * along + n[1] * out];
    out.push({
      openingId: o.id,
      entry: isEntryDoor(o, f),
      access: [f.centre[0] + n[0] * k, f.centre[1] + n[1] * k],
      width: o.width,
      strip: [at(-half, t), at(half, t), at(half, k), at(-half, k)],
    });
  }
  out.sort((a, b) => Number(b.entry) - Number(a.entry));
  byRoom.set(roomId, out);
  return out;
}

const windowCache = new WeakMap<LayoutContext, Map<string, { openingId: string; front: Vec2 }[]>>();

/** In front of each window of a room (inside point, ACCESS_DEPTH_M from the wall face). */
function roomWindows(ctx: LayoutContext, roomId: string): { openingId: string; front: Vec2 }[] {
  let byRoom = windowCache.get(ctx);
  if (!byRoom) {
    byRoom = new Map();
    windowCache.set(ctx, byRoom);
  }
  const hit = byRoom.get(roomId);
  if (hit) return hit;
  const out: { openingId: string; front: Vec2 }[] = [];
  for (const o of ctx.scene.openings as Opening[]) {
    if (o.type !== 'window') continue;
    const f = openingFrame(ctx.scene, o);
    if (!f) continue;
    let n: Vec2 | undefined;
    if (f.leftRoom?.id === roomId) n = f.left;
    else if (f.rightRoom?.id === roomId) n = [-f.left[0], -f.left[1]];
    if (!n) continue;
    const k = f.wall.thickness / 2 + ACCESS_DEPTH_M;
    out.push({ openingId: o.id, front: [f.centre[0] + n[0] * k, f.centre[1] + n[1] * k] });
  }
  byRoom.set(roomId, out);
  return out;
}

/** Marks `inside[i + j*nx]` for cell centres inside the polygon (even-odd scanline). */
function rasterise(polygon: readonly Vec2[], x0: number, y0: number, nx: number, ny: number, step: number): Uint8Array {
  const inside = new Uint8Array(nx * ny);
  const n = polygon.length;
  const xs: number[] = [];
  for (let j = 0; j < ny; j++) {
    const y = y0 + (j + 0.5) * step;
    xs.length = 0;
    for (let k = 0; k < n; k++) {
      const a = polygon[k]!;
      const b = polygon[(k + 1) % n]!;
      if (a[1] > y !== b[1] > y) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil((xs[k]! - x0) / step - 0.5));
      const to = Math.min(nx - 1, Math.floor((xs[k + 1]! - x0) / step - 0.5));
      for (let i = from; i <= to; i++) inside[i + j * nx] = 1;
    }
  }
  return inside;
}

/** Squared distance (in cells) from every cell to the nearest 0 cell (Felzenszwalb & Huttenlocher). */
function squaredDistance(free: Uint8Array, nx: number, ny: number): Float64Array {
  const INF = 1e12;
  const d = new Float64Array(nx * ny);
  for (let i = 0; i < d.length; i++) d[i] = free[i] ? INF : 0;
  const size = Math.max(nx, ny);
  const f = new Float64Array(size);
  const out = new Float64Array(size);
  const v = new Int32Array(size);
  const z = new Float64Array(size + 1);
  const BIG = 1e20;
  const pass = (len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -BIG;
    z[1] = BIG;
    for (let q = 1; q < len; q++) {
      let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) {
        k--;
        s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = BIG;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1]! < q) k++;
      const p = v[k]!;
      out[q] = (q - p) * (q - p) + f[p]!;
    }
  };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) f[j] = d[i + j * nx]!;
    pass(ny);
    for (let j = 0; j < ny; j++) d[i + j * nx] = out[j]!;
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) f[i] = d[i + j * nx]!;
    pass(nx);
    for (let i = 0; i < nx; i++) d[i + j * nx] = out[i]!;
  }
  return d;
}

/**
 * Width of the free run through a cell whose squared distance to the nearest blocked cell is `d2` (cells^2). An even
 * number of free cells puts the cell off-centre and reads one cell short, an odd one reads right; a quarter cell on
 * the clearance splits the difference. Only a screen: see the header.
 */
const rasterWidthM = (d2: number, step: number): number => (d2 <= 0 ? 0 : Math.max(0, 2 * Math.sqrt(d2) - 0.5) * step);

interface Solid {
  poly: readonly Vec2[];
  bounds: Bounds;
}

/** Exact distance from a point to the nearest wall / blocking item / room edge; 0 inside any of them or outside the room. */
function exactClearance(x: number, y: number, near: readonly Solid[], room: readonly Vec2[]): number {
  const p: Vec2 = [x, y];
  let best = Infinity;
  for (const s of near) {
    if (insideConvex(p, s.poly)) return 0;
    const n = s.poly.length;
    for (let i = 0; i < n; i++) {
      const d = distanceToSegment(p, s.poly[i]!, s.poly[(i + 1) % n]!);
      if (d < best) best = d;
    }
  }
  if (!pointInPolygon(p, room, 0)) return 0;
  const n = room.length;
  for (let i = 0; i < n; i++) {
    const d = distanceToSegment(p, room[i]!, room[(i + 1) % n]!);
    if (d < best) best = d;
  }
  return best;
}

/** Widest free run (twice the largest exact clearance) in the neighbourhood of a raster cell centre. */
function exactWidthAround(cx: number, cy: number, solids: readonly Solid[], room: readonly Vec2[], step: number): number {
  const pad = 1;
  const near = solids.filter((s) => s.bounds.minX <= cx + pad && s.bounds.maxX >= cx - pad && s.bounds.minY <= cy + pad && s.bounds.maxY >= cy - pad);
  const search = (ox: number, oy: number, half: number, h: number): { x: number; y: number; c: number } => {
    let best = { x: ox, y: oy, c: -1 };
    const n = Math.round(half / h);
    for (let j = -n; j <= n; j++) {
      for (let i = -n; i <= n; i++) {
        const x = ox + i * h;
        const y = oy + j * h;
        const c = exactClearance(x, y, near, room);
        if (c > best.c) best = { x, y, c };
      }
    }
    return best;
  };
  // the ridge of the free run can be up to a cell from the cell centre (even run lengths): look that far
  const coarse = search(cx, cy, step, 0.0125);
  const fine = search(coarse.x, coarse.y, 0.0125, 0.0025);
  return 2 * fine.c;
}

/**
 * Walkway analysis of one room. `extra` is a candidate item treated like a placed one; items for which `skip` is true
 * (the one being moved) is left out via `skip`.
 */
export function analyzeWalkways(ctx: LayoutContext, info: RoomInfo, extra?: ItemBox, skip?: (b: ItemBox) => boolean): WalkwayAnalysis {
  const step = RASTER_STEP_M;
  const b = info.bounds;
  const x0 = b.minX - step;
  const y0 = b.minY - step;
  const nx = Math.ceil((b.maxX - b.minX) / step) + 2;
  const ny = Math.ceil((b.maxY - b.minY) / step) + 2;
  const free = rasterise(info.room.polygon, x0, y0, nx, ny, step);
  const solids: Solid[] = [];
  const mark = (poly: readonly Vec2[], bounds: Bounds) => {
    solids.push({ poly, bounds });
    const i0 = Math.max(0, Math.floor((bounds.minX - x0) / step - 0.5));
    const i1 = Math.min(nx - 1, Math.ceil((bounds.maxX - x0) / step - 0.5));
    const j0 = Math.max(0, Math.floor((bounds.minY - y0) / step - 0.5));
    const j1 = Math.min(ny - 1, Math.ceil((bounds.maxY - y0) / step - 0.5));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (free[i + j * nx] && insideConvex([x0 + (i + 0.5) * step, y0 + (j + 0.5) * step], poly)) free[i + j * nx] = 0;
      }
    }
  };
  const touches = (o: Bounds) => o.minX <= b.maxX && o.maxX >= b.minX && o.minY <= b.maxY && o.maxY >= b.minY;
  for (const w of ctx.walls) if (touches(w.bounds)) mark(w.polygon, w.bounds);
  const blockers = ctx.boxes.filter((bx) => !(skip?.(bx)) && blocksWalking(bx) && touches(bx.bounds));
  if (extra && blocksWalking(extra) && touches(extra.bounds)) blockers.push(extra);
  for (const bx of blockers) mark(bx.footprint, bx.bounds);

  let freeCells = 0;
  for (let i = 0; i < free.length; i++) freeCells += free[i]!;
  const freeAreaM2 = Math.round(freeCells * step * step * 100) / 100;

  const doors = roomDoors(ctx, info.room.id);
  if (doors.length === 0) return { freeAreaM2 };

  const d2 = squaredDistance(free, nx, ny);
  const cellCentre = (idx: number): Vec2 => {
    const i = idx % nx;
    return [x0 + (i + 0.5) * step, y0 + ((idx - i) / nx + 0.5) * step];
  };
  // access cell of each door: the roomiest cell around its inside point
  const bestCellAround = (p: Vec2, radius: number): number => {
    const reach = Math.ceil(radius / step);
    const ci = Math.round((p[0] - x0) / step - 0.5);
    const cj = Math.round((p[1] - y0) / step - 0.5);
    let best = -1;
    let bestD = -1;
    for (let j = Math.max(0, cj - reach); j <= Math.min(ny - 1, cj + reach); j++) {
      for (let i = Math.max(0, ci - reach); i <= Math.min(nx - 1, ci + reach); i++) {
        const v = d2[i + j * nx]!;
        if (v > bestD) {
          bestD = v;
          best = i + j * nx;
        }
      }
    }
    return best;
  };
  const access = doors.map((d) => bestCellAround(d.access, ACCESS_SEARCH_M));

  if (doors.length === 1) return oneDoor(ctx, info, doors[0]!, access[0]!, { d2, nx, ny, step, blockers, bestCellAround, freeAreaM2 });

  const widths: number[] = new Array<number>(doors.length).fill(0);
  /** Up to MAX_EXACT_CELLS cells around `start` (8-connected) with the same squared distance: the stretch of equal width. */
  const sameLevelRun = (start: number, level: number): number[] => {
    const run = [start];
    const seenRun = new Set<number>(run);
    for (let q = 0; q < run.length && run.length < MAX_EXACT_CELLS; q++) {
      const i = run[q]! % nx;
      const j = (run[q]! - i) / nx;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const n = ii + jj * nx;
          if (d2[n] === level && !seenRun.has(n) && run.length < MAX_EXACT_CELLS) {
            seenRun.add(n);
            run.push(n);
          }
        }
      }
    }
    return run;
  };
  // cells where the route to each door is narrowest (candidates for the exact measurement)
  const narrowest: number[][] = doors.map(() => []);
  {
    // widest path from the first door to every other: activate cells by decreasing clearance
    const total = nx * ny;
    // counting sort of the cells with clearance by decreasing squared distance (integers); cells under
    // MIN_ACTIVE_M are never walked through, so routes narrower than twice that read as "not connected"
    const minD2 = Math.pow(MIN_ACTIVE_M / step + 0.5, 2);
    let maxD2 = 0;
    for (let i = 0; i < total; i++) if (d2[i]! > maxD2) maxD2 = d2[i]!;
    const counts = new Int32Array(maxD2 + 2);
    for (let i = 0; i < total; i++) if (d2[i]! >= minD2) counts[d2[i]!]!++;
    const starts = new Int32Array(maxD2 + 2);
    let acc = 0;
    for (let v = maxD2; v >= 1; v--) {
      starts[v] = acc;
      acc += counts[v]!;
    }
    const order = new Int32Array(acc);
    const fill = starts.slice();
    for (let i = 0; i < total; i++) if (d2[i]! >= minD2) order[fill[d2[i]!]!++] = i;
    const parent = new Int32Array(total).fill(-1);
    const find = (x: number): number => {
      let r = x;
      while (parent[r]! !== r) r = parent[r]!;
      while (parent[x]! !== r) {
        const nxt = parent[x]!;
        parent[x] = r;
        x = nxt;
      }
      return r;
    };
    const resolved = new Array<boolean>(doors.length).fill(false);
    let pending = doors.length - 1;
    let g = 0;
    while (g < acc && pending > 0) {
      const level = d2[order[g]!]!;
      let h = g;
      while (h < acc && d2[order[h]!]! === level) {
        const idx = order[h]!;
        parent[idx] = idx;
        const i = idx % nx;
        const j = (idx - i) / nx;
        let merged = false;
        const join = (n: number) => {
          const rn = find(n);
          const ri = find(idx);
          if (rn !== ri) {
            parent[rn] = ri;
            merged = true;
          }
        };
        if (i > 0 && parent[idx - 1]! >= 0) join(idx - 1);
        if (i < nx - 1 && parent[idx + 1]! >= 0) join(idx + 1);
        if (j > 0 && parent[idx - nx]! >= 0) join(idx - nx);
        if (j < ny - 1 && parent[idx + nx]! >= 0) join(idx + nx);
        // the cell that links a door to the first one is on the narrowest stretch of the route
        const root = merged && access[0]! >= 0 && parent[access[0]!]! >= 0 ? find(access[0]!) : -1;
        if (root >= 0) {
          for (let k = 1; k < doors.length; k++) {
            if (resolved[k] || access[k]! < 0 || parent[access[k]!]! < 0) continue;
            if (find(access[k]!) === root) {
              resolved[k] = true;
              widths[k] = rasterWidthM(level, step);
              narrowest[k] = sameLevelRun(idx, level);
              pending--;
            }
          }
        }
        h++;
      }
      g = h;
    }
  }

  const need = doors[0]!.entry ? WALKWAY_MIN_ENTRY_M : WALKWAY_MIN_M;
  // near the minimum the raster cannot decide: measure the narrowest point of the route exactly
  for (let k = 1; k < doors.length; k++) {
    if (Math.abs(widths[k]! - need) >= REFINE_BAND_M || narrowest[k]!.length === 0) continue;
    // each cell sees the widest point near it; the narrowest of them is the route's bottleneck (mouths read wider)
    let narrow = Infinity;
    for (const c of narrowest[k]!) {
      const at = cellCentre(c);
      narrow = Math.min(narrow, exactWidthAround(at[0], at[1], solids, info.room.polygon, step));
    }
    widths[k] = narrow;
  }
  widths[0] = Math.min(...widths.slice(1));

  let worst = Infinity;
  let bad: { door: DoorRef; width: number; other?: DoorRef } | undefined;
  for (let k = 1; k < doors.length; k++) {
    if (widths[k]! < worst) worst = widths[k]!;
    if (!bad && widths[k]! < need - WIDTH_SLACK_M) bad = { door: doors[k]!, width: widths[k]!, other: doors[0]! };
  }
  const minWidthM = Math.round(worst * 100) / 100;
  if (!bad) return { freeAreaM2, minWidthM };
  const route = `between "${bad.other!.openingId}" and "${bad.door.openingId}"`;
  const entry = doors[0]!.entry && (bad.door.entry || bad.other?.entry);
  const ids = [info.room.id, bad.door.openingId, bad.other!.openingId];
  return {
    freeAreaM2,
    minWidthM,
    violation: violation(
      'walkway_too_narrow',
      `the walkway ${route} is only ${Math.round(bad.width * 100) / 100} m wide in "${info.room.name}" (minimum ${need} m${entry ? ', the flat entry needs 0.9 m' : ''})`,
      ids,
    ),
  };
}

interface RasterView {
  d2: Float64Array;
  nx: number;
  ny: number;
  step: number;
  blockers: ItemBox[];
  bestCellAround: (p: Vec2, radius: number) => number;
  freeAreaM2: number;
}

/**
 * A room with one door: no route to measure, so the door must open onto free floor (the strip in front of it is clear)
 * and that floor must be most of what a person can stand on, windows included.
 */
function oneDoor(ctx: LayoutContext, info: RoomInfo, door: DoorRef, accessCell: number, r: RasterView): WalkwayAnalysis {
  const { d2, nx, ny, step } = r;
  const minWidthM = Math.round((accessCell >= 0 ? rasterWidthM(d2[accessCell]!, step) : 0) * 100) / 100;
  const fail = (message: string, ids: string[], reach: number): WalkwayAnalysis => ({
    freeAreaM2: r.freeAreaM2,
    minWidthM,
    reach,
    violation: violation('walkway_too_narrow', message, [info.room.id, door.openingId, ...ids]),
  });

  const blocking = r.blockers.filter((bx) => overlaps(door.strip, bx.footprint, 0.01));
  if (blocking.length > 0) {
    return fail(
      `the ${Math.round(door.width * 100) / 100} m strip in front of "${door.openingId}" in "${info.room.name}" is blocked by ${blocking.map((x) => `"${x.id || 'the item'}"`).join(', ')}`,
      blocking.map((x) => x.id).filter((id) => id !== ''),
      0,
    );
  }

  // floor that is wide enough to stand on, and the part of it the door reaches
  const minUse = Math.pow(CONNECT_CLEARANCE_M / step + 0.5, 2);
  const total = nx * ny;
  let usable = 0;
  for (let i = 0; i < total; i++) if (d2[i]! >= minUse) usable++;
  if (usable === 0) return { freeAreaM2: r.freeAreaM2, minWidthM, reach: 1 };

  const seen = new Uint8Array(total);
  let reached = 0;
  if (accessCell >= 0 && d2[accessCell]! >= minUse) {
    const queue = new Int32Array(usable);
    let head = 0;
    let tail = 0;
    queue[tail++] = accessCell;
    seen[accessCell] = 1;
    while (head < tail) {
      const idx = queue[head++]!;
      reached++;
      const i = idx % nx;
      const j = (idx - i) / nx;
      const visit = (n: number) => {
        if (!seen[n] && d2[n]! >= minUse) {
          seen[n] = 1;
          queue[tail++] = n;
        }
      };
      if (i > 0) visit(idx - 1);
      if (i < nx - 1) visit(idx + 1);
      if (j > 0) visit(idx - nx);
      if (j < ny - 1) visit(idx + nx);
    }
  }
  const share = reached / usable;
  const cut: string[] = [];
  for (const w of roomWindows(ctx, info.room.id)) {
    const cell = r.bestCellAround(w.front, WINDOW_REACH_M);
    if (cell >= 0 && d2[cell]! >= minUse && !seen[cell]) cut.push(w.openingId);
  }
  const reach = Math.round(Math.min(share, cut.length > 0 ? 0.5 : 1) * 100) / 100;
  if (share < REACH_SHARE_MIN || cut.length > 0) {
    const pct = Math.round((1 - share) * 100);
    const what = share < REACH_SHARE_MIN ? `cuts ${pct}% of the floor of "${info.room.name}" off from "${door.openingId}"` : `leaves ${cut.map((x) => `"${x}"`).join(', ')} out of reach of "${door.openingId}"`;
    return fail(`the layout ${what}: keep a path about 0.6 m wide to every part of the room${share < REACH_SHARE_MIN && cut.length > 0 ? ` and to the windows ${cut.map((x) => `"${x}"`).join(', ')}` : ''}`, cut, reach);
  }
  return { freeAreaM2: r.freeAreaM2, minWidthM, reach };
}

/**
 * The walkway verdict for a layout: a violation only when the layout makes the room's walkways too narrow.
 * A room that is already too narrow without the items in question (`baseline`) is not blamed on them unless
 * they narrow it further.
 */
export function walkwayVerdict(
  ctx: LayoutContext,
  info: RoomInfo,
  options: { candidate?: ItemBox; skip?: (b: ItemBox) => boolean; baselineSkip: (b: ItemBox) => boolean },
): WalkwayAnalysis {
  const current = analyzeWalkways(ctx, info, options.candidate, options.skip);
  if (!current.violation) return current;
  const baseline = analyzeWalkways(ctx, info, undefined, options.baselineSkip);
  const notWorse =
    current.reach !== undefined && baseline.reach !== undefined
      ? current.reach >= baseline.reach - 0.02
      : current.minWidthM !== undefined && baseline.minWidthM !== undefined && current.minWidthM >= baseline.minWidthM - BASELINE_SLACK_M;
  if (baseline.violation && notWorse) {
    const { violation: _drop, ...rest } = current;
    void _drop;
    return rest;
  }
  return current;
}
