import { describe, expect, it } from 'vitest';
import {
  PlacementRequest,
  Relation,
  VIOLATION_CODES,
  VIOLATION_HINTS,
  Violation,
  solvePlacement,
  validateLayout,
  type PlacementResult,
} from './types';
import { billOfMaterials } from '../bill-of-materials';
import { parseScene } from '../parse';
import sample from '../../fixtures/sample.flat.json';

const scene = (() => {
  const r = parseScene(sample);
  if (!r.ok) throw new Error(r.errors.join());
  return r.scene;
})();

describe('Relation', () => {
  const valid: unknown[] = [
    { kind: 'against_wall', wallId: 'n' },
    { kind: 'against_wall', wallId: 'n', roomId: 'r', align: 'end', offset: 0.3, gap: 0.02 },
    { kind: 'in_corner', roomId: 'r', corner: 0 },
    { kind: 'centered_in', roomId: 'r' },
    { kind: 'centered_in', roomId: 'r', axis: 'x' },
    { kind: 'facing', targetId: 'bed-1' },
    { kind: 'next_to', itemId: 'bed-1', side: 'left' },
    { kind: 'under_window', openingId: 'win' },
    { kind: 'at', position: [1, 2] },
  ];
  it.each(valid)('accepts %j', (rel) => {
    expect(Relation.safeParse(rel).success).toBe(true);
  });
  it('fills defaults', () => {
    expect(Relation.parse({ kind: 'against_wall', wallId: 'n' })).toEqual({ kind: 'against_wall', wallId: 'n', align: 'center', offset: 0, gap: 0 });
    expect(Relation.parse({ kind: 'next_to', itemId: 'b', side: 'right' })).toMatchObject({ gap: 0.02, align: 'center' });
    expect(Relation.parse({ kind: 'at', position: [1, 2] })).toEqual({ kind: 'at', position: [1, 2], rotation: 0, elevation: 0 });
  });
  it.each([
    { kind: 'against_wall' },
    { kind: 'against_wall', wallId: 'n', gap: -1 },
    { kind: 'in_corner', roomId: 'r', corner: -1 },
    { kind: 'in_corner', roomId: 'r', corner: 1.5 },
    { kind: 'next_to', itemId: 'b', side: 'above' },
    { kind: 'at', position: [1] },
    { kind: 'floating', wallId: 'n' },
    { kind: 'facing', targetId: 'x', extra: 1 },
  ])('rejects %j', (rel) => {
    expect(Relation.safeParse(rel).success).toBe(false);
  });
});

describe('PlacementRequest', () => {
  const req = { roomId: 'r', dims: { w: 1.6, d: 2, h: 0.9 }, relation: { kind: 'centered_in', roomId: 'r' } };
  it('parses with defaults', () => {
    expect(PlacementRequest.parse(req)).toMatchObject({ mount: 'floor', acknowledgeHeavyPartition: false, maxCandidates: 3 });
  });
  it('rejects missing relation, bad dims and unknown keys', () => {
    expect(PlacementRequest.safeParse({ ...req, relation: undefined }).success).toBe(false);
    expect(PlacementRequest.safeParse({ ...req, dims: { w: 0, d: 1, h: 1 } }).success).toBe(false);
    expect(PlacementRequest.safeParse({ ...req, price: 1 }).success).toBe(false);
  });
});

describe('Violation and results', () => {
  it('lists the ten D7 codes, each with a default hint', () => {
    expect([...VIOLATION_CODES]).toEqual([
      'outside_room',
      'overlap',
      'door_swing_blocked',
      'window_blocked',
      'glazing_blocked',
      'walkway_too_narrow',
      'heavy_mount_partition',
      'locked_item',
      'invalid_relation',
      'dims_mismatch',
    ]);
    for (const c of VIOLATION_CODES) expect(VIOLATION_HINTS[c].length).toBeGreaterThan(10);
  });
  it('validates a violation', () => {
    expect(Violation.safeParse({ code: 'overlap', message: 'm', entityIds: ['a'], hint: 'h' }).success).toBe(true);
    expect(Violation.safeParse({ code: 'too_tall', message: 'm', entityIds: [], hint: 'h' }).success).toBe(false);
  });
  it('the PlacementResult union narrows on ok', () => {
    const r = { ok: false, violations: [], candidates: [] } as PlacementResult;
    if (!r.ok) expect(r.candidates).toEqual([]);
  });
});

describe('stubs throw "not implemented"', () => {
  it('solvePlacement', () => {
    expect(() => solvePlacement(scene, { roomId: 'r', dims: { w: 1, d: 1, h: 1 }, relation: { kind: 'centered_in', roomId: 'r' } })).toThrow(/not implemented/);
  });
  it('validateLayout', () => {
    expect(() => validateLayout(scene)).toThrow(/not implemented/);
  });
  it('billOfMaterials', () => {
    expect(() => billOfMaterials(scene)).toThrow(/not implemented/);
  });
});
