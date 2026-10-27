import { describe, expect, it } from 'vitest';
import charme from '../../fixtures/charme-3205.flat.json';
import { parseScene } from '../parse';
import type { GridLight, Scene } from '../schema';
import { gridClusters, gridFixtures } from './grid';
import {
  LAMP_BOUNCE_ALBEDO,
  DEFAULT_LAMP_LUMENS,
  fitGridToRoom,
  lampBounceLux,
  lampEmitterFor,
  lampKindOf,
  largestInscribedRect,
  lightLumens,
  roomBounceLux,
  roomLightingPlan,
  roomSurfaceArea,
} from './lamps';

const parsed = parseScene(charme);
if (!parsed.ok) throw new Error('fixture');
const scene: Scene = parsed.scene;

const grid = (over: Partial<GridLight> = {}): GridLight => ({
  id: 'g',
  type: 'grid',
  position: [5, 4],
  elevation: 2.4,
  rows: 3,
  cols: 4,
  width: 4,
  depth: 3,
  rotation: 0,
  lumensEach: 450,
  angle: 100,
  kelvin: 2700,
  on: true,
  ...over,
});

describe('grid photometry', () => {
  it('total flux is rows x cols x lumensEach, and every cluster split keeps it exact', () => {
    const g = grid();
    expect(lightLumens(g)).toBe(5400);
    for (const budget of [1, 2, 3, 4, 6, 12, 50]) {
      const tiles = gridClusters(g, budget);
      expect(tiles.length).toBeLessThanOrEqual(Math.max(1, Math.min(budget, 12)));
      expect(tiles.reduce((s, t) => s + t.count, 0)).toBe(12);
      expect(tiles.reduce((s, t) => s + t.count * g.lumensEach, 0)).toBe(5400);
    }
  });

  it('fixtures are cell centres; their centroid is the grid centre, also when rotated', () => {
    for (const rotation of [0, 30, 90]) {
      const g = grid({ rotation });
      const f = gridFixtures(g);
      expect(f).toHaveLength(12);
      const cx = f.reduce((s, p) => s + p[0], 0) / 12;
      const cy = f.reduce((s, p) => s + p[1], 0) / 12;
      expect(cx).toBeCloseTo(5, 9);
      expect(cy).toBeCloseTo(4, 9);
    }
    const flat = gridFixtures(grid());
    expect(flat[0]).toEqual([3.5, 3]); // half a pitch (0.5, 0.5) inside the 4 x 3 area
  });

  it('a single tile sits at the centre; as many tiles as fixtures reproduce the fixtures', () => {
    expect(gridClusters(grid(), 1)).toEqual([{ position: [5, 4], count: 12 }]);
    const all = gridClusters(grid(), 12);
    expect(all.map((t) => t.position)).toEqual(gridFixtures(grid()));
  });
});

describe('lamp bounce', () => {
  it('follows rho x flux / (area x (1 - rho)) and is bounded by the lamp flux per surface area', () => {
    const wc = scene.rooms.find((r) => r.id === 'wc')!;
    const area = roomSurfaceArea(scene, wc);
    const e = lampBounceLux(400, area);
    expect(e).toBeCloseTo((LAMP_BOUNCE_ALBEDO * 400) / (area * (1 - LAMP_BOUNCE_ALBEDO)), 9);
    // energy: the bounce flux on the room's surfaces never exceeds rho/(1-rho) times the lamp flux
    expect(e * area).toBeLessThanOrEqual(400 * (LAMP_BOUNCE_ALBEDO / (1 - LAMP_BOUNCE_ALBEDO)) + 1e-9);
    expect(lampBounceLux(0, area)).toBe(0);
    expect(lampBounceLux(400, 0)).toBe(0);
    expect(lampBounceLux(800, area)).toBeCloseTo(2 * e, 9);
    expect(lampBounceLux(400, area, 0.9)).toBeLessThan(lampBounceLux(400, area, 0.99)); // clamped, finite
    expect(Number.isFinite(lampBounceLux(400, area, 5))).toBe(true);
  });

  it('is local to the room of the lamp and follows on/off', () => {
    const src = (roomId: string, on: boolean) => ({ roomId, position: [0, 0] as [number, number], lumens: 500, on });
    const wcOnly = roomBounceLux(scene, [src('wc', true), src('sdb', false)]);
    expect(Object.keys(wcOnly)).toEqual(['wc']);
    const both = roomBounceLux(scene, [src('wc', true), src('sdb', true)]);
    expect(Object.keys(both).sort()).toEqual(['sdb', 'wc']);
    expect(both.wc).toBe(wcOnly.wc); // a lamp next door changes nothing here
    expect(roomBounceLux(scene, [src('wc', false)])).toEqual({});
    // a lamp with no roomId counts for the room that contains it
    const wc = scene.rooms.find((r) => r.id === 'wc')!;
    const inside = roomBounceLux(scene, [{ position: [wc.polygon[0]![0] + 0.05, wc.polygon[0]![1] + 0.05], lumens: 500, on: true }]);
    expect(Object.keys(inside)).toEqual(['wc']);
  });

  it('the retuned WC and bathroom lamps have believable lumens', () => {
    const wc = scene.lights.find((l) => l.id === 'l-wc')!;
    const sdb = scene.lights.find((l) => l.id === 'l-sdb')!;
    expect(lightLumens(wc)).toBeGreaterThanOrEqual(350);
    expect(lightLumens(wc)).toBeLessThanOrEqual(450);
    expect(lightLumens(sdb)).toBeGreaterThanOrEqual(800);
    expect(lightLumens(sdb)).toBeLessThanOrEqual(1000);
    expect(wc.type === 'spot' ? wc.angle : 180).toBeGreaterThanOrEqual(140); // no hard cone
    expect(sdb.type === 'spot' ? sdb.angle : 180).toBeGreaterThanOrEqual(140);
  });
});

describe('fit and plan', () => {
  it('largestInscribedRect is exact for a rectangle and stays inside an L', () => {
    expect(largestInscribedRect([[0, 0], [4, 0], [4, 3], [0, 3]])).toEqual([0, 0, 4, 3]);
    const L: [number, number][] = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]];
    const r = largestInscribedRect(L)!;
    expect((r[2] - r[0]) * (r[3] - r[1])).toBeCloseTo(4, 9);
  });

  it('fitGridToRoom covers the sejour below the ceiling', () => {
    const room = scene.rooms.find((r) => r.id === 'sejour')!;
    const fit = fitGridToRoom(scene, room)!;
    expect(fit.width).toBeGreaterThan(2);
    expect(fit.elevation).toBeLessThan(2.5);
  });

  it('lighting plan: targets by room type, lux estimate, a suggested grid that reaches the target', () => {
    const living = scene.rooms.find((r) => r.id === 'sejour')!;
    const plan = roomLightingPlan(scene, living, [{ lumens: 1600, on: true }, { lumens: 2500, on: false }]);
    expect(plan.targetLux).toEqual({ min: 100, max: 150 });
    expect(plan.installedLumens).toBe(4100);
    expect(plan.litLumens).toBe(1600);
    expect(plan.estimatedLux).toBe(Math.round((1600 * 0.5) / plan.areaM2));
    expect(plan.suggestedGrid).not.toBeNull();
    const g = plan.suggestedGrid!;
    const lux = (g.rows * g.cols * g.lumensEach * 0.5) / plan.areaM2;
    expect(lux).toBeGreaterThan(plan.targetLux.min * 0.9);
    expect(lux).toBeLessThan(plan.targetLux.max * 1.1);
    expect(roomLightingPlan(scene, living, []).status).toBe('dark');
    const kitchenish = { ...living, type: 'kitchen' as const };
    expect(roomLightingPlan(scene, kitchenish, []).targetLux.max).toBe(300);
    expect(roomLightingPlan(scene, { ...living, type: 'bathroom' as const }, []).targetLux.min).toBeLessThanOrEqual(200);
  });
});

describe('lamp items', () => {
  const base = { assetId: 'param:lamp' };
  const product = (name: string, h: number, extra = {}) => ({
    provider: 'mock',
    sku: 'x',
    name,
    url: 'https://example.com/x',
    price: 1,
    currency: 'EUR',
    dims: { w: 0.3, d: 0.3, h },
    category: 'lamp' as const,
    snapshotAt: '2026-10-27T10:00:00.000Z',
    ...extra,
  });
  it('classifies by mount, name and height, and defaults the lumens per kind', () => {
    expect(lampKindOf({ ...base, product: product('Lampadaire', 1.5) })).toBe('floor');
    expect(lampKindOf({ ...base, product: product('Lampe de table', 0.4) })).toBe('table');
    expect(lampKindOf({ ...base, product: product('Suspension', 0.5) })).toBe('pendant');
    expect(lampKindOf({ ...base, product: product('Applique murale', 0.2), mount: 'wall' })).toBe('wall');
    expect(lampKindOf({ ...base, product: product('Plafonnier', 0.1), mount: 'ceiling' })).toBe('ceiling');
    expect(lampKindOf({ assetId: 'param:sofa', product: { ...product('Sofa', 0.9), category: 'sofa' } })).toBeUndefined();
    expect(DEFAULT_LAMP_LUMENS).toMatchObject({ floor: 800, table: 400, pendant: 1000, wall: 400 });
  });
  it('uses the product lumens (source product) before the estimate', () => {
    expect(lampEmitterFor({ ...base, product: product('Lampadaire', 1.5, { lumens: 1055 }) })).toMatchObject({ lumens: 1055, lumensSource: 'product', kelvin: 2700 });
    expect(lampEmitterFor({ ...base, product: product('Lampadaire', 1.5) })).toMatchObject({ lumens: 800, lumensSource: 'estimated' });
  });
});
