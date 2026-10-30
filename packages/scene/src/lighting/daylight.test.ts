import { describe, expect, it } from 'vitest';
import charme from '../../fixtures/charme-3205.flat.json';
import { Scene } from '../schema';
import { DAYLIGHT_FLOOR, roomDaylightFactors, wallExposure, wallSideRooms } from './daylight';

const scene = Scene.parse(charme);

describe('roomDaylightFactors (Charme 3205)', () => {
  const f = roomDaylightFactors(scene);
  it('has every room in [0, 1]', () => {
    expect(Object.keys(f).sort()).toEqual(scene.rooms.map((r) => r.id).sort());
    for (const v of Object.values(f)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
  it('the living room and balcony are bright', () => {
    expect(f['sejour']).toBeGreaterThan(0.8);
    expect(f['balcon']).toBe(1);
  });
  it('north bedrooms with a window are in between', () => {
    for (const id of ['ch1', 'ch2']) {
      expect(f[id]).toBeGreaterThan(0.5);
      expect(f[id]).toBeLessThan(0.8);
    }
    expect(f['alcove']).toBeGreaterThan(0.5);
  });
  it('windowless wc, sdb and entree are low', () => {
    for (const id of ['wc', 'sdb', 'entree']) {
      expect(f[id]).toBeGreaterThanOrEqual(DAYLIGHT_FLOOR);
      expect(f[id]).toBeLessThan(0.3);
    }
    expect(f['entree']!).toBeGreaterThan(f['wc']!); // borrows from the living room
  });
});

describe('wallSideRooms (Charme 3205)', () => {
  const w = wallSideRooms(scene);
  it('has an entry per wall with consistent segments', () => {
    expect(Object.keys(w).sort()).toEqual(scene.walls.map((x) => x.id).sort());
    for (const wall of scene.walls) {
      const segs = w[wall.id]!.segments;
      expect(segs[0]!.from).toBeCloseTo(0, 9);
      expect(segs[segs.length - 1]!.to).toBeCloseTo(Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]), 9);
    }
  });
  it('the west facade has the living room on one face and the balcony on the other', () => {
    const west = w['w-west']!;
    const ids = [west.left, west.right];
    expect(ids).toContain('sejour');
    const all = new Set(west.segments.flatMap((s) => [s.left, s.right]));
    expect(all.has('balcon')).toBe(true);
  });
  it('a partition between the entree and wc maps to those two rooms', () => {
    const p = w['w-wc-west']!;
    expect(new Set([p.left, p.right]).has('wc')).toBe(true);
  });
});

describe('daylight comes through windows only', () => {
  const f = roomDaylightFactors(scene);
  it('a windowless room with its door shut is dark; the hall only borrows a share of the living room`s light through its door', () => {
    expect(DAYLIGHT_FLOOR).toBe(0);
    expect(f['wc']).toBe(0);
    expect(f['sdb']).toBe(0);
    expect(f['entree']).toBeGreaterThan(0.1);
    expect(f['entree']).toBeLessThan(0.2);
  });
  it('tells the facade from the walls towards the landing and the neighbours', () => {
    const e = wallExposure(scene);
    for (const id of ['w-north', 'w-east', 'w-south']) expect(e[id], id).toBe('facade');
    for (const id of ['w-sdb-east', 'w-landing', 'w-wc-south']) expect(e[id], id).toBe('party');
    for (const id of ['w-sdb-north', 'w-wc-west', 'w-ch2-ch1', 'w-ch1-south', 'w-west', 'w-balcony-rail']) expect(e[id], id).toBe('interior');
  });
  it('a window makes its wall a facade, and lets the sky in', () => {
    const copy = structuredClone(charme) as typeof charme;
    (copy.openings as unknown[]).push({ id: 'win-party', wallId: 'w-sdb-east', type: 'window', offset: 1.2, width: 1, height: 1, sill: 1 });
    const s = Scene.parse(copy);
    expect(wallExposure(s)['w-sdb-east']).toBe('facade');
    expect(roomDaylightFactors(s)['sdb']).toBeGreaterThan(0.1);
  });
  it('a window in a facade wall does', () => {
    const copy = structuredClone(charme) as typeof charme;
    (copy.openings as unknown[]).push({ id: 'win-sdb', wallId: 'w-south', type: 'window', offset: 2.5, width: 1, height: 1, sill: 1 });
    expect(roomDaylightFactors(Scene.parse(copy))['sdb']).toBeGreaterThan(0.1);
  });
});
