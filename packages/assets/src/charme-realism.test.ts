import { describe, expect, it } from 'vitest';
import charme from '@flat/scene/fixtures/charme-3205.flat.json';
import { buildFittings, footprintOf, itemDims, parseScene } from '@flat/scene';
import type { Item, Scene } from '@flat/scene';
import './register';

/** Realism details of the Charme 3205 scene: hand basin, bath screen, white doors, French doors, grey wardrobes, washing machine. */
const parsed = parseScene(charme);
if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
const scene: Scene = parsed.scene;
const item = (id: string): Item => scene.items.find((i) => i.id === id)!;
const rect = (id: string) => {
  const it = item(id);
  const pts = footprintOf(it.position, it.rotation, itemDims(it));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};

describe('WC hand basin', () => {
  it('hangs on the north wall of the WC, clear of the toilet and of the door swing, at 40 x 25 cm', () => {
    const b = item('wc-handbasin');
    expect(b).toMatchObject({ locked: true, roomId: 'wc', mount: 'wall', mesh: { generator: 'handBasin' } });
    expect(b.dims).toEqual({ w: 0.4, d: 0.25, h: 0.22 });
    const r = rect('wc-handbasin');
    expect(r.minY).toBeCloseTo(4.49, 3); // back on the north face of w-ch1-south
    const t = rect('wc-toilet');
    expect(t.minX - r.maxX).toBeGreaterThan(0.15);
    // the door (west wall, y 4.95-5.65) opens outwards; the basin is on the other side of the room from it
    expect(r.maxY).toBeLessThan(4.95);
    expect(b.elevation + b.dims!.h).toBeGreaterThan(0.85);
    expect(b.elevation + b.dims!.h).toBeLessThan(1.0);
  });
});

describe('bath screen', () => {
  it('stands on the front edge of the tub at its tap end, against the wall, 75 cm wide and 1.4 m high', () => {
    const s = item('sdb-bath-screen');
    const tub = item('sdb-bathtub');
    expect(s.dims).toEqual({ w: 0.75, d: 0.03, h: 1.4 });
    expect(s).toMatchObject({ locked: true, mount: 'wall', mesh: { generator: 'bathScreen' } });
    // tapEnd "right" with rotation 90: local +x is world -y, so the taps (and the wall behind them) are at the tub's min y
    expect((tub.mesh as unknown as { params: { tapEnd: string } }).params.tapEnd).toBe('right');
    const t = rect('sdb-bathtub');
    const r = rect('sdb-bath-screen');
    expect(r.minY).toBeCloseTo(6.65, 3); // the wall channel is on the face of the tap-end wall (w-niche-north, centre y 6.615, 7 cm thick)
    expect(r.minY - t.minY).toBeLessThan(0.05);
    expect(r.maxY - r.minY).toBeCloseTo(0.75, 3);
    expect(r.minX).toBeGreaterThanOrEqual(t.maxX - 1e-6); // along the open (front) side of the tub
    // starts at the rim (0.54 m) and reaches about 1.95 m
    expect(s.elevation).toBeGreaterThanOrEqual(0.54);
    expect(s.elevation + s.dims!.h).toBeGreaterThan(1.9);
  });
});

describe('doors and windows', () => {
  const white = scene.openings.filter((o) => o.type !== 'passage');
  it('every door and window of the flat is white; French doors and the bedroom windows have sashes', () => {
    for (const o of white) expect(o.finish, o.id).toBe('white');
    for (const id of ['door-balcony-sejour', 'door-balcony-cuisine', 'win-alcove', 'win-ch1', 'win-ch2']) expect(scene.openings.find((o) => o.id === id)?.sashes, id).toBeGreaterThan(0);
    expect(scene.openings.find((o) => o.id === 'door-balcony-sejour')).toMatchObject({ glazed: true, sashes: 2, width: 1.4 });
  });

  it('interior doors carry a steel lever on both sides at 1.05 m; windows a white handle at 1.1 m', () => {
    const { fittings } = buildFittings(scene);
    const levels = (matId: string, id: string) => {
      const group = fittings.groups.find((g) => g.materialId === matId);
      if (!group) return [] as number[];
      const ys: number[] = [];
      for (const o of fittings.owners) {
        if (o.entityId !== id) continue;
        for (let t = o.start; t < o.start + o.count; t++) {
          if (t * 3 < group.start || t * 3 >= group.start + group.count) continue;
          for (let k = 0; k < 3; k++) ys.push(fittings.positions[fittings.indices[t * 3 + k]! * 3 + 1]!);
        }
      }
      return ys;
    };
    for (const id of ['door-sdb', 'door-wc', 'door-ch1', 'door-ch2', 'door-alcove', 'door-sejour-entree', 'door-entry']) {
      const ys = levels('builtin:handle', id);
      expect(ys.length, id).toBeGreaterThan(0);
      expect(ys.some((y) => Math.abs(y - 1.05) < 0.011), id).toBe(true);
      expect(Math.min(...ys)).toBeGreaterThan(0.9);
      expect(Math.max(...ys)).toBeLessThan(1.1);
    }
    for (const id of ['door-balcony-sejour', 'win-alcove', 'win-ch1']) {
      const ys = levels('builtin:handle-white', id);
      expect(ys.length, id).toBeGreaterThan(0);
      expect(ys.some((y) => Math.abs(y - 1.1) < 0.02), id).toBe(true);
    }
  });
});

describe('wardrobes and washing machine', () => {
  it('the sliding wardrobe doors are grey', () => {
    for (const id of ['placard-ch1', 'placard-ch2']) expect((item(id).mesh as unknown as { params: { finish: string } }).params.finish, id).toBe('grey');
  });
  it('the washing machine is a 60 x 60 x 85 front loader', () => {
    expect(item('sdb-washing-machine-ll')).toMatchObject({ dims: { w: 0.6, d: 0.6, h: 0.85 }, mesh: { generator: 'washingMachine' } });
  });
});
