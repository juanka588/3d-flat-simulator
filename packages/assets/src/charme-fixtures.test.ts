import { describe, expect, it } from 'vitest';
import charme from '@flat/scene/fixtures/charme-3205.flat.json';
import { analyzeWalkways, billOfMaterials, buildShell, DEFAULT_LIGHTING, describeRoom, footprintOf, frontOf, GENERATORS, itemDims, layoutContext, openingZones, ownerAt, parseScene, penetration, pointInPolygon, validateLayout, wallLength } from '@flat/scene';
import { buildItems } from './meshes/build-items';
import type { Item, Scene, Vec2 } from '@flat/scene';
import './register';

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
  'kitchen-oven-column': { generator: 'ovenColumn', room: 'sejour' },
  'kitchen-larder-column': { generator: 'ovenColumn', room: 'sejour' },
  'kitchen-end-panel': { generator: 'kitchenBase', room: 'sejour' },
  'kitchen-wall-niche': { generator: 'kitchenWall', room: 'sejour' },
  'sdb-vanity-mirror': { generator: 'mirror', room: 'sdb' },
  'sdb-tiles-back': { generator: 'wallTiles', room: 'sdb' },
  'sdb-tiles-end-north': { generator: 'wallTiles', room: 'sdb' },
  'sdb-tiles-end-south': { generator: 'wallTiles', room: 'sdb' },
  'sejour-ceiling-lamp': { generator: 'pendant', room: 'sejour' },
  'heat-ch1-north': { generator: 'radiator', room: 'ch1' },
  'heat-alcove-north': { generator: 'radiator', room: 'alcove' },
  'heat-ch2-east': { generator: 'radiator', room: 'ch2' },
  'heat-sejour-east': { generator: 'radiator', room: 'sejour' },
  'heat-sdb-towel': { generator: 'radiator', room: 'sdb' },
  'heat-sdb-towel-2': { generator: 'radiator', room: 'sdb' },
  'sdb-towel-shelves': { generator: 'kitchenWall', room: 'sdb' },
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

  it('fills the niche between the séjour wall and the door jamb: back wall behind, east side wall, front on the hall face', () => {
    const r = rect('placard-ch2');
    const back = wall('w-placard-ch2-back');
    const east = wall('w-placard-ch2-east');
    const stub = wall('w-ch2-south-west');
    near(r.minY, back.start[1] + back.thickness / 2); // against the back wall's face
    // front flush with the hall face of the south wall: the closet fills the slot between the stub and w-sejour-entree
    near(r.maxY, wall('w-ch2-south').start[1] + wall('w-ch2-south').thickness / 2);
    near(wall('w-sejour-entree').start[1], r.maxY); // the séjour wall starts at the closet front
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
    const shell = buildShell(scene, { items: buildItems }).items;
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
  it('lines up along the south wall, east to west: fridge, sink, induction hob, black end panel, oven column, larder column, none overlapping', () => {
    const order = ['kitchen-sink-tri', 'kitchen-cooktop-cui', 'kitchen-end-panel', 'kitchen-oven-column', 'kitchen-larder-column'];
    const rs = order.map(rect);
    expect(rect('kitchen-fridge-f').minX).toBeGreaterThan(rs[0]!.maxX); // the fridge stands east of the run (left when facing the wall)
    for (let i = 0; i < rs.length - 1; i++) near(rs[i]!.minX, rs[i + 1]!.maxX); // each ends exactly where the next begins, no gap and no overlap
    near(rs[4]!.minX, 0); // the larder reaches the west wall (balcony side)
    for (const r of rs) near(r.maxY, 8.28);
    // 240 cm kit does not fit: the plan holds 291 cm between the west wall and the 80 cm column, columns take 104 cm
    expect(rs[0]!.maxX - rs[2]!.minX).toBeCloseTo(1.87, 9); // sink + hob + end panel: the run the plan can hold
    // the base run is a worktop at 0.9; the wall run (units + niche) sits above, ending at the same x as the end panel
    const wall1 = rect('kitchen-wall-niche');
    near(wall1.minX, rect('kitchen-end-panel').maxX);
    near(rect('kitchen-wall-est-1').minX, wall1.maxX);
    near(rect('kitchen-wall-est-2').maxX, rs[0]!.maxX);
    expect(item('kitchen-wall-niche').mesh).toMatchObject({ params: { niches: 4, finish: 'dark' } });
    near(item('kitchen-wall-niche').elevation + item('kitchen-wall-niche').dims!.h, 2.0);
    expect(item('kitchen-cooktop-cui').mesh).toMatchObject({ params: { style: 'induction' } });
    expect(item('kitchen-larder-column').mesh).toMatchObject({ params: { kind: 'larder' } });
    for (let a = 0; a < order.length; a++) for (let b = a + 1; b < order.length; b++) expect(penetration(rs[a]!.pts, rs[b]!.pts), `${order[a]} vs ${order[b]}`).toBeLessThan(1e-3);
    expect(penetration(rs[0]!.pts, wallRect('w-kitchen-column'))).toBeLessThan(1e-3);
  });

  it('is one run along the south wall: cooktop CUI, then the sink with the TRI unit up to the 80 cm column by the niche wall (user)', () => {
    const run = ['kitchen-cooktop-cui', 'kitchen-sink-tri'].map(rect);
    for (const r of run) {
      near(r.maxY, 8.28); // against the inner face of the south wall
      near(r.maxY - r.minY, 0.6);
    }
    near(run[0]!.maxX, run[1]!.minX);
    near(run[0]!.maxX - run[0]!.minX, 0.63);
    const column = wallRect('w-kitchen-column');
    near(run[1]!.maxX, Math.min(...column.map((p) => p[0]))); // the sink ends at the column (80 x 60 cm, user)
    expect(wall('w-kitchen-column').structural).toBe(true);
    near(run[1]!.maxX - run[1]!.minX, 1.22);
    for (const id of ['kitchen-cooktop-cui', 'kitchen-sink-tri']) expect(item(id).dims!.h).toBeGreaterThanOrEqual(0.9); // one continuous worktop level (the sink's dims also count its mixer tap)
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

  it('hangs two wall units over the sink so that the top of the kit is 2.00 m, above the worktop', () => {
    for (const id of ['kitchen-wall-est-1', 'kitchen-wall-est-2']) {
      const it = item(id);
      expect(it).toMatchObject({ mount: 'wall', elevation: 1.4 });
      expect(it.elevation).toBeGreaterThanOrEqual(0.9 + 0.5);
      near(it.elevation + it.dims!.h, 2.0); // kit height 200 cm, floor to the top of the wall units (user)
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

describe('radiators (chauffage), from the home video and the user\'s wall list', () => {
  /** Seen from inside the room, facing the wall: `left` is the direction of the left end of the wall run, `limit` the coordinate of that end on the axis of `left`. */
  const RADIATORS = [
    { id: 'heat-ch1-north', wall: 'w-north', room: 'ch1', kind: 'panel', front: [0, 1], left: [-1, 0], limit: 6.91, window: 'win-ch1' },
    { id: 'heat-alcove-north', wall: 'w-north', room: 'alcove', kind: 'panel', front: [0, 1], left: [-1, 0], limit: 0, window: 'win-alcove' },
    { id: 'heat-ch2-east', wall: 'w-ch2-ch1', room: 'ch2', kind: 'panel', front: [-1, 0], left: [0, -1], limit: 0, window: 'win-ch2' },
    { id: 'heat-sejour-east', wall: 'w-sejour-ch2', room: 'sejour', kind: 'panel', front: [-1, 0], left: [0, -1], limit: 2.27 },
  ] as const;

  it.each(RADIATORS)('$id is a locked wall-mounted $kind radiator on $wall, room side, 15 cm off the floor', (r) => {
    const it = item(r.id);
    expect(it).toMatchObject({ locked: true, mount: 'wall', roomId: r.room, mesh: { kind: 'parametric', generator: 'radiator', params: { kind: r.kind } } });
    expect(it.product).toBeUndefined();
    expect(it.elevation).toBeGreaterThanOrEqual(0.15);
    expect(it.elevation).toBeLessThanOrEqual(0.3);
    const f = frontOf(it.rotation);
    near(f[0], r.front[0]);
    near(f[1], r.front[1]);
    // the back touches the wall face on the room side
    const w = wall(r.wall);
    const len = wallLength(w);
    const dir: Vec2 = [(w.end[0] - w.start[0]) / len, (w.end[1] - w.start[1]) / len];
    const faceDist = Math.abs((it.position[0] - w.start[0]) * dir[1] - (it.position[1] - w.start[1]) * dir[0]) - itemDims(it).d / 2;
    near(faceDist, w.thickness / 2, 0.003);
    // within the left end of the wall run, as seen from the room
    const pts = rect(r.id).pts;
    // the extreme of the radiator along `left` is at most 0.2 m from the end of the run
    const extreme = Math.max(...pts.map((p) => p[0] * r.left[0] + p[1] * r.left[1]));
    const limit = r.limit * (r.left[0] + r.left[1]);
    expect(limit - extreme, r.id).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(limit - extreme, r.id).toBeGreaterThanOrEqual(-1e-9);
  });

  it('the SDB recess (east wall, between the TE partition and the column) holds two 1.2 m towel radiators facing each other and open shelves above', () => {
    const te = wall('w-te-south');
    const col = wallRect('w-sdb-column');
    const teFace = te.start[1] + te.thickness / 2; // south face of the TE partition
    const colFace = Math.min(...col.map((p) => p[1])); // north face of the column
    const east = wall('w-sdb-east').start[0] - wall('w-sdb-east').thickness / 2; // inner face of the east wall (6.39)
    near(colFace - teFace, 0.43, 1e-6); // measured width of the recess
    const a = rect('heat-sdb-towel');
    const b = rect('heat-sdb-towel-2');
    for (const [id, r] of [['heat-sdb-towel', a], ['heat-sdb-towel-2', b]] as const) {
      expect(item(id)).toMatchObject({ mount: 'wall', roomId: 'sdb', elevation: 0.3, dims: { h: 1.2 } });
      expect(r.maxX).toBeLessThanOrEqual(east + 1e-9);
    }
    near(a.minY, teFace, 1e-6); // back on the south face of the TE partition, facing south
    near(frontOf(item('heat-sdb-towel').rotation)[1], 1);
    near(b.maxY, colFace, 1e-6); // back on the north face of the column, facing north
    near(frontOf(item('heat-sdb-towel-2').rotation)[1], -1);
    expect(a.minX).toBeGreaterThanOrEqual(5.95 - 1e-9);
    expect(b.minX).toBeGreaterThanOrEqual(Math.min(...col.map((p) => p[0])) - 1e-9); // the column face is only 24 cm wide
    expect(b.maxY - b.minY).toBeCloseTo(0.08, 9);
    expect(b.minY - a.maxY).toBeGreaterThan(0.25); // a clear 27 cm between the two radiators
    // the shelves hang over the recess, above the radiators, on the east wall
    const sh = rect('sdb-towel-shelves');
    near(sh.maxX, east);
    expect(sh.minY).toBeGreaterThanOrEqual(teFace - 1e-9);
    expect(sh.maxY).toBeLessThanOrEqual(colFace + 1e-9);
    expect(item('sdb-towel-shelves').elevation).toBeGreaterThanOrEqual(0.3 + 1.2);
    expect(item('sdb-towel-shelves').mesh).toMatchObject({ params: { niches: 3, finish: 'white' } });
    expect(validateLayout(scene, { roomId: 'sdb' }).violations.filter((v) => v.entityIds.some((e) => e.startsWith('heat-sdb-towel') || e === 'sdb-towel-shelves'))).toEqual([]);
  });

  it('stands clear of every window next to it and of every door swing, and inside its room', () => {
    for (const r of RADIATORS) {
      const rep = validateLayout(scene, { roomId: r.room });
      expect(rep.violations.filter((v) => v.entityIds.includes(r.id)), r.id).toEqual([]);
    }
    const win = (id: string) => scene.openings.find((o) => o.id === id)!;
    for (const r of RADIATORS) {
      if (!('window' in r)) continue;
      const o = win(r.window);
      const w = wall(o.wallId);
      const len = wallLength(w);
      const dir: Vec2 = [(w.end[0] - w.start[0]) / len, (w.end[1] - w.start[1]) / len];
      const c: Vec2 = [w.start[0] + dir[0] * o.offset, w.start[1] + dir[1] * o.offset];
      const wx0 = c[0] - o.width / 2;
      const wx1 = c[0] + o.width / 2;
      const pts = rect(r.id).pts;
      const rx0 = Math.min(...pts.map((p) => p[0]));
      const rx1 = Math.max(...pts.map((p) => p[0]));
      if (r.wall === 'w-north') expect(rx1 <= wx0 + 1e-9 || rx0 >= wx1 - 1e-9, r.id).toBe(true);
      else expect(rx0).toBeGreaterThan(wx1 - 1e-9); // the ch2 window ends before the radiator wall
    }
  });

  it('the ch2 radiator is next to the window, the others sit in the left corner of their wall', () => {
    const o = scene.openings.find((x) => x.id === 'win-ch2')!;
    const w = wall(o.wallId);
    const winEast = w.start[0] + o.offset + o.width / 2;
    const r = rect('heat-ch2-east');
    expect(r.minX - winEast).toBeLessThan(0.3); // radiator back is just past the window's east jamb
    expect(r.minY).toBeLessThan(0.3);
  });

  it('keeps 15 cm free in front: furniture there is refused by validate_layout, a rug is not, and a shelf above is fine', () => {
    const base: Scene = JSON.parse(JSON.stringify(scene));
    const r = item('heat-ch1-north');
    const add = (extra: Partial<Item> & { id: string }): Scene => {
      const it: Item = { assetId: 'param:sideboard', position: [r.position[0], r.position[1] + 0.05 + 0.1 + 0.2], elevation: 0, rotation: 0, roomId: 'ch1', mount: 'floor', dims: { w: 0.8, d: 0.4, h: 0.5 }, mesh: { kind: 'parametric', generator: 'sideboard', params: { w: 0.8, d: 0.4, h: 0.5 } }, ...extra } as Item;
      return { ...base, items: [...base.items, it] };
    };
    // d 0.4 centred 0.35 off the wall face reaches 0.15 from the radiator front (wall face y = 0, radiator front at y = 0.1): inside the zone by 0.05
    const blocked = add({ id: 'sideboard-in-front', position: [r.position[0], 0.1 + 0.2 + 0.0 - 0.05] });
    expect(validateLayout(blocked, { roomId: 'ch1' }).violations.some((v) => v.entityIds.includes('heat-ch1-north') && v.entityIds.includes('sideboard-in-front'))).toBe(true);
    const clear = add({ id: 'sideboard-clear', position: [r.position[0], 0.1 + 0.15 + 0.2 + 0.01] });
    expect(validateLayout(clear, { roomId: 'ch1' }).violations.filter((v) => v.entityIds.includes('sideboard-clear'))).toEqual([]);
    const above = add({ id: 'shelf-above', mount: 'wall', elevation: 1.2, dims: { w: 0.8, d: 0.25, h: 0.3 }, position: [r.position[0], 0.125], mesh: { kind: 'parametric', generator: 'sideboard', params: { w: 0.8, d: 0.25, h: 0.3 } } });
    expect(validateLayout(above, { roomId: 'ch1' }).violations.filter((v) => v.entityIds.includes('shelf-above'))).toEqual([]);
  });

  it('radiators cost EUR 0 (existing furniture) and are not purchasable', () => {
    const bom = billOfMaterials(scene);
    for (const r of RADIATORS) expect(bom.lines.find((l) => l.itemId === r.id), r.id).toMatchObject({ locked: true, existing: true, amount: 0 });
  });
});
