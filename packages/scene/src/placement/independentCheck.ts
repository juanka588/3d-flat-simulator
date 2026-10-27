import type { Opening, Scene, Vec2 } from '../schema';

/**
 * A second, deliberately separate implementation of the geometric hard rules, for tests: it shares no code with
 * `constraints.ts` / `swing.ts` / `footprint.ts` (no SAT, no `openingFrame`, no `wallLeftNormal`). Footprints are
 * clipped against the zones (Sutherland-Hodgman) and the clipped AREA is measured.
 */

const area = (p: readonly Vec2[]): number => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length]!;
    a += p[i]![0] * q[1] - q[0] * p[i]![1];
  }
  return Math.abs(a) / 2;
};

const signed = (p: readonly Vec2[]): number => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length]!;
    a += p[i]![0] * q[1] - q[0] * p[i]![1];
  }
  return a / 2;
};

/** Area of the intersection of two convex polygons. */
export function clippedArea(subject: readonly Vec2[], clip: readonly Vec2[]): number {
  const c = signed(clip) < 0 ? [...clip].reverse() : [...clip];
  let out: Vec2[] = [...subject];
  for (let i = 0; i < c.length && out.length > 0; i++) {
    const a = c[i]!;
    const b = c[(i + 1) % c.length]!;
    const side = (p: Vec2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const input = out;
    out = [];
    for (let k = 0; k < input.length; k++) {
      const p = input[k]!;
      const q = input[(k + 1) % input.length]!;
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp > 0 && sq < 0) || (sp < 0 && sq > 0)) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out.length < 3 ? 0 : area(out);
}

function inPolygon(x: number, y: number, poly: readonly Vec2[], tol: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    // on-boundary points count as inside (within tol)
    const dx = xj - xi;
    const dy = yj - yi;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / l2));
    if (Math.hypot(x - (xi + t * dx), y - (yi + t * dy)) <= tol) return true;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface Candidate {
  roomId: string;
  position: Vec2;
  /** Degrees, local x -> plan [cos r, -sin r], local z (front) -> [sin r, cos r]. */
  rotation: number;
  elevation: number;
  w: number;
  d: number;
  h: number;
  mount: 'floor' | 'wall' | 'ceiling';
}

const footprint = (c: Candidate): Vec2[] => {
  const r = (c.rotation * Math.PI) / 180;
  const ex: Vec2 = [Math.cos(r), -Math.sin(r)];
  const ez: Vec2 = [Math.sin(r), Math.cos(r)];
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sz]): Vec2 => [
    c.position[0] + ex[0] * sx * (c.w / 2) + ez[0] * sz * (c.d / 2),
    c.position[1] + ex[1] * sx * (c.w / 2) + ez[1] * sz * (c.d / 2),
  ]);
};

/** Wall frame, derived here from scratch: unit direction and the normal on the LEFT of the direction (plan y down). */
function frame(scene: Scene, o: Opening) {
  const w = scene.walls.find((x) => x.id === o.wallId)!;
  const len = Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]);
  const dir: Vec2 = [(w.end[0] - w.start[0]) / len, (w.end[1] - w.start[1]) / len];
  const left: Vec2 = [dir[1], -dir[0]];
  const centre: Vec2 = [w.start[0] + dir[0] * o.offset, w.start[1] + dir[1] * o.offset];
  return { wall: w, dir, left, centre };
}

function rect(centre: Vec2, dir: Vec2, normal: Vec2, width: number, from: number, to: number): Vec2[] {
  const h = width / 2;
  const p = (a: number, n: number): Vec2 => [centre[0] + dir[0] * a + normal[0] * n, centre[1] + dir[1] * a + normal[1] * n];
  return [p(-h, from), p(h, from), p(h, to), p(-h, to)];
}

/** A 48-gon quarter disc around the hinge, swept by the leaf. */
function sector(scene: Scene, o: Opening): Vec2[] {
  const f = frame(scene, o);
  const hingeAtStart = (o.hinge ?? 'start') === 'start';
  const alongSign = hingeAtStart ? -1 : 1;
  const side: Vec2 = (o.swing ?? 'left') === 'left' ? f.left : [-f.left[0], -f.left[1]];
  const t = f.wall.thickness / 2;
  const hinge: Vec2 = [f.centre[0] + alongSign * f.dir[0] * (o.width / 2) + side[0] * t, f.centre[1] + alongSign * f.dir[1] * (o.width / 2) + side[1] * t];
  const closed: Vec2 = [-alongSign * f.dir[0], -alongSign * f.dir[1]];
  const out: Vec2[] = [hinge];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * (Math.PI / 2);
    out.push([hinge[0] + o.width * (Math.cos(a) * closed[0] + Math.sin(a) * side[0]), hinge[1] + o.width * (Math.cos(a) * closed[1] + Math.sin(a) * side[1])]);
  }
  return out;
}

/** Reasons the candidate breaks a geometric hard rule (empty = it does not). */
export function independentViolations(scene: Scene, c: Candidate): string[] {
  const out: string[] = [];
  const fp = footprint(c);
  const room = scene.rooms.find((r) => r.id === c.roomId);
  if (!room) return ['no such room'];
  // inside the room: corners and 12 points along every edge, plus no room corner poking in
  for (let i = 0; i < 4; i++) {
    const a = fp[i]!;
    const b = fp[(i + 1) % 4]!;
    for (let k = 0; k <= 12; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / 12;
      const y = a[1] + ((b[1] - a[1]) * k) / 12;
      if (!inPolygon(x, y, room.polygon, 0.004)) {
        out.push('outside the room');
        i = 4;
        break;
      }
    }
  }
  if (clippedArea(fp, fp) > 0) {
    const inner = fp.map((p): Vec2 => [c.position[0] + (p[0] - c.position[0]) * 0.97, c.position[1] + (p[1] - c.position[1]) * 0.97]);
    for (const v of room.polygon) if (inPolygon(v[0], v[1], inner, 0)) out.push('a room corner pokes into the footprint');
  }
  const bottom = c.elevation;
  const top = c.elevation + c.h;
  // walls
  for (const w of scene.walls) {
    const len = Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]);
    const dir: Vec2 = [(w.end[0] - w.start[0]) / len, (w.end[1] - w.start[1]) / len];
    const n: Vec2 = [-dir[1], dir[0]];
    const hw = w.thickness / 2;
    const poly: Vec2[] = [
      [w.start[0] + n[0] * hw, w.start[1] + n[1] * hw],
      [w.end[0] + n[0] * hw, w.end[1] + n[1] * hw],
      [w.end[0] - n[0] * hw, w.end[1] - n[1] * hw],
      [w.start[0] - n[0] * hw, w.start[1] - n[1] * hw],
    ];
    if (bottom < w.height - 0.01 && clippedArea(fp, poly) > 0.005 * 2.4) out.push(`overlaps wall ${w.id}`);
  }
  // openings
  const longest = Math.max(c.w, c.d);
  for (const o of scene.openings) {
    const f = frame(scene, o);
    const sides: Vec2[] = [f.left, [-f.left[0], -f.left[1]]];
    const t = f.wall.thickness / 2;
    const roomAt = (n: Vec2) => {
      const p: Vec2 = [f.centre[0] + n[0] * (t + 0.05), f.centre[1] + n[1] * (t + 0.05)];
      return scene.rooms.find((r) => inPolygon(p[0], p[1], r.polygon, 1e-6));
    };
    const rooms = sides.map(roomAt);
    const flat = c.h <= 0.03;
    if (o.type === 'door' && !flat && bottom < o.sill + o.height - 0.01) {
      if (clippedArea(fp, sector(scene, o)) > 0.005 * longest) out.push(`blocks the swing of ${o.id}`);
      const swingNormal: Vec2 = (o.swing ?? 'left') === 'left' ? f.left : [-f.left[0], -f.left[1]];
      const entry = (rooms[0] === undefined) !== (rooms[1] === undefined);
      sides.forEach((n, i) => {
        if (!rooms[i]) return;
        const isSwingSide = n[0] === swingNormal[0] && n[1] === swingNormal[1];
        const depth = entry ? 0.9 : isSwingSide ? 0 : 0.6;
        const tol = entry ? 0.005 : 0.03;
        if (depth > 0 && clippedArea(fp, rect(f.centre, f.dir, n, o.width, 0, t + depth)) > tol * longest) out.push(`blocks the doorway of ${o.id}`);
      });
    }
    if (o.type === 'passage' && !flat && bottom < o.sill + o.height - 0.01) {
      sides.forEach((n, i) => {
        if (rooms[i] && clippedArea(fp, rect(f.centre, f.dir, n, o.width, 0, t + 0.6)) > 0.005 * longest) out.push(`blocks the passage ${o.id}`);
      });
    }
    if (c.mount === 'wall' && (o.type === 'door' || o.type === 'passage') && bottom < o.sill + o.height - 0.01) {
      for (const n of sides) if (clippedArea(fp, rect(f.centre, f.dir, n, o.width, 0, t + 0.08)) > 0.005 * longest) out.push(`hangs in the doorway of ${o.id}`);
    }
    if (o.type === 'window') {
      sides.forEach((n, i) => {
        if (!rooms[i]) return;
        const strip = rect(f.centre, f.dir, n, o.width, 0, t + 0.3);
        if (clippedArea(fp, strip) <= 0.005 * longest) return;
        if (c.mount === 'wall') {
          if (bottom < o.sill + o.height - 0.01 && top > o.sill + 0.01) out.push(`hangs over the glazing of ${o.id}`);
        } else if (c.mount === 'floor' && !flat && top > o.sill - 0.02 + 1e-9 && bottom < o.sill + o.height - 0.01) {
          out.push(`taller than the sill of ${o.id}`);
        }
      });
    }
  }
  return out;
}
