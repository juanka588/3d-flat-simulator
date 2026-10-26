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
  const frame = BUILTIN_MATERIALS.frame;

  box(fit, f, [from, from + fw], [-fd, fd], [sill, top], frame, owner);
  box(fit, f, [to - fw, to], [-fd, fd], [sill, top], frame, owner);
  box(fit, f, [from + fw, to - fw], [-fd, fd], [top - fw, top], frame, owner);
  if (hasBottom) box(fit, f, [from + fw, to - fw], [-fd, fd], [sill, sill + fw], frame, owner);

  const s0 = from + fw;
  const s1 = to - fw;
  const y0 = hasBottom ? sill + fw : sill;
  const y1 = top - fw;
  const glazed = opening.glazed ?? opening.type === 'window';
  if (glazed) {
    const p = (s: number, y: number) => framePoint(f, s, 0, y);
    // Left-face convention: u = length - s grows to the viewer's right.
    const uvs: [number, number][] = [[f.length - s0, y0], [f.length - s1, y0], [f.length - s1, y1], [f.length - s0, y1]];
    emitQuad(glass, [p(s0, y0), p(s1, y0), p(s1, y1), p(s0, y1)], frameDir(f, 0, 1), uvs, BUILTIN_MATERIALS.glass, owner);
  } else if (opening.type === 'door') {
    const h = f.half;
    const t = Math.min(LEAF_THICKNESS, s1 - s0);
    const leafWidth = s1 - s0;
    const sAlong: [number, number] = (opening.hinge ?? 'start') === 'start' ? [s0, s0 + t] : [s1 - t, s1];
    const dAcross: [number, number] = (opening.swing ?? 'left') === 'left' ? [h, h + leafWidth] : [-h - leafWidth, -h];
    box(fit, f, sAlong, dAcross, [y0, y1], BUILTIN_MATERIALS.door, owner);
  }
}
