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
    // w-sdb-north-east is the 7 cm stub (6.39 -> 6.49) closing the SDB/Entrée wall onto w-sdb-east beside the TE recess. The SDB
    // polygon ends at the inner face of w-sdb-east (x 6.39), so only the Entrée sees the stub: it reads as 'exterior', hence
    // structural. That is the wanted behaviour (nobody should open a hole in the corner next to the electrical panel).
    expect(structuralInfo(charme, charme.walls.find((w) => w.id === 'w-sdb-north-east')!)).toEqual({ structural: true, source: 'exterior' });
    for (const w of charme.walls.filter((w) => w.thickness === 0.07 && w.id !== 'w-sdb-north-east')) expect(res[w.id], w.id).toBe(false);
    for (const id of ['w-kitchen-column', 'w-ch1-column', 'w-sdb-column']) expect(res[id], id).toBe(true);
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

describe('side index cache', () => {
  it('is reused across scenes that only change finishes, and invalidated by geometry changes', () => {
    const before = roomWallSides(charme, 'alcove');
    // finish-only change: new walls array, same geometry
    const painted = { ...charme, walls: charme.walls.map((w) => (w.id === 'w-north' ? { ...w, finish: { ...w.finish, right: 'paint-white' } } : w)) };
    expect(painted.walls).not.toBe(charme.walls);
    expect(roomWallSides(painted, 'alcove')).toStrictEqual(before);
    // geometry change: the wall between the alcove and the sejour moves away, so the alcove loses it
    const moved = { ...charme, walls: charme.walls.map((w) => (w.id === 'w-alcove' ? { ...w, start: [w.start[0] + 5, w.start[1]] as [number, number], end: [w.end[0] + 5, w.end[1]] as [number, number] } : w)) };
    expect(roomWallSides(moved, 'alcove').some((x) => x.wallId === 'w-alcove')).toBe(false);
    // and the original still answers as before (no cross-contamination)
    expect(roomWallSides(charme, 'alcove')).toStrictEqual(before);
    expect(before.find((x) => x.wallId === 'w-north')!.otherRoomIds).toStrictEqual(['ch2', 'ch1', 'balcon']);
  });
});

