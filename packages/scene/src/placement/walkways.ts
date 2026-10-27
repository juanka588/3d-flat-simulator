import { WALK_CLEARANCE_M } from '../assets/builtin';
import type { Opening, Vec2 } from '../schema';
import { violation, type LayoutContext, type RoomInfo } from './constraints';
import { insideConvex, type ItemBox } from './footprint';
import { isEntryDoor, openingFrame } from './swing';
import { WALKWAY_MIN_ENTRY_M, WALKWAY_MIN_M, type Violation } from './types';

/**
 * Walkway rule (D7): the doors of a room must be linked by a path at least `WALKWAY_MIN_M` wide (0.9 m when
 * the flat entry is involved). The floor is rasterised at 5 cm; a cell is walkable when its centre is inside
 * the room and under no blocking item; the walkable area is eroded by half the width (0.4 m) and the doors
 * must stay connected through the eroded area. Computed with an exact squared-distance transform, then a
 * widest-path search (union-find over cells by decreasing clearance), so the width reported is the narrowest
 * point of the widest route.
 */

export const RASTER_STEP_M = 0.05;
/** The raster is coarse (half a cell): widths this far below the minimum still pass. */
const WIDTH_SLACK_M = 0.04;
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
}

export interface WalkwayAnalysis {
  /** Free floor in m2 (walkable cells, before erosion). */
  freeAreaM2: number;
  /** Narrowest width of the widest route linking the doors, in metres (undefined for a room with no door). */
  minWidthM?: number;
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
    const k = f.wall.thickness / 2 + ACCESS_DEPTH_M;
    out.push({ openingId: o.id, entry: isEntryDoor(o, f), access: [f.centre[0] + n[0] * k, f.centre[1] + n[1] * k] });
  }
  out.sort((a, b) => Number(b.entry) - Number(a.entry));
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

const clearanceM = (d2: number, step: number): number => (d2 <= 0 ? 0 : Math.max(0, Math.sqrt(d2) - 0.5) * step);

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
  const mark = (poly: readonly Vec2[], bounds: { minX: number; minY: number; maxX: number; maxY: number }) => {
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
  const touches = (o: { minX: number; minY: number; maxX: number; maxY: number }) => o.minX <= b.maxX && o.maxX >= b.minX && o.minY <= b.maxY && o.maxY >= b.minY;
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
  // access cell of each door: the roomiest cell around its inside point
  const reach = Math.ceil(ACCESS_SEARCH_M / step);
  const access = doors.map((d) => {
    const ci = Math.round((d.access[0] - x0) / step - 0.5);
    const cj = Math.round((d.access[1] - y0) / step - 0.5);
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
  });

  const widths: number[] = new Array<number>(doors.length).fill(0);
  if (doors.length === 1) {
    widths[0] = 2 * clearanceM(access[0]! >= 0 ? d2[access[0]!]! : 0, step);
  } else {
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
    const keys = { length: acc, at: (k: number) => order[k]! };
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
    while (g < keys.length && pending > 0) {
      const level = d2[keys.at(g)]!;
      let h = g;
      while (h < keys.length && d2[keys.at(h)]! === level) {
        const idx = keys.at(h);
        parent[idx] = idx;
        const i = idx % nx;
        const j = (idx - i) / nx;
        if (i > 0 && parent[idx - 1]! >= 0) parent[find(idx - 1)] = find(idx);
        if (i < nx - 1 && parent[idx + 1]! >= 0) parent[find(idx + 1)] = find(idx);
        if (j > 0 && parent[idx - nx]! >= 0) parent[find(idx - nx)] = find(idx);
        if (j < ny - 1 && parent[idx + nx]! >= 0) parent[find(idx + nx)] = find(idx);
        h++;
      }
      g = h;
      const root = access[0]! >= 0 && parent[access[0]!]! >= 0 ? find(access[0]!) : -1;
      if (root >= 0) {
        for (let k = 1; k < doors.length; k++) {
          if (resolved[k] || access[k]! < 0 || parent[access[k]!]! < 0) continue;
          if (find(access[k]!) === root) {
            resolved[k] = true;
            widths[k] = 2 * clearanceM(level, step);
            pending--;
          }
        }
      }
    }
    widths[0] = Math.min(...widths.slice(1));
  }

  const need = doors[0]!.entry ? WALKWAY_MIN_ENTRY_M : WALKWAY_MIN_M;
  let worst = Infinity;
  let bad: { door: DoorRef; width: number; other?: DoorRef } | undefined;
  for (let k = doors.length === 1 ? 0 : 1; k < doors.length; k++) {
    if (widths[k]! < worst) worst = widths[k]!;
    if (!bad && widths[k]! < need - WIDTH_SLACK_M) bad = { door: doors[k]!, width: widths[k]!, ...(k > 0 ? { other: doors[0]! } : {}) };
  }
  const minWidthM = Math.round(worst * 100) / 100;
  if (!bad) return { freeAreaM2, minWidthM };
  const route = bad.other ? `between "${bad.other.openingId}" and "${bad.door.openingId}"` : `in front of "${bad.door.openingId}"`;
  const entry = doors[0]!.entry && (bad.door.entry || bad.other?.entry);
  const ids = [info.room.id, bad.door.openingId, ...(bad.other ? [bad.other.openingId] : [])];
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
  if (baseline.violation && current.minWidthM !== undefined && baseline.minWidthM !== undefined && current.minWidthM >= baseline.minWidthM - WIDTH_SLACK_M) {
    const { violation: _drop, ...rest } = current;
    void _drop;
    return rest;
  }
  return current;
}
