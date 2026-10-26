import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../commands/testUtil';
import { analyzeRoomWallSides, roomWallSides } from './room-sides';
import { structuralInfo } from '../structural';

const charme = FIXTURES.charme!;
const fmt = (id: string) => roomWallSides(charme, id).map((s) => `${s.wallId}:${s.side}:${s.coverage}`);

describe('roomWallSides', () => {
  it('finds faces along polygon edges (alcove)', () => {
    expect(fmt('alcove')).toEqual(['w-north:right:partial', 'w-west:right:partial', 'w-alcove:left:full', 'w-sejour-ch2:right:partial']);
  });

  it('every Charme room has sides; unique sides are full', () => {
    for (const room of charme.rooms) {
      const sides = roomWallSides(charme, room.id);
      expect(sides.length, room.id).toBeGreaterThanOrEqual(3);
    }
    expect(roomWallSides(charme, 'ch2').find((s) => s.wallId === 'w-ch2-ch1')!.coverage).toBe('full');
  });

  it('balcony rail and screen face the balcony', () => {
    expect(fmt('balcon')).toContain('w-balcony-rail:left:full');
  });

  it('unknown or unwalled rooms are errors', () => {
    const r = analyzeRoomWallSides(charme, 'nope');
    expect(!r.ok && r.errors[0]!.code).toBe('unknown_entity');
    const ghost = { ...charme, rooms: [...charme.rooms, { id: 'g', name: 'g', type: 'other' as const, polygon: [[30, 30], [32, 30], [32, 32]] as [number, number][] }] };
    const g = analyzeRoomWallSides(ghost, 'g');
    expect(!g.ok && g.errors[0]!.code).toBe('no_wall_sides');
  });

  it('warns about shared sides', () => {
    const r = analyzeRoomWallSides(charme, 'alcove');
    expect(r.ok && r.warnings.map((w) => w.wallId)).toContain('w-sejour-ch2');
  });
});

describe('isStructural defaults', () => {
  it('Charme: facades, w-landing, w-sdb-east structural; 7 cm partitions removable', () => {
    const res = Object.fromEntries(charme.walls.map((w) => [w.id, structuralInfo(charme, w).structural]));
    for (const id of ['w-north', 'w-east', 'w-south', 'w-west', 'w-wc-south', 'w-landing', 'w-sdb-east']) expect(res[id], id).toBe(true);
    for (const w of charme.walls.filter((w) => w.thickness === 0.07)) expect(res[w.id], w.id).toBe(false);
  });

  it('explicit value wins; thickness >= 0.15 is structural without rooms', () => {
    const w = charme.walls.find((x) => x.id === 'w-alcove')!;
    expect(structuralInfo(charme, { ...w, structural: true })).toEqual({ structural: true, source: 'explicit' });
    const bare = { walls: [], rooms: [] };
    expect(structuralInfo(bare, { id: 'x', thickness: 0.15 }).source).toBe('thickness');
    expect(structuralInfo(bare, { id: 'x', thickness: 0.1 }).structural).toBe(false);
  });

  it('sample fixture resolves for every wall', () => {
    const s = FIXTURES.sample!;
    for (const w of s.walls) expect(typeof structuralInfo(s, w).structural).toBe('boolean');
  });
});
