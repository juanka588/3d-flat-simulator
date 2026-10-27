import { describe, expect, it } from 'vitest';
import { applyCommand } from './apply';
import { createHistory, recordCommand, undo } from './history';
import { describeCommand } from './labels';
import { commandToolSchemas } from './tools';
import { deepFreeze, env, FIXTURES } from './testUtil';
import type { Command } from './schema';
import { itemCoalesceKey } from './item-schema';
import type { Item, Scene } from '../schema';
import { Scene as SceneSchema } from '../schema';

/** Charme without its items: robust against fixture items other lanes add. */
const bare: Scene = deepFreeze({ ...FIXTURES.charme!, items: [] });
const dims = { w: 1.6, d: 2, h: 0.9 };
const snapshot = {
  provider: 'mock',
  sku: 'BED-160',
  name: 'MOCK bed 160x200',
  url: 'https://example.com/bed',
  price: 199,
  currency: 'EUR',
  dims,
  category: 'bed' as const,
  snapshotAt: '2026-10-27T10:00:00.000Z',
};
const bedDraft = (over: Record<string, unknown> = {}) => ({
  assetId: 'param:bed',
  id: 'bed',
  position: [7.71, 1] as [number, number],
  roomId: 'ch1',
  dims,
  productRef: { provider: 'mock', sku: 'BED-160' },
  product: snapshot,
  ...over,
});
const place = (item: Record<string, unknown>, index?: number): Command => ({ type: 'item.place', item: item as never, ...(index !== undefined ? { index } : {}) });
const llm = { author: { kind: 'llm' as const } };
const apply = (scene: Scene, cmd: Command, extra = {}) => applyCommand(scene, env(cmd, extra));

function okScene(scene: Scene, cmd: Command, extra = {}): Scene {
  const r = apply(scene, cmd, extra);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.scene;
}

const withBed = okScene(bare, place(bedDraft()));

describe('item.place', () => {
  it('places a product-backed item, derives nothing it was given, and undoes with item.remove', () => {
    const r = apply(bare, place(bedDraft()), llm);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scene.items).toHaveLength(1);
    expect(r.scene.items[0]).toMatchObject({ id: 'bed', roomId: 'ch1', rotation: 0, elevation: 0 });
    expect(r.changed.items).toEqual(['bed']);
    expect(r.inverse).toEqual({ type: 'item.remove', id: 'bed' });
    expect(SceneSchema.safeParse(r.scene).success).toBe(true);
    const back = applyCommand(r.scene, env(r.inverse));
    expect(back.ok && back.scene).toStrictEqual(bare);
  });

  it('derives the id (item-N) and the room from the position', () => {
    const { id: _id, roomId: _room, ...draft } = bedDraft();
    void _id;
    void _room;
    const scene = okScene(bare, place(draft));
    expect(scene.items[0]).toMatchObject({ id: 'item-1', roomId: 'ch1' });
    const again = okScene(scene, place({ ...draft, position: [8.5, 3.2], dims: { w: 0.5, d: 0.5, h: 0.5 }, product: undefined, productRef: undefined }));
    expect(again.items.map((i) => i.id)).toEqual(['item-1', 'item-2']);
  });

  it('an LLM or planner needs a product: precondition_failed "search_products first"; a user does not', () => {
    const { product: _p, productRef: _r, ...bare1 } = bedDraft();
    void _p;
    void _r;
    for (const kind of ['llm', 'planner'] as const) {
      const r = apply(bare, place(bare1), { author: { kind } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]).toMatchObject({ code: 'precondition_failed', path: 'item/product', hint: expect.stringContaining('search_products first') });
    }
    expect(apply(bare, place(bare1)).ok).toBe(true);
    // a product ref alone is enough
    expect(apply(bare, place({ ...bare1, productRef: { provider: 'mock', sku: 'x' } }), llm).ok).toBe(true);
  });

  it('refuses a duplicate id, an unknown room and an invalid item', () => {
    expect(apply(withBed, place(bedDraft())).ok).toBe(false);
    const unknown = apply(bare, place(bedDraft({ roomId: 'nope' })));
    expect(!unknown.ok && unknown.errors[0]).toMatchObject({ code: 'unknown_entity' });
    const raised = apply(bare, place(bedDraft({ mount: 'floor', elevation: 1 })));
    expect(raised.ok).toBe(false);
  });

  it('is refused with placement_invalid {violation, hint}: outside the room, over a wall, over an item, in a door swing', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['outside_room', { position: [20, 20], roomId: 'ch1' }, 'outside_room'],
      ['wall', { position: [10, 0.5] }, 'outside_room'],
      ['swing', { position: [7.3, 3.9], dims: { w: 0.5, d: 0.5, h: 0.5 }, product: { ...snapshot, dims: { w: 0.5, d: 0.5, h: 0.5 } } }, 'door_swing_blocked'],
      ['item', { id: 'bed2', position: [8, 1.5] }, 'overlap'],
    ];
    for (const [name, over, code] of cases) {
      const r = apply(withBed, place(bedDraft({ id: 'x', ...over })));
      expect(r.ok, name).toBe(false);
      if (r.ok) continue;
      expect(r.errors[0], name).toMatchObject({ code: 'placement_invalid', violation: { code }, hint: expect.any(String) });
      expect(r.errors[0]!.hint!.length).toBeGreaterThan(5);
    }
  });

  it('does not run the window, glazing or walkway rules (validate_layout does)', () => {
    // a tall wardrobe under the window is placeable; validate_layout reports it
    const r = apply(bare, place(bedDraft({ id: 'w', position: [9.29, 0.3], dims: { w: 1, d: 0.6, h: 2.2 }, product: { ...snapshot, dims: { w: 1, d: 0.6, h: 2.2 } } })));
    expect(r.ok).toBe(true);
  });

  it('enforces the soft cap of 60 items per room', () => {
    const items: Item[] = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, assetId: 'param:test', position: [0.3 + (i % 10) * 0.35, 2.9 + Math.floor(i / 10) * 0.35], elevation: 0, rotation: 0, roomId: 'sejour', dims: { w: 0.2, d: 0.2, h: 0.2 } }));
    const full: Scene = { ...bare, items };
    const r = apply(full, place(bedDraft({ id: 'x61', roomId: 'sejour', position: [3, 7.5], dims: { w: 0.3, d: 0.3, h: 0.3 }, product: { ...snapshot, dims: { w: 0.3, d: 0.3, h: 0.3 } } })));
    expect(!r.ok && r.errors[0]).toMatchObject({ code: 'limit_exceeded' });
    // another room is not affected
    expect(apply(full, place(bedDraft())).ok).toBe(true);
  });

  it('a non-user cannot create a locked item', () => {
    const r = apply(bare, place(bedDraft({ locked: true })), llm);
    expect(!r.ok && r.errors[0]).toMatchObject({ code: 'precondition_failed' });
    expect(apply(bare, place(bedDraft({ locked: true }))).ok).toBe(true);
  });
});

describe('locked items', () => {
  const locked = okScene(bare, place(bedDraft({ id: 'placard', locked: true, position: [7.4, 0.5], dims: { w: 0.8, d: 0.6, h: 2.2 }, product: undefined, productRef: undefined })));
  const cmds: Command[] = [
    { type: 'item.move', id: 'placard', position: [7.5, 0.5] },
    { type: 'item.rotate', id: 'placard', rotation: 90 },
    { type: 'item.setVariant', id: 'placard', variant: 'x' },
    { type: 'item.remove', id: 'placard' },
  ];

  it.each(cmds.map((c) => [c.type, c] as const))('%s is precondition_failed for llm and planner, allowed for a user', (_t, cmd) => {
    for (const kind of ['llm', 'planner'] as const) {
      const r = apply(locked, cmd, { author: { kind } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]).toMatchObject({ code: 'precondition_failed', path: 'id' });
    }
    expect(apply(locked, cmd).ok).toBe(true);
  });

  it('an undo may restore a locked item (trusted)', () => {
    const removed = applyCommand(locked, env(cmds[3]!));
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const back = applyCommand(removed.scene, env(removed.inverse, { author: { kind: 'llm' } }), { trusted: true });
    expect(back.ok && back.scene).toStrictEqual(locked);
  });

  it('a locked item is an obstacle for others', () => {
    const r = apply(locked, place(bedDraft({ id: 'b2', position: [7.4, 0.6], dims: { w: 0.5, d: 0.5, h: 0.5 } })));
    expect(!r.ok && r.errors[0]).toMatchObject({ code: 'placement_invalid', violation: { code: 'overlap', entityIds: ['placard'] } });
  });
});

describe('item.move / item.rotate', () => {
  it('moves with an exact inverse and tracks the room', () => {
    const r = apply(withBed, { type: 'item.move', id: 'bed', position: [8.2, 1.2], rotation: 0, relation: { kind: 'at', position: [8.2, 1.2], rotation: 0, elevation: 0 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scene.items[0]).toMatchObject({ position: [8.2, 1.2], relation: { kind: 'at' } });
    expect(r.changed.items).toEqual(['bed']);
    const back = applyCommand(r.scene, env(r.inverse));
    expect(back.ok && back.scene).toStrictEqual(withBed);
  });

  it('follows the item into another room, and undo returns it', () => {
    const small = okScene(bare, place(bedDraft({ id: 'box', dims: { w: 0.4, d: 0.4, h: 0.4 }, product: undefined, productRef: undefined, position: [8, 2] })));
    const r = apply(small, { type: 'item.move', id: 'box', position: [5.5, 1] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scene.items[0]!.roomId).toBe('ch2');
    const back = applyCommand(r.scene, env(r.inverse));
    expect(back.ok && back.scene).toStrictEqual(small);
  });

  it('refuses a move that no longer fits (placement_invalid) and a floor item with elevation (invalid_command)', () => {
    const r = apply(withBed, { type: 'item.move', id: 'bed', position: [20, 20], roomId: 'ch1' });
    expect(!r.ok && r.errors[0]).toMatchObject({ code: 'placement_invalid' });
    const e = apply(okScene(bare, place(bedDraft({ mount: 'floor' }))), { type: 'item.move', id: 'bed', position: [8, 2], elevation: 1 });
    expect(!e.ok && e.errors[0]!.code).toBe('invalid_command');
    const u = apply(withBed, { type: 'item.move', id: 'nope', position: [8, 2] });
    expect(!u.ok && u.errors[0]).toMatchObject({ code: 'unknown_entity' });
  });

  it('the item is not an obstacle to itself; no change is a noop', () => {
    const r = apply(withBed, { type: 'item.move', id: 'bed', position: [7.71, 1.05] });
    expect(r.ok).toBe(true);
    const same = apply(withBed, { type: 'item.move', id: 'bed', position: [7.71, 1] });
    expect(same.ok && same.noop).toBe(true);
  });

  it('rotates with an exact inverse and refuses a rotation that leaves the room', () => {
    const r = apply(withBed, { type: 'item.rotate', id: 'bed', rotation: 90 });
    expect(!r.ok && r.errors[0]).toMatchObject({ code: 'placement_invalid' }); // 2 m wide against a 1 m margin
    const small = okScene(bare, place(bedDraft({ id: 'box', dims: { w: 0.6, d: 0.4, h: 0.4 }, product: undefined, productRef: undefined, position: [8, 2] })));
    const rot = apply(small, { type: 'item.rotate', id: 'box', rotation: 90 });
    expect(rot.ok).toBe(true);
    if (!rot.ok) return;
    const back = applyCommand(rot.scene, env(rot.inverse));
    expect(back.ok && back.scene).toStrictEqual(small);
  });

  it('drags coalesce into one undo step with coalesceKey item:<id>', () => {
    const small = okScene(bare, place(bedDraft({ id: 'box', dims: { w: 0.4, d: 0.4, h: 0.4 }, product: undefined, productRef: undefined, position: [8, 2] })));
    let scene = small;
    let history = createHistory();
    for (const [i, x] of [8.1, 8.2, 8.3].entries()) {
      const e = env({ type: 'item.move', id: 'box', position: [x, 2] }, { ts: 1000 + i * 100, coalesceKey: itemCoalesceKey('box') });
      const r = applyCommand(scene, e);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      history = recordCommand(history, e, r, e.ts);
      scene = r.scene;
    }
    expect(history.past).toHaveLength(1);
    const u = undo(history, scene, { id: 'u', ts: 5000, author: { kind: 'user' } });
    expect(u.ok && u.scene).toStrictEqual(small);
  });
});

describe('item.setVariant', () => {
  const other = { ...snapshot, sku: 'BED-140', name: 'MOCK bed 140x200', price: 149, dims: { w: 1.4, d: 2, h: 0.9 } };

  it('swaps variant, product snapshot and dims with an exact inverse', () => {
    const r = apply(withBed, { type: 'item.setVariant', id: 'bed', variant: 'BED-140', product: other, dims: { w: 1.4, d: 2, h: 0.9 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scene.items[0]).toMatchObject({ variant: 'BED-140', product: { sku: 'BED-140', price: 149 }, productRef: { sku: 'BED-140' }, dims: { w: 1.4 } });
    const back = applyCommand(r.scene, env(r.inverse));
    expect(back.ok && back.scene).toStrictEqual(withBed);
    // clearing: variant null, dims null
    const cleared = apply(r.scene, { type: 'item.setVariant', id: 'bed', variant: null, dims: null });
    expect(cleared.ok && cleared.scene.items[0]).not.toHaveProperty('variant');
    if (cleared.ok) {
      const again = applyCommand(cleared.scene, env(cleared.inverse));
      expect(again.ok && again.scene).toStrictEqual(r.scene);
    }
  });

  it('only a product-backed item can take a new product snapshot; dims are checked', () => {
    const plain = okScene(bare, place(bedDraft({ id: 'p', product: undefined, productRef: undefined, dims: { w: 0.4, d: 0.4, h: 0.4 }, position: [8, 2] })));
    const r = apply(plain, { type: 'item.setVariant', id: 'p', variant: 'x', product: other });
    expect(!r.ok && r.errors[0]).toMatchObject({ code: 'precondition_failed' });
    const big = apply(plain, { type: 'item.setVariant', id: 'p', variant: 'x', dims: { w: 8, d: 8, h: 0.4 } });
    expect(!big.ok && big.errors[0]).toMatchObject({ code: 'placement_invalid' });
  });
});

describe('item.remove', () => {
  it('removes with an inverse that restores the list position', () => {
    const three = okScene(okScene(withBed, place(bedDraft({ id: 'b', position: [8, 3], dims: { w: 0.4, d: 0.4, h: 0.4 }, product: undefined, productRef: undefined }))), place(bedDraft({ id: 'c', position: [9, 3], dims: { w: 0.4, d: 0.4, h: 0.4 }, product: undefined, productRef: undefined })));
    const r = apply(three, { type: 'item.remove', id: 'b' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scene.items.map((i) => i.id)).toEqual(['bed', 'c']);
    expect(r.inverse).toMatchObject({ type: 'item.place', index: 1 });
    const back = applyCommand(r.scene, env(r.inverse));
    expect(back.ok && back.scene).toStrictEqual(three);
    expect(apply(three, { type: 'item.remove', id: 'nope' }).ok).toBe(false);
  });
});

describe('batches', () => {
  it('are atomic: a refused item rolls the whole batch back, the error path names the command', () => {
    const cmd: Command = {
      type: 'batch',
      label: 'furnish',
      commands: [
        { type: 'item.place', item: bedDraft() as never },
        { type: 'item.place', item: bedDraft({ id: 'bad', position: [20, 20] }) as never },
      ],
    };
    const r = apply(bare, cmd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatchObject({ code: 'placement_invalid', path: 'commands/1/item' });
    // the later command sees the earlier one
    const overlap: Command = { type: 'batch', label: 'two', commands: [{ type: 'item.place', item: bedDraft() as never }, { type: 'item.place', item: bedDraft({ id: 'b2' }) as never }] };
    const o = apply(bare, overlap);
    expect(!o.ok && o.errors[0]).toMatchObject({ code: 'placement_invalid', violation: { code: 'overlap' } });
    // and a good batch undoes in one step
    const good: Command = { type: 'batch', label: 'two', commands: [{ type: 'item.place', item: bedDraft() as never }, { type: 'item.place', item: bedDraft({ id: 'b2', position: [9, 3.4], dims: { w: 0.4, d: 0.4, h: 0.4 }, product: undefined, productRef: undefined }) as never }] };
    const g = apply(bare, good);
    expect(g.ok).toBe(true);
    if (g.ok) {
      const back = applyCommand(g.scene, env(g.inverse));
      expect(back.ok && back.scene).toStrictEqual(bare);
      expect(g.changed.items).toEqual(['bed', 'b2']);
    }
  });
});

describe('labels and tools', () => {
  it('describes item commands with names and rooms', () => {
    expect(describeCommand(place(bedDraft()), bare)).toBe('Placed MOCK bed 160x200 in Chambre 1');
    expect(describeCommand({ type: 'item.move', id: 'bed', position: [8, 1] }, withBed)).toBe('Moved MOCK bed 160x200 in Chambre 1');
    expect(describeCommand({ type: 'item.rotate', id: 'bed', rotation: 90 }, withBed)).toBe('Rotated MOCK bed 160x200 to 90°');
    expect(describeCommand({ type: 'item.remove', id: 'bed' }, withBed)).toBe('Removed MOCK bed 160x200 from Chambre 1');
    expect(describeCommand({ type: 'item.setVariant', id: 'bed', variant: 'white' }, withBed)).toBe('Changed MOCK bed 160x200 to variant white');
    expect(describeCommand({ type: 'item.remove', id: 'ghost' }, withBed)).toBe('Removed ghost');
  });

  it('exposes one LLM tool per item command, naming the related tools', () => {
    const tools = new Map(commandToolSchemas().map((t) => [t.name, t]));
    for (const name of ['item_place', 'item_move', 'item_rotate', 'item_set_variant', 'item_remove']) expect(tools.has(name), name).toBe(true);
    expect(tools.get('item_place')!.description).toContain('search_products');
    expect(tools.get('item_place')!.description).toContain('placement_invalid');
    expect(tools.get('item_move')!.description).toContain('validate_layout');
    expect(tools.get('item_place')!.description).toContain('place_item');
  });
});
