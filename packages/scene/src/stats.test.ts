import { describe, expect, it } from 'vitest';
import charme from '../fixtures/charme-3205.flat.json';
import { parseScene } from './parse';
import { roomStats, wallStats } from './stats';

const r = parseScene(charme);
if (!r.ok) throw new Error(r.errors.join('\n'));
const scene = r.scene;

describe('wallStats', () => {
  it('reports dimensions, areas and finishes of w-north', () => {
    const s = wallStats(scene, 'w-north')!;
    expect(s.length).toBeCloseTo(11.75, 9);
    expect(s.thickness).toBe(0.2);
    expect(s.height).toBe(2.5);
    expect(s.grossArea.left).toBeCloseTo(11.75 * 2.5, 9);
    expect(s.grossArea.right).toBeCloseTo(11.75 * 2.5, 9);
    // three windows: 1.0, 0.9, 0.9 wide, 1.7 high
    expect(s.netArea.left).toBeCloseTo(11.75 * 2.5 - (1.0 + 0.9 + 0.9) * 1.7, 9);
    expect(s.netArea.right).toBeCloseTo(s.netArea.left, 12);
    expect(s.openings.map((o) => o.id)).toEqual(['win-alcove', 'win-ch2', 'win-ch1']);
    expect(s.finish).toEqual({ left: 'facade', right: scene.defaults.wall });
  });
  it('returns undefined for unknown walls', () => {
    expect(wallStats(scene, 'nope')).toBeUndefined();
  });
  it('uses a side-specific finish when present', () => {
    const withFinish = { ...scene, walls: scene.walls.map((w) => (w.id === 'w-north' ? { ...w, finish: { left: 'x' } } : w)) };
    expect(wallStats(withFinish, 'w-north')!.finish).toEqual({ left: 'x', right: scene.defaults.wall });
  });
});

describe('roomStats', () => {
  it('ch1: area, perimeter, materials, ceiling height and boundary openings', () => {
    const s = roomStats(scene, 'ch1')!;
    expect(s.area).toBeCloseTo(13.88, 1);
    expect(s.perimeter).toBeCloseTo(2 * (3.14 + 4.42), 9);
    expect(s.floorMaterial).toBe('lib-parquet-light-oak');
    expect(s.ceilingMaterial).toBe('ceiling-white');
    expect(s.ceilingHeight).toBe(2.5);
    expect(s.openings.map((o) => o.id).sort()).toEqual(['door-ch1', 'win-ch1']);
    expect(s.wallIds).toEqual(expect.arrayContaining(['w-north', 'w-east', 'w-ch1-south', 'w-ch2-ch1']));
  });
  it('balcony has no ceiling and lists its balcony doors', () => {
    const s = roomStats(scene, 'balcon')!;
    expect(s.ceilingMaterial).toBeNull();
    expect(s.ceilingHeight).toBeNull();
    expect(s.openings.map((o) => o.id).sort()).toEqual(['door-balcony-cuisine', 'door-balcony-sejour']);
  });
  it('the living room also sees the balcony doors, the entrance sees its two doors', () => {
    expect(roomStats(scene, 'sejour')!.openings.map((o) => o.id)).toEqual(
      expect.arrayContaining(['door-balcony-sejour', 'door-balcony-cuisine', 'door-alcove', 'door-sejour-entree']),
    );
    expect(roomStats(scene, 'entree')!.openings.map((o) => o.id)).toEqual(
      expect.arrayContaining(['door-entry', 'door-sejour-entree', 'door-ch1', 'door-wc']),
    );
  });
  it('returns undefined for unknown rooms', () => {
    expect(roomStats(scene, 'nope')).toBeUndefined();
  });
});
