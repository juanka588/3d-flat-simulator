import { describe, expect, it } from 'vitest';
import { HEAVY_MOUNT_KG } from '../products';
import { openingZones, solvePlacement, type PlacementResult } from './index';
import type { PlacementRequestInput } from './types';
import { BARE_CHARME, corridorScene } from './testUtil';

const codes = (r: PlacementResult) => (r.ok ? [] : r.violations.map((v) => v.code));
const dims = (w: number, d: number, h: number) => ({ w, d, h });
const warnings = (r: PlacementResult) => (r.ok ? r.warnings.map((w) => w.code) : []);

const picture = { w: 0.8, d: 0.04, h: 0.6 };
const at = (roomId: string, position: [number, number], rotation: number, d: ReturnType<typeof dims>, over: Partial<PlacementRequestInput> = {}): PlacementRequestInput => ({
  roomId,
  dims: d,
  relation: { kind: 'at', position, rotation },
  ...over,
});

describe('the non-swing side of doors (M9)', () => {
  // door-ch2: on the south wall of Chambre 2 (y = 4.12..4.19), 0.8 wide, centre x = 6.315, swinging into Chambre 2
  it('a wardrobe 0.3 m in front of door-ch2 on the Entree side is door_swing_blocked', () => {
    const r = solvePlacement(BARE_CHARME, at('entree', [6.315, 4.5], 0, dims(1, 0.6, 2.2)));
    expect(codes(r)).toEqual(['door_swing_blocked']);
    if (!r.ok) expect(r.violations[0]!.entityIds).toEqual(['door-ch2']);
  });

  it('a picture at 1.2 m inside the opening is refused on either face', () => {
    const entree = solvePlacement(BARE_CHARME, at('entree', [6.315, 4.19 + 0.022], 0, picture, { mount: 'wall', elevation: 1.2 }));
    expect(codes(entree)).toEqual(['door_swing_blocked']);
    const swingSide = solvePlacement(BARE_CHARME, at('ch2', [6.315, 4.12 - 0.022], 180, picture, { mount: 'wall', elevation: 1.2 }));
    expect(codes(swingSide)).toEqual(['door_swing_blocked']);
  });

  it('a picture beside the opening or above the door head is fine', () => {
    expect(solvePlacement(BARE_CHARME, at('entree', [5.5, 4.19 + 0.022], 0, picture, { mount: 'wall', elevation: 1.2 })).ok).toBe(true);
    expect(solvePlacement(BARE_CHARME, at('entree', [6.315, 4.19 + 0.022], 0, { w: 0.8, d: 0.04, h: 0.3 }, { mount: 'wall', elevation: 2.1 })).ok).toBe(true);
  });

  it('a picture in a passage is refused on either face', () => {
    const room = corridorScene(); // passage p-out in wall "mid" (x = 5.0 .. 5.1), room r to its west, b to its east
    expect(codes(solvePlacement(room, at('r', [4.978, 1.5], 270, picture, { mount: 'wall', elevation: 1.2 })))).toEqual(['door_swing_blocked']);
    expect(codes(solvePlacement(room, at('b', [5.122, 1.5], 90, picture, { mount: 'wall', elevation: 1.2 })))).toEqual(['door_swing_blocked']);
  });

  it('every non-entry door has one approach zone, on the side it does not swing to', () => {
    const zones = openingZones(BARE_CHARME).filter((z) => z.openingId === 'door-ch2');
    expect(zones.map((z) => z.kind).sort()).toEqual(['approach', 'span', 'span', 'swing']);
    const approach = zones.find((z) => z.kind === 'approach')!;
    const ys = approach.polygon.map((p) => p[1]);
    expect(Math.min(...ys)).toBeGreaterThan(4.1); // the Entree side, south of the wall
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(0.6 + 0.035, 2);
    const xs = approach.polygon.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.8, 6); // door wide
  });
});

describe('door zones start at the sill', () => {
  it('a door on a 0.1 m step keeps its zone up to sill + height', () => {
    const room = corridorScene();
    const stepped = { ...room, openings: room.openings.map((o) => (o.id === 'p-out' ? { ...o, sill: 0.1 } : o)) };
    // passage 2.1 m high: a plaque from 2.15 m up is above a flat door but inside a door on a step
    const plaque = at('r', [4.978, 1.5], 270, { w: 0.4, d: 0.04, h: 0.2 }, { mount: 'wall', elevation: 2.15 });
    expect(solvePlacement(room, plaque).ok).toBe(true);
    expect(codes(solvePlacement(stepped, plaque))).toEqual(['door_swing_blocked']);
    for (const z of openingZones(stepped).filter((x) => x.openingId === 'p-out' && x.kind !== 'span')) expect(z.hi).toBeCloseTo(2.2, 6);
  });
});

describe('ceiling mounts and windows', () => {
  it('a ceiling lamp near a window wall is not window_blocked', () => {
    const lamp = at('ch1', [9.29, 0.3], 0, dims(0.4, 0.4, 0.3), { mount: 'ceiling' });
    expect(solvePlacement(BARE_CHARME, lamp).ok).toBe(true);
    // the same box standing on the floor is
    expect(codes(solvePlacement(BARE_CHARME, at('ch1', [9.29, 0.3], 0, dims(0.4, 0.4, 1.5))))).toEqual(['window_blocked']);
  });
});

describe('wall mount weights', () => {
  const cabinet = (over: Partial<PlacementRequestInput> = {}): PlacementRequestInput => ({
    roomId: 'ch1',
    dims: dims(0.8, 0.3, 0.6),
    mount: 'wall',
    elevation: 1.4,
    category: 'wall_cabinet',
    relation: { kind: 'against_wall', wallId: 'w-ch2-ch1', roomId: 'ch1', align: 'center' },
    ...over,
  });

  it('a wall cabinet with no weight gets a weight_unknown warning, not a refusal', () => {
    const r = solvePlacement(BARE_CHARME, cabinet());
    expect(r.ok).toBe(true);
    expect(warnings(r)).toEqual(['weight_unknown']);
    if (r.ok) expect(r.rationale.join(' ')).toMatch(/warning: .*no weight/);
  });

  it('a known weight, a light category, or a floor mount gives no warning', () => {
    expect(warnings(solvePlacement(BARE_CHARME, cabinet({ weightKg: 5 })))).toEqual([]);
    expect(warnings(solvePlacement(BARE_CHARME, cabinet({ category: 'mirror' })))).toEqual([]);
    expect(warnings(solvePlacement(BARE_CHARME, cabinet({ mount: 'floor', elevation: undefined })))).toEqual([]);
  });

  it('a heavy wall mount held away from a partition still counts as wall-mounted', () => {
    // 0.26 m off the 7 cm partition between Chambre 2 and Chambre 1: beyond the 0.12 m reach of a flush mount
    const far = at('ch1', [6.91 + 0.04 + 0.26, 2], 90, dims(0.8, 0.08, 0.7), { mount: 'wall', elevation: 1, weightKg: HEAVY_MOUNT_KG + 5 });
    const r = solvePlacement(BARE_CHARME, far);
    expect(codes(r)).toEqual(['heavy_mount_partition']);
    const ack = solvePlacement(BARE_CHARME, { ...far, acknowledgeHeavyPartition: true });
    expect(warnings(ack)).toEqual(['heavy_mount_partition']);
  });
});

describe('stored relations', () => {
  it('an `at` relation keeps the real elevation of a wall mount, in the placement and in the alternatives', () => {
    const ok = solvePlacement(BARE_CHARME, at('ch1', [8.0, 0.022], 0, picture, { mount: 'wall', elevation: 1.4 }));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.placement.elevation).toBe(1.4);
      expect(ok.placement.relation).toMatchObject({ kind: 'at', elevation: 1.4 });
    }
    // refused (glazing): the alternatives are `against_wall`-style poses or `at` poses; every `at` carries the elevation
    const bad = solvePlacement(BARE_CHARME, at('ch1', [9.29, 0.022], 0, { w: 0.6, d: 0.04, h: 0.5 }, { mount: 'wall', elevation: 1.4 }));
    if (!bad.ok) for (const c of bad.candidates) if (c.relation.kind === 'at') expect(c.relation.elevation).toBe(c.elevation);
    // a floor item keeps 0
    const floor = solvePlacement(BARE_CHARME, at('ch1', [8, 2], 0, dims(0.5, 0.5, 0.5)));
    if (floor.ok) expect(floor.placement.relation).toMatchObject({ kind: 'at', elevation: 0 });
  });
});
