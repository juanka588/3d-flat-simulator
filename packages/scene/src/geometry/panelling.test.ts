import { describe, expect, it } from 'vitest';
import type { Scene, SceneInput } from '../schema';
import { PANEL_LAYOUT, fittingObstacles, layoutFace, paintMaterialId, wallFacePanelling, type FaceObstacle, type LayoutInput } from './panelling';
import { makeScene, triangles } from './testUtil';
import { wallFrame } from './walls';
import { buildWalls } from './walls';

const base = (over: Partial<LayoutInput> = {}): LayoutInput => ({ from: 0, to: 5, height: 2.6, style: 'frames', railY: 0.9, obstacles: [], ...over });
const door = (from: number, to: number): FaceObstacle => ({ from, to, y0: 0, y1: 2.1 });
const win = (from: number, to: number): FaceObstacle => ({ from, to, y0: 0.9, y1: 2.1 });

const overlapsInS = (r: { s0: number; s1: number }, o: { from: number; to: number }) => r.s0 < o.to && r.s1 > o.from;

describe('layoutFace', () => {
  it('spreads equal frames over a free wall, inside the margins', () => {
    const { frames, rails } = layoutFace(base());
    expect(rails).toEqual([]);
    expect(frames.length).toBeGreaterThanOrEqual(5);
    expect(frames[0]!.s0).toBeCloseTo(PANEL_LAYOUT.edgeMargin);
    expect(frames.at(-1)!.s1).toBeCloseTo(5 - PANEL_LAYOUT.edgeMargin);
    const widths = frames.map((f) => f.s1 - f.s0);
    for (const w of widths) expect(w).toBeCloseTo(widths[0]!);
    for (const f of frames) {
      expect(f.y0).toBeCloseTo(PANEL_LAYOUT.skirting);
      expect(f.y1).toBeLessThan(2.6 - PANEL_LAYOUT.topGap + 1e-9);
    }
  });

  it('never lets a frame cross a door, a window or a fitting, wherever they stand', () => {
    for (let at = 0.2; at < 4.8; at += 0.17) {
      for (const w of [0.7, 0.9, 1.4]) {
        const obstacles = [door(at - w / 2, at + w / 2), win(3.9 - w / 2, 3.9 + w / 2), { from: 1.2, to: 1.8, y0: 0, y1: 0.8 }];
        for (const style of ['frames', 'dado', 'frames+dado'] as const) {
          const { frames } = layoutFace(base({ obstacles, style }));
          for (const f of frames) {
            for (const o of obstacles) {
              if (o.y0 < f.y1 && o.y1 > f.y0) expect(overlapsInS(f, o), `${style} frame ${f.s0.toFixed(2)}-${f.s1.toFixed(2)} vs ${o.from.toFixed(2)}-${o.to.toFixed(2)}`).toBe(false);
            }
            expect(f.s0).toBeGreaterThanOrEqual(0);
            expect(f.s1).toBeLessThanOrEqual(5);
          }
        }
      }
    }
  });

  it('keeps the clearance next to an opening and skips stretches that are too short', () => {
    // A door leaves 0.3 m on the left (less than margin + clearance + a panel): nothing is drawn there.
    const { frames } = layoutFace(base({ obstacles: [door(0.4, 1.3)] }));
    expect(frames.every((f) => f.s0 >= 1.3 + PANEL_LAYOUT.clearance - 1e-9)).toBe(true);
    // A whole wall shorter than a panel gets no frame at all.
    expect(layoutFace(base({ to: 0.3 })).frames).toEqual([]);
    expect(layoutFace(base({ to: 0.2, obstacles: [] })).frames).toEqual([]);
  });

  it('frames above a window sill row can run past the window when it sits above the row', () => {
    // A low fitting (0.5 m) blocks the lower row of frames+dado only.
    const { frames } = layoutFace(base({ style: 'frames+dado', obstacles: [{ from: 2, to: 3, y0: 0, y1: 0.5 }] }));
    const lower = frames.filter((f) => f.y1 < 0.9);
    const upper = frames.filter((f) => f.y0 > 0.9);
    expect(lower.some((f) => overlapsInS(f, { from: 2, to: 3 }))).toBe(false);
    expect(upper.some((f) => overlapsInS(f, { from: 2, to: 3 }))).toBe(true);
  });

  it('lays the dado rail at its height and breaks it at doors', () => {
    const { frames, rails } = layoutFace(base({ style: 'frames+dado', obstacles: [door(2, 3)] }));
    expect(rails).toHaveLength(2);
    expect(rails.every((r) => r.y === 0.9)).toBe(true);
    expect(rails[0]!.s1).toBeCloseTo(2);
    expect(rails[1]!.s0).toBeCloseTo(3);
    // frames sit below and above the rail, never on it
    expect(frames.every((f) => f.y1 <= 0.9 - PANEL_LAYOUT.railHeight / 2 || f.y0 >= 0.9 + PANEL_LAYOUT.railHeight / 2)).toBe(true);
    // a window whose sill is above the rail leaves the rail whole
    expect(layoutFace(base({ style: 'dado', obstacles: [{ from: 2, to: 3, y0: 1.1, y1: 2.1 }] })).rails).toHaveLength(1);
  });

  it('leaves room for a cornice under the ceiling', () => {
    const plain = layoutFace(base());
    const corniced = layoutFace(base({ topGap: 0.15 }));
    expect(corniced.frames[0]!.y1).toBeCloseTo(plain.frames[0]!.y1 - 0.15);
  });
});

const room = (over: Partial<SceneInput['rooms'] extends (infer R)[] | undefined ? R : never> = {}) => ({
  id: 'r',
  name: 'R',
  type: 'living' as const,
  polygon: [[0.05, 0.05], [4.95, 0.05], [4.95, 3.95], [0.05, 3.95]] as [number, number][],
  ...over,
});
const walls = [
  { id: 'wn', start: [0, 0] as [number, number], end: [5, 0] as [number, number], thickness: 0.1, height: 2.6 },
  { id: 'we', start: [5, 0] as [number, number], end: [5, 4] as [number, number], thickness: 0.1, height: 2.6 },
  { id: 'ws', start: [5, 4] as [number, number], end: [0, 4] as [number, number], thickness: 0.1, height: 2.6 },
  { id: 'ww', start: [0, 4] as [number, number], end: [0, 0] as [number, number], thickness: 0.1, height: 2.6 },
];
const openings: NonNullable<SceneInput['openings']> = [
  { id: 'd1', wallId: 'ws', type: 'door', offset: 1.5, width: 0.9, height: 2.04, sill: 0 },
  { id: 'win1', wallId: 'wn', type: 'window', offset: 2.5, width: 1.2, height: 1.2, sill: 0.9 },
];
const flat = (roomOver = {}, extra: Partial<SceneInput> = {}): Scene => makeScene(walls, openings, { rooms: [room(roomOver)], ...extra });

/** Vertices of the wall mesh that stand proud of the wall faces, as (wall id, s, d, y). */
function moulded(scene: Scene) {
  const mesh = buildWalls(scene);
  const frames = new Map(scene.walls.map((w) => [w.id, wallFrame(w)]));
  const out: { wall: string; s: number; d: number; y: number }[] = [];
  for (const o of mesh.owners) {
    if (o.kind !== 'wall') continue;
    const f = frames.get(o.entityId)!;
    for (let t = o.start; t < o.start + o.count; t++) {
      for (let k = 0; k < 3; k++) {
        const i = mesh.indices[t * 3 + k]!;
        const x = mesh.positions[i * 3]! - f.origin[0];
        const z = mesh.positions[i * 3 + 2]! - f.origin[1];
        const d = x * f.n[0] + z * f.n[1];
        if (Math.abs(d) > f.half + 1e-4) out.push({ wall: o.entityId, s: x * f.u[0] + z * f.u[1], d, y: mesh.positions[i * 3 + 1]! });
      }
    }
  }
  return out;
}

describe('wall mouldings in the wall mesh', () => {
  it('adds nothing without panelling or cornice', () => {
    expect(moulded(flat())).toEqual([]);
  });

  it('draws bevelled frames in front of the room faces, none inside the door or the window', () => {
    const scene = flat({ panelling: { style: 'frames' } });
    const pts = moulded(scene);
    expect(pts.length).toBeGreaterThan(100);
    // every vertex projects into the room (inside the room polygon, at most 18 mm off the face)
    for (const p of pts) expect(Math.abs(p.d)).toBeLessThanOrEqual(0.05 + 0.018 + 1e-4);
    // the door of the south wall is centred 1.5 m from its start: s 1.05..1.95
    const doorHits = pts.filter((p) => p.wall === 'ws' && p.s > 1.05 + 1e-6 && p.s < 1.95 - 1e-6 && p.y < 2.04);
    expect(doorHits).toEqual([]);
    const windowHits = pts.filter((p) => p.wall === 'wn' && p.s > 1.9 + 1e-6 && p.s < 3.1 - 1e-6 && p.y > 0.9 && p.y < 2.1);
    expect(windowHits).toEqual([]);
    // but the walls without openings are covered
    expect(new Set(pts.map((p) => p.wall))).toEqual(new Set(['wn', 'we', 'ws', 'ww']));
  });

  it('shares the wall material (no extra draw call) unless a colour is set', () => {
    const plain = buildWalls(flat());
    const tone = buildWalls(flat({ panelling: { style: 'frames+dado' } }));
    expect(tone.groups.map((g) => g.materialId)).toEqual(plain.groups.map((g) => g.materialId));
    const coloured = buildWalls(flat({ panelling: { style: 'frames', colour: '#FFFFFF' } }));
    expect(coloured.groups.map((g) => g.materialId)).toContain(paintMaterialId('#ffffff'));
  });

  it('a wall side beats the room, and style none switches mouldings off', () => {
    const scene = flat({ panelling: { style: 'frames' } }, {});
    const wall = scene.walls.find((w) => w.id === 'wn')!;
    expect(wallFacePanelling(scene, wall, 'right', 'r')?.style).toBe('frames');
    expect(wallFacePanelling(scene, { panelling: { right: { style: 'none' } } }, 'right', 'r')).toBeUndefined();
    expect(wallFacePanelling(scene, { panelling: { right: { style: 'dado' } } }, 'right', 'r')?.style).toBe('dado');
    const off = flat({ panelling: { style: 'frames' } });
    const north = { ...off, walls: off.walls.map((w) => (w.id === 'wn' ? { ...w, panelling: { right: { style: 'none' as const } } } : w)) };
    expect(new Set(moulded(north).map((p) => p.wall))).toEqual(new Set(['we', 'ws', 'ww']));
  });

  it('draws the cornice under the ceiling, interrupted only by openings that reach it', () => {
    const scene = flat({ cornice: { heightMm: 100 } });
    const pts = moulded(scene);
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.every((p) => p.y >= 2.5 - 1e-6 && p.y <= 2.6 + 1e-6)).toBe(true);
    const mesh = buildWalls(scene);
    expect(triangles(mesh).every((t) => t.area > 0)).toBe(true);
  });

  it('keeps frames off a locked fitting standing against the wall', () => {
    const scene = flat(
      { panelling: { style: 'frames' } },
      { items: [{ id: 'rad', assetId: 'builtin:wardrobe', position: [4.5, 0.25], elevation: 0, rotation: 0, dims: { w: 1.2, d: 0.4, h: 1.6 }, mount: 'floor', locked: true }] },
    );
    const f = wallFrame(scene.walls.find((w) => w.id === 'wn')!);
    const obstacles = fittingObstacles(scene, f, 'left');
    // wn is walked from (0,0) to (5,0): the room is on its +z side, which is the right face
    expect(fittingObstacles(scene, f, 'right')).toHaveLength(1);
    expect(obstacles).toHaveLength(0);
    const o = fittingObstacles(scene, f, 'right')[0]!;
    expect(o.from).toBeCloseTo(3.9);
    expect(o.to).toBeCloseTo(5.1);
    const pts = moulded(scene).filter((p) => p.wall === 'wn' && p.s > 3.9 && p.s < 5 && p.y < 1.6);
    expect(pts).toEqual([]);
  });
});
