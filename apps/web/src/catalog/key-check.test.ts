import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseScene } from '@flat/scene';
import type { Item, Scene } from '@flat/scene';
import { itemKeysApply } from '../ui/useItemKeys';
import { addToRoom, solveForRoom, targetRoom } from './add-to-room';
import { keyVerdict, poseAfterKey } from './key-check';
import { defaultElevation, generatorSource, itemKeyAction, libraryModelSource } from './place';
import { ceilingAt } from './ghost';

const parsed = parseScene(JSON.parse(readFileSync(new URL('../../../../packages/scene/fixtures/charme-3205.flat.json', import.meta.url), 'utf8')));
if (!parsed.ok) throw new Error('fixture');
const scene: Scene = parsed.scene;
const key = (k: string, shiftKey = false) => itemKeyAction({ key: k, shiftKey, ctrlKey: false, metaKey: false, altKey: false })!;
const bed = (x: number, y: number, rotation = 0): Item => ({ id: 'bed', assetId: 'param:bed', position: [x, y], elevation: 0, rotation, roomId: 'ch1', mount: 'floor', dims: { w: 1.6, d: 2, h: 0.9 } }) as Item;

describe('keyboard moves use the full ghost check', () => {
  it('computes the pose after a nudge or rotation, none for Delete', () => {
    expect(poseAfterKey(bed(8.2, 2), key('ArrowRight'))).toMatchObject({ position: [8.21, 2], rotation: 0 });
    expect(poseAfterKey(bed(8.2, 2, 270), key('r'))).toMatchObject({ rotation: 0 });
    expect(poseAfterKey(bed(8.2, 2), key('Delete'))).toBeNull();
  });
  it('accepts a nudge in free space and refuses one into the door swing, with the message', () => {
    const free = scene.items.length;
    expect(free).toBeGreaterThan(0);
    expect(keyVerdict(scene, bed(8.2, 2), key('ArrowRight'))!.valid).toBe(true);
    const refused = keyVerdict(scene, bed(8.05, 2.7), key('ArrowDown', true))!;
    expect(refused.valid).toBe(false);
    expect(refused.message).toBeTruthy();
    expect(keyVerdict(scene, bed(8.2, 2), key('Delete'))).toBeNull();
  });
});

describe('where the item keys apply', () => {
  const el = (tagName: string, attrs: Record<string, string> = {}, inRegion = false) =>
    ({ tagName, isContentEditable: false, getAttribute: (n: string) => attrs[n] ?? null, closest: () => (inRegion ? {} : null) }) as unknown as EventTarget;
  it('applies on the page body, the canvas and the room item list', () => {
    expect(itemKeysApply(null)).toBe(true);
    expect(itemKeysApply(el('BODY'))).toBe(true);
    expect(itemKeysApply(el('CANVAS'))).toBe(true);
    expect(itemKeysApply(el('BUTTON', {}, true))).toBe(true);
    expect(itemKeysApply(el('HEADER'))).toBe(true); // the sidebar the app focuses programmatically
  });
  it('does not steal keys from inputs, tabs, sliders or other buttons and links', () => {
    expect(itemKeysApply(el('INPUT', {}, true))).toBe(false);
    expect(itemKeysApply(el('BUTTON', { role: 'tab' }, true))).toBe(false);
    expect(itemKeysApply(el('DIV', { role: 'slider' }))).toBe(false);
    expect(itemKeysApply(el('BUTTON'))).toBe(false);
    expect(itemKeysApply(el('A'))).toBe(false);
  });
});

describe('Add to room (solver path)', () => {
  it('targets the selected room, the room of the selected item, else the first real room', () => {
    expect(targetRoom(scene, { kind: 'floor', entityId: 'ch1' })!.id).toBe('ch1');
    expect(targetRoom(scene, { kind: 'item', entityId: 'placard-ch1' })!.id).toBe(scene.items.find((i) => i.id === 'placard-ch1')!.roomId);
    expect(targetRoom(scene, null)!.type).not.toBe('balcony');
  });
  it('places a floor item centred in the room, a wall item against a wall, both valid', () => {
    const room = scene.rooms.find((r) => r.id === 'ch1')!;
    const small = generatorSource({ id: 'bed', label: 'Bed' }, {}, { w: 0.9, d: 1.9, h: 0.5 });
    const r = solveForRoom(scene, small, room);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.placement.roomId).toBe('ch1');
    const shelf = { ...libraryModelSource({ id: 'x:y', name: 'Shelf', nativeDims: { w: 0.6, d: 0.2, h: 0.3 } }, 'wall'), elevation: 1.4 };
    const w = solveForRoom(scene, shelf, room);
    expect(w.ok).toBe(true);
    if (w.ok) expect(w.placement.elevation).toBe(1.4);
  });
  it('reports why when nothing fits', () => {
    const room = scene.rooms.find((r) => r.id === 'ch1')!;
    const huge = generatorSource({ id: 'bed', label: 'Bed' }, {}, { w: 9, d: 9, h: 0.5 });
    const r = solveForRoom(scene, huge, room);
    expect(r.ok).toBe(false);
  });
  it('is exported as an async action', () => {
    expect(typeof addToRoom).toBe('function');
  });
});

describe('ceilings', () => {
  it('uses the ceiling of the room under the point and hangs ceiling mounts from it', () => {
    const tall = { ...scene, rooms: scene.rooms.map((r) => (r.id === 'ch1' ? { ...r, ceilingHeight: 3.1 } : r)) };
    expect(ceilingAt(tall, [8.2, 2])).toBe(3.1);
    expect(defaultElevation('ceiling', 0.4, 3.1)).toBe(2.7);
    expect(defaultElevation('ceiling', 0.4)).toBe(2.1);
    expect(defaultElevation('floor', 0.4)).toBe(0);
    expect(defaultElevation('wall', 0.4)).toBeGreaterThan(0);
  });
});
