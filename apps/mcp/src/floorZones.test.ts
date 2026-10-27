import { describe, expect, it } from 'vitest';
import { connect, json } from './testing/inproc';

/** Floor zones over MCP: describe_room lists them; the three tools edit them and refuse bad geometry. */
describe('floor zone tools', () => {
  it('describe_room lists the zones of the séjour with name, area and material', async () => {
    const { client } = await connect();
    const room = json(await client.callTool({ name: 'describe_room', arguments: { roomId: 'sejour' } }));
    expect(room.floor.materialId).toBe('lib-parquet-light-oak');
    expect(room.floor.zones).toHaveLength(1);
    expect(room.floor.zones[0]).toMatchObject({ id: 'cuisine', name: 'Cuisine', materialId: 'floor-tile-grey' });
    expect(room.floor.zones[0].areaM2).toBeGreaterThan(4);
    const other = json(await client.callTool({ name: 'describe_room', arguments: { roomId: 'ch1' } }));
    expect(other.floor).not.toHaveProperty('zones');
  });

  it('room_set_floor_zone_material commits, shows in describe_room and undoes', async () => {
    const { client } = await connect();
    const r = json(await client.callTool({ name: 'room_set_floor_zone_material', arguments: { roomId: 'sejour', zoneId: 'cuisine', material: 'floor-tile' } }));
    expect(r).toMatchObject({ ok: true, committed: true, changed: { rooms: ['sejour'] } });
    const room = json(await client.callTool({ name: 'describe_room', arguments: { roomId: 'sejour' } }));
    expect(room.floor.zones[0].materialId).toBe('floor-tile');
    expect(json(await client.callTool({ name: 'undo', arguments: {} })).ok).toBe(true);
    expect(json(await client.callTool({ name: 'describe_room', arguments: { roomId: 'sejour' } })).floor.zones[0].materialId).toBe('floor-tile-grey');
  });

  it('room_set_floor_zone adds a zone and room_remove_floor_zone removes it', async () => {
    const { client } = await connect();
    const add = json(await client.callTool({ name: 'room_set_floor_zone', arguments: { roomId: 'ch1', zone: { id: 'rug', name: 'Rug', polygon: [[8, 1], [9, 1], [9, 2], [8, 2]], material: 'floor-tile' } } }));
    expect(add.ok).toBe(true);
    expect(json(await client.callTool({ name: 'describe_room', arguments: { roomId: 'ch1' } })).floor.zones).toMatchObject([{ id: 'rug', name: 'Rug', areaM2: 1 }]);
    expect(json(await client.callTool({ name: 'room_remove_floor_zone', arguments: { roomId: 'ch1', zoneId: 'rug' } })).ok).toBe(true);
    expect(json(await client.callTool({ name: 'describe_room', arguments: { roomId: 'ch1' } })).floor).not.toHaveProperty('zones');
  });

  it('refuses a zone outside the room or over another zone, and unknown ids, with hints', async () => {
    const { client } = await connect();
    const outside = json(await client.callTool({ name: 'room_set_floor_zone', arguments: { roomId: 'ch1', zone: { id: 'z', polygon: [[0, 0], [1, 0], [1, 1], [0, 1]], material: 'floor-tile' } } }));
    expect(outside).toMatchObject({ code: 'precondition_failed' });
    expect(outside.message).toMatch(/not inside the room/);
    const over = json(await client.callTool({ name: 'room_set_floor_zone', arguments: { roomId: 'sejour', zone: { id: 'z', polygon: [[1.5, 7], [2.5, 7], [2.5, 8], [1.5, 8]], material: 'floor-tile' } } }));
    expect(over.message).toMatch(/overlaps zone "cuisine"/);
    const unknown = json(await client.callTool({ name: 'room_remove_floor_zone', arguments: { roomId: 'sejour', zoneId: 'cuisin' } }));
    expect(unknown).toMatchObject({ code: 'unknown_entity' });
    expect(JSON.stringify(unknown)).toContain('cuisine');
  });

  it('material_remove names the zone that still uses the material', async () => {
    const { client } = await connect();
    const r = json(await client.callTool({ name: 'material_remove', arguments: { id: 'floor-tile-grey' } }));
    expect(r.code).toBe('precondition_failed');
    expect(r.message).toContain('floor zone cuisine');
  });
});
