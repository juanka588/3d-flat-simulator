import { pointInPolygon, type Scene } from '@flat/scene';
import { describe, expect, it } from 'vitest';
import { charmeScene } from '../testing/mockFlatApi';
import { bathFittings, doorwayPose, itemVisibility, layoutIntent, roomPlan, roomViews, roomZones } from './views';

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
    expect(l.promptText).toMatch(/sofa faces the TV wall/);
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
    expect(m.checks).toMatchObject({ ok: true, seen: ['wc-toilet'] });
    expect(m.checks!.share).toBeGreaterThanOrEqual(0.75);
    const toilet = scene.items.find((i) => i.id === 'wc-toilet')!;
    expect(itemVisibility(scene, m.pose, toilet)).toBeGreaterThanOrEqual(0.75);
    // at the door or outside it, not inside the 1.28 m room staring at a corner
    expect(m.pose.position[0]).toBeLessThan(room('wc').polygon[0]![0]);
  });

  it('a camera that stares into a wall corner does not see the toilet; the doorway one does', () => {
    const toilet = bathFittings(scene, room('wc'));
    expect(toilet.map((i) => i.id)).toEqual(['wc-toilet']);
    const corner = { mode: 'walk' as const, position: [9.17, 5.69] as [number, number], eyeHeight: 1.55, headingDeg: 29, pitchDeg: 0, fovDeg: 70 };
    expect(itemVisibility(scene, corner, toilet[0]!)).toBeLessThan(0.5);
    expect(doorwayPose(scene, 'wc', toilet)?.checks.ok).toBe(true);
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
