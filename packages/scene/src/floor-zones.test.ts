import { describe, expect, it } from 'vitest';
import charme from '../fixtures/charme-3205.flat.json';
import { applyCommand, type ApplyOk } from './commands/apply';
import { describeCommand } from './commands/labels';
import { createHistory, recordCommand, undo } from './commands/history';
import { commandToolSchemas } from './commands/tools';
import type { Command } from './commands/schema';
import { env } from './commands/testUtil';
import { describeRoom } from './describe';
import { buildFloors } from './geometry/floors';
import { floorParts, polygonIntersectionArea, remainderArea, zoneProblems } from './geometry/zones';
import { polygonArea } from './measure';
import { parseScene } from './parse';
import { LIMITS, Scene, type FloorZone, type SceneInput } from './schema';
import { serializeScene } from './serialize';
import { validateScene } from './validate';

const load = (input: unknown): Scene => {
  const r = parseScene(input);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.scene;
};

const ROOM: [number, number][] = [[0, 0], [6, 0], [6, 4], [3, 4], [3, 2], [0, 2]]; // an L: concave
const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

function flat(zones?: { id: string; name?: string; polygon: [number, number][]; material: string }[], extra: Record<string, unknown> = {}): SceneInput {
  return {
    version: 1,
    name: 't',
    site: { latitude: 0, longitude: 0 },
    materials: [
      { id: 'wood', name: 'Wood', kind: 'paint', color: '#aa8855' },
      { id: 'tile', name: 'Tile', kind: 'paint', color: '#cccccc' },
      { id: 'rug', name: 'Rug', kind: 'paint', color: '#aa2222' },
    ],
    defaults: { floor: 'wood' },
    walls: [{ id: 'w', start: [0, 0], end: [6, 0] }],
    rooms: [{ id: 'r', name: 'R', type: 'living', polygon: ROOM, ...(zones ? { floorZones: zones } : {}), ...extra }],
  };
}
const zone = (id: string, polygon: [number, number][], material = 'tile', name?: string) => ({ id, polygon, material, ...(name ? { name } : {}) });

describe('floorZones in the schema', () => {
  it('accepts zones inside the room, touching each other and the room edge', () => {
    const s = load(flat([zone('a', rect(0, 0, 2, 2)), zone('b', rect(2, 0, 4, 2), 'rug', 'Rug area'), zone('c', rect(3, 2, 6, 4))]));
    expect(s.rooms[0]!.floorZones).toHaveLength(3);
  });

  it('is optional: a room without zones parses and round-trips unchanged', () => {
    expect(load(flat()).rooms[0]).not.toHaveProperty('floorZones');
  });

  it('accepts a zone that pokes out by less than the 1 cm tolerance', () => {
    expect(parseScene(flat([zone('a', rect(-0.005, 0, 2, 2))])).ok).toBe(true);
  });

  it.each([
    ['outside the room', [zone('a', rect(4, -1, 7, 1))], /not inside the room/],
    ['in the notch of the L', [zone('a', rect(0.5, 2.2, 2.5, 3.8))], /not inside the room/],
    ['overlapping another zone', [zone('a', rect(0, 0, 3, 2)), zone('b', rect(2, 0, 4, 2))], /overlaps zone "a"/],
    ['self-intersecting', [zone('a', [[0, 0], [2, 2], [2, 0], [0, 1]])], /intersects itself/],
    ['zero area', [zone('a', [[0, 0], [1, 0], [2, 0]])], /zero area/],
    ['duplicate ids', [zone('a', rect(0, 0, 1, 1)), zone('a', rect(2, 0, 3, 1))], /duplicate floor zone id/],
  ])('rejects a zone %s', (_name, zones, message) => {
    const r = parseScene(flat(zones));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(message);
  });

  it('rejects an unknown material and points at it', () => {
    const r = parseScene(flat([zone('a', rect(0, 0, 1, 1), 'nope')]));
    expect(!r.ok && r.errors).toEqual(['rooms[0].floorZones[0].material: unknown material "nope"']);
  });

  it('rejects unknown keys and too many zones or vertices', () => {
    expect(parseScene({ ...flat(), rooms: [{ id: 'r', name: 'R', type: 'living', polygon: ROOM, floorZones: [{ ...zone('a', rect(0, 0, 1, 1)), extra: 1 }] }] }).ok).toBe(false);
    const many = Array.from({ length: LIMITS.floorZonesPerRoom + 1 }, (_v, i) => zone(`z${i}`, rect(i * 0.1, 0, i * 0.1 + 0.05, 1)));
    const r = parseScene(flat(many));
    expect(!r.ok && r.errors.join('\n')).toContain(`too many floor zones (max ${LIMITS.floorZonesPerRoom})`);
    const round = Array.from({ length: LIMITS.polygonVertices + 1 }, (_v, i) => [1 + Math.cos(i), 1 + Math.sin(i)]);
    expect(parseScene(flat([zone('a', round as [number, number][])])).ok).toBe(false);
  });

  it('zoneProblems is empty for no zones and names every problem', () => {
    expect(zoneProblems(ROOM, [])).toEqual([]);
    const problems = zoneProblems(ROOM, [{ id: 'a', polygon: rect(0, 0, 3, 2) }, { id: 'b', polygon: rect(2, 0, 4, 2) }, { id: 'c', polygon: rect(5, 3, 8, 6) }]);
    expect(problems.map((p) => [p.index, p.field])).toEqual([[2, 'polygon'], [1, 'polygon']]);
  });
});

describe('validateScene on zones', () => {
  it('warns about a tiny zone and about a zone with the floor material', () => {
    const s = load(flat([zone('tiny', rect(0, 0, 0.05, 0.05)), zone('same', rect(1, 0, 2, 1), 'wood')]));
    const codes = validateScene(s).warnings.filter((w) => w.code.startsWith('floor-zone')).map((w) => [w.code, w.path]);
    expect(codes).toEqual([['floor-zone-tiny', 'rooms[0].floorZones[0]'], ['floor-zone-redundant', 'rooms[0].floorZones[1]']]);
  });

  it('the Charme fixture has no zone warning', () => {
    expect(validateScene(load(charme)).warnings.filter((w) => w.code.startsWith('floor-zone'))).toEqual([]);
  });
});

describe('floor geometry with zones', () => {
  const area = (mesh: ReturnType<typeof buildFloors>, pick: (o: { zoneId?: string; entityId: string }) => boolean) => {
    let sum = 0;
    const p = mesh.positions;
    for (const o of mesh.owners) {
      if (!pick(o)) continue;
      for (let t = o.start; t < o.start + o.count; t++) {
        const [a, b, c] = [mesh.indices[t * 3]!, mesh.indices[t * 3 + 1]!, mesh.indices[t * 3 + 2]!];
        const ny = (p[b * 3 + 2]! - p[a * 3 + 2]!) * (p[c * 3]! - p[a * 3]!) - (p[b * 3]! - p[a * 3]!) * (p[c * 3 + 2]! - p[a * 3 + 2]!);
        expect(ny, 'every floor triangle faces up').toBeGreaterThan(0);
        sum += ny / 2;
      }
    }
    return sum;
  };

  const scene = load(flat([zone('a', rect(0.5, 0.5, 2, 1.5)), zone('b', rect(3, 2, 6, 4), 'rug', 'Rug'), zone('c', [[1, 1.8], [2.5, 0.2], [2.9, 1.9]].map((p) => [p[0]! + 2.2, p[1]!] as [number, number]))]));

  it('zone areas plus the remainder equal the room area (1e-6) and each part has its material', () => {
    const mesh = buildFloors(scene);
    const room = polygonArea(ROOM);
    const zones = scene.rooms[0]!.floorZones!;
    const zoneSum = zones.reduce((s, z) => s + area(mesh, (o) => o.zoneId === z.id), 0);
    const rest = area(mesh, (o) => o.zoneId === undefined);
    expect(zoneSum + rest).toBeCloseTo(room, 6);
    expect(rest).toBeCloseTo(remainderArea(scene.rooms[0]!), 6);
    for (const z of zones) expect(area(mesh, (o) => o.zoneId === z.id)).toBeCloseTo(polygonArea(z.polygon), 6);
    // materials per part
    const materialOf = (zoneId: string | undefined) => {
      const ids = new Set<string>();
      for (const g of mesh.groups) {
        for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) {
          const owner = mesh.owners.find((o) => o.start <= t && t < o.start + o.count)!;
          if (owner.zoneId === zoneId) ids.add(g.materialId);
        }
      }
      return [...ids];
    };
    expect(materialOf('a')).toEqual(['tile']);
    expect(materialOf('b')).toEqual(['rug']);
    expect(materialOf(undefined)).toEqual(['wood']);
  });

  it('every triangle is owned by the room, zone triangles carry the zone id, uvs are plan metres', () => {
    const mesh = buildFloors(scene);
    expect(new Set(mesh.owners.map((o) => o.entityId))).toEqual(new Set(['r']));
    expect(new Set(mesh.owners.map((o) => o.zoneId))).toEqual(new Set(['a', 'b', 'c', undefined]));
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      expect(mesh.uvs[v * 2]).toBeCloseTo(mesh.positions[v * 3]!, 9);
      expect(mesh.uvs[v * 2 + 1]).toBeCloseTo(mesh.positions[v * 3 + 2]!, 9);
    }
  });

  it('a room without zones builds exactly the old mesh (one owner, no zoneId)', () => {
    const mesh = buildFloors(load(flat()));
    expect(mesh.owners).toEqual([{ start: 0, count: mesh.indices.length / 3, kind: 'floor', entityId: 'r' }]);
  });

  it('a zone poking out within the tolerance is clipped to the room, so the parts still tile it exactly', () => {
    const s = load(flat([zone('a', rect(-0.008, 0, 2, 1))]));
    const mesh = buildFloors(s);
    expect(area(mesh, () => true)).toBeCloseTo(polygonArea(ROOM), 6);
  });

  it('a zone covering the whole room leaves no remainder; keeps triangle counts modest', () => {
    const whole = load(flat([zone('all', ROOM)]));
    expect(floorParts(whole, whole.rooms[0]!).map((p) => p.zoneId)).toEqual(['all']);
    const one = load(flat([zone('a', rect(0.5, 0.5, 2, 1.5))]));
    const tris = buildFloors(one).indices.length / 3;
    expect(tris).toBeLessThanOrEqual(16);
  });

  it('zone-free rooms next to a zoned one are untouched', () => {
    const two = load({
      ...flat([zone('a', rect(0.5, 0.5, 2, 1.5))]),
      rooms: [
        { id: 'r', name: 'R', type: 'living', polygon: ROOM, floorZones: [zone('a', rect(0.5, 0.5, 2, 1.5))] },
        { id: 'q', name: 'Q', type: 'other', polygon: rect(7, 0, 9, 2) },
      ],
    });
    const mesh = buildFloors(two);
    expect(mesh.owners.filter((o) => o.entityId === 'q')).toEqual([{ start: expect.any(Number), count: 2, kind: 'floor', entityId: 'q' }]);
  });

  it('polygonIntersectionArea handles concave polygons', () => {
    expect(polygonIntersectionArea(ROOM, rect(0, 0, 6, 4))).toBeCloseTo(polygonArea(ROOM), 9);
    expect(polygonIntersectionArea(ROOM, rect(0, 2, 3, 4))).toBeCloseTo(0, 9);
  });

  it('the Charme kitchen zone covers the cooktop, sink and fridge, is inside the séjour, the rest is parquet', () => {
    const c = load(charme);
    const sejour = c.rooms.find((r) => r.id === 'sejour')!;
    const cuisine = sejour.floorZones!.find((z) => z.id === 'cuisine')!;
    expect(zoneProblems(sejour.polygon, sejour.floorZones!)).toEqual([]);
    const parts = floorParts(c, sejour);
    expect(parts.map((p) => p.materialId)).toEqual(['floor-tile-grey', 'lib-parquet-light-oak']);
    expect(polygonArea(cuisine.polygon)).toBeGreaterThan(4);
    for (const id of ['kitchen-cooktop-cui', 'kitchen-sink-tri', 'kitchen-fridge-f']) {
      const item = c.items.find((i) => i.id === id)!;
      const [x, y] = item.position;
      expect(x).toBeGreaterThan(cuisine.polygon[0]![0]);
      expect(x).toBeLessThan(cuisine.polygon[1]![0]);
      expect(y).toBeGreaterThan(cuisine.polygon[0]![1]);
    }
  });
});

describe('floor zone commands', () => {
  const base = load(flat([zone('a', rect(0.5, 0.5, 2, 1.5), 'tile', 'Corner')]));
  const ok = (scene: Scene, cmd: Command): ApplyOk => {
    const r = applyCommand(scene, env(cmd));
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r;
  };
  const fail = (scene: Scene, cmd: Command) => {
    const r = applyCommand(scene, env(cmd));
    if (r.ok) throw new Error('expected a failure');
    return r.errors[0]!;
  };
  const back = (scene: Scene, r: ApplyOk) => ok(r.scene, r.inverse).scene;

  it('room.setFloorZone adds a zone; undo removes it exactly', () => {
    const r = ok(base, { type: 'room.setFloorZone', roomId: 'r', zone: zone('b', rect(4, 2.5, 5, 3.5), 'rug') });
    expect(r.scene.rooms[0]!.floorZones!.map((z) => z.id)).toEqual(['a', 'b']);
    expect(r.changed.rooms).toEqual(['r']);
    expect(r.inverse).toEqual({ type: 'room.removeFloorZone', roomId: 'r', zoneId: 'b' });
    expect(back(base, r)).toStrictEqual(base);
  });

  it('the first zone of a room creates the list; removing the last one drops the key', () => {
    const plain = load(flat());
    const added = ok(plain, { type: 'room.setFloorZone', roomId: 'r', zone: zone('a', rect(0, 0, 1, 1)) });
    expect(added.scene.rooms[0]!.floorZones).toHaveLength(1);
    const removed = ok(added.scene, { type: 'room.removeFloorZone', roomId: 'r', zoneId: 'a' });
    expect(removed.scene.rooms[0]).not.toHaveProperty('floorZones');
    expect(removed.scene).toStrictEqual(plain);
  });

  it('upsert replaces a zone in place (full replace) and undo restores the old one', () => {
    const r = ok(base, { type: 'room.setFloorZone', roomId: 'r', zone: zone('a', rect(0.5, 0.5, 2.5, 1.5), 'rug') });
    const z = r.scene.rooms[0]!.floorZones![0]!;
    expect(z).toEqual({ id: 'a', polygon: rect(0.5, 0.5, 2.5, 1.5), material: 'rug' }); // the name is cleared
    expect(back(base, r)).toStrictEqual(base);
  });

  it('an identical upsert and an unchanged material are no-ops', () => {
    const z = base.rooms[0]!.floorZones![0]! as FloorZone;
    expect(applyCommand(base, env({ type: 'room.setFloorZone', roomId: 'r', zone: z }))).toMatchObject({ ok: true, noop: true });
    expect(applyCommand(base, env({ type: 'room.setFloorZoneMaterial', roomId: 'r', zoneId: 'a', material: 'tile' }))).toMatchObject({ ok: true, noop: true });
  });

  it('room.removeFloorZone restores the zone at its list position', () => {
    const s3 = ok(ok(base, { type: 'room.setFloorZone', roomId: 'r', zone: zone('b', rect(4, 2.5, 5, 3.5)) }).scene, { type: 'room.setFloorZone', roomId: 'r', zone: zone('c', rect(5, 0.5, 5.8, 1.5)) }).scene;
    const r = ok(s3, { type: 'room.removeFloorZone', roomId: 'r', zoneId: 'b' });
    expect(r.scene.rooms[0]!.floorZones!.map((z) => z.id)).toEqual(['a', 'c']);
    expect(back(s3, r)).toStrictEqual(s3);
    expect(back(s3, r).rooms[0]!.floorZones!.map((z) => z.id)).toEqual(['a', 'b', 'c']);
  });

  it('room.setFloorZoneMaterial changes only the material, with an exact inverse', () => {
    const r = ok(base, { type: 'room.setFloorZoneMaterial', roomId: 'r', zoneId: 'a', material: 'rug' });
    expect(r.scene.rooms[0]!.floorZones![0]).toEqual({ id: 'a', name: 'Corner', polygon: rect(0.5, 0.5, 2, 1.5), material: 'rug' });
    expect(back(base, r)).toStrictEqual(base);
    expect(r.scene.walls).toBe(base.walls);
  });

  it('refuses unknown rooms, zones and materials with hints', () => {
    expect(fail(base, { type: 'room.setFloorZone', roomId: 'x', zone: zone('b', rect(4, 2.5, 5, 3.5)) }).code).toBe('unknown_entity');
    expect(fail(base, { type: 'room.removeFloorZone', roomId: 'r', zoneId: 'aa' })).toMatchObject({ code: 'unknown_entity' });
    expect(fail(base, { type: 'room.removeFloorZone', roomId: 'r', zoneId: 'aa' }).hint).toContain('"a"');
    expect(fail(base, { type: 'room.setFloorZoneMaterial', roomId: 'r', zoneId: 'a', material: 'nope' }).code).toBe('unknown_material');
    expect(fail(base, { type: 'room.setFloorZone', roomId: 'r', zone: zone('b', rect(4, 2.5, 5, 3.5), 'nope') }).code).toBe('unknown_material');
  });

  it('refuses a zone outside the room or over another zone, leaving the scene alone', () => {
    const out = fail(base, { type: 'room.setFloorZone', roomId: 'r', zone: zone('b', rect(0.5, 2.5, 2.5, 3.5)) });
    expect(out).toMatchObject({ code: 'precondition_failed' });
    expect(out.message).toMatch(/not inside the room/);
    const over = fail(base, { type: 'room.setFloorZone', roomId: 'r', zone: zone('b', rect(1, 1, 3, 1.9)) });
    expect(over.message).toMatch(/overlaps zone "a"/);
    expect(fail(base, { type: 'room.setFloorZone', roomId: 'r', zone: zone('a', rect(0.5, 0.5, 2.5, 3)) }).message).toMatch(/not inside/);
  });

  it('material.remove names a zone that still uses the material', () => {
    const e = fail(base, { type: 'material.remove', id: 'tile' });
    expect(e.message).toContain('room r (floor zone a)');
    const freed = ok(base, { type: 'room.setFloorZoneMaterial', roomId: 'r', zoneId: 'a', material: 'rug' });
    expect(ok(freed.scene, { type: 'material.remove', id: 'tile' }).scene.materials.map((m) => m.id)).not.toContain('tile');
  });

  it('a batch is atomic and undoes in one step', () => {
    const cmd: Command = {
      type: 'batch',
      label: 'two zones',
      commands: [
        { type: 'room.setFloorZone', roomId: 'r', zone: zone('b', rect(4, 2.5, 5, 3.5), 'rug') },
        { type: 'room.setFloorZoneMaterial', roomId: 'r', zoneId: 'b', material: 'wood' },
        { type: 'room.removeFloorZone', roomId: 'r', zoneId: 'a' },
      ],
    };
    const r = ok(base, cmd);
    expect(r.scene.rooms[0]!.floorZones!.map((z) => [z.id, z.material])).toEqual([['b', 'wood']]);
    expect(back(base, r)).toStrictEqual(base);
    const bad = applyCommand(base, env({ ...cmd, commands: [...(cmd as { commands: Command[] }).commands as never[], { type: 'room.removeFloorZone', roomId: 'r', zoneId: 'zzz' } as never] }));
    expect(bad.ok).toBe(false);
  });

  it('history: a drag of one zone coalesces into one undo step', () => {
    let scene = base;
    let h = createHistory();
    for (const x of [2, 2.2, 2.4]) {
      const e = env({ type: 'room.setFloorZone', roomId: 'r', zone: zone('a', rect(0.5, 0.5, x, 1.5)) }, { coalesceKey: 'zone:r/a' });
      const r = applyCommand(scene, e);
      if (!r.ok) throw new Error('apply');
      h = recordCommand(h, e, r, e.ts);
      scene = r.scene;
    }
    expect(h.past).toHaveLength(1);
    const u = undo(h, scene, { id: 'u1', ts: 5000, author: { kind: 'user' } });
    expect(u.ok && u.scene).toStrictEqual(base);
  });

  it('labels name the zone, the room and the material', () => {
    const d = (c: Command) => describeCommand(c, base);
    expect(d({ type: 'room.setFloorZone', roomId: 'r', zone: zone('b', rect(4, 2.5, 5, 3.5), 'rug', 'Rug area') })).toBe('Add floor zone Rug area in R → Rug (matt)');
    expect(d({ type: 'room.setFloorZone', roomId: 'r', zone: zone('a', rect(0.5, 0.5, 2, 1.5), 'rug') })).toBe('Update floor zone a in R → Rug (matt)');
    expect(d({ type: 'room.removeFloorZone', roomId: 'r', zoneId: 'a' })).toBe('Remove floor zone Corner from R');
    expect(d({ type: 'room.setFloorZoneMaterial', roomId: 'r', zoneId: 'a', material: 'rug' })).toBe('Floor zone Corner of R → Rug (matt)');
    expect(d({ type: 'room.removeFloorZone', roomId: 'nowhere', zoneId: 'q' })).toBe('Remove floor zone q from nowhere');
  });
});

describe('describe_room and tool schemas', () => {
  it('describeRoom lists the zones with name, area and material, and omits the key without zones', () => {
    const c = load(charme);
    const d = describeRoom(c, 'sejour', { date: '2026-06-21' });
    expect(d && 'floor' in d ? d.floor : null).toMatchObject({ materialId: 'lib-parquet-light-oak', zones: [{ id: 'cuisine', name: 'Cuisine', materialId: 'floor-tile-grey' }] });
    const area = (d as { floor: { zones: { areaM2: number }[] } }).floor.zones[0]!.areaM2;
    expect(area).toBeCloseTo(polygonArea(c.rooms.find((r) => r.id === 'sejour')!.floorZones![0]!.polygon), 2);
    expect((describeRoom(c, 'ch1', { date: '2026-06-21' }) as { floor: object }).floor).toEqual({ materialId: 'lib-parquet-light-oak' });
  });

  it('the three tools exist with the right required fields', () => {
    const by = new Map(commandToolSchemas().map((t) => [t.name, t]));
    const req = (n: string) => (by.get(n)!.inputSchema.required as string[]).sort();
    expect(req('room_set_floor_zone')).toEqual(['roomId', 'zone']);
    expect(req('room_remove_floor_zone')).toEqual(['roomId', 'zoneId']);
    expect(req('room_set_floor_zone_material')).toEqual(['material', 'roomId', 'zoneId']);
    expect(Object.keys(by.get('room_set_floor_zone')!.inputSchema.properties as object)).not.toContain('index');
  });
});

describe('Scene.superRefine path for the whole file', () => {
  it('fixture zones survive a parse round trip', () => {
    const text = serializeScene(Scene.parse(charme));
    expect(serializeScene(Scene.parse(JSON.parse(text)))).toBe(text);
    expect(text).toContain('"floorZones"');
  });
});
