import { openingFrame, pointInPolygon, type Scene } from '@flat/scene';
import { describe, expect, it } from 'vitest';
import { charmeScene } from '../testing/mockFlatApi';
import { bathFittings, doorwayPose, itemVisibility, layoutIntent, mediaWalls, roomEdges, roomPlan, roomViews, roomZones } from './views';

/** Views, zones and layout intent derived from the geometry of the Charme fixture (séjour / cuisine, sdb, chambres). */

const scene = charmeScene();

describe('zones', () => {
  it('the séjour has a living zone and a kitchen zone with its locked fittings', () => {
    const zones = roomZones(scene, 'sejour');
    expect(zones.map((z) => [z.id, z.kind])).toEqual([
      ['living', 'main'],
      ['kitchen', 'kitchen'],
    ]);
    expect(zones[1]!.fittings).toEqual(expect.arrayContaining(['kitchen-cooktop-cui', 'kitchen-sink-tri', 'kitchen-fridge-f']));
    expect(zones[0]!.areaM2).toBeGreaterThan(zones[1]!.areaM2);
  });

  it('a room without floor zones has one main zone', () => {
    expect(roomZones(scene, 'ch1').map((z) => z.id)).toEqual(['main']);
  });
});

describe('views', () => {
  it('séjour living: media wall, balcony doors, wide diagonal; kitchen: front and side', () => {
    const v = roomViews(scene, 'sejour');
    expect(v.map((x) => `${x.zone}/${x.id}`)).toEqual(['living/media', 'living/windows', 'living/wide', 'kitchen/kitchen', 'kitchen/kitchen-side']);
    const byId = Object.fromEntries(v.map((x) => [x.id, x]));
    // the media view looks at the TV (north wall, towards plan-up), the windows view at the balcony doors (west wall)
    expect(byId['media']!.faces).toContain('tv-sejour');
    expect(byId['media']!.pose.headingDeg).toBeCloseTo(0, 0);
    expect(byId['windows']!.faces).toContain('door-balcony-sejour');
    expect(byId['windows']!.pose.headingDeg).toBeCloseTo(270, 0);
    // the diagonal sees both walls: its heading is between them
    expect(byId['wide']!.pose.headingDeg).toBeGreaterThan(270);
    expect(byId['wide']!.pose.headingDeg).toBeLessThan(360);
    expect(byId['wide']!.pose.fovDeg).toBeGreaterThan(70);
    // the kitchen views look at the fittings (south)
    expect(byId['kitchen']!.faces).toContain('kitchen-cooktop-cui');
    expect(byId['kitchen']!.pose.headingDeg).toBeCloseTo(180, 0);
    expect(byId['kitchen']!.sees).toEqual(['kitchen']);
    // the camera views differ from each other (that was the point)
    const headings = new Set(v.map((x) => Math.round(x.pose.headingDeg / 5)));
    expect(headings.size).toBeGreaterThanOrEqual(4);
  });

  it('weights add up to 1 per zone and the first view of a zone is its hero', () => {
    const v = roomViews(scene, 'sejour');
    for (const zone of ['living', 'kitchen']) {
      const mine = v.filter((x) => x.zone === zone);
      expect(mine.reduce((a, x) => a + x.weight, 0)).toBeCloseTo(1, 1);
      expect(mine.map((x) => x.hero)).toEqual(mine.map((_, i) => i === 0));
    }
  });

  it('every eye stands inside the room, off the walls (doorway views of fitted bathrooms stand at the door, checked)', () => {
    for (const room of scene.rooms) {
      if (room.type === 'balcony') continue;
      for (const view of roomViews(scene, room.id)) {
        if (view.checks?.ok && /doorway|main/.test(view.id) && room.type === 'bathroom') continue;
        expect(pointInPolygon(view.pose.position, room.polygon, 1e-6), `${room.id}/${view.id}`).toBe(true);
        expect(Number.isFinite(view.pose.headingDeg)).toBe(true);
      }
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(roomViews(scene, 'sejour'))).toBe(JSON.stringify(roomViews(scene, 'sejour')));
  });

  it('can be limited to a zone and to a number of views; an unknown zone is an error', () => {
    expect(roomViews(scene, 'sejour', { zone: 'kitchen' }).map((x) => x.id)).toEqual(['kitchen', 'kitchen-side']);
    expect(roomViews(scene, 'sejour', { zone: 'living', perZone: 1 }).map((x) => x.id)).toEqual(['media']);
    expect(roomViews(scene, 'sejour', { zone: 'cuisine' }).every((x) => x.zone === 'kitchen')).toBe(true);
    expect(() => roomViews(scene, 'sejour', { zone: 'garden' })).toThrow(/no zone "garden"/);
  });

  it('small and plain rooms get one or two views', () => {
    expect(roomViews(scene, 'sdb').length).toBeGreaterThanOrEqual(1);
    expect(roomViews(scene, 'sdb').length).toBeLessThanOrEqual(2);
    expect(roomViews(scene, 'entree').length).toBeGreaterThanOrEqual(1);
    expect(roomViews(scene, 'ch1').map((x) => x.id)).toEqual(['windows', 'reverse']);
  });

  it('a hint in the scene replaces a derived view with the same id and can add one', () => {
    const rooms = scene.rooms.map((r) => (r.id === 'sejour' ? { ...r, views: [{ id: 'media', facing: 'W', weight: 0.5 }, { id: 'corner', zone: 'living', point: [0.3, 2.6] as [number, number], standoff: 4, label: 'TV corner' }] } : r));
    const hinted: Scene = { ...scene, rooms };
    const v = roomViews(hinted, 'sejour', { zone: 'living', perZone: 3 });
    expect(Math.abs(v.find((x) => x.id === 'media')!.pose.headingDeg - 270)).toBeLessThan(8);
    expect(v.find((x) => x.id === 'corner')!.label).toBe('TV corner');
    expect(v.map((x) => x.id)).toContain('windows');
    expect(roomViews(hinted, 'sejour', { zone: 'living', perZone: 3 }).reduce((a, x) => a + x.weight, 0)).toBeCloseTo(1, 1);
  });
});

describe('media wall (the TV is not a fixed fitting)', () => {
  const withTv = (position: [number, number], rotation = 0): Scene => ({ ...scene, items: scene.items.map((i) => (i.id === 'tv-sejour' ? { ...i, position, rotation } : i)) });
  const room = scene.rooms.find((r) => r.id === 'sejour')!;

  it('candidates are plain stretches of at least 2 m with floor in front, never the kitchen or the balcony glazing', () => {
    const c = mediaWalls(scene, room, roomEdges(scene, room), roomZones(scene, 'sejour'));
    // the alcove wall has a door at its west end: its plain stretch east of the door qualifies; the west wall (balcony doors) and the kitchen wall do not
    expect(c.map((w) => w.wallId)).toEqual(['w-alcove']);
    expect(c[0]).toMatchObject({ hasTv: true });
    expect(c[0]!.from[1]).toBe(1);
    expect(c[0]!.length).toBeGreaterThanOrEqual(2);
    expect(c[0]!.depth).toBeGreaterThan(2.8);
  });

  it('the TV where it is keeps the media wall; the intent says nothing about moving it', () => {
    const l = layoutIntent(scene, 'sejour', 'living');
    expect(l.text).not.toMatch(/NOT a fixed fitting/);
    expect(l.place.map((p) => p.role)).not.toContain('tv');
  });

  it('a TV moved onto a wall that is no candidate: the intent proposes the best wall and how to move the TV there, the sofa faces that wall', () => {
    const moved = withTv([1.5, 8.2], 0); // on the kitchen side wall
    const l = layoutIntent(moved, 'sejour', 'living');
    const tv = l.place.find((p) => p.role === 'tv')!;
    expect(tv.relation).toMatchObject({ kind: 'at', rotation: 0 });
    expect((tv.relation['position'] as [number, number])[1]).toBeCloseTo(2.275, 1);
    expect(tv.note).toMatch(/move tv-sejour here \(item_move, item_rotate 0\)/);
    expect(l.text).toMatch(/Media wall: w-alcove .* tv-sejour is not on it and is NOT a fixed fitting: move it there/);
    const sofa = l.place.find((p) => p.role === 'sofa')!;
    expect(sofa.relation['rotation']).toBe(180);
    expect(l.promptText).not.toMatch(/TV wall/);
  });

  it('the views follow the TV wherever it is now', () => {
    const before = roomViews(scene, 'sejour').find((v) => v.id === 'media')!;
    expect(before.faces).toContain('tv-sejour on w-alcove');
    const moved = roomViews(withTv([1.5, 8.2], 0), 'sejour').find((v) => v.id === 'media')!;
    expect(moved.faces).toContain('tv-sejour on w-south');
    expect(moved.pose.headingDeg).not.toBeCloseTo(before.pose.headingDeg, 0);
    expect(moved.promptHint).not.toMatch(/TV wall/);
  });

  it('without a TV the best candidate wall is the focus, and the intent names it', () => {
    const none: Scene = { ...scene, items: scene.items.filter((i) => i.id !== 'tv-sejour') };
    const l = layoutIntent(none, 'sejour', 'living');
    expect(l.place.find((p) => p.role === 'sofa')).toBeDefined();
    expect(l.text).toMatch(/Media wall: w-alcove/);
    expect(l.place.find((p) => p.role === 'tv')!.note).toMatch(/a TV \(or a framed panel\)/);
  });
});

describe('layout intent', () => {
  it('the living zone puts the sofa facing the TV, off the circulation path, away from the kitchen', () => {
    const l = layoutIntent(scene, 'sejour', 'living');
    const sofa = l.place.find((p) => p.role === 'sofa')!;
    expect(sofa.relation['kind']).toBe('at');
    const pos = sofa.relation['position'] as [number, number];
    const tv = scene.items.find((i) => i.id === 'tv-sejour')!;
    // in front of the TV (south of it), centred on it, facing it (rotation 180 = looking towards plan-up)
    expect(pos[1]).toBeGreaterThan(tv.position[1] + 1.8);
    expect(Math.abs(pos[0] - tv.position[0])).toBeLessThan(1.1);
    expect(sofa.relation['rotation']).toBe(180);
    const kitchen = roomZones(scene, 'sejour').find((z) => z.id === 'kitchen')!;
    expect(pointInPolygon(pos, kitchen.polygon, 0)).toBe(false);
    expect(l.text).toMatch(/faces tv-sejour|facing it/);
    expect(l.text).toMatch(/at least 0\.9 m wide/);
    expect(l.circulation.length).toBeGreaterThan(0);
    expect(l.promptText).toMatch(/sofa faces the media wall/);
    expect(l.text).toMatch(/Media wall: w-alcove .*where tv-sejour already is/);
    expect(l.place.some((p) => p.role === 'tv')).toBe(false);
    expect(l.fixes).toEqual(expect.arrayContaining(['sofa', 'rug']));
  });

  it('the kitchen zone keeps its fittings; a bedroom puts the bed on the longest plain wall', () => {
    const k = layoutIntent(scene, 'sejour', 'kitchen');
    expect(k.text).toMatch(/Do not move the fittings/);
    expect(k.place).toEqual([]);
    const b = layoutIntent(scene, 'ch1');
    expect(b.place[0]).toMatchObject({ role: 'bed', relation: { kind: 'against_wall' } });
  });

  it('describe_room data: zones, views and a layout per zone', () => {
    const plan = roomPlan(scene, 'sejour');
    expect(plan.zones.map((z) => z.id)).toEqual(['living', 'kitchen']);
    expect(plan.views).toHaveLength(5);
    expect(plan.layout.map((l) => l.zone)).toEqual(['living', 'kitchen']);
    expect(JSON.stringify(plan).length / 4).toBeLessThan(2200);
  });
});

describe('views of small rooms are checked for what they see', () => {
  const room = (id: string) => scene.rooms.find((r) => r.id === id)!;

  it('the WC (1.28 x 1.54 m) gets one wide camera at its door that sees the toilet, outside the room and clear of the walls', () => {
    const v = roomViews(scene, 'wc');
    expect(v.map((x) => x.id)).toEqual(['main']);
    const m = v[0]!;
    expect(m.pose.fovDeg).toBeGreaterThanOrEqual(90);
    expect(m.pose.fovDeg).toBeLessThanOrEqual(100);
    expect(m.checks).toMatchObject({ ok: true });
    expect(m.checks!.seen).toContain('wc-toilet');
    expect(m.checks!.share).toBeGreaterThanOrEqual(0.75);
    const toilet = scene.items.find((i) => i.id === 'wc-toilet')!;
    expect(itemVisibility(scene, m.pose, toilet)).toBeGreaterThanOrEqual(0.75);
    // at the door or outside it, not inside the 1.28 m room staring at a corner
    expect(m.pose.position[0]).toBeLessThan(room('wc').polygon[0]![0]);
  });

  it('a camera that stares into a wall corner does not see the toilet; the doorway one does', () => {
    const toilet = bathFittings(scene, room('wc'));
    expect(toilet.map((i) => i.id)).toEqual(['wc-toilet', 'wc-handbasin']);
    const corner = { mode: 'walk' as const, position: [9.17, 5.69] as [number, number], eyeHeight: 1.55, headingDeg: 29, pitchDeg: 0, fovDeg: 70 };
    expect(itemVisibility(scene, corner, toilet[0]!)).toBeLessThan(0.5);
    expect(doorwayPose(scene, 'wc', toilet)?.checks.ok).toBe(true);
  });

  it('the WC view needs ALL locked fittings in the picture: the basin sits right of the toilet, in view, not behind the door jamb', () => {
    const m = roomViews(scene, 'wc')[0]!;
    expect(m.checks).toMatchObject({ ok: true, seen: ['wc-toilet', 'wc-handbasin'] });
    expect(m.checks!.missing).toBeUndefined();
    const toilet = scene.items.find((i) => i.id === 'wc-toilet')!;
    const basin = scene.items.find((i) => i.id === 'wc-handbasin')!;
    expect(itemVisibility(scene, m.pose, basin)).toBeGreaterThanOrEqual(0.75);
    // bearing of each from the camera, clockwise from the heading: the basin is to the right of the toilet
    const bearing = (p: [number, number]) => {
      const a = (Math.atan2(p[0] - m.pose.position[0], -(p[1] - m.pose.position[1])) * 180) / Math.PI;
      return ((a - m.pose.headingDeg + 540) % 360) - 180;
    };
    expect(bearing(basin.position as [number, number])).toBeGreaterThan(bearing(toilet.position as [number, number]) + 5);
  });

  it('a fitting no doorway camera can show makes the check fail and names it', () => {
    // the bathtub of the sdb is never in a picture of the WC: the camera shows the WC fittings, the check names what it misses
    const fittings = [...bathFittings(scene, room('wc')), scene.items.find((i) => i.id === 'sdb-bathtub')!];
    const d = doorwayPose(scene, 'wc', fittings);
    expect(d?.checks.ok).toBe(false);
    expect(d?.checks.missing).toEqual(['sdb-bathtub']);
    expect(d?.checks.seen).toEqual(['wc-toilet', 'wc-handbasin']);
  });

  it('every sdb view sees the bath and says so; no duplicate ids', () => {
    const v = roomViews(scene, 'sdb');
    expect(v.length).toBeGreaterThanOrEqual(1);
    for (const x of v) {
      expect(x.checks?.ok).toBe(true);
      expect(x.checks!.seen).toContain('sdb-bathtub');
    }
    expect(new Set(v.map((x) => x.id)).size).toBe(v.length);
  });

  it('kitchen views carry a check; describe_room exposes it; bedrooms are untouched', () => {
    for (const x of roomViews(scene, 'sejour', { zone: 'kitchen' })) expect(x.checks).toMatchObject({ ok: true });
    expect(roomPlan(scene, 'wc').views[0]).toMatchObject({ id: 'main', checks: { ok: true } });
    expect(roomViews(scene, 'ch1').every((x) => x.checks === undefined)).toBe(true);
  });
});

describe('the alcove is an office: gaming desk and cat wall', () => {
  const alcove = scene.rooms.find((r) => r.id === 'alcove')!;

  it('the room is an office with one zone and three views: desk wall, cat wall, wide corner', () => {
    expect(alcove.type).toBe('office');
    expect(roomZones(scene, 'alcove').map((z) => z.id)).toEqual(['main']);
    const v = roomViews(scene, 'alcove');
    expect(v.map((x) => x.id)).toEqual(['desk', 'cats', 'wide']);
    expect(v.reduce((a, x) => a + x.weight, 0)).toBeCloseTo(1, 1);
    for (const x of v) expect(pointInPolygon(x.pose.position, alcove.polygon, 1e-6), x.id).toBe(true);
    // the desk view looks at the north wall, the window is at its side
    expect(v[0]!.pose.headingDeg).toBeCloseTo(0, 0);
    expect(v[0]!.faces).toContain('win-alcove');
  });

  it('the layout puts the desk beside the window (screens not facing it), clear of the radiator and the door, with room behind the chair', () => {
    const l = layoutIntent(scene, 'alcove');
    const desk = l.place.find((p) => p.role === 'gaming desk')!;
    const pos = desk.relation['position'] as [number, number];
    // flat to the window wall, beside the window (x 1.14 - 2.14), not under it nor over the radiator (x 0.15 - 0.95)
    expect(pos[1]).toBeCloseTo(0.4, 1);
    expect(pos[0] - 0.8).toBeGreaterThan(2.14);
    expect(desk.relation['rotation']).toBe(0);
    const chair = l.place.find((p) => p.role === 'gaming chair')!;
    expect((chair.relation['position'] as [number, number])[1]).toBeGreaterThan(0.8);
    expect(chair.relation['rotation']).toBe(180);
    // the cat wall is not on the window wall (rotation 0 would face the room from the north wall)
    const cats = l.place.find((p) => p.role === 'cat climbing wall')!;
    expect(cats.relation['rotation']).not.toBe(0);
    expect(l.text).toMatch(/never turn the screens towards a window/);
    expect(l.text).toMatch(/power strip/);
  });

  it('with a desk and a cat wall in place the views say whether they see them', () => {
    const items = [
      { id: 'desk-x', assetId: 'param:desk', position: [3.25, 0.4], rotation: 0, elevation: 0, mount: 'floor', roomId: 'alcove', dims: { w: 1.6, d: 0.8, h: 0.75 } },
      { id: 'cat-x', assetId: 'param:catWall', position: [3.92, 1.5], rotation: 270, elevation: 0.2, mount: 'wall', roomId: 'alcove', dims: { w: 1.2, d: 0.3, h: 1.8 }, mesh: { kind: 'parametric', generator: 'catWall', params: { w: 1.2, d: 0.3, h: 1.8 } } },
    ];
    const furnished = { ...scene, items: [...scene.items, ...items] } as unknown as Scene;
    const byId = Object.fromEntries(roomViews(furnished, 'alcove').map((x) => [x.id, x]));
    expect(byId['desk']!.checks).toMatchObject({ ok: true, seen: ['desk-x'] });
    expect(byId['cats']!.checks).toMatchObject({ ok: true, seen: ['cat-x'] });
    expect(byId['wide']!.checks).toBeUndefined();
  });
});

describe('balcony, entrance hall and the small bedroom (run 3 targets)', () => {
  const at = (p: { relation: Record<string, unknown> }) => p.relation['position'] as [number, number];

  it('the alcove layout text has no empty number', () => {
    expect(layoutIntent(scene, 'alcove').text).not.toMatch(/with {2}m/);
    expect(layoutIntent(scene, 'alcove').place.map((p) => p.note ?? '').join(' ')).not.toMatch(/ {2}m of floor/);
  });

  it('the balcony gets a bistro set along the rail in a stretch clear of the door landings, planters and outdoor lights', () => {
    const l = layoutIntent(scene, 'balcon');
    const table = l.place.find((p) => p.role === 'bistro table')!;
    const chairs = l.place.filter((p) => p.role === 'bistro chair');
    expect(chairs).toHaveLength(2);
    const [tx, ty] = at(table);
    // along the rail (x -1.55), not in front of the french doors (y 2.85-4.25 and 6.27-7.17, landing 0.9 m deep from x -0.2)
    expect(tx).toBeLessThan(-0.8);
    for (const c of chairs) {
      const [cx, cy] = at(c);
      expect(Math.abs(cx - tx)).toBeLessThan(0.2);
      for (const [a, b] of [[2.75, 4.35], [6.17, 7.27]] as [number, number][]) expect(cy > a && cy < b).toBe(false);
    }
    expect(ty).toBeGreaterThan(0.5);
    expect(l.place.map((p) => p.role)).toEqual(expect.arrayContaining(['planters', 'outdoor light']));
    expect(l.text).toMatch(/stays clear/);
    expect(l.promptText).toMatch(/outdoor balcony/);
    // no circulation from a door to itself
    expect(l.circulation).toEqual([]);
  });

  it('the entrance hall looks at the front door and back, keeps a 0.9 m walkway and the front of the placard, and places slim pieces only on free wall', () => {
    const v = roomViews(scene, 'entree');
    expect(v.map((x) => x.id)).toEqual(['focus', 'reverse']);
    expect(v[0]!.faces).toContain('door-entry');
    const l = layoutIntent(scene, 'entree');
    expect(l.text).toMatch(/placard-ch2/);
    expect(l.text).toMatch(/at least 0\.9 m wide/);
    const roles = l.place.map((p) => p.role);
    expect(roles).toEqual(expect.arrayContaining(['console', 'mirror', 'coat hooks']));
    // nothing stands in a door: the console is not within 0.6 m of any door centre
    const console_ = l.place.find((p) => p.role === 'console')!;
    const [cx, cy] = at(console_);
    for (const o of scene.openings.filter((x) => x.type === 'door')) {
      const f = openingFrame(scene, o)!;
      expect(Math.hypot(f.centre[0] - cx, f.centre[1] - cy), o.id).toBeGreaterThan(0.6);
    }
    expect(l.promptText).toMatch(/entrance hall/);
  });

  it('chambre 2 stays flexible: a desk under the window besides the bed on the long plain wall', () => {
    const l = layoutIntent(scene, 'ch2');
    expect(l.place.find((p) => p.role === 'bed')!.relation).toMatchObject({ kind: 'against_wall', wallId: 'w-ch2-ch1' });
    expect(l.place.find((p) => p.role === 'desk')!.relation).toEqual({ kind: 'under_window', openingId: 'win-ch2' });
    expect(l.text).toMatch(/guest, child, study/);
    expect(l.promptText).toMatch(/desk with a chair under the window/);
    // a bigger bedroom keeps just the bed
    expect(layoutIntent(scene, 'ch1').place.some((p) => p.role === 'desk')).toBe(false);
  });
});
