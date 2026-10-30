import { describe, expect, it } from 'vitest';
import type { MeshData } from '@flat/scene';
import { ITEM_MATERIALS } from '../materials/item-materials';
import { island } from './cabinets';

/** The island concept options: open shelf and wine-rack bays, and the swivel / extendable top (a "table-island"). */

const dimsOf = (raw: Record<string, unknown>) => island.describeParams(island.params.parse(raw)).dims;
const meshOf = (raw: Record<string, unknown>) => island.generate(island.params.parse(raw));
const materials = (m: MeshData) => new Set(m.groups.map((g) => g.materialId));

function bbox(m: MeshData) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, m.positions[i + a]!);
      max[a] = Math.max(max[a]!, m.positions[i + a]!);
    }
  }
  return { min, max };
}

const concept = { w: 1.3, d: 0.6, doors: 2, shelfBays: 1, wineBays: 1, topLength: 1.6, topWidth: 0.55 };

describe('island concept options', () => {
  it('options off leave the plain island as it was: same dims, no bottles', () => {
    expect(dimsOf({})).toEqual({ w: 1.26, d: 0.77, h: 0.9 });
    expect(materials(meshOf({})).has(ITEM_MATERIALS.glassSmoked)).toBe(false);
  });

  it('a wine bay brings bottles; shelf and wine bays stay inside the body box', () => {
    expect(materials(meshOf({ wineBays: 1 })).has(ITEM_MATERIALS.glassSmoked)).toBe(true);
    const raw = { shelfBays: 2, wineBays: 1 };
    expect(dimsOf(raw)).toEqual({ w: 1.26, d: 0.77, h: 0.9 });
    const { min, max } = bbox(meshOf(raw));
    expect(max[0]! - min[0]!).toBeCloseTo(1.26, 3);
    expect(max[1]).toBeCloseTo(0.9, 3);
  });

  it('keeps room for the doors when the island is short', () => {
    const m = meshOf({ w: 0.6, shelfBays: 3, wineBays: 1 });
    expect(bbox(m).max[0]! - bbox(m).min[0]!).toBeCloseTo(0.6, 3);
  });

  it('the swivel top goes from aligned (closed) to square to the island (a dining table); the box follows, centred, 0.9 m high', () => {
    const closed = dimsOf({ ...concept, topAngle: 0 });
    const open = dimsOf({ ...concept, topAngle: 90 });
    // closed: the 1.6 m top lies along the island (0.02 m behind its pivot post) and overhangs the far end
    expect(closed.w).toBeCloseTo(1.62, 3);
    expect(closed.d).toBeCloseTo(0.6, 3);
    // open: it points out of the stool side; the island box is 1.3 wide, the top reaches 1.6 - 0.275 m past the pivot axis
    expect(open.w).toBeCloseTo(1.3, 3);
    expect(open.d).toBeGreaterThan(open.w);
    for (const angle of [0, 30, 60, 90]) {
      const raw = { ...concept, topAngle: angle };
      const d = dimsOf(raw);
      const { min, max } = bbox(meshOf(raw));
      expect(d.h).toBe(0.9);
      expect(max[1]).toBeCloseTo(0.9, 3);
      expect(min[0]).toBeCloseTo(-d.w / 2, 3);
      expect(max[0]).toBeCloseTo(d.w / 2, 3);
      expect(min[2]).toBeCloseTo(-d.d / 2, 3);
      expect(max[2]).toBeCloseTo(d.d / 2, 3);
    }
  });

  it('is deterministic and the angle changes the geometry', () => {
    const hashOf = (m: MeshData) => Array.from(m.positions, (v) => v.toFixed(5)).join(',');
    expect(hashOf(meshOf({ ...concept, topAngle: 90 }))).toBe(hashOf(meshOf({ ...concept, topAngle: 90 })));
    expect(hashOf(meshOf({ ...concept, topAngle: 90 }))).not.toBe(hashOf(meshOf({ ...concept, topAngle: 0 })));
  });

  it('rejects an angle outside 0-90 and unknown options', () => {
    expect(island.params.safeParse({ topAngle: 91 }).success).toBe(false);
    expect(island.params.safeParse({ topAngle: -1 }).success).toBe(false);
    expect(island.params.safeParse({ rotation: 90 }).success).toBe(false);
  });
});
