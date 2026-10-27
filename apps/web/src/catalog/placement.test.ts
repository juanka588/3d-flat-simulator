import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSceneStore } from '../state/sceneStore';
import { useCatalogStore } from './catalogStore';
import { endDrag, isDragging, registerViewer, startDrag } from './placement';

const charme = readFileSync(new URL('../../../../packages/scene/fixtures/charme-3205.flat.json', import.meta.url), 'utf8');

/** A DOM-less stand-in: a window that takes events, and a document whose element under the pointer we choose. */
class FakeCanvas {}
let over: unknown;
let win: EventTarget;

function pointer(type: 'pointermove' | 'pointerup', x: number, y: number): void {
  win.dispatchEvent(Object.assign(new Event(type), { clientX: x, clientY: y, shiftKey: false, altKey: false }));
}

const bedAt = (x: number, y: number) => ({
  type: 'item.place',
  item: { id: 'bed-1', assetId: 'param:bed', position: [x, y], roomId: 'ch1', mount: 'floor', dims: { w: 1.6, d: 2, h: 0.9 }, mesh: { kind: 'parametric', generator: 'bed', params: { w: 1.6, l: 2, h: 0.9, headboard: true } } },
});
const position = () => useSceneStore.getState().scene!.items.find((i) => i.id === 'bed-1')!.position;
const entries = () => useSceneStore.getState().history.past.length;

beforeEach(() => {
  win = new EventTarget();
  over = new FakeCanvas();
  vi.stubGlobal('window', win);
  vi.stubGlobal('HTMLCanvasElement', FakeCanvas);
  vi.stubGlobal('document', { elementFromPoint: () => over });
  // the pointer position IS the plan position: the ray looks straight down at (clientX, clientY)
  registerViewer({ ray: (x, y) => ({ origin: [x, 10, y], dir: [0, -1, 0] }), setControlsEnabled: () => undefined });
  useSceneStore.getState().loadText(charme, 'charme');
  const r = useSceneStore.getState().dispatch(bedAt(8.2, 2) as never, { label: 'Place bed' });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  useCatalogStore.getState().setNotice(null);
});

afterEach(() => {
  endDrag(false);
  registerViewer(null);
  vi.unstubAllGlobals();
});

const drag = (to: [number, number]) => startDrag({ kind: 'move', itemId: 'bed-1', grab: [0, 0], touch: false }, { clientX: to[0], clientY: to[1] });

describe('releasing a gizmo drag (M13)', () => {
  it('commits a valid final pose as ONE history entry', async () => {
    const before = entries();
    drag([8.2, 2]);
    expect(isDragging()).toBe(true);
    pointer('pointermove', 8.6, 1.6);
    pointer('pointerup', 8.6, 1.6);
    await Promise.resolve();
    expect(isDragging()).toBe(false);
    expect(position()[0]).toBeGreaterThan(8.3);
    expect(entries()).toBe(before + 1);
    expect(useCatalogStore.getState().notice).toBeNull();
  });

  it('reverts when the pointer is released on a red pose, even after valid steps', async () => {
    const before = entries();
    const start = position();
    drag([8.2, 2]);
    pointer('pointermove', 8.6, 1.6); // valid: the preview follows
    pointer('pointermove', 8.05, 2.75); // over the door swing: red
    pointer('pointerup', 8.05, 2.75);
    await Promise.resolve();
    expect(position()).toEqual(start);
    expect(entries()).toBe(before);
    expect(useCatalogStore.getState().notice).toMatch(/Can't put/);
  });

  it('reverts when the pointer is released off the canvas (over the sidebar: no pose)', async () => {
    const before = entries();
    const start = position();
    drag([8.2, 2]);
    pointer('pointermove', 8.6, 1.6); // valid step
    over = {}; // not the canvas any more
    pointer('pointermove', 20, 20);
    pointer('pointerup', 20, 20);
    await Promise.resolve();
    expect(position()).toEqual(start);
    expect(entries()).toBe(before);
    expect(useCatalogStore.getState().notice).toMatch(/Can't put/);
  });
});
