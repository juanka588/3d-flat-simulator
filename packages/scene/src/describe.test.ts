import { describe, expect, it } from 'vitest';
import { FIXTURES } from './commands/testUtil';
import { describeRoom, listRooms } from './describe';
import { RoomDescription, RoomSummary } from './mcp-types';
import { sunlightHours } from './lighting/sunpatch';
import { roomDaylightFactors } from './lighting/daylight';
import { roomStats } from './stats';
import { isStructural } from './structural';
import { DEFAULT_LIGHTING } from './view';

const charme = FIXTURES.charme!;
const light = { ...DEFAULT_LIGHTING, date: '2026-12-21' };
const desc = (id: string, scene = charme) => describeRoom(scene, id, light)!;

describe('listRooms', () => {
  it('is compact, schema-valid and in scene order', () => {
    for (const scene of Object.values(FIXTURES)) {
      const rooms = listRooms(scene);
      expect(rooms.map((r) => r.id)).toEqual(scene.rooms.map((r) => r.id));
      for (const r of rooms) RoomSummary.parse(r);
    }
    const sej = listRooms(charme).find((r) => r.id === 'sejour')!;
    expect(sej.lights).toBe(2);
    expect(sej.doors).toBeGreaterThanOrEqual(2);
  });
});

describe('describeRoom items (M5.16)', () => {
  const bare = { ...charme, items: [] };
  const snapshot = { provider: 'mock', sku: 'BED-160', name: 'MOCK bed 160x200', url: 'https://example.com/bed', price: 199, currency: 'EUR', dims: { w: 1.6, d: 2, h: 0.9 }, category: 'bed' as const, snapshotAt: '2026-10-27T10:00:00.000Z' };
  const bed = { id: 'bed', assetId: 'param:bed', position: [7.71, 1] as [number, number], elevation: 0, rotation: 0, roomId: 'ch1', productRef: { provider: 'mock', sku: 'BED-160' }, product: snapshot, mesh: { kind: 'parametric' as const, generator: 'bed', params: {} } };
  const stand = { id: 'stand', assetId: 'param:stand', position: [10.05 - 0.2, 4.42 - 0.2] as [number, number], elevation: 0, rotation: 0, roomId: 'ch1', dims: { w: 0.4, d: 0.4, h: 0.5 }, locked: true };
  const shelf = { id: 'shelf', assetId: 'param:shelf', position: [8.5, 0.15] as [number, number], elevation: 1.4, rotation: 0, roomId: 'ch1', mount: 'wall' as const, dims: { w: 0.8, d: 0.3, h: 0.3 } };
  const mid = { id: 'mid', assetId: 'param:mid', position: [8.5, 2.5] as [number, number], elevation: 0, rotation: 0, roomId: 'ch1', dims: { w: 0.4, d: 0.4, h: 0.5 } };

  it('lists id, name, product, price, dims, mount, locked, mesh source, pose and the position in words', () => {
    const d = describeRoom({ ...bare, items: [bed, stand, shelf, mid] }, 'ch1', light)!;
    RoomDescription.parse(d);
    const by = Object.fromEntries(d.items.map((i) => [i.id, i]));
    expect(by.bed).toMatchObject({ name: 'MOCK bed 160x200', productId: 'mock:BED-160', price: { amount: 199, currency: 'EUR' }, dims: { w: 1.6, d: 2, h: 0.9 }, mount: 'floor', locked: false, mesh: 'parametric', position: [7.71, 1] });
    expect(by.bed!.where).toBe('in the north-west corner (west and north walls)');
    expect(describeRoom({ ...bare, items: [{ ...bed, position: [8.2, 1] }] }, 'ch1', light)!.items[0]!.where).toBe('against the north wall, 0.49 m from the west corner');
    expect(by.stand).toMatchObject({ productId: null, price: null, locked: true, mesh: 'placeholder' });
    expect(by.stand!.where).toBe('in the south-east corner (south and east walls)');
    expect(by.shelf).toMatchObject({ mount: 'wall', elevationM: 1.4 });
    expect(by.shelf!.where).toBe('against the north wall, 1.15 m from the east corner, 1.4 m above the floor');
    expect(by.mid!.where).toBe('1.35 m from the east wall');
  });

  it('only lists the items of that room, and stays inside the token budget with a furnished room', () => {
    const scene = { ...bare, items: [bed, { ...mid, id: 'other', roomId: 'ch2', position: [5.5, 2] as [number, number] }] };
    expect(describeRoom(scene, 'ch2', light)!.items.map((i) => i.id)).toEqual(['other']);
    const many = Array.from({ length: 8 }, (_, i) => ({ ...mid, id: `m${i}`, position: [7.3 + (i % 4) * 0.7, 2 + Math.floor(i / 4) * 0.7] as [number, number] }));
    expect(JSON.stringify(describeRoom({ ...bare, items: [bed, ...many] }, 'ch1', light)).length).toBeLessThanOrEqual(6000);
  });
});

describe('describeRoom', () => {
  it('returns undefined for an unknown room', () => {
    expect(describeRoom(charme, 'nope', light)).toBeUndefined();
  });

  it('matches roomStats and the schema, on every room of both fixtures', () => {
    for (const scene of Object.values(FIXTURES)) {
      for (const room of scene.rooms) {
        const d = RoomDescription.parse(describeRoom(scene, room.id, light));
        const s = roomStats(scene, room.id)!;
        expect(d.areaM2).toBeCloseTo(s.area, 1);
        expect(d.perimeterM).toBeCloseTo(s.perimeter, 1);
        expect(d.items.map((i) => i.id)).toEqual(scene.items.filter((i) => i.roomId === room.id).map((i) => i.id));
      }
    }
  });

  it('sejour area equals roomStats and structural flags match isStructural', () => {
    const d = desc('sejour');
    expect(d.areaM2).toBeCloseTo(roomStats(charme, 'sejour')!.area, 2);
    expect(d.walls.length).toBeGreaterThan(4);
    for (const w of d.walls) {
      const wall = charme.walls.find((x) => x.id === w.wallId)!;
      expect(w.structural).toBe(isStructural(charme, wall));
    }
    expect(d.walls.find((w) => w.wallId === 'w-west')).toMatchObject({ structural: true, structuralSource: 'exterior' });
    expect(d.walls.find((w) => w.wallId === 'w-alcove')).toMatchObject({ structural: false, structuralSource: 'partition' });
  });

  it('walls are sorted by id then side and report the stretch inside the room', () => {
    const d = desc('ch1');
    const ids = d.walls.map((w) => w.wallId);
    expect(ids).toEqual([...ids].sort());
    const north = d.walls.find((w) => w.wallId === 'w-north')!;
    expect(north.lengthM).toBeCloseTo(10.05 - 6.91, 0);
    expect(north.wallOn).toBe('N');
    expect(north).not.toHaveProperty('facing');
    expect(north.finish).toEqual({ materialId: 'paint-white', source: 'scene_default' });
  });

  it('resolves finish sources', () => {
    const scoped = {
      ...charme,
      rooms: charme.rooms.map((r) => (r.id === 'ch1' ? { ...r, wallFinish: 'floor-tile' } : r)),
      walls: charme.walls.map((w) => (w.id === 'w-north' ? { ...w, roomFinishes: { alcove: { right: 'floor-oak' } } } : w)),
    };
    const ch1 = desc('ch1', scoped);
    expect(ch1.walls.find((w) => w.wallId === 'w-north')!.finish).toEqual({ materialId: 'floor-tile', source: 'room_wall_finish' });
    expect(desc('alcove', scoped).walls.find((w) => w.wallId === 'w-north')!.finish).toEqual({ materialId: 'floor-oak', source: 'room_scoped' });
    const whole = desc('ch1');
    expect(whole.walls.find((w) => w.wallId === 'w-ch2-ch1')!.sharedWith).toEqual([]);
    expect(desc('sejour').walls.some((w) => w.sharedWith.length > 0)).toBe(true);
    expect(desc('balcon').walls.find((w) => w.wallId === 'w-west')?.finish.source).toBe('whole_face');
  });

  it('windows of ch1/ch2/alcove face north, the sejour French doors face west', () => {
    expect(charme.site.northAngle).toBe(355.5);
    for (const id of ['ch1', 'ch2', 'alcove']) {
      const windows = desc(id).openings.filter((o) => o.type === 'window');
      expect(windows.length).toBe(1);
      expect(windows[0]!.compass).toBe('N');
      expect(windows[0]!.glazed).toBe(true);
      expect(windows[0]!.leadsTo).toBeNull();
    }
    const doors = desc('sejour').openings.filter((o) => o.id.startsWith('door-balcony'));
    expect(doors.map((d) => d.compass)).toEqual(['W', 'W']);
    expect(doors.every((d) => d.leadsTo === 'balcon' && d.glazed)).toBe(true);
  });

  it('wallOn (the side of the room a wall is on) equals the compass of every opening on that wall, in every room of both fixtures', () => {
    for (const scene of Object.values(FIXTURES)) {
      for (const room of scene.rooms) {
        const d = describeRoom(scene, room.id, light)!;
        for (const o of d.openings) {
          const sides = d.walls.filter((w) => w.wallId === o.wallId).map((w) => w.wallOn);
          expect(sides, `${room.id}/${o.id}`).toContain(o.compass);
        }
      }
    }
  });

  it('the sejour west wall (with the balcony doors) is on the W side; the ch1/ch2/alcove window walls are on the N side', () => {
    const west = desc('sejour').walls.find((w) => w.wallId === 'w-west')!;
    expect(west.wallOn).toBe('W');
    for (const id of ['ch1', 'ch2', 'alcove']) expect(desc(id).walls.find((w) => w.wallId === 'w-north')!.wallOn, id).toBe('N');
  });

  it('door swings are relative to the described room', () => {
    const swing = (room: string, door: string) => desc(room).openings.find((o) => o.id === door)!.swing;
    expect(swing('alcove', 'door-alcove')).toBe('into this room');
    expect(swing('ch1', 'door-ch1')).toBe('into this room');
    expect(swing('ch2', 'door-ch2')).toBe('into this room');
    expect(swing('sejour', 'door-sejour-entree')).toBe('into this room');
    expect(swing('entree', 'door-sejour-entree')).toBe('into sejour');
    expect(swing('entree', 'door-sdb')).toBe('into this room');
    expect(swing('sdb', 'door-sdb')).toBe('into entree');
    expect(swing('wc', 'door-wc')).toBe('into entree');
    expect(swing('entree', 'door-entry')).toBe('outward');
    expect(desc('sejour').openings.find((o) => o.type === 'window')).toBeUndefined();
    expect(desc('ch1').openings.find((o) => o.type === 'window')!.swing).toBeUndefined();
  });

  it('lights, daylight factor and sunlight hours come from the lighting helpers', () => {
    const d = desc('sejour');
    expect(d.lights.map((l) => l.id).sort()).toEqual(['l-cuisine', 'l-sejour']);
    expect(d.lights[0]).toMatchObject({ on: true });
    expect(d.daylight.daylightFactorPct).toBeCloseTo(roomDaylightFactors(charme).sejour! * 100, 0);
    for (const date of ['2026-12-21', '2026-06-21']) {
      const hours = sunlightHours(charme, date);
      for (const room of charme.rooms) {
        const dd = describeRoom(charme, room.id, { date })!;
        expect(dd.daylight.sunlightHours).toBeCloseTo(hours[room.id]!, 1);
        expect(dd.daylight.obstruction).toBe('none');
        if (hours[room.id]! > 0) {
          expect(dd.daylight.firstSun).toMatch(/^\d\d:\d\d$/);
          expect(dd.daylight.lastSun! >= dd.daylight.firstSun!).toBe(true);
        } else expect(dd.daylight.firstSun).toBeNull();
      }
    }
  });

  it('applies lamp overrides from the lighting view', () => {
    const d = describeRoom(charme, 'sejour', { ...light, lamps: { 'l-sejour': { on: false, kelvin: 4000 } } })!;
    expect(d.lights.find((l) => l.id === 'l-sejour')).toMatchObject({ on: false, kelvin: 4000 });
  });

  it('stays within the token budget (<= 6000 chars of JSON) for every Charme room', () => {
    for (const room of charme.rooms) {
      const json = JSON.stringify(describeRoom(charme, room.id, light));
      expect(json.length, room.id).toBeLessThanOrEqual(6000);
    }
  });

  it('is deterministic and does not mutate the scene', () => {
    const before = JSON.stringify(charme);
    expect(JSON.stringify(desc('sejour'))).toBe(JSON.stringify(desc('sejour')));
    expect(JSON.stringify(charme)).toBe(before);
  });
});
