import { describe, expect, it } from 'vitest';
import { loadSceneText, wallSideRooms } from '@flat/scene';
import type { Scene } from '@flat/scene';
import { DEFAULT_FIXTURE } from '../state/fixtures';
import { selectionForWallFace, withHitContext } from './selection';

const loaded = loadSceneText(DEFAULT_FIXTURE.text);
if (!loaded.ok) throw new Error('fixture');
const scene: Scene = loaded.scene;

/** Plan point on a wall's centreline `along` metres from its start. */
function pointAt(wallId: string, along: number): [number, number] {
  const w = scene.walls.find((x) => x.id === wallId)!;
  const len = Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]);
  return [w.start[0] + ((w.end[0] - w.start[0]) / len) * along, w.start[1] + ((w.end[1] - w.start[1]) / len) * along];
}

describe('withHitContext', () => {
  it('records the room on the clicked face of a wall shared by two rooms', () => {
    const segs = wallSideRooms(scene)['w-west']!.segments;
    const rooms = segs.map((s) => s.right).filter((r): r is string => !!r);
    expect(new Set(rooms)).toEqual(new Set(['sejour', 'alcove']));
    for (const seg of segs.filter((s) => s.right)) {
      const mid = (seg.from + seg.to) / 2;
      const sel = withHitContext(scene, { kind: 'wall', entityId: 'w-west', face: 'right' }, pointAt('w-west', mid));
      expect(sel.roomId).toBe(seg.right);
      expect(sel.along).toBeCloseTo(mid, 6);
    }
  });

  it('clicking w-north inside chambre 1 resolves chambre 1, not the alcove or chambre 2', () => {
    const segs = wallSideRooms(scene)['w-north']!.segments;
    const seg = segs.find((s) => s.left === 'ch1' || s.right === 'ch1')!;
    expect(seg).toBeDefined();
    const face = seg.left === 'ch1' ? 'left' : 'right';
    const sel = withHitContext(scene, { kind: 'wall', entityId: 'w-north', face }, pointAt('w-north', (seg.from + seg.to) / 2));
    expect(sel.roomId).toBe('ch1');
  });

  it('passes other selections and unlocated hits through', () => {
    const floor = { kind: 'floor' as const, entityId: 'sejour' };
    expect(withHitContext(scene, floor, [1, 1])).toBe(floor);
    const top = { kind: 'wall' as const, entityId: 'w-west', face: 'top' as const };
    expect(withHitContext(scene, top, [1, 1])).toBe(top);
  });
});

describe('selectionForWallFace', () => {
  it('selects the stretch of the given room', () => {
    const sel = selectionForWallFace(scene, { wallId: 'w-west', side: 'right', roomId: 'alcove' })!;
    expect(sel).toMatchObject({ kind: 'wall', entityId: 'w-west', face: 'right', roomId: 'alcove' });
    expect(withHitContext(scene, { kind: 'wall', entityId: 'w-west', face: 'right' }, pointAt('w-west', sel.along!)).roomId).toBe('alcove');
  });
  it('is null for a room that does not border the face, or an unknown wall', () => {
    expect(selectionForWallFace(scene, { wallId: 'w-west', side: 'right', roomId: 'ch2' })).toBeNull();
    expect(selectionForWallFace(scene, { wallId: 'nope', side: 'left' })).toBeNull();
  });
});
