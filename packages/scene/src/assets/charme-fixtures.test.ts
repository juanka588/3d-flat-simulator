import { describe, expect, it } from 'vitest';
import charme from '../../fixtures/charme-3205.flat.json';
import { billOfMaterials } from '../bill-of-materials';
import { describeRoom } from '../describe';
import { buildShell } from '../geometry/shell';
import { parseScene } from '../parse';
import { analyzeWalkways, footprintOf, frontOf, itemDims, layoutContext, openingZones, penetration, validateLayout } from '../placement';
import type { Item, Scene, Vec2 } from '../schema';
import { wallLength } from '../schema';
import { DEFAULT_LIGHTING } from '../view';
import { pointInPolygon } from '../validate';
import { ownerAt } from '../geometry/builder';
import { GENERATORS } from '../items/mesh-source';
import './generators';

/**
 * The fixed fixtures of the Charme 3205 scene (the flat's own kitchen, bathtub, WC, electrical panel and the closet of
 * Chambre 2), transcribed from page 6 of the plan. All are locked existing furniture with no product (EUR 0).
 */
const parsed = parseScene(charme);
if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
const scene: Scene = parsed.scene;
const item = (id: string): Item => scene.items.find((i) => i.id === id)!;
const wall = (id: string) => scene.walls.find((w) => w.id === id)!;
const rect = (id: string) => {
  const it = item(id);
  const pts = footprintOf(it.position, it.rotation, itemDims(it));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys), pts };
};
const wallRect = (id: string): Vec2[] => {
  const w = wall(id);
  const len = wallLength(w);
  const [dx, dy] = [(w.end[0] - w.start[0]) / len, (w.end[1] - w.start[1]) / len];
  const [nx, ny] = [-dy * (w.thickness / 2), dx * (w.thickness / 2)];
  return [[w.start[0] + nx, w.start[1] + ny], [w.end[0] + nx, w.end[1] + ny], [w.end[0] - nx, w.end[1] - ny], [w.start[0] - nx, w.start[1] - ny]];
};
const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThan(tol);

const FIXTURE_ITEMS: Record<string, { generator: string; room: string }> = {
  'placard-ch2': { generator: 'wardrobe', room: 'entree' },
  'kitchen-cooktop-cui': { generator: 'cooktop', room: 'sejour' },
  'kitchen-sink-tri': { generator: 'washbasin', room: 'sejour' },
  'kitchen-fridge-f': { generator: 'fridge', room: 'sejour' },
  'kitchen-wall-est-1': { generator: 'kitchenWall', room: 'sejour' },
  'kitchen-wall-est-2': { generator: 'kitchenWall', room: 'sejour' },
  'sdb-bathtub': { generator: 'bathtub', room: 'sdb' },
  'sdb-vanity-basin': { generator: 'washbasin', room: 'sdb' },
  'sdb-washing-machine-ll': { generator: 'kitchenBase', room: 'sdb' },
  'wc-toilet': { generator: 'toilet', room: 'wc' },
  'te-electrical-panel': { generator: 'wardrobe', room: 'entree' },
};

describe('fixed fixtures: locked, existing, exact', () => {
  it.each(Object.entries(FIXTURE_ITEMS))('%s is locked existing furniture on its generator at the generator dims', (id, { generator, room }) => {
    const it = item(id);
    expect(it).toMatchObject({ locked: true, roomId: room, assetId: `param:${generator}`, mesh: { kind: 'parametric', generator } });
    expect(it.product).toBeUndefined();
    expect(it.productRef).toBeUndefined();
    const g = GENERATORS.get(generator)!;
    const exact = g.describeParams(g.params.parse((it.mesh as { params: unknown }).params)).dims;
    expect(it.dims).toEqual(exact);
  });

  it('they all cost EUR 0 as existing furniture', () => {
    const bom = billOfMaterials(scene);
    for (const id of Object.keys(FIXTURE_ITEMS)) expect(bom.lines.find((l) => l.itemId === id), id).toMatchObject({ locked: true, existing: true, amount: 0 });
    expect(bom.totalEur).toBe(0);
  });

  it('none overlaps a wall or another fixture, except the closet of Chambre 2 touching its walls', () => {
    const ids = Object.keys(FIXTURE_ITEMS);
    for (const id of ids) {
      const it = item(id);
      if (it.mount === 'wall') continue; // hung above the floor run / on a wall face: checked below
      for (const w of scene.walls) expect(penetration(rect(id).pts, wallRect(w.id)), `${id} vs ${w.id}`).toBeLessThan(1e-3);
      for (const other of ids) if (other !== id && item(other).mount !== 'wall') expect(penetration(rect(id).pts, rect(other).pts), `${id} vs ${other}`).toBeLessThan(1e-3);
    }
  });

  it('validateLayout is ok for every room, and every room keeps a walkway of at least 0.8 m (0.9 m with the entry)', () => {
    const report = validateLayout(scene);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    const ctx = layoutContext(scene);
    for (const room of scene.rooms) {
      expect(validateLayout(scene, { roomId: room.id }).ok, room.id).toBe(true);
      const a = analyzeWalkways(ctx, ctx.rooms.get(room.id)!);
      if (a.minWidthM !== undefined) expect(a.minWidthM, room.id).toBeGreaterThanOrEqual(0.8);
      expect(a.violation, room.id).toBeUndefined();
    }
  });
});

describe('placard of Chambre 2: a closet in the wall, doors onto the Entrée', () => {
  const doorFrom = () => wall('w-ch2-south').start[0] + 0.52 - 0.4;

  it('is a sliding wardrobe whose doors face south (+y) onto the Entrée, listed as hall storage and not as bedroom storage', () => {
    const it = item('placard-ch2');
    expect(it).toMatchObject({ roomId: 'entree', rotation: 0, mount: 'floor', mesh: { params: { doorType: 'sliding', h: 2.4 } } });
    expect(frontOf(it.rotation)).toEqual([0, 1]);
    const light = { ...DEFAULT_LIGHTING, date: '2026-12-21' };
    expect(describeRoom(scene, 'entree', light)!.items.map((i) => i.id)).toContain('placard-ch2');
    expect(describeRoom(scene, 'ch2', light)!.items.map((i) => i.id)).not.toContain('placard-ch2');
  });

  it('fills the niche between the séjour wall and the door jamb: back wall behind, east side wall, front on the wall axis', () => {
    const r = rect('placard-ch2');
    const back = wall('w-placard-ch2-back');
    const east = wall('w-placard-ch2-east');
    const stub = wall('w-ch2-south-west');
    near(r.minY, back.start[1] + back.thickness / 2); // against the back wall's face
    near(r.maxY, wall('w-ch2-south').start[1]); // front on the axis of the south wall: 3.5 cm behind the hall face, no coplanar faces
    near(r.maxX, east.start[0] - east.thickness / 2); // against the east side wall
    near(r.minX, stub.end[0]); // against the end of the stub that closes the séjour side
    expect(r.maxX - r.minX).toBeGreaterThan(1.4); // the plan's 1.45 m
    // it is carved out of the kept polygon of Chambre 2 (official area 11.13 m2 includes the closet); only its front 3.5 cm
    // lie in the wall thickness, and none of it is in the Entrée
    const ch2 = scene.rooms.find((x) => x.id === 'ch2')!.polygon;
    for (const p of r.pts.filter((q) => q[1] < 4)) expect(pointInPolygon(p, ch2, 1e-6)).toBe(true);
    const entree = scene.rooms.find((x) => x.id === 'entree')!.polygon;
    for (const p of r.pts) expect(pointInPolygon(p, entree, 1e-9) && p[1] > 4.19 + 1e-9).toBe(false);
    expect(Math.max(...ch2.map((q) => q[1])) - r.maxY).toBeLessThan(0.04);
  });

  it('touches its walls without overlapping them, in the built mesh too', () => {
    const r = rect('placard-ch2');
    for (const id of ['w-ch2-south-west', 'w-placard-ch2-back', 'w-placard-ch2-east', 'w-ch2-south', 'w-sejour-entree', 'w-sejour-ch2']) {
      expect(penetration(r.pts, wallRect(id)), id).toBeLessThan(1e-3);
    }
    const shell = buildShell(scene).items;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let t = 0; t < shell.indices.length / 3; t++) {
      if (ownerAt(shell.owners, t)?.entityId !== 'placard-ch2') continue;
      for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) {
        const c = shell.positions[shell.indices[t * 3 + k]! * 3 + a]!;
        min[a] = Math.min(min[a]!, c);
        max[a] = Math.max(max[a]!, c);
      }
    }
    near(min[0]!, r.minX, 2e-3);
    near(max[0]!, r.maxX, 2e-3);
    near(min[2]!, r.minY, 2e-3);
    near(max[2]!, r.maxY, 2e-3); // the door handles stand 8 mm proud of the doors, flush with the footprint
    expect(max[1]!).toBeLessThan(wall('w-placard-ch2-back').height);
  });

  it('leaves door-ch2 exactly where it was (world centre x = 6.315) with the same swing, clear of the closet', () => {
    const w = wall('w-ch2-south');
    const o = scene.openings.find((x) => x.id === 'door-ch2')!;
    near(w.start[0] + o.offset, 6.315);
    expect(o).toMatchObject({ width: 0.8, hinge: 'end', swing: 'left', wallId: 'w-ch2-south' });
    expect(w.end).toEqual([6.875, 4.155]);
    // the hinge is on the far side: the leaf (0.8 m) cannot reach the closet, and the doorway span starts at its east jamb
    const hinge = w.start[0] + o.offset + o.width / 2;
    expect(hinge - rect('placard-ch2').maxX).toBeGreaterThan(o.width);
    expect(rect('placard-ch2').maxX).toBeLessThanOrEqual(doorFrom() + 1e-9);
    const zones = openingZones(scene).filter((z) => z.openingId === 'door-ch2');
    for (const z of zones) expect(penetration(rect('placard-ch2').pts, z.polygon), z.kind).toBeLessThan(1e-3);
  });

  it('the stub keeps the séjour wall closed and every wall segment is a straight, doorless piece except the door segment', () => {
    const stub = wall('w-ch2-south-west');
    expect(stub.start).toEqual(wall('w-sejour-ch2').end); // continues the séjour/Chambre 2 wall's end
    expect(scene.openings.filter((o) => o.wallId.startsWith('w-placard-ch2') || o.wallId === 'w-ch2-south-west')).toEqual([]);
  });
});

describe('kitchen (CUISINE), transcribed from the plan', () => {
  it('is one run along the south wall: cooktop CUI, then the sink with the TRI unit up to the 80 cm column by the niche wall (user)', () => {
    const run = ['kitchen-cooktop-cui', 'kitchen-sink-tri'].map(rect);
    for (const r of run) {
      near(r.maxY, 8.28); // against the inner face of the south wall
      near(r.maxY - r.minY, 0.6);
    }
    near(run[0]!.maxX, run[1]!.minX);
    const column = wallRect('w-kitchen-column');
    near(run[1]!.maxX, Math.min(...column.map((p) => p[0]))); // the sink ends at the column (80 x 60 cm, user)
    expect(wall('w-kitchen-column').structural).toBe(true);
    near(run[1]!.maxX - run[1]!.minX, 1.22);
    for (const id of ['kitchen-cooktop-cui', 'kitchen-sink-tri']) expect(item(id).dims!.h).toBe(0.9); // one continuous worktop level
    for (const id of ['kitchen-cooktop-cui', 'kitchen-sink-tri']) expect(frontOf(item(id).rotation)[1]).toBeCloseTo(-1, 9); // fronts face north into the room
  });

  it('has the fridge F in the recess under the new partition, against the east (niche) wall, door opening west', () => {
    const top = wall('w-fridge-top');
    expect(top.start).toEqual(wall('w-niche-west').start);
    expect(top.end[0]).toBeCloseTo(3.08, 9);
    expect(top).toMatchObject({ thickness: 0.07, height: 2.5 });
    const f = rect('kitchen-fridge-f');
    near(f.minY, 6.615 + 0.035); // just below the partition
    near(f.maxX, 3.71); // against the east wall
    expect(f.minX).toBeGreaterThanOrEqual(3.08 - 1e-9);
    expect(frontOf(item('kitchen-fridge-f').rotation)[0]).toBeCloseTo(-1, 9);
    expect(penetration(f.pts, wallRect('w-fridge-top'))).toBeLessThan(1e-3);
    // the recess is open on its west side and below the fridge: nothing else stands in front of the door
    const swept: Vec2[] = [[f.minX - 0.65, f.minY], [f.minX, f.minY], [f.minX, f.maxY], [f.minX - 0.65, f.maxY]];
    for (const id of Object.keys(FIXTURE_ITEMS)) if (id !== 'kitchen-fridge-f' && item(id).mount !== 'wall') expect(penetration(swept, rect(id).pts), id).toBeLessThan(1e-3);
  });

  it('hangs two estimated wall units over the sink at 1.45 m, above the worktop', () => {
    for (const id of ['kitchen-wall-est-1', 'kitchen-wall-est-2']) {
      const it = item(id);
      expect(it).toMatchObject({ mount: 'wall', elevation: 1.45 });
      expect(it.elevation).toBeGreaterThan(0.9 + 0.5);
      near(rect(id).maxY, 8.28);
      expect(it.elevation + it.dims!.h).toBeLessThan(wall('w-south').height);
    }
  });
});

describe('bathroom and WC, transcribed from the plan', () => {
  it('puts the bathtub in the niche, long side against the niche wall, taps at the north end', () => {
    const t = rect('sdb-bathtub');
    near(t.minX, 3.78);
    near(t.maxX - t.minX, 0.7);
    near(t.maxY, 8.28);
    expect(t.maxY - t.minY).toBeGreaterThan(1.55);
    expect(t.minY).toBeGreaterThanOrEqual(6.65 - 1e-9);
    expect(frontOf(item('sdb-bathtub').rotation)[0]).toBeCloseTo(1, 9); // long side faces east, into the room
    // taps at the north end: local +x is north at rotation 90
    expect(item('sdb-bathtub').mesh).toMatchObject({ params: { tapEnd: 'right' } });
  });

  it('has the washbasin vanity beside the tub against the south wall facing north, and the LL washing-machine slot at the east wall', () => {
    const v = rect('sdb-vanity-basin');
    near(v.minX, rect('sdb-bathtub').maxX);
    near(v.maxY, 8.28);
    expect(frontOf(item('sdb-vanity-basin').rotation)[1]).toBeCloseTo(-1, 9);
    const ll = rect('sdb-washing-machine-ll');
    near(ll.maxX, 6.39);
    near(ll.maxY, 8.28);
    near(ll.maxX - ll.minX, 0.6);
    // the slot is reserved: it is a locked placeholder so the designer cannot put furniture there
    expect(item('sdb-washing-machine-ll').locked).toBe(true);
  });

  it('puts the toilet against the east wall of the WC with at least 0.6 m free in front of it', () => {
    const t = rect('wc-toilet');
    near(t.maxX, 10.05);
    expect(frontOf(item('wc-toilet').rotation)[0]).toBeCloseTo(-1, 9);
    const wcWest = 8.77;
    expect(t.minX - wcWest).toBeGreaterThanOrEqual(0.6);
    // the door-wc swing does not reach the toilet or its front strip
    const strip: Vec2[] = [[t.minX - 0.6, t.minY], [t.minX, t.minY], [t.minX, t.maxY], [t.minX - 0.6, t.maxY]];
    expect(penetration(t.pts, wallRect('w-ch1-south'))).toBeLessThan(1e-3);
    for (const z of openingZones(scene).filter((x) => x.openingId === 'door-wc')) expect(penetration(t.pts, z.polygon), z.kind).toBeLessThan(1e-3);
    expect(penetration(strip, wallRect('w-wc-west'))).toBeLessThan(1e-3);
  });

  it('recesses the electrical panel TE (a hall-facing cupboard) in the north-east corner of the SDB, front onto the Entrée', () => {
    const it = item('te-electrical-panel');
    expect(it).toMatchObject({ roomId: 'entree', mount: 'floor', locked: true, rotation: 180, mesh: { params: { doors: 1, doorType: 'hinged', h: 2.5 } } }); // full height: the wall gap above it is closed
    expect(frontOf(it.rotation)[1]).toBeCloseTo(-1, 9); // front faces -y, onto the Entrée
    const r = rect('te-electrical-panel');
    const west = wall('w-te-west');
    const south = wall('w-te-south');
    const east = wall('w-sdb-east');
    const north = wall('w-sdb-north');
    const stub = wall('w-sdb-north-east');
    // the gap of w-sdb-north is the cupboard front: 4.505 -> 5.95 keeps the door, the stub runs 6.39 -> 6.49
    near(north.end[0], 5.95);
    near(stub.start[0], 6.39);
    near(stub.end[0], east.start[0]);
    near(r.maxY - r.minY, 0.335);
    near(r.minY, north.start[1]); // front flush with the wall axis, like placard-ch2: 3.5 cm behind the hall face
    // snug inside the recess: against the west and south walls, and against the east wall's inner face
    near(r.minX, west.start[0] + west.thickness / 2);
    near(r.maxY, south.start[1] - south.thickness / 2);
    near(r.maxX, east.start[0] - east.thickness / 2);
    for (const id of ['w-te-west', 'w-te-south', 'w-sdb-east']) expect(penetration(r.pts, wallRect(id)), id).toBeLessThan(1e-3);
    // the cupboard sits between the recess walls, east of the SDB door span (5.1 to 5.9) and clear of its swing and the entry's
    expect(r.minX).toBeGreaterThan(5.9);
    for (const z of openingZones(scene).filter((x) => x.openingId === 'door-sdb' || x.openingId === 'door-entry')) expect(penetration(r.pts, z.polygon), `${z.openingId} ${z.kind}`).toBeLessThan(1e-3);
    // 0.6 m of clear floor in front of it, in the Entrée
    const ctx = layoutContext(scene);
    const front: Vec2[] = [[r.minX, r.minY - 0.6], [r.maxX, r.minY - 0.6], [r.maxX, r.minY], [r.minX, r.minY]];
    for (const b of ctx.boxes) if (b.id !== it.id && b.mount !== 'wall') expect(penetration(front, b.footprint), b.id).toBeLessThan(1e-3);
  });
});

describe('structural columns: kitchen, Chambre 1 and SDB', () => {
  /** Axis-aligned bounds of a wall rectangle. */
  const box = (id: string) => {
    const pts = wallRect(id);
    return { minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])), minY: Math.min(...pts.map((p) => p[1])), maxY: Math.max(...pts.map((p) => p[1])), pts };
  };

  it.each([
    ['w-kitchen-column', 2.91, 3.71, 7.68, 8.28],
    ['w-ch1-column', 9.6, 10.05, 3.82, 4.42],
    ['w-sdb-column', 6.15, 6.39, 6.9, 7.66],
  ])('%s is a structural wall rectangle at x %f-%f, y %f-%f', (id, x0, x1, y0, y1) => {
    expect(wall(id).structural).toBe(true);
    const b = box(id);
    near(b.minX, x0);
    near(b.maxX, x1);
    near(b.minY, y0);
    near(b.maxY, y1);
  });

  it('the kitchen column fills the box between the sink and the bathroom niche wall; the dishwasher and the third wall unit are gone', () => {
    const b = box('w-kitchen-column');
    near(b.maxX - b.minX, 0.8);
    near(b.maxY - b.minY, 0.6);
    near(b.minX, rect('kitchen-sink-tri').maxX); // flush against the sink
    expect(scene.items.find((i) => i.id === 'kitchen-dishwasher-lv')).toBeUndefined();
    expect(scene.items.find((i) => i.id === 'kitchen-wall-est-3')).toBeUndefined();
    for (const id of ['kitchen-cooktop-cui', 'kitchen-sink-tri']) expect(penetration(rect(id).pts, b.pts), id).toBeLessThan(1e-3);
  });

  it('the Chambre 1 column is flush with the placard and with the outer east wall', () => {
    const b = box('w-ch1-column');
    near(b.minX, rect('placard-ch1').maxX); // fills the gap between the placard and the east wall
    near(b.maxX, wall('w-east').start[0] - wall('w-east').thickness / 2);
    near(b.maxY, 4.42); // flush with the south edge of the Chambre 1 polygon
    near(b.maxX - b.minX, 0.45);
    expect(penetration(rect('placard-ch1').pts, b.pts)).toBeLessThan(1e-3);
  });

  it('the SDB column stands against the east wall, about 2 cm from the LL washing machine', () => {
    const b = box('w-sdb-column');
    near(b.maxX, wall('w-sdb-east').start[0] - wall('w-sdb-east').thickness / 2); // against the inner face of w-sdb-east (6.39)
    const ll = rect('sdb-washing-machine-ll');
    near(b.maxY, 7.66);
    near(ll.minY - b.maxY, 0.02, 1e-6); // washing machine stays about 2 cm south of the column
    expect(penetration(ll.pts, b.pts)).toBeLessThan(1e-3);
    // and it leaves the TE recess walls alone
    for (const id of ['w-te-west', 'w-te-south']) expect(penetration(box(id).pts, b.pts), id).toBeLessThan(1e-3);
  });
});
