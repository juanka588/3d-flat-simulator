import { describe, expect, it } from 'vitest';
import { analyzeWalkways, layoutContext, solvePlacement, validateLayout, type PlacementResult } from './index';
import { BARE_CHARME, channelItems, channelScene, corridorScene, mkItem, withItems } from './testUtil';

const codes = (r: PlacementResult) => (r.ok ? [] : r.violations.map((v) => v.code));
const dims = (w: number, d: number, h: number) => ({ w, d, h });

const measure = (scene: ReturnType<typeof channelScene>, room = 'r') => {
  const ctx = layoutContext(scene);
  return analyzeWalkways(ctx, ctx.rooms.get(room)!);
};

describe('one-door rooms (M7)', () => {
  it('a 3.14 m unit across Chambre 1 cuts the room in two and is refused', () => {
    const r = solvePlacement(BARE_CHARME, { roomId: 'ch1', dims: dims(3.14, 0.4, 1), relation: { kind: 'at', position: [8.48, 2.2], rotation: 0 } });
    expect(codes(r)).toEqual(['walkway_too_narrow']);
    if (!r.ok) {
      expect(r.violations[0]!.message).toMatch(/cuts \d+% of the floor/);
      expect(r.violations[0]!.entityIds).toEqual(expect.arrayContaining(['ch1', 'door-ch1']));
    }
  });

  it('a wardrobe along the east wall leaves the room in one piece', () => {
    const r = solvePlacement(BARE_CHARME, { roomId: 'ch1', dims: dims(1.2, 0.6, 2.2), relation: { kind: 'against_wall', wallId: 'w-east', roomId: 'ch1', align: 'center' } });
    expect(r.ok).toBe(true);
  });

  it('a toilet against the east wall of the WC (0.58 m left beside it) is accepted', () => {
    const r = solvePlacement(BARE_CHARME, { roomId: 'wc', dims: dims(0.38, 0.7, 0.8), relation: { kind: 'against_wall', wallId: 'w-east', roomId: 'wc', align: 'center' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scene = withItems(BARE_CHARME, [mkItem('toilet', { position: r.placement.position, rotation: r.placement.rotation, roomId: 'wc', dims: dims(0.38, 0.7, 0.8) })]);
    expect(validateLayout(scene, { roomId: 'wc' }).violations).toEqual([]);
  });

  it('a toilet against the north wall of the WC, clear of the door, is accepted', () => {
    const r = solvePlacement(BARE_CHARME, { roomId: 'wc', dims: dims(0.38, 0.7, 0.8), relation: { kind: 'against_wall', wallId: 'w-ch1-south', roomId: 'wc', align: 'end' } });
    expect(r.ok).toBe(true);
  });

  it('a toilet in front of the WC door is refused as door-blocking, not as a narrow walkway', () => {
    const r = solvePlacement(BARE_CHARME, { roomId: 'wc', dims: dims(0.38, 0.7, 0.8), relation: { kind: 'against_wall', wallId: 'w-ch1-south', roomId: 'wc', align: 'start' } });
    expect(codes(r)).toEqual(['door_swing_blocked']);
  });

  it('a window cut off behind a barrier is reported even when most of the floor is still reachable', () => {
    // a thin full-width rack close to the window wall: the window side is a 0.6 m deep strip, under 20 % of the room
    const r = solvePlacement(BARE_CHARME, { roomId: 'ch1', dims: dims(3.14, 0.3, 1), relation: { kind: 'at', position: [8.48, 0.95], rotation: 0 } });
    expect(codes(r)).toEqual(['walkway_too_narrow']);
    if (!r.ok) expect(r.violations[0]!.message).toMatch(/"win-ch1" out of reach/);
  });
});

describe('raster bias (M8)', () => {
  const GAPS = [0.79, 0.8, 0.81];
  const SHIFTS = [0, 0.013, 0.027, 0.038];

  it.each([
    ['straight', 1.5, 1.5],
    ['slightly diagonal', 1.2, 1.8],
    ['diagonal', 0.9, 2.1],
  ])('a %s passage: 0.79 m is refused, 0.80 m and 0.81 m are accepted, at every raster phase', (_name, westY, eastY) => {
    const base = channelScene(westY, eastY, 1.8);
    for (const shift of SHIFTS) {
      for (const gap of GAPS) {
        const scene = withItems(base, channelItems(westY, eastY, gap, shift));
        const a = measure(scene);
        const label = `gap ${gap} shift ${shift}: width ${a.minWidthM}`;
        expect(a.violation !== undefined, label).toBe(gap < 0.8);
        expect(a.minWidthM!, label).toBeGreaterThan(gap - 0.015);
        expect(a.minWidthM!, label).toBeLessThan(gap + 0.015);
      }
    }
  });

  it('the entry route needs 0.9 m: 0.89 refused, 0.90 and 0.91 accepted, at every raster phase', () => {
    const room = corridorScene();
    // a rack hung from the north wall leaves a gap against the south wall
    for (const gap of [0.88, 0.89, 0.9, 0.91, 0.92, 0.93]) {
      const top = 3 - gap;
      const scene = withItems(room, [mkItem('rack', { position: [2.5, top / 2], roomId: 'r', dims: dims(3, top, 0.8) })]);
      const a = measure(scene);
      expect(a.violation !== undefined, `gap ${gap}: ${a.minWidthM}`).toBe(gap < 0.895);
    }
  });

  it('a gap well above or below the minimum is decided without the exact pass', () => {
    const base = channelScene(1.5, 1.5, 1.8);
    expect(measure(withItems(base, channelItems(1.5, 1.5, 0.6))).violation).toBeDefined();
    expect(measure(withItems(base, channelItems(1.5, 1.5, 1.2))).violation).toBeUndefined();
  });
});
