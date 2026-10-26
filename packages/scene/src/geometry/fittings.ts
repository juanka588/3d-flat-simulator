import type { Opening, Scene, Wall } from '../schema';
import { MeshBuilder } from './builder';
import { emitQuad, frameDir, framePoint, openingSpan, wallFrame, type WallFrame } from './walls';
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
  // Left (+d) and right (-d) faces.
  emitQuad(b, [p(s0, d1, y0), p(s1, d1, y0), p(s1, d1, y1), p(s0, d1, y1)], frameDir(f, 0, 1), uv(s0, y0, s1, y1), materialId, owner);
  emitQuad(b, [p(s0, d0, y0), p(s1, d0, y0), p(s1, d0, y1), p(s0, d0, y1)], frameDir(f, 0, -1), uv(s0, y0, s1, y1), materialId, owner);
  // Ends along the wall.
  emitQuad(b, [p(s0, d0, y0), p(s0, d1, y0), p(s0, d1, y1), p(s0, d0, y1)], frameDir(f, -1, 0), uv(d0, y0, d1, y1), materialId, owner);
  emitQuad(b, [p(s1, d0, y0), p(s1, d1, y0), p(s1, d1, y1), p(s1, d0, y1)], frameDir(f, 1, 0), uv(d0, y0, d1, y1), materialId, owner);
  // Top and bottom.
  emitQuad(b, [p(s0, d0, y1), p(s1, d0, y1), p(s1, d1, y1), p(s0, d1, y1)], [0, 1, 0], uv(s0, d0, s1, d1), materialId, owner);
  emitQuad(b, [p(s0, d0, y0), p(s1, d0, y0), p(s1, d1, y0), p(s0, d1, y0)], [0, -1, 0], uv(s0, d0, s1, d1), materialId, owner);
}

/**
 * Frames and door leaves (opaque) and glass panes (transparent). Everything lies inside the
 * wall hole. Passages get nothing; doors/windows get a frame (no threshold at sill 0); a
 * glazed opening gets a glass pane, an unglazed one a closed leaf.
 */
export function buildFittings(scene: Scene): { fittings: MeshData; glass: MeshData } {
  const fit = new MeshBuilder();
  const glass = new MeshBuilder();
  const walls = new Map<string, Wall>(scene.walls.map((w) => [w.id, w]));

  for (const opening of scene.openings) {
    const wall = walls.get(opening.wallId);
    if (!wall || opening.type === 'passage') continue;
    buildOpening(fit, glass, wall, opening);
  }
  return { fittings: fit.build(), glass: glass.build() };
}

function buildOpening(fit: MeshBuilder, glass: MeshBuilder, wall: Wall, opening: Opening): void {
  const f = wallFrame(wall);
  if (!(f.length > 0)) return;
  const span = openingSpan(opening, wall.height);
  const from = Math.max(0, span.from);
  const to = Math.min(f.length, span.to);
  const { sill, top } = span;
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
    const uvs: [number, number][] = [[s0, y0], [s1, y0], [s1, y1], [s0, y1]];
    const corners: [ReturnType<typeof p>, ReturnType<typeof p>, ReturnType<typeof p>, ReturnType<typeof p>] = [
      p(s0, y0),
      p(s1, y0),
      p(s1, y1),
      p(s0, y1),
    ];
    // Both sides, so the pane is visible from either room.
    emitQuad(glass, corners, frameDir(f, 0, 1), uvs, BUILTIN_MATERIALS.glass, owner);
    emitQuad(glass, corners, frameDir(f, 0, -1), uvs, BUILTIN_MATERIALS.glass, owner);
  } else {
    const t = Math.min(LEAF_THICKNESS, wall.thickness) / 2;
    box(fit, f, [s0, s1], [-t, t], [y0, y1], BUILTIN_MATERIALS.door, owner);
  }
}
