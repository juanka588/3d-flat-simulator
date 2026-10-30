import type { Opening, Scene, Wall } from '../schema';
import { MeshBuilder } from './builder';
import { computeWallJunctions } from './junctions';
import { clampedOpeningSpans } from './openings';
import { emitQuad, frameDir, framePoint, wallFrame, type WallFrame } from './walls';
import { BUILTIN_MATERIALS, type MeshData } from './types';

/** Frame member width (m), capped for tiny openings. */
const FRAME_WIDTH = 0.05;
/** Frame depth across the wall (m), capped by the wall thickness. */
const FRAME_DEPTH = 0.07;
/** Door leaf thickness (m). */
const LEAF_THICKNESS = 0.04;

type Owner = { kind: 'opening'; entityId: string };

/** Axis-aligned (in wall coordinates) box: s along the wall, d across, y up. */
function box(
  b: MeshBuilder,
  f: WallFrame,
  [s0, s1]: [number, number],
  [d0, d1]: [number, number],
  [y0, y1]: [number, number],
  materialId: string,
  owner: Owner,
): void {
  if (s1 - s0 <= 1e-6 || y1 - y0 <= 1e-6 || d1 - d0 <= 1e-6) return;
  const p = (s: number, d: number, y: number) => framePoint(f, s, d, y);
  const uv = (a: number, c: number, e: number, g: number): [number, number][] => [[a, c], [e, c], [e, g], [a, g]];
  // Left (+d) face: u = length - s so it grows to the viewer's right, as on the wall's left face.
  emitQuad(b, [p(s0, d1, y0), p(s1, d1, y0), p(s1, d1, y1), p(s0, d1, y1)], frameDir(f, 0, 1), uv(f.length - s0, y0, f.length - s1, y1), materialId, owner);
  // Right (-d) face.
  emitQuad(b, [p(s0, d0, y0), p(s1, d0, y0), p(s1, d0, y1), p(s0, d0, y1)], frameDir(f, 0, -1), uv(s0, y0, s1, y1), materialId, owner);
  // Ends along the wall.
  emitQuad(b, [p(s0, d0, y0), p(s0, d1, y0), p(s0, d1, y1), p(s0, d0, y1)], frameDir(f, -1, 0), uv(d0, y0, d1, y1), materialId, owner);
  emitQuad(b, [p(s1, d0, y0), p(s1, d1, y0), p(s1, d1, y1), p(s1, d0, y1)], frameDir(f, 1, 0), uv(d0, y0, d1, y1), materialId, owner);
  // Top and bottom.
  emitQuad(b, [p(s0, d0, y1), p(s1, d0, y1), p(s1, d1, y1), p(s0, d1, y1)], [0, 1, 0], uv(s0, d0, s1, d1), materialId, owner);
  emitQuad(b, [p(s0, d0, y0), p(s1, d0, y0), p(s1, d1, y0), p(s0, d1, y0)], [0, -1, 0], uv(s0, d0, s1, d1), materialId, owner);
}

/**
 * Frames, door leaves (opaque) and glass panes (transparent). Hole extents come from
 * `clampedOpeningSpans`, the same helper that cuts the walls, so every fitting lies inside
 * its hole even next to junctions. Passages get nothing; doors/windows get a frame (no
 * threshold at sill 0).
 *
 * - Glazed openings get ONE glass quad per pane (facing the wall's left side); the web
 *   renders glass with a double-sided material. The pane stays in the frame, also for
 *   glazed doors (they are not drawn open).
 * - Unglazed doors get a leaf drawn OPEN at 90 degrees so the doorway is clear: hinged at
 *   `opening.hinge` ('start' | 'end', default 'start'), lying against the wall face on the
 *   `opening.swing` side ('left' | 'right' of `wallLeftNormal`, default 'left'),
 *   perpendicular to the wall and at most one leaf width long.
 */
export function buildFittings(scene: Scene): { fittings: MeshData; glass: MeshData } {
  const fit = new MeshBuilder();
  const glass = new MeshBuilder();
  const footprints = computeWallJunctions(scene.walls);
  const byWall = new Map<string, Opening[]>();
  for (const o of scene.openings) {
    if (o.type === 'passage') continue;
    const list = byWall.get(o.wallId);
    if (list) list.push(o);
    else byWall.set(o.wallId, [o]);
  }

  for (const wall of scene.walls) {
    const openings = byWall.get(wall.id);
    if (!openings) continue;
    const f = wallFrame(wall);
    if (!(f.length > 0)) continue;
    const fp = footprints.get(wall.id) ?? { startLeft: 0, startRight: 0, endLeft: f.length, endRight: f.length };
    const byId = new Map(openings.map((o) => [o.id, o]));
    for (const hole of clampedOpeningSpans(openings, fp, wall.height)) {
      buildOpening(fit, glass, wall, f, byId.get(hole.openingId)!, hole);
    }
  }
  return { fittings: fit.build(), glass: glass.build() };
}

function buildOpening(
  fit: MeshBuilder,
  glass: MeshBuilder,
  wall: Wall,
  f: WallFrame,
  opening: Opening,
  { from, to, sill, top }: { from: number; to: number; sill: number; top: number },
): void {
  if (to - from <= 1e-6 || top - sill <= 1e-6) return;

  const owner: Owner = { kind: 'opening', entityId: opening.id };
  const fw = Math.min(FRAME_WIDTH, (to - from) / 4, (top - sill) / 4);
  const fd = Math.min(FRAME_DEPTH, wall.thickness) / 2;
  const hasBottom = sill > 1e-3;
  const white = opening.finish === 'white';
  const frame = white ? BUILTIN_MATERIALS.frameWhite : BUILTIN_MATERIALS.frame;

  box(fit, f, [from, from + fw], [-fd, fd], [sill, top], frame, owner);
  box(fit, f, [to - fw, to], [-fd, fd], [sill, top], frame, owner);
  box(fit, f, [from + fw, to - fw], [-fd, fd], [top - fw, top], frame, owner);
  if (hasBottom) box(fit, f, [from + fw, to - fw], [-fd, fd], [sill, sill + fw], frame, owner);

  const s0 = from + fw;
  const s1 = to - fw;
  const y0 = hasBottom ? sill + fw : sill;
  const y1 = top - fw;
  const glazed = opening.glazed ?? opening.type === 'window';
  if (glazed && opening.sashes !== undefined && white) {
    buildSashes(fit, glass, f, opening, owner, [s0, s1], [y0, y1], frame);
  } else if (glazed) {
    const p = (s: number, y: number) => framePoint(f, s, 0, y);
    // Left-face convention: u = length - s grows to the viewer's right.
    const uvs: [number, number][] = [[f.length - s0, y0], [f.length - s1, y0], [f.length - s1, y1], [f.length - s0, y1]];
    emitQuad(glass, [p(s0, y0), p(s1, y0), p(s1, y1), p(s0, y1)], frameDir(f, 0, 1), uvs, BUILTIN_MATERIALS.glass, owner);
  } else if (opening.type === 'door') {
    const h = f.half;
    const t = Math.min(LEAF_THICKNESS, s1 - s0);
    const leafWidth = s1 - s0;
    const sAlong: [number, number] = (opening.hinge ?? 'start') === 'start' ? [s0, s0 + t] : [s1 - t, s1];
    const left = (opening.swing ?? 'left') === 'left';
    const dAcross: [number, number] = left ? [h, h + leafWidth] : [-h - leafWidth, -h];
    box(fit, f, sAlong, dAcross, [y0, y1], white ? BUILTIN_MATERIALS.doorWhite : BUILTIN_MATERIALS.door, owner);
    if (white) {
      // Slim architrave round the frame on both faces of the wall.
      const a = ARCHITRAVE_WIDTH;
      for (const [d0, d1] of [[h, h + ARCHITRAVE_DEPTH], [-h - ARCHITRAVE_DEPTH, -h]] as [number, number][]) {
        box(fit, f, [from - a, from], [d0, d1], [sill, top + a], frame, owner);
        box(fit, f, [to, to + a], [d0, d1], [sill, top + a], frame, owner);
        box(fit, f, [from, to], [d0, d1], [top, top + a], frame, owner);
      }
      // Lever handle on a rose near the free edge, both sides, plus the key rose below.
      const free = left ? h + leafWidth : -h - leafWidth;
      const toHinge = left ? -1 : 1;
      const dRose = free + toHinge * DOOR_HANDLE_INSET;
      for (const q of [-1, 1]) doorHandle(fit, f, owner, q < 0 ? sAlong[0] : sAlong[1], q, dRose, toHinge);
    }
  }
}

const ARCHITRAVE_WIDTH = 0.055;
const ARCHITRAVE_DEPTH = 0.012;
/** Height of the door lever above the floor (m). */
export const DOOR_HANDLE_HEIGHT = 1.05;
/** Height of a window handle above the floor (m). */
export const WINDOW_HANDLE_HEIGHT = 1.1;
/** Distance of the rose centre from the leaf's free edge (m). */
const DOOR_HANDLE_INSET = 0.05;

/** A cylinder along the wall direction `s` from `sA` to `sB`, centred at (`d`, `y`): the cap at `sB` is a fan, the sides quads. */
function cylinderS(b: MeshBuilder, f: WallFrame, [sA, sB]: [number, number], d: number, y: number, r: number, material: string, owner: Owner, segments = 10): void {
  const q = Math.sign(sB - sA);
  const ring = (k: number): [number, number] => [d + r * Math.cos((k / segments) * Math.PI * 2), y + r * Math.sin((k / segments) * Math.PI * 2)];
  for (let k = 0; k < segments; k++) {
    const [d0, y0] = ring(k);
    const [d1, y1] = ring(k + 1);
    const mid = ((k + 0.5) / segments) * Math.PI * 2;
    emitQuad(b, [framePoint(f, sA, d0, y0), framePoint(f, sB, d0, y0), framePoint(f, sB, d1, y1), framePoint(f, sA, d1, y1)], frameDir(f, 0, Math.cos(mid), Math.sin(mid)), [[0, 0], [1, 0], [1, 1], [0, 1]], material, owner);
    const c = framePoint(f, sB, d, y);
    emitQuad(b, [c, framePoint(f, sB, d0, y0), framePoint(f, sB, d1, y1), c], frameDir(f, q, 0), [[0, 0], [1, 0], [1, 1], [0, 0]], material, owner);
  }
}

/** One side of a door's furniture: round rose, short stem, lever pointing to the hinge, round key rose below. `q` is the face direction along s. */
function doorHandle(b: MeshBuilder, f: WallFrame, owner: Owner, face: number, q: number, d: number, toHinge: number): void {
  const m = BUILTIN_MATERIALS.handle;
  const y = DOOR_HANDLE_HEIGHT;
  const at = (off: number) => face + q * off;
  const span = (a: number, c: number): [number, number] => (q > 0 ? [at(a), at(c)] : [at(c), at(a)]);
  cylinderS(b, f, [face, at(0.008)], d, y, 0.027, m, owner, 12);
  box(b, f, span(0.008, 0.042), [d - 0.007, d + 0.007], [y - 0.007, y + 0.007], m, owner);
  const lever: [number, number] = toHinge < 0 ? [d - 0.12, d + 0.012] : [d - 0.012, d + 0.12];
  box(b, f, span(0.034, 0.05), lever, [y - 0.01, y + 0.01], m, owner);
  cylinderS(b, f, [face, at(0.006)], d, y - 0.075, 0.013, m, owner, 8);
}

/**
 * Sashes of a glazed opening in white PVC: `opening.sashes` leaves side by side inside the frame, each with stiles, a top rail and a
 * wider bottom rail, a cover strip where two leaves meet, one pane of double glazing per leaf and a white window handle at 1.1 m on the
 * room side (the `swing` side, default right).
 */
function buildSashes(fit: MeshBuilder, glass: MeshBuilder, f: WallFrame, opening: Opening, owner: Owner, [s0, s1]: [number, number], [y0, y1]: [number, number], mat: string): void {
  const n = opening.sashes ?? 1;
  const SD = 0.026; // half depth of the sash profile (frame: 0.035)
  const stile = 0.045;
  const meet = 0.035;
  const topRail = 0.045;
  const botRail = y1 - y0 > 1 ? 0.09 : 0.055;
  const width = (s1 - s0) / n;
  const p = (s: number, y: number) => framePoint(f, s, 0, y);
  for (let i = 0; i < n; i++) {
    const a = s0 + i * width;
    const c = a + width;
    const left = i === 0 ? stile : meet;
    const right = i === n - 1 ? stile : meet;
    box(fit, f, [a, a + left], [-SD, SD], [y0, y1], mat, owner);
    box(fit, f, [c - right, c], [-SD, SD], [y0, y1], mat, owner);
    box(fit, f, [a + left, c - right], [-SD, SD], [y1 - topRail, y1], mat, owner);
    box(fit, f, [a + left, c - right], [-SD, SD], [y0, y0 + botRail], mat, owner);
    const g0 = a + left;
    const g1 = c - right;
    const gy0 = y0 + botRail;
    const gy1 = y1 - topRail;
    const uvs: [number, number][] = [[f.length - g0, gy0], [f.length - g1, gy0], [f.length - g1, gy1], [f.length - g0, gy1]];
    emitQuad(glass, [p(g0, gy0), p(g1, gy0), p(g1, gy1), p(g0, gy1)], frameDir(f, 0, 1), uvs, BUILTIN_MATERIALS.glass, owner);
    if (i < n - 1) box(fit, f, [c - 0.012, c + 0.012], [-SD - 0.004, SD + 0.004], [y0, y1], mat, owner); // cover strip over the meeting stiles
  }
  // White handle on the room side, on the leaf that meets the next one (or the free edge of a single leaf).
  const q = (opening.swing ?? 'right') === 'left' ? 1 : -1;
  const face = q * (SD + (n > 1 ? 0.004 : 0));
  const sc = n > 1 ? s0 + width - 0.03 : s1 - 0.0225;
  const hm = BUILTIN_MATERIALS.handleWhite;
  const hy = WINDOW_HANDLE_HEIGHT;
  const dd = (a: number, c: number): [number, number] => (q > 0 ? [face + a, face + c] : [face - c, face - a]);
  box(fit, f, [sc - 0.014, sc + 0.014], dd(0, 0.007), [hy - 0.07, hy + 0.07], hm, owner); // back plate
  box(fit, f, [sc - 0.007, sc + 0.007], dd(0.007, 0.03), [hy - 0.007, hy + 0.007], hm, owner); // spindle
  box(fit, f, [sc - 0.009, sc + 0.009], dd(0.024, 0.04), [hy - 0.11, hy + 0.012], hm, owner); // lever, pointing down (closed)
}
