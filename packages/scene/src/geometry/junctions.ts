import type { Wall } from '../schema';

/**
 * Where each face of a wall starts and ends, as distances along the centreline measured from
 * the wall's `start` (so `0` and `length` mean "no trim"). Negative values / values above the
 * length mean the face is extended past the endpoint (outer side of a mitred corner).
 */
export interface WallFootprint {
  startLeft: number;
  startRight: number;
  endLeft: number;
  endRight: number;
}

export interface JunctionOptions {
  /** Distance below which endpoints / on-segment tests match, in metres. */
  tolerance?: number;
  /** Maximum mitre length as a multiple of the half thickness; beyond it the outer corner is a butt. */
  mitreLimit?: number;
}

export const JUNCTION_TOLERANCE = 1e-3;
export const MITRE_LIMIT = 4;
/** |sin(angle)| below which two directions count as parallel. */
const PARALLEL = 5e-3;
/** Smallest face length a wall may keep after trimming. */
const MIN_FACE = 1e-3;

type V = [number, number];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1];
const cross = (a: V, b: V) => a[0] * b[1] - a[1] * b[0];

interface Info {
  wall: Wall;
  length: number;
  u: V;
  /** Left normal, as in `wallLeftNormal`. */
  n: V;
  half: number;
}

interface End {
  wi: number;
  end: 'start' | 'end';
  p: V;
  /** Unit direction pointing from the node into the wall. */
  o: V;
}

interface Trim {
  left: number;
  right: number;
}

/**
 * Computes per-wall footprint trims so walls meet cleanly:
 * - L corners (and 3+ way nodes) are mitred pairwise between angular neighbours; the outer
 *   side of a very acute corner falls back to a butt (mitre limit).
 * - A wall ending on another wall's centreline (T), or on a through-line made of two collinear
 *   walls, stops at the host's face instead of its centreline.
 * - Collinear continuations are butted at the shared node (no gap).
 * Walls that end up with an inverted/degenerate face fall back to no trim at all.
 */
export function computeWallJunctions(
  walls: readonly Wall[],
  options: JunctionOptions = {},
): Map<string, WallFootprint> {
  const tol = options.tolerance ?? JUNCTION_TOLERANCE;
  const mitreLimit = options.mitreLimit ?? MITRE_LIMIT;

  const infos: Info[] = walls.map((wall) => {
    const dx = wall.end[0] - wall.start[0];
    const dy = wall.end[1] - wall.start[1];
    const length = Math.hypot(dx, dy);
    const u: V = length > 0 ? [dx / length, dy / length] : [1, 0];
    return { wall, length, u, n: [u[1], -u[0]], half: wall.thickness / 2 };
  });

  const ends: End[] = [];
  infos.forEach((info, wi) => {
    if (info.length <= tol) return;
    ends.push({ wi, end: 'start', p: info.wall.start, o: info.u });
    ends.push({ wi, end: 'end', p: info.wall.end, o: [-info.u[0], -info.u[1]] });
  });

  const trims = new Map<End, Trim>();
  for (const e of ends) trims.set(e, resolveEnd(e));

  function resolveEnd(e: End): Trim {
    const info = infos[e.wi]!;
    const zero: Trim = { left: 0, right: 0 };

    const cluster = ends.filter(
      (f) => f === e || (f.wi !== e.wi && Math.hypot(f.p[0] - e.p[0], f.p[1] - e.p[1]) <= tol),
    );

    // Host candidate 1: walls whose body passes through the node.
    let host: { dir: V; normal: V; half: number } | undefined;
    infos.forEach((k, ki) => {
      if (ki === e.wi || k.length <= tol) return;
      const rel: V = [e.p[0] - k.wall.start[0], e.p[1] - k.wall.start[1]];
      const t = dot(rel, k.u);
      if (t > tol && t < k.length - tol && Math.abs(cross(rel, k.u)) <= tol && (!host || k.half > host.half)) {
        host = { dir: k.u, normal: k.n, half: k.half };
      }
    });

    // Host candidate 2: two collinear walls meeting at the node form a virtual through-wall.
    let inBestPair = false;
    if (!host) {
      let bestHalf = -1;
      for (let i = 0; i < cluster.length; i++) {
        for (let j = i + 1; j < cluster.length; j++) {
          const a = cluster[i]!;
          const b = cluster[j]!;
          if (dot(a.o, b.o) < 0 && Math.abs(cross(a.o, b.o)) < PARALLEL) {
            const half = Math.max(infos[a.wi]!.half, infos[b.wi]!.half);
            if (half > bestHalf) {
              bestHalf = half;
              inBestPair = a === e || b === e;
              host = { dir: a.o, normal: [a.o[1], -a.o[0]], half };
            }
          }
        }
      }
    }
    if (host) return inBestPair ? zero : hostTrim(e, info, host);

    if (cluster.length < 2) return zero;
    return mitreTrim(e, info, cluster);
  }

  /** Stops the wall end at the host's face on the side the wall comes from. */
  function hostTrim(e: End, info: Info, host: { normal: V; half: number }): Trim {
    const cosO = dot(e.o, host.normal);
    if (Math.abs(cosO) < PARALLEL) return { left: 0, right: 0 };
    const sign = cosO > 0 ? 1 : -1;
    const along = (face: V) => (sign * host.half - info.half * dot(face, host.normal)) / cosO;
    return { left: along(info.n), right: along([-info.n[0], -info.n[1]]) };
  }

  /** Mitres the end against its angular neighbours around the node. */
  function mitreTrim(e: End, info: Info, cluster: End[]): Trim {
    const sorted = [...cluster].sort((a, b) => Math.atan2(a.o[1], a.o[0]) - Math.atan2(b.o[1], b.o[0]));
    const idx = sorted.indexOf(e);
    const next = sorted[(idx + 1) % sorted.length]!;
    const prev = sorted[(idx - 1 + sorted.length) % sorted.length]!;

    // Face of `e` towards increasing angle meets the neighbour's face towards decreasing angle.
    const ccwNormal: V = [-e.o[1], e.o[0]];
    const cwNormal: V = [e.o[1], -e.o[0]];
    const ccw = pairTrim(e, next, true);
    const cw = pairTrim(e, prev, false);

    const out: Trim = { left: 0, right: 0 };
    const assign = (normal: V, value: number) => {
      if (dot(normal, info.n) > 0) out.left = value;
      else out.right = value;
    };
    assign(ccwNormal, ccw);
    assign(cwNormal, cw);
    return out;
  }

  /** Distance from the node at which `e`'s face (normal `ne`) meets the neighbour's adjacent face. */
  function pairTrim(e: End, other: End, ccw: boolean): number {
    if (other === e) return 0;
    const ne: V = ccw ? [-e.o[1], e.o[0]] : [e.o[1], -e.o[0]];
    const hi = infos[e.wi]!.half;
    const hj = infos[other.wi]!.half;
    const sinAngle = cross(e.o, other.o);
    if (Math.abs(sinAngle) < PARALLEL) return 0;
    // Neighbour's face on the side facing `e`: opposite rotation to `e`'s face.
    const nj: V = ccw ? [other.o[1], -other.o[0]] : [-other.o[1], other.o[0]];
    const d: V = [nj[0] * hj - ne[0] * hi, nj[1] * hj - ne[1] * hi];
    // Solve e.o * a - other.o * b = d.
    const det = -sinAngle;
    const a = (d[0] * -other.o[1] + other.o[0] * d[1]) / det;
    if (!Number.isFinite(a)) return 0;
    if (a < 0) {
      // Extension past the node: apply the mitre limit.
      const px = ne[0] * hi + e.o[0] * a;
      const py = ne[1] * hi + e.o[1] * a;
      if (Math.hypot(px, py) > mitreLimit * Math.max(hi, hj)) return 0;
    }
    return a;
  }

  const result = new Map<string, WallFootprint>();
  infos.forEach((info, wi) => {
    const s = ends.find((e) => e.wi === wi && e.end === 'start');
    const t = ends.find((e) => e.wi === wi && e.end === 'end');
    const st = (s && trims.get(s)) ?? { left: 0, right: 0 };
    const en = (t && trims.get(t)) ?? { left: 0, right: 0 };
    let fp: WallFootprint = {
      startLeft: st.left,
      startRight: st.right,
      endLeft: info.length - en.left,
      endRight: info.length - en.right,
    };
    const valid =
      Object.values(fp).every(Number.isFinite) &&
      fp.endLeft - fp.startLeft >= MIN_FACE &&
      fp.endRight - fp.startRight >= MIN_FACE;
    if (!valid) fp = { startLeft: 0, startRight: 0, endLeft: info.length, endRight: info.length };
    result.set(info.wall.id, fp);
  });
  return result;
}
