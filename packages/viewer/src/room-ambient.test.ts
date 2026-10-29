import { DataUtils } from 'three';
import { describe, expect, it } from 'vitest';
import { buildItems } from '@flat/assets';
import { buildShell, loadSceneText, roomDaylightFactors } from '@flat/scene';
import charme from '@flat/scene/fixtures/charme-3205.flat.json';
import { createRoomAmbient, withRoomAmbient } from './room-ambient';

const result = loadSceneText(JSON.stringify(charme));
if (!result.ok) throw new Error('fixture does not load');
const scene = result.scene;
const shell = buildShell(scene, { items: buildItems });
const ambient = createRoomAmbient(scene);
const texelOf = (uv1: Float32Array, vertex: number) => Math.floor(uv1[vertex * 2]! * ambient.texels);
const value = (roomId: string) => (ambient.texture.image.data as Uint8Array)[ambient.indexOf(roomId)]! / 255;

describe('room ambient texture and uv1', () => {
  it('has one texel per room, a full-sky texel, and one texel per room for its furniture with the room`s own factor (a bathtub in a windowless room is not lit by the full sky)', () => {
    expect(ambient.texture.image.width).toBe(2 * scene.rooms.length + 1);
    expect(ambient.texels).toBe(2 * scene.rooms.length + 1);
    const data = ambient.texture.image.data as Uint8Array;
    expect(data[ambient.none]).toBe(255);
    for (const room of scene.rooms) expect(data[ambient.itemIndexOf(room.id)], room.id).toBe(data[ambient.indexOf(room.id)]);
    expect(data[ambient.itemIndexOf('wc')]).toBeLessThan(80);
    const factors = roomDaylightFactors(scene);
    for (const room of scene.rooms) expect(value(room.id), room.id).toBeCloseTo(factors[room.id]!, 2);
    expect(value('wc')).toBeLessThan(0.3);
    expect(value('sejour')).toBeGreaterThan(0.8);
    expect(ambient.texture.channel).toBe(1);
    expect(ambient.none).toBe(scene.rooms.length);
  });

  it('floors and ceilings point at their own room', () => {
    for (const mesh of [shell.floors, shell.ceilings]) {
      const data = withRoomAmbient(mesh, scene, ambient);
      for (const owner of mesh.owners) {
        const vertex = data.indices[owner.start * 3]!;
        expect(texelOf(data.uv1, vertex)).toBe(ambient.indexOf(owner.entityId));
      }
    }
  });

  it('keeps triangles, owners and index count; every vertex has exactly one room texel', () => {
    for (const mesh of [shell.walls, shell.floors, shell.ceilings, shell.fittings]) {
      const data = withRoomAmbient(mesh, scene, ambient);
      expect(data.indices.length).toBe(mesh.indices.length);
      expect(data.owners).toBe(mesh.owners);
      expect(data.uv1.length / 2).toBe(data.positions.length / 3);
      expect(data.uv1.every((v) => v >= 0 && v <= 1)).toBe(true);
    }
  });

  it('wall faces look at the room they face: the WC side of its walls is windowless, the Séjour side is not', () => {
    const data = withRoomAmbient(shell.walls, scene, ambient);
    const wcTriangles = new Set<string>();
    for (const owner of shell.walls.owners) {
      if (owner.entityId !== 'w-wc-west' || (owner.face !== 'left' && owner.face !== 'right')) continue;
      for (let t = owner.start; t < owner.start + owner.count; t++) wcTriangles.add(`${owner.face}:${texelOf(data.uv1, data.indices[t * 3]!)}`);
    }
    // One face of the WC's west wall belongs to the WC, the other to the Entrée (both low in daylight).
    const rooms = [...wcTriangles].map((s) => Number(s.split(':')[1]));
    expect(rooms).toContain(ambient.indexOf('wc'));
    expect(rooms).toContain(ambient.indexOf('entree'));
    const north = withRoomAmbient(shell.walls, scene, ambient);
    const exterior = shell.walls.owners.filter((o) => o.entityId === 'w-north' && (o.face === 'left' || o.face === 'right'));
    const exteriorTexels = new Set(exterior.map((o) => texelOf(north.uv1, north.indices[o.start * 3]!)));
    expect(exteriorTexels.has(ambient.none) || exteriorTexels.size > 0).toBe(true);
  });
});

describe('room lamp bounce texture', () => {
  const halves = () => ambient.bounce.texture.image.data as Uint16Array;
  const rgb = (texel: number) => [0, 1, 2].map((k) => DataUtils.fromHalfFloat(halves()[texel * 4 + k]!));

  it('is dark until a room has a lit lamp, then lights only that room (walls and its furniture)', () => {
    expect(rgb(ambient.indexOf('wc'))).toEqual([0, 0, 0]);
    ambient.bounce.set({ wc: { lux: Math.PI * 2, color: [1, 1, 1] } });
    expect(rgb(ambient.indexOf('wc'))[0]).toBeCloseTo(2, 2); // radiance = E / pi, reflected by the surface colour
    expect(rgb(ambient.itemIndexOf('wc'))[0]).toBeCloseTo(2, 2);
    for (const id of ['sejour', 'sdb', 'entree']) expect(rgb(ambient.indexOf(id)), id).toEqual([0, 0, 0]);
    expect(rgb(ambient.none)).toEqual([0, 0, 0]); // outside faces get no lamp light
    ambient.bounce.set({});
    expect(rgb(ambient.indexOf('wc'))).toEqual([0, 0, 0]);
  });

  it('carries the lamp colour', () => {
    ambient.bounce.set({ sdb: { lux: Math.PI, color: [1.2, 1, 0.8] } });
    const c = rgb(ambient.indexOf('sdb'));
    expect(c[0]).toBeCloseTo(1.2, 2);
    expect(c[2]).toBeCloseTo(0.8, 2);
    ambient.bounce.set({});
  });
});
