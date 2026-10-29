import { beforeEach, describe, expect, it } from 'vitest';
import type { Command, CommandEnvelope } from '@flat/scene';
import sample from '@flat/scene/fixtures/sample.flat.json';
import { sceneKey, shellFor } from '@flat/viewer';
import { committedScene, useSceneStore } from './sceneStore';
import { useViewStore } from './viewStore';

const text = JSON.stringify(sample);
const store = () => useSceneStore.getState();
const siteSet = (northAngle: number): Command => ({ type: 'site.set', site: { northAngle } });
const scene = () => store().scene!;

beforeEach(() => {
  store().loadText(text, 'sample');
  useViewStore.getState().select(null);
});

describe('dispatch', () => {
  it('applies, records, bumps rev and keeps the scene identity', () => {
    const before = scene();
    const rev = store().rev;
    const key = sceneKey(before);
    const shell = shellFor(before);
    const r = store().dispatch(siteSet(33), { label: 'North' });
    expect(r.ok).toBe(true);
    expect(scene().site.northAngle).toBe(33);
    expect(store().rev).toBe(rev + 1);
    expect(store().canUndo).toBe(true);
    expect(store().historyLabels).toEqual(['North']);
    expect(sceneKey(scene())).toBe(key);
    expect(shellFor(scene())).toBe(shell); // site edits reuse the shell
  });

  it('rebuilds the shell but keeps the camera key for a geometry-affecting edit', () => {
    const before = scene();
    const key = sceneKey(before);
    const shell = shellFor(before);
    const wall = before.walls[0]!;
    const material = before.materials[0]!;
    expect(store().dispatch({ type: 'wall.setFinish', wallId: wall.id, side: 'both', materialId: material.id }).ok).toBe(true);
    expect(sceneKey(scene())).toBe(key);
    expect(shellFor(scene())).not.toBe(shell);
  });

  it('reports errors and leaves the scene untouched', () => {
    const before = scene();
    const rev = store().rev;
    const r = store().dispatch({ type: 'wall.setFinish', wallId: 'nope', side: 'both', materialId: null });
    expect(r.ok).toBe(false);
    expect(scene()).toBe(before);
    expect(store().rev).toBe(rev);
    expect(store().lastErrors.length).toBeGreaterThan(0);
    expect(store().canUndo).toBe(false);
    store().dispatch(siteSet(5));
    expect(store().lastErrors).toEqual([]);
  });

  it('does not record a no-op', () => {
    const r = store().dispatch(siteSet(scene().site.northAngle));
    expect(r.ok && r.noop).toBe(true);
    expect(store().canUndo).toBe(false);
  });

  it('stamps ULID ids and the author', () => {
    store().dispatch(siteSet(1), { author: 'llm' });
    const env = store().history.past[0]!.envelope;
    expect(env.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(env.author.kind).toBe('llm');
  });

  it('sends recorded envelopes to the transport, if any', () => {
    const sent: CommandEnvelope[] = [];
    store().setTransport({ send: (e) => sent.push(e) });
    store().dispatch(siteSet(7));
    store().undo();
    store().setTransport(null);
    store().dispatch(siteSet(8));
    expect(sent.map((e) => e.cmd.type)).toEqual(['site.set', 'site.set']);
    expect(sent[1]!.undoOf).toBe(sent[0]!.id);
  });
});

describe('undo / redo', () => {
  it('restores the previous scene and redoes', () => {
    const north = scene().site.northAngle;
    store().dispatch(siteSet(north + 40));
    expect(store().undo()).toBe(true);
    expect(scene().site.northAngle).toBe(north);
    expect(store().canUndo).toBe(false);
    expect(store().canRedo).toBe(true);
    expect(store().redo()).toBe(true);
    expect(scene().site.northAngle).toBe(north + 40);
    expect(store().canRedo).toBe(false);
    expect(store().undo() && store().undo()).toBe(false);
  });

  it('a new dispatch clears redo', () => {
    store().dispatch(siteSet(10));
    store().undo();
    store().dispatch(siteSet(20));
    expect(store().canRedo).toBe(false);
  });

  it('coalesces quick edits with the same key into one step', () => {
    store().dispatch(siteSet(10), { coalesceKey: 'k' });
    store().dispatch(siteSet(11), { coalesceKey: 'k' });
    expect(store().history.past).toHaveLength(1);
    store().undo();
    expect(scene().site.northAngle).toBe((sample as { site: { northAngle: number } }).site.northAngle);
  });
});

describe('preview', () => {
  it('shows without recording; commit records one entry; cancel restores', () => {
    const committed = scene();
    expect(store().preview(siteSet(50)).ok).toBe(true);
    expect(scene().site.northAngle).toBe(50);
    expect(committedScene(store())).toBe(committed);
    expect(store().canUndo).toBe(false);
    store().preview(siteSet(60));
    store().cancelPreview();
    expect(scene()).toBe(committed);
    expect(store().previewBase).toBeNull();

    store().preview(siteSet(70));
    store().preview(siteSet(71));
    store().commitPreview();
    expect(scene().site.northAngle).toBe(71);
    expect(store().history.past).toHaveLength(1);
    expect(store().previewBase).toBeNull();
    store().undo();
    expect(scene().site.northAngle).toBe(committed.site.northAngle);
  });

  it('a failed preview keeps the previous state', () => {
    const r = store().preview({ type: 'room.setFloor', roomId: 'nope', materialId: null });
    expect(r.ok).toBe(false);
    store().commitPreview(); // no-op
    expect(store().canUndo).toBe(false);
  });

  it('undo while previewing acts on the committed scene', () => {
    store().dispatch(siteSet(10));
    store().preview(siteSet(99));
    store().undo();
    expect(scene().site.northAngle).toBe((sample as { site: { northAngle: number } }).site.northAngle);
    expect(store().previewBase).toBeNull();
  });
});

describe('selection and loading', () => {
  it('keeps the selection while the entity exists, clears it otherwise', () => {
    const wallId = scene().walls[0]!.id;
    useViewStore.getState().select({ kind: 'wall', entityId: wallId });
    store().dispatch(siteSet(12));
    expect(useViewStore.getState().selection?.entityId).toBe(wallId);
    useViewStore.getState().select({ kind: 'wall', entityId: 'ghost' });
    store().dispatch(siteSet(13));
    expect(useViewStore.getState().selection).toBeNull();
  });

  it('loadText resets history, bumps rev and mints a new identity', () => {
    store().dispatch(siteSet(12));
    const old = scene();
    const rev = store().rev;
    expect(store().loadText(text, 'sample').ok).toBe(true);
    expect(store().canUndo).toBe(false);
    expect(store().historyLabels).toEqual([]);
    expect(store().rev).toBe(rev + 1);
    expect(sceneKey(scene())).not.toBe(sceneKey(old));
  });

  it('a failed load keeps the scene and history', () => {
    store().dispatch(siteSet(12));
    const keep = scene();
    expect(store().loadText('{nope', 'x').ok).toBe(false);
    expect(scene()).toBe(keep);
    expect(store().canUndo).toBe(true);
    expect(store().errors.length).toBeGreaterThan(0);
  });
});

describe('receiveRemote', () => {
  it('replaces the scene without recording history or sending', () => {
    const sent: CommandEnvelope[] = [];
    store().setTransport({ send: (e) => sent.push(e) });
    const first = store().dispatch(siteSet(30));
    sent.length = 0;
    const env = store().history.past[0]!.envelope;
    const rev = store().rev;
    if (!first.ok) throw new Error('setup');
    store().receiveRemote(env, { ...first, scene: { ...first.scene, name: 'remote' } });
    store().setTransport(null);
    expect(scene().name).toBe('remote');
    expect(store().rev).toBe(rev + 1);
    expect(store().history.past).toHaveLength(1);
    expect(sent).toEqual([]);
  });
});
