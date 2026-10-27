import { describe, expect, it } from 'vitest';
import { COMMAND_TYPES, LEAF_COMMAND_SCHEMAS } from './schema';
import { ITEM_COMMAND_SCHEMAS, itemCoalesceKey, ItemDraft, ItemMove, ItemPlace, ItemRemove, ItemRotate, ItemSetVariant } from './item-schema';
import { parseCommand } from './parse';

const env = (cmd: unknown) => ({ v: 1, id: 'e1', ts: 1, author: { kind: 'llm' }, cmd });

describe('item command schemas (contract only)', () => {
  it('parse valid and invalid examples', () => {
    const item = { assetId: 'param:bed', position: [1, 1], mesh: { kind: 'parametric', generator: 'bed' } };
    expect(ItemPlace.safeParse({ type: 'item.place', item }).success).toBe(true);
    expect(ItemPlace.safeParse({ type: 'item.place', item: { ...item, id: 'bed-1', mount: 'floor', elevation: 1 } }).success).toBe(false);
    expect(ItemDraft.safeParse({ ...item, extra: 1 }).success).toBe(false);
    expect(ItemMove.safeParse({ type: 'item.move', id: 'a', position: [1, 2], rotation: 90, roomId: null, relation: null }).success).toBe(true);
    expect(ItemMove.safeParse({ type: 'item.move', id: 'a' }).success).toBe(false);
    expect(ItemRotate.safeParse({ type: 'item.rotate', id: 'a', rotation: 45 }).success).toBe(true);
    expect(ItemSetVariant.safeParse({ type: 'item.setVariant', id: 'a', variant: null }).success).toBe(true);
    expect(ItemRemove.safeParse({ type: 'item.remove', id: 'a' }).success).toBe(true);
    expect(ItemRemove.safeParse({ type: 'item.remove' }).success).toBe(false);
  });

  it('are registered: command types, leaf schemas and tools; item.add / item.update stay reserved', () => {
    for (const s of ITEM_COMMAND_SCHEMAS) {
      expect(LEAF_COMMAND_SCHEMAS).toContain(s);
      expect(COMMAND_TYPES).toContain(s.shape.type.value);
    }
    for (const type of ['item.add', 'item.update']) {
      const r = parseCommand(env({ type, id: 'a' }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]).toMatchObject({ code: 'not_supported' });
    }
    expect(itemCoalesceKey('bed-1')).toBe('item:bed-1');
  });
});
