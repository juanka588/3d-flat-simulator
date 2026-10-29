import { applyCommand, makeEnvelope, parseScene } from '@flat/scene';
import type { Scene } from '@flat/scene';
import charme from '../../../../packages/scene/fixtures/charme-3205.flat.json';
import { describe, expect, it } from 'vitest';
import { currentMouldings } from './FinishExtras';
import { buildCorniceCommand, buildMouldingCommand, buildParquetCommand, parquetMaterial } from './finish-commands';

const parsed = parseScene(charme);
if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
const scene: Scene = parsed.scene;
let n = 0;
const apply = (s: Scene, cmd: Parameters<typeof makeEnvelope>[0]): Scene => {
  const r = applyCommand(s, makeEnvelope(cmd, { id: `e${++n}`, ts: 1000 + n }));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.scene;
};

describe('mouldings controls', () => {
  it('a wall side and a room both take a style, which the panel reads back', () => {
    const side = buildMouldingCommand({ kind: 'wallSide', wallId: 'w-north', side: 'right' }, 'frames+dado')!;
    const a = apply(scene, side);
    expect(a.walls.find((w) => w.id === 'w-north')!.panelling?.right?.style).toBe('frames+dado');
    expect(currentMouldings(a, { kind: 'wallSide', wallId: 'w-north', side: 'right' }, 'ch1')).toBe('frames+dado');
    const room = buildMouldingCommand({ kind: 'roomWalls', roomId: 'sejour' }, 'dado', { room: 'Séjour' })!;
    expect(room.label).toBe('Dado rail on Séjour walls');
    const b = apply(a, room);
    expect(currentMouldings(b, { kind: 'roomWalls', roomId: 'sejour' }, 'sejour')).toBe('dado');
    const off = apply(b, buildMouldingCommand({ kind: 'roomWalls', roomId: 'sejour' }, 'none')!);
    expect(currentMouldings(off, { kind: 'roomWalls', roomId: 'sejour' }, 'sejour')).toBe('none');
    expect(buildMouldingCommand({ kind: 'floor', roomId: 'sejour' }, 'frames')).toBeUndefined();
  });

  it('the cornice toggles on and off', () => {
    const on = apply(scene, buildCorniceCommand('sejour', true));
    expect(on.rooms.find((r) => r.id === 'sejour')!.cornice).toStrictEqual({ heightMm: 100 });
    const off = apply(on, buildCorniceCommand('sejour', false));
    expect(off.rooms.find((r) => r.id === 'sejour')!.cornice).toBeUndefined();
  });
});

describe('parquet controls', () => {
  it('lays a herringbone floor with a deterministic material, also on a zone scope', () => {
    const cmd = buildParquetCommand({ kind: 'floor', roomId: 'sejour' }, 'herringbone', '#A47A4D', { room: 'Séjour' })!;
    expect(cmd.label).toBe('Herringbone parquet, Honey oak on Séjour floor');
    const a = apply(scene, cmd);
    const mat = a.materials.find((m) => m.id === 'parquet-herringbone-a47a4d')!;
    expect(mat).toMatchObject({ kind: 'paint', pattern: 'herringbone', color: '#a47a4d' });
    expect(a.rooms.find((r) => r.id === 'sejour')!.floorMaterial).toBe(mat.id);
    expect(parquetMaterial('chevron', '#6b4a32').name).toBe('Chevron parquet, Walnut');
    expect(buildParquetCommand({ kind: 'ceiling', roomId: 'sejour' }, 'chevron', '#a47a4d')).toBeUndefined();
    // applying the same choice twice defines the same material once
    expect(apply(a, cmd).materials.filter((m) => m.id === mat.id)).toHaveLength(1);
  });
});
