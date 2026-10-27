import { describe, expect, it } from 'vitest';
import { applyCommand, makeEnvelope, parseScene, zoneProblems } from '@flat/scene';
import type { Command, Room, Scene } from '@flat/scene';
import charme from '../../../../packages/scene/fixtures/charme-3205.flat.json';
import { addZoneCommand, axisRect, dragCorner, dragZoneCorner, newZoneRect, nextZoneId } from './zones';

const parsed = parseScene(charme);
if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
const scene: Scene = parsed.scene;
const room = (id: string): Room => scene.rooms.find((r) => r.id === id)!;
const apply = (s: Scene, cmd: Command): Scene => {
  const r = applyCommand(s, makeEnvelope(cmd, { id: 'e', ts: 1, author: { kind: 'user' } }));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.scene;
};

describe('newZoneRect', () => {
  it('is a 1 x 1 m square at the centre of a rectangular room', () => {
    const p = newZoneRect(room('ch1'))!;
    expect(axisRect(p)).toMatchObject({ x1: expect.any(Number) });
    const r = axisRect(p)!;
    expect(r.x1 - r.x0).toBeCloseTo(1, 9);
    expect(r.y1 - r.y0).toBeCloseTo(1, 9);
    expect((r.x0 + r.x1) / 2).toBeCloseTo(8.5, 1); // the room runs 6.91 - 10.05
    expect((r.y0 + r.y1) / 2).toBeCloseTo(2.2, 1);
  });

  it('finds a free spot in a concave room and off existing zones', () => {
    const s = room('sejour');
    const p = newZoneRect(s)!;
    expect(zoneProblems(s.polygon, [...s.floorZones!, { id: 'n', polygon: p }])).toEqual([]);
  });

  it('shrinks in a tight room and is null when nothing fits', () => {
    const tiny: Room = { id: 't', name: 'T', type: 'storage', polygon: [[0, 0], [0.6, 0], [0.6, 0.6], [0, 0.6]] };
    const r = axisRect(newZoneRect(tiny)!)!;
    expect(r.x1 - r.x0).toBeCloseTo(0.5, 9);
    expect(newZoneRect({ ...tiny, polygon: [[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1]] })).toBeNull();
  });

  it('ids do not collide', () => {
    const z = (id: string) => ({ id, polygon: [], material: 'm' }) as never;
    expect(nextZoneId({})).toBe('zone-1');
    expect(nextZoneId({ floorZones: [z('zone-1')] })).toBe('zone-2');
    expect(nextZoneId({ floorZones: [z('zone-2')] })).toBe('zone-3');
  });
});

describe('addZoneCommand', () => {
  it('adds a valid zone with a visible material, selected by id', () => {
    const add = addZoneCommand(scene, room('ch1'))!;
    const next = apply(scene, add.command);
    const zone = next.rooms.find((r) => r.id === 'ch1')!.floorZones!.find((z) => z.id === add.zoneId)!;
    expect(zone.material).not.toBe('lib-parquet-light-oak');
    expect(zone.name).toBe('Zone 1');
  });

  it('defines a grey paint when the flat has no other floor material', () => {
    const bare = parseScene({ version: 1, name: 't', site: { latitude: 0, longitude: 0 }, walls: [{ id: 'w', start: [0, 0], end: [4, 0] }], rooms: [{ id: 'r', name: 'R', type: 'living', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] }] });
    if (!bare.ok) throw new Error('parse');
    const add = addZoneCommand(bare.scene, bare.scene.rooms[0]!)!;
    expect(add.command.type).toBe('batch');
    expect(apply(bare.scene, add.command).rooms[0]!.floorZones).toHaveLength(1);
  });
});

describe('dragZoneCorner', () => {
  const ch1 = room('ch1');
  const zone = { id: 'z', name: 'Z', polygon: [[7.5, 1], [8.5, 1], [8.5, 2], [7.5, 2]] as [number, number][], material: 'floor-tile-grey' };
  const withZone: Room = { ...ch1, floorZones: [zone] };

  it('resizes a rectangle from the dragged corner, snapped to 5 cm', () => {
    const r = dragZoneCorner(withZone, 'z', zone.polygon, 2, [9.123, 2.771]);
    expect(r.clamped).toBe(false);
    expect(axisRect(r.polygon)).toEqual({ x0: 7.5, y0: 1, x1: 9.1, y1: 2.75 });
    expect(r.polygon[r.corner]).toEqual([9.1, 2.75]);
  });

  it('clamps at the room walls: far outside stops at the inner face', () => {
    const r = dragZoneCorner(withZone, 'z', zone.polygon, 2, [14, 9]);
    expect(r.clamped).toBe(true);
    const rect = axisRect(r.polygon)!;
    expect(rect.x1).toBeCloseTo(10.05, 1);
    expect(rect.y1).toBeCloseTo(4.42, 1);
    expect(zoneProblems(ch1.polygon, [{ id: 'z', polygon: r.polygon }])).toEqual([]);
  });

  it('never leaves the room whatever the pointer does', () => {
    for (const x of [-20, 3, 7.4, 12, 40]) {
      for (const y of [-20, 0.5, 3, 9, 40]) {
        for (const corner of [0, 1, 2, 3]) {
          const r = dragZoneCorner(withZone, 'z', zone.polygon, corner, [x, y]);
          expect(zoneProblems(ch1.polygon, [{ id: 'z', polygon: r.polygon }]), `${x},${y} corner ${corner}`).toEqual([]);
        }
      }
    }
  });

  it('stops at another zone and at the minimum side', () => {
    const two: Room = { ...ch1, floorZones: [zone, { id: 'o', polygon: [[9, 1], [9.8, 1], [9.8, 2], [9, 2]], material: 'x' }] };
    const r = dragZoneCorner(two, 'z', zone.polygon, 2, [9.6, 1.8]);
    expect(axisRect(r.polygon)!.x1).toBeLessThanOrEqual(9 + 1e-6);
    const thin = dragZoneCorner(withZone, 'z', zone.polygon, 2, [7.5, 1]);
    const t = axisRect(thin.polygon)!;
    expect(t.x1 - t.x0).toBeGreaterThanOrEqual(0.1 - 1e-6);
  });

  it('moves one vertex of a non-rectangular zone', () => {
    const tri: [number, number][] = [[7.5, 1], [8.5, 1], [8, 2]];
    expect(dragCorner(tri, 2, [8.2, 2.5])).toEqual([[7.5, 1], [8.5, 1], [8.2, 2.5]]);
  });
});
