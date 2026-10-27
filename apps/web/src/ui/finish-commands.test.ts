import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '@flat/scene';
import { buildFinishCommand, colourName, materialLabel } from './finish-commands';
import type { FinishScope } from './finish-commands';

const entry = {
  id: 'parquet-light-oak',
  name: 'Light oak parquet',
  category: 'floor-wood',
  tileSizeM: 1.8,
  meanColor: '#9b7b5e',
  roughness: 0.5,
} as CatalogEntry;

const sage = { kind: 'paint', hex: '#a3ae93', sheen: 'matt' } as const;

describe('buildFinishCommand', () => {
  const scopes: [FinishScope, string, object][] = [
    [{ kind: 'wallSide', wallId: 'w1', side: 'left' }, 'Paint wall w1 left side Sage', { type: 'wall.setFinish', wallId: 'w1', side: 'left' }],
    [{ kind: 'wallSide', wallId: 'w1', side: 'both' }, 'Paint wall w1 both sides Sage', { type: 'wall.setFinish', wallId: 'w1', side: 'both' }],
    [{ kind: 'roomWalls', roomId: 'r1' }, 'Paint Séjour walls Sage', { type: 'room.setWallFinish', roomId: 'r1' }],
    [{ kind: 'floor', roomId: 'r1' }, 'Paint Séjour floor Sage', { type: 'room.setFloor', roomId: 'r1' }],
    [{ kind: 'ceiling', roomId: 'r1' }, 'Paint Séjour ceiling Sage', { type: 'room.setCeiling', roomId: 'r1' }],
  ];

  it.each(scopes)('%j', (scope, label, expected) => {
    const cmd = buildFinishCommand(scope, sage, { room: 'Séjour' });
    expect(cmd.type).toBe('batch');
    expect(cmd.label).toBe(label);
    expect(cmd.commands).toHaveLength(2);
    expect(cmd.commands[0]).toMatchObject({ type: 'material.define', material: { id: 'paint-a3ae93-matt', kind: 'paint' } });
    expect(cmd.commands[1]).toMatchObject({ ...expected, materialId: 'paint-a3ae93-matt' });
  });

  it('labels a palette colour by name and a custom one by hex', () => {
    expect(colourName('#A3AE93')).toBe('Sage');
    expect(buildFinishCommand({ kind: 'floor', roomId: 'r1' }, { kind: 'paint', hex: '#123', sheen: 'gloss' }).label).toBe('Paint r1 floor #112233');
  });

  it('dedupes paint ids: equal choices share an id, sheen and colour change it', () => {
    const id = (hex: string, sheen: 'matt' | 'satin' | 'gloss') => {
      const c = buildFinishCommand({ kind: 'roomWalls', roomId: 'r1' }, { kind: 'paint', hex, sheen });
      return c.commands[1] && 'materialId' in c.commands[1] ? c.commands[1].materialId : undefined;
    };
    expect(id('#A3AE93', 'matt')).toBe(id('a3ae93', 'matt'));
    expect(id('#a3ae93', 'satin')).not.toBe(id('#a3ae93', 'matt'));
    expect(id('#a3ae94', 'matt')).not.toBe(id('#a3ae93', 'matt'));
  });

  it('builds a texture batch from a catalog entry', () => {
    const cmd = buildFinishCommand({ kind: 'floor', roomId: 'r1' }, { kind: 'catalog', entry }, { room: 'Séjour' });
    expect(cmd.label).toBe('Texture Séjour floor Light oak parquet');
    expect(cmd.commands[0]).toMatchObject({ type: 'material.define', material: { id: 'lib-parquet-light-oak', kind: 'texture', textureUrl: 'lib:parquet-light-oak' } });
    expect(cmd.commands[1]).toEqual({ type: 'room.setFloor', roomId: 'r1', materialId: 'lib-parquet-light-oak' });
  });

  it('resets with materialId null and no material.define', () => {
    for (const [scope] of scopes) {
      const cmd = buildFinishCommand(scope, { kind: 'reset' }, { room: 'Séjour' });
      expect(cmd.commands).toHaveLength(1);
      expect(cmd.commands[0]).toMatchObject({ materialId: null });
      expect(cmd.label).toMatch(/^Reset .* to default$/);
    }
  });

  describe('room-scoped wall scopes', () => {
    const names = { rooms: { sejour: 'Séjour', alcove: 'Alcôve' } };

    it('"This wall (Séjour side)" dispatches wall.setFinish with the clicked room', () => {
      const cmd = buildFinishCommand({ kind: 'wallSide', wallId: 'w-west', side: 'right', roomId: 'sejour' }, sage, names);
      expect(cmd.label).toBe('Paint wall w-west right side in Séjour Sage');
      expect(cmd.commands[1]).toEqual({ type: 'wall.setFinish', wallId: 'w-west', side: 'right', roomId: 'sejour', materialId: 'paint-a3ae93-matt' });
    });

    it('"Both faces here" batches one room-scoped wall.setFinish per face', () => {
      const scope: FinishScope = {
        kind: 'wallFaces',
        wallId: 'w-alcove',
        faces: [
          { side: 'left', roomId: 'alcove' },
          { side: 'right', roomId: 'sejour' },
        ],
      };
      const cmd = buildFinishCommand(scope, sage, names);
      expect(cmd.label).toBe('Paint wall w-alcove both faces here (Alcôve / Séjour) Sage');
      expect(cmd.commands).toHaveLength(3);
      expect(cmd.commands.slice(1)).toEqual([
        { type: 'wall.setFinish', wallId: 'w-alcove', side: 'left', roomId: 'alcove', materialId: 'paint-a3ae93-matt' },
        { type: 'wall.setFinish', wallId: 'w-alcove', side: 'right', roomId: 'sejour', materialId: 'paint-a3ae93-matt' },
      ]);
    });

    it('a face no room sees is painted whole (no roomId)', () => {
      const cmd = buildFinishCommand({ kind: 'wallFaces', wallId: 'w1', faces: [{ side: 'left' }, { side: 'right', roomId: 'sejour' }] }, sage, names);
      expect(cmd.commands[1]).not.toHaveProperty('roomId');
      expect(cmd.commands[2]).toHaveProperty('roomId', 'sejour');
    });

    it('reset clears only the scoped stretches (materialId null, same roomIds), without material.define', () => {
      const cmd = buildFinishCommand({ kind: 'wallSide', wallId: 'w-west', side: 'right', roomId: 'sejour' }, { kind: 'reset' }, names);
      expect(cmd.commands).toEqual([{ type: 'wall.setFinish', wallId: 'w-west', side: 'right', roomId: 'sejour', materialId: null }]);
      const both = buildFinishCommand({ kind: 'wallFaces', wallId: 'w', faces: [{ side: 'left', roomId: 'a' }, { side: 'right', roomId: 'b' }] }, { kind: 'reset' });
      expect(both.commands).toHaveLength(2);
      expect(both.label).toBe('Reset wall w both faces here (a / b) to default');
    });
  });

  it('rejects invalid hex', () => {
    expect(() => buildFinishCommand({ kind: 'floor', roomId: 'r1' }, { kind: 'paint', hex: 'zzz', sheen: 'matt' })).toThrow();
  });
});

describe('materialLabel', () => {
  it('names palette paints with their sheen', () => {
    expect(materialLabel({ id: 'paint-a3ae93-satin', name: 'Paint #a3ae93 (satin)', kind: 'paint', color: '#a3ae93' })).toBe('Sage (satin)');
    expect(materialLabel({ id: 'lib-x', name: 'Oak', kind: 'texture', color: '#000000' })).toBe('Oak');
  });
});
