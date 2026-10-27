import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCommand } from './apply';
import { createHistory, recordCommand, undo, redo } from './history';
import { describeCommand } from './labels';
import { commandToolSchemas } from './tools';
import { deepFreeze, env, FIXTURES } from './testUtil';
import type { Command } from './schema';
import { gridFixtures } from '../lighting/grid';
import { lightLumens, linkedLightPose } from '../lighting/lamps';
import { polygonCentroid } from '../measure';
import { Scene as SceneSchema } from '../schema';
import type { GridLight, Light, Scene } from '../schema';

/** Charme without items and with only the lights that matter here. */
const bare: Scene = deepFreeze({ ...FIXTURES.charme!, items: [] });
const apply = (scene: Scene, cmd: Command, extra = {}) => applyCommand(scene, env(cmd, extra));
let stepNo = 0;
const step = () => ({ id: `step${++stepNo}`, ts: 5000 + stepNo, author: { kind: 'user' as const } });
function okScene(scene: Scene, cmd: Command, extra = {}): Scene {
  const r = apply(scene, cmd, extra);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.scene;
}

const sejour = bare.rooms.find((r) => r.id === 'sejour')!;
const ch1 = bare.rooms.find((r) => r.id === 'ch1')!;
const gridCmd = (over: Record<string, unknown> = {}): Command => ({
  type: 'light.add',
  light: { type: 'grid', id: 'led', roomId: 'sejour', fitToRoom: true, rows: 3, cols: 4, lumensEach: 450, kelvin: 2700, angle: 100, ...over } as never,
});
const grid = (scene: Scene, id = 'led') => scene.lights.find((l) => l.id === id) as GridLight;

describe('grid lights', () => {
  it('fitToRoom covers the room, sets the flux and undoes with light.remove', () => {
    const r = apply(bare, gridCmd());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = grid(r.scene);
    expect(g).toMatchObject({ type: 'grid', rows: 3, cols: 4, lumensEach: 450, roomId: 'sejour', rotation: 0, on: true });
    expect(lightLumens(g)).toBe(3 * 4 * 450);
    // every fixture inside the room's bounding box, half a pitch from the grid edge
    const xs = sejour.polygon.map((p) => p[0]);
    const ys = sejour.polygon.map((p) => p[1]);
    for (const [x, y] of gridFixtures(g)) {
      expect(x).toBeGreaterThan(Math.min(...xs));
      expect(x).toBeLessThan(Math.max(...xs));
      expect(y).toBeGreaterThan(Math.min(...ys));
      expect(y).toBeLessThan(Math.max(...ys));
    }
    expect(g.elevation).toBeGreaterThan(2);
    expect(r.changed.lights).toEqual(['led']);
    expect(r.inverse).toEqual({ type: 'light.remove', id: 'led' });
    expect(SceneSchema.safeParse(r.scene).success).toBe(true);
    const back = applyCommand(r.scene, env(r.inverse));
    expect(back.ok && back.scene).toStrictEqual(bare);
  });

  it('takes explicit geometry, defaults the height from the room and rejects what it cannot place', () => {
    const c = gridCmd({ fitToRoom: undefined, position: [2, 4], width: 3, depth: 2 });
    const g = grid(okScene(bare, c));
    expect(g).toMatchObject({ position: [2, 4], width: 3, depth: 2 });
    expect(g.elevation).toBeCloseTo(2.47, 2); // 3 cm below a 2.5 m ceiling

    const missing = apply(bare, gridCmd({ fitToRoom: undefined, roomId: undefined }));
    expect(!missing.ok && missing.errors[0]!.message).toMatch(/needs/);
    const noRoom = apply(bare, gridCmd({ roomId: undefined }));
    expect(!noRoom.ok && noRoom.errors[0]!.path).toBe('light/roomId');
    const tooMany = apply(bare, gridCmd({ rows: 20, cols: 20 }));
    expect(!tooMany.ok && tooMany.errors[0]!.message).toMatch(/at most 100 fixtures/);
    expect(apply(bare, gridCmd({ rows: 0 })).ok).toBe(false);
    expect(apply(bare, gridCmd({ lumensEach: -1 })).ok).toBe(false);
  });

  it('update changes rows, cols, flux, colour and on/off with exact inverses', () => {
    const base = okScene(bare, gridCmd());
    for (const patch of [{ rows: 2, cols: 6 }, { lumensEach: 600 }, { kelvin: 4000, angle: 120 }, { on: false }, { name: 'LED ceiling' }]) {
      const r = apply(base, { type: 'light.update', id: 'led', patch });
      expect(r.ok, JSON.stringify(patch)).toBe(true);
      if (!r.ok) continue;
      expect(r.changed.lights).toEqual(['led']);
      const back = applyCommand(r.scene, env(r.inverse));
      expect(back.ok && back.scene, JSON.stringify(patch)).toStrictEqual(base);
    }
    const two = okScene(base, { type: 'light.update', id: 'led', patch: { rows: 2, cols: 6, lumensEach: 100 } });
    expect(lightLumens(grid(two))).toBe(1200);
  });

  it('refits to the room, and a grid refuses fields of other light types', () => {
    const moved = okScene(okScene(bare, gridCmd({ fitToRoom: undefined, position: [1, 1], width: 1, depth: 1 })), { type: 'light.update', id: 'led', patch: { fitToRoom: true } });
    const fitted = grid(okScene(bare, gridCmd()));
    expect(grid(moved)).toMatchObject({ position: fitted.position, width: fitted.width, depth: fitted.depth });
    const bad = apply(okScene(bare, gridCmd()), { type: 'light.update', id: 'led', patch: { lumens: 500 } });
    expect(bad.ok).toBe(false);
    const spot = apply(bare, { type: 'light.update', id: 'l-wc', patch: { fitToRoom: true } });
    expect(!spot.ok && spot.errors[0]!.message).toMatch(/grid/);
  });

  it('labels read well in the undo history', () => {
    const base = okScene(bare, gridCmd());
    expect(describeCommand(gridCmd(), bare)).toBe('Add 3×4 downlight grid in Séjour (5400 lm)');
    expect(describeCommand({ type: 'light.update', id: 'led', patch: { rows: 2, cols: 6 } }, base)).toBe('Séjour 3×4 downlight grid 2×6 fixtures');
    expect(describeCommand({ type: 'light.update', id: 'led', patch: { on: false } }, base)).toBe('Turn off Séjour 3×4 downlight grid');
    expect(describeCommand({ type: 'light.update', id: 'led', patch: { lumensEach: 300 } }, base)).toMatch(/300 lm each/);
  });

  it('history: add, update and remove undo and redo to the exact scene', () => {
    let h = createHistory();
    let scene: Scene = bare;
    const states: Scene[] = [scene];
    for (const cmd of [gridCmd(), { type: 'light.update', id: 'led', patch: { cols: 5 } } as Command, { type: 'light.remove', id: 'led' } as Command]) {
      const e = env(cmd);
      const r = applyCommand(scene, e);
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      h = recordCommand(h, e, r, e.ts);
      scene = r.scene;
      states.push(scene);
    }
    for (let i = states.length - 2; i >= 0; i--) {
      const u = undo(h, scene, step());
      if (!u.ok) throw new Error('undo failed');
      h = u.history;
      scene = u.scene;
      expect(scene).toStrictEqual(states[i]);
    }
    for (let i = 1; i < states.length; i++) {
      const rr = redo(h, scene, step());
      if (!rr.ok) throw new Error('redo failed');
      h = rr.history;
      scene = rr.scene;
      expect(scene).toStrictEqual(states[i]);
    }
  });

  it('the tool schema offers grid with an example that validates', () => {
    const add = commandToolSchemas().find((t) => t.name === 'light_add')!;
    expect(add.description).toMatch(/grid/);
    expect(JSON.stringify(add.inputSchema)).toContain('lumensEach');
    expect(JSON.stringify(add.inputSchema)).not.toContain('itemId'); // the link is managed by the item commands
  });
});

// ---- lamps that are items ---------------------------------------------------------------------------

const lampProduct = (over: Record<string, unknown> = {}) => ({
  provider: 'mock',
  sku: 'LAMP-F1',
  name: 'MOCK Lampadaire',
  url: 'https://example.com/lamp',
  price: 39,
  currency: 'EUR',
  dims: { w: 0.35, d: 0.35, h: 1.55 },
  category: 'lamp' as const,
  snapshotAt: '2026-10-27T10:00:00.000Z',
  ...over,
});
const centre = polygonCentroid(ch1.polygon);
const lampDraft = (over: Record<string, unknown> = {}, productOver: Record<string, unknown> = {}) => ({
  assetId: 'param:lamp',
  id: 'lamp1',
  position: [centre[0], centre[1]] as [number, number],
  roomId: 'ch1',
  dims: { w: 0.35, d: 0.35, h: 1.55 },
  productRef: { provider: 'mock', sku: 'LAMP-F1' },
  product: lampProduct(productOver),
  ...over,
});
const placeLamp = (over: Record<string, unknown> = {}, productOver: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Command => ({ type: 'item.place', item: lampDraft(over, productOver) as never, ...extra });
const llm = { author: { kind: 'llm' as const } };
const lightOf = (scene: Scene, itemId = 'lamp1') => scene.lights.find((l) => l.itemId === itemId) as Extract<Light, { type: 'point' }> | undefined;

describe('lamp items carry a light', () => {
  it('placing a lamp adds a linked light: category default (estimated) or the product lumens', () => {
    const est = apply(bare, placeLamp(), llm);
    expect(est.ok).toBe(true);
    if (!est.ok) return;
    const l = lightOf(est.scene)!;
    expect(l).toMatchObject({ type: 'point', id: 'lamp1-light', itemId: 'lamp1', roomId: 'ch1', lumens: 800, kelvin: 2700, on: true, lumensSource: 'estimated' });
    expect(l.elevation).toBeCloseTo(1.55 * 0.92, 1);
    expect(l.position).toEqual(linkedLightPose(est.scene.items[0]!, l.offset!).position);
    expect(est.changed).toMatchObject({ items: ['lamp1'], lights: ['lamp1-light'] });
    expect(SceneSchema.safeParse(est.scene).success).toBe(true);

    const prod = okScene(bare, placeLamp({}, { lumens: 1055 }), llm);
    expect(lightOf(prod)).toMatchObject({ lumens: 1055, lumensSource: 'product' });

    // category defaults: table 400, pendant 1000, wall 400 (by name or mount)
    const table = okScene(bare, placeLamp({ dims: { w: 0.2, d: 0.2, h: 0.4 } }, { name: 'Lampe de table', dims: { w: 0.2, d: 0.2, h: 0.4 } }));
    expect(lightOf(table)!.lumens).toBe(400);
    const pendant = okScene(bare, placeLamp({ mount: 'ceiling', elevation: 1.9, dims: { w: 0.4, d: 0.4, h: 0.6 } }, { name: 'Suspension papier', dims: { w: 0.4, d: 0.4, h: 0.6 } }));
    expect(lightOf(pendant)!.lumens).toBe(1000);
    expect(lightOf(pendant)!.elevation).toBeGreaterThan(1.9);
  });

  it('only lamps get one, and autoLight false places the lamp unlit', () => {
    const decor = okScene(bare, placeLamp({ assetId: 'param:test' }, { category: 'decor' }));
    expect(decor.lights.some((l) => l.itemId)).toBe(false);
    const unlit = okScene(bare, placeLamp({}, {}, { autoLight: false }));
    expect(unlit.lights.some((l) => l.itemId)).toBe(false);
    expect(unlit.items).toHaveLength(1);
  });

  it('the light follows the item: move, rotate (also with a bulb offset) and room change', () => {
    const placed = okScene(bare, placeLamp());
    const moved = okScene(placed, { type: 'item.move', id: 'lamp1', position: [centre[0] + 0.3, centre[1] - 0.2] });
    expect(lightOf(moved)!.position).toEqual([centre[0] + 0.3, centre[1] - 0.2]);
    // an offset bulb turns with the item
    const off = { ...placed, lights: placed.lights.map((l) => (l.itemId ? { ...l, offset: [0.5, 0, 1.2] as [number, number, number] } : l)) } as Scene;
    const turned = okScene(off, { type: 'item.rotate', id: 'lamp1', rotation: 90 });
    expect(lightOf(turned)!.position[0]).toBeCloseTo(centre[0], 6);
    expect(lightOf(turned)!.position[1]).toBeCloseTo(centre[1] - 0.5, 6);
    expect(lightOf(turned)!.elevation).toBeCloseTo(1.2, 6);
    expect(applyCommand(placed, env({ type: 'item.move', id: 'lamp1', position: [centre[0] + 0.3, centre[1] - 0.2] })).ok && true).toBe(true);
  });

  it('move, rotate and remove have exact inverses that restore the light too', () => {
    const placed = okScene(bare, placeLamp());
    for (const cmd of [
      { type: 'item.move', id: 'lamp1', position: [centre[0] + 0.31, centre[1] + 0.17] },
      { type: 'item.rotate', id: 'lamp1', rotation: 37.5 },
      { type: 'item.remove', id: 'lamp1' },
    ] as Command[]) {
      const r = apply(placed, cmd);
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      expect(r.changed.lights, cmd.type).toEqual(cmd.type === 'item.rotate' ? [] : ['lamp1-light']); // a bulb on the item's axis does not move when it turns
      const back = applyCommand(r.scene, env(r.inverse));
      expect(back.ok && back.scene, cmd.type).toStrictEqual(placed);
    }
    const removed = okScene(placed, { type: 'item.remove', id: 'lamp1' });
    expect(removed.lights).toStrictEqual(bare.lights); // the light went with the item
  });

  it('undo of a removal restores the light at its list position, the user edits included', () => {
    const withTwo = okScene(okScene(bare, gridCmd()), placeLamp());
    const edited = okScene(withTwo, { type: 'light.update', id: 'lamp1-light', patch: { lumens: 300, kelvin: 3000, on: false } });
    expect(lightOf(edited)).toMatchObject({ lumens: 300, lumensSource: 'user', on: false });
    const r = apply(edited, { type: 'item.remove', id: 'lamp1' });
    if (!r.ok) throw new Error('remove failed');
    const back = applyCommand(r.scene, env(r.inverse));
    expect(back.ok && back.scene).toStrictEqual(edited);
  });

  it('the light can be dimmed and switched but not moved or removed on its own', () => {
    const placed = okScene(bare, placeLamp());
    const up = apply(placed, { type: 'light.update', id: 'lamp1-light', patch: { on: false, lumens: 500, kelvin: 3500 } });
    expect(up.ok).toBe(true);
    if (up.ok) {
      expect(lightOf(up.scene)).toMatchObject({ on: false, lumens: 500, kelvin: 3500, lumensSource: 'user' });
      const back = applyCommand(up.scene, env(up.inverse));
      expect(back.ok && back.scene).toStrictEqual(placed);
    }
    const move = apply(placed, { type: 'light.update', id: 'lamp1-light', patch: { position: [1, 1] } });
    expect(!move.ok && move.errors[0]).toMatchObject({ code: 'precondition_failed' });
    expect(!move.ok && move.errors[0]!.hint).toMatch(/item_move|move or rotate the item/);
    const rm = apply(placed, { type: 'light.remove', id: 'lamp1-light' });
    expect(!rm.ok && rm.errors[0]!.message).toMatch(/belongs to item/);
  });

  it('a light cannot reference a missing item or share one', () => {
    const placed = okScene(bare, placeLamp());
    const orphan = { ...placed, items: [] } as Scene;
    expect(SceneSchema.safeParse(orphan).success).toBe(false);
    const twin = { ...placed, lights: [...placed.lights, { ...lightOf(placed)!, id: 'twin' }] } as Scene;
    expect(SceneSchema.safeParse(twin).success).toBe(false);
    // linking through light.add is not possible: the tool input has no itemId
    const viaAdd = apply(bare, { type: 'light.add', light: { type: 'point', position: [1, 1], elevation: 1, lumens: 100, itemId: 'x' } as never });
    expect(viaAdd.ok).toBe(false);
  });
});

// ---- property: any sequence undoes to the exact scene -----------------------------------------------

describe('property: lights and lamp items undo exactly', () => {
  const opArb = fc.record({ k: fc.nat(9), a: fc.nat(1000), b: fc.nat(1000), n: fc.integer({ min: 0, max: 360 }) });
  const near = (op: { a: number; b: number }): [number, number] => [centre[0] + (op.a - 500) / 4000, centre[1] + (op.b - 500) / 4000];

  function resolve(scene: Scene, op: { k: number; a: number; b: number; n: number }): Command {
    const lamps = scene.items.filter((i) => i.assetId === 'param:lamp');
    const lights = scene.lights;
    const pick = <T>(list: readonly T[], i: number): T => list[i % list.length]!;
    switch (op.k) {
      case 0: return placeLamp({ id: `lamp${op.a % 3}`, position: near(op), rotation: op.n });
      case 1: return lamps.length ? { type: 'item.move', id: pick(lamps, op.a).id, position: near(op) } : placeLamp({ id: 'lampx' });
      case 2: return lamps.length ? { type: 'item.rotate', id: pick(lamps, op.a).id, rotation: op.n } : placeLamp({ id: 'lampy' });
      case 3: return lamps.length ? { type: 'item.remove', id: pick(lamps, op.a).id } : gridCmd({ id: `g${op.a % 2}` });
      case 4: return gridCmd({ id: `g${op.a % 2}`, rows: 1 + (op.a % 5), cols: 1 + (op.b % 5) });
      case 5: return lights.length ? { type: 'light.update', id: pick(lights, op.a).id, patch: { on: op.b % 2 === 0, kelvin: 2000 + op.n } } : gridCmd();
      case 6: return lights.length ? { type: 'light.update', id: pick(lights, op.a).id, patch: { lumens: op.n * 10 } } : gridCmd();
      case 7: return lights.length ? { type: 'light.remove', id: pick(lights, op.a).id } : gridCmd();
      case 8: return lights.length ? { type: 'light.update', id: pick(lights, op.a).id, patch: { name: op.b % 2 ? null : 'x' } } : gridCmd();
      default: return { type: 'batch', label: 'lamp and grid', commands: [placeLamp({ id: `lamp${op.a % 3}`, position: near(op) }), gridCmd({ id: `g${op.b % 2}` })] as never };
    }
  }

  it('every applied command is undone to the identical scene, scenes stay valid and linked lights stay in step', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 25 }), (ops) => {
        let scene: Scene = bare;
        let h = createHistory();
        const seen: Scene[] = [scene];
        for (const op of ops) {
          const cmd = resolve(scene, op);
          const e = env(cmd);
          const r = applyCommand(scene, e);
          if (!r.ok) continue;
          expect(SceneSchema.safeParse(r.scene).success).toBe(true);
          // the invariant: every linked light sits where its item says, in its item's room
          for (const l of r.scene.lights) {
            if (!l.itemId) continue;
            const item = r.scene.items.find((i) => i.id === l.itemId)!;
            const pose = linkedLightPose(item, l.offset!);
            expect(l.position).toStrictEqual(pose.position);
            expect(l.elevation).toBe(pose.elevation);
            expect(l.roomId).toBe(item.roomId);
          }
          const back = applyCommand(r.scene, env(r.inverse));
          expect(back.ok && back.scene).toStrictEqual(scene);
          if (!r.noop) {
            h = recordCommand(h, e, r, e.ts);
            scene = r.scene;
            seen.push(scene);
          }
        }
        for (let i = seen.length - 2; i >= 0; i--) {
          const u = undo(h, scene, step());
          if (!u.ok) throw new Error('undo failed');
          h = u.history;
          scene = u.scene;
          expect(scene).toStrictEqual(seen[i]);
        }
      }),
      { numRuns: 60 },
    );
  });
});
