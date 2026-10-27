import { describe, expect, it } from 'vitest';
import { describeCommand } from './labels';
import type { Command } from './schema';
import { FIXTURES } from './testUtil';

const scene = FIXTURES.charme!;
const d = (cmd: Command) => describeCommand(cmd, scene);

describe('describeCommand', () => {
  it('paints and finishes with names, not ids', () => {
    expect(d({ type: 'room.setWallFinish', roomId: 'sejour', materialId: 'paint-white' })).toBe('Paint Séjour walls Warm white paint (matt)');
    expect(d({ type: 'room.setFloor', roomId: 'ch1', materialId: 'floor-oak' })).toBe('Floor of Chambre 1 → Oak parquet (satin)');
    expect(d({ type: 'room.setCeiling', roomId: 'ch1', materialId: null })).toBe('Ceiling of Chambre 1 → default');
    expect(d({ type: 'room.setWallFinish', roomId: 'ch1', materialId: null })).toBe('Clear Chambre 1 wall finish');
  });

  it('names a wall by compass direction and the room side', () => {
    expect(d({ type: 'wall.setFinish', wallId: 'w-west', side: 'both', materialId: 'paint-white', roomId: 'sejour' })).toBe('Paint west wall (Séjour side) Warm white paint (matt)');
    // Without a room: the room found on that face of the wall.
    expect(d({ type: 'wall.setFinish', wallId: 'w-north', side: 'right', materialId: 'paint-white' })).toMatch(/^Paint (north|south|east|west) wall \(.+ side\) /);
    expect(d({ type: 'wall.setFinish', wallId: 'nope', side: 'left', materialId: null })).toBe('Clear finish of wall nope');
  });

  it('describes structural marks, defaults, materials', () => {
    expect(d({ type: 'wall.setStructural', wallId: 'w-alcove', structural: false })).toBe('Mark w-alcove as removable');
    expect(d({ type: 'wall.setStructural', wallId: 'w-alcove', structural: true })).toBe('Mark w-alcove as structural');
    expect(d({ type: 'wall.setStructural', wallId: 'w-alcove', structural: null })).toBe('Reset w-alcove to its default structural status');
    expect(d({ type: 'scene.setDefaults', wall: 'paint-white', floor: null })).toBe('Default wall → Warm white paint (matt), floor → default');
    expect(d({ type: 'material.define', material: { id: 'sage', name: 'Sage', kind: 'paint', color: '#aabbaa', roughness: 0.9 } })).toBe('Define material Sage (matt)');
    expect(d({ type: 'material.define', material: { id: 'paint-white', name: 'White', kind: 'paint', color: '#ffffff', roughness: 0.2 } })).toBe('Update material White (gloss)');
    expect(d({ type: 'material.remove', id: 'floor-tile' })).toBe('Remove material Light grey tile');
    expect(d({ type: 'material.remove', id: 'ghost' })).toBe('Remove material ghost');
  });

  it('describes site edits', () => {
    expect(d({ type: 'site.set', site: { latitude: 48.79 } })).toBe('Set latitude to 48.79');
    expect(d({ type: 'site.set', site: { latitude: 48.1, longitude: 2.5, northAngle: 20, timezone: 'Europe/Paris', floorElevation: 5.8 } })).toBe(
      'Set latitude to 48.1, longitude to 2.5, north angle to 20°, time zone to Europe/Paris, floor elevation to 5.8 m',
    );
    expect(d({ type: 'site.set', site: { address: null } })).toBe('Set address cleared');
  });

  it('describes lights by name', () => {
    expect(d({ type: 'light.update', id: 'l-sejour', patch: { on: true } })).toBe('Turn on Séjour ceiling');
    expect(d({ type: 'light.update', id: 'l-sejour', patch: { on: false } })).toBe('Turn off Séjour ceiling');
    expect(d({ type: 'light.update', id: 'l-cuisine', patch: { kelvin: 2700 } })).toBe('Kitchen panel 2700 K');
    expect(d({ type: 'light.update', id: 'l-cuisine', patch: { kelvin: 3000, lumens: 2000, on: true } })).toBe('Kitchen panel on, 3000 K, 2000 lm');
    expect(d({ type: 'light.update', id: 'l-cuisine', patch: { position: [1, 1] } })).toBe('Kitchen panel moved');
    expect(d({ type: 'light.update', id: 'l-cuisine', patch: {} })).toBe('Update Kitchen panel');
    expect(d({ type: 'light.remove', id: 'l-wc' })).toBe('Remove WC spot');
    expect(d({ type: 'light.add', light: { type: 'point', id: 'new', roomId: 'wc', position: [9, 5], elevation: 2, lumens: 300 } })).toBe('Add point light in WC');
    expect(d({ type: 'light.add', light: { type: 'point', name: 'Lampe', position: [9, 5], elevation: 2, lumens: 300 } })).toBe('Add Lampe');
    expect(d({ type: 'light.update', id: 'zzz', patch: { on: true } })).toBe('Turn on zzz');
  });

  it('uses the batch label, or summarises the changes', () => {
    const cmds = [
      { type: 'room.setFloor', roomId: 'ch1', materialId: 'floor-tile' },
      { type: 'light.update', id: 'l-sejour', patch: { on: true } },
    ] as const;
    expect(d({ type: 'batch', label: 'Cosy bedroom', commands: [...cmds] })).toBe('Cosy bedroom');
    expect(d({ type: 'batch', label: ' ', commands: [...cmds] })).toBe('2 changes: Floor of Chambre 1 → Light grey tile (satin); Turn on Séjour ceiling');
    expect(d({ type: 'batch', label: ' ', commands: [cmds[0]] })).toBe('Floor of Chambre 1 → Light grey tile (satin)');
    expect(d({ type: 'batch', label: ' ', commands: [] })).toBe('No changes');
  });

  it('never throws and never returns an empty label', () => {
    expect(d({ type: 'room.setFloor', roomId: 'nowhere', materialId: 'x' })).toBe('Floor of nowhere → x');
    expect(describeCommand({ type: 'mystery' } as unknown as Command, scene)).toBe('mystery');
  });
});
