import { buildContextMeshes, parseScene } from '@flat/scene';
import type { Scene, SiteContext } from '@flat/scene';
import { describe, expect, it } from 'vitest';
import charme from '@flat/scene/fixtures/charme-3205.flat.json';
import charmeContext from '@flat/scene/fixtures/charme-3205.context.json';
import { buildingFraming } from './building-framing';
import { canopyIds, contextGeometries, floorLineSegments, hostIds, storeyHeight, CONTEXT_PALETTE } from './derived-geometry';

const parsed = parseScene(charme);
if (!parsed.ok) throw new Error('fixture');
const scene: Scene = parsed.scene;
const context = charmeContext as unknown as SiteContext;

describe('buildingFraming', () => {
  it('turns the default orbit camera towards the facade nearest the flat and reaches below the floor', () => {
    const f = buildingFraming(scene, context)!;
    expect(f).not.toBeNull();
    expect(f.belowReach).toBeGreaterThan(2);
    expect(f.elevationDeg).toBeLessThan(60);
    // The building lies to the south and east of the flat: the camera comes from the north-west quadrant.
    expect(f.azimuthDeg).toBeGreaterThanOrEqual(270);
    expect(f.azimuthDeg).toBeLessThan(360);
  });

  it('keeps the plain framing without context, with a flat on the ground, or far from any facade', () => {
    expect(buildingFraming(scene, null)).toBeNull();
    expect(buildingFraming({ ...scene, site: { ...scene.site, floorElevation: 0 } }, context)).toBeNull();
    const far: SiteContext = { ...context, buildings: context.buildings.map((b) => ({ ...b, footprint: b.footprint.map(([x, y]): [number, number] => [x + 500, y]) })) };
    expect(buildingFraming(scene, far)).toBeNull();
  });
});

describe('host building geometry', () => {
  it('splits neighbours, the façade below the flat, the canopy and the ground; colours differ', () => {
    const g = contextGeometries(buildContextMeshes(context), canopyIds(context), hostIds(context));
    expect(g.buildings && g.facade && g.canopy && g.ground).toBeTruthy();
    const colours = new Set<string>(Object.values(CONTEXT_PALETTE));
    expect(colours.size).toBe(Object.keys(CONTEXT_PALETTE).length);
    // The façade is the "below" band only (its top is the storey slab, at or below the flat floor).
    const ys = (geometry: NonNullable<typeof g.facade>) => Array.from(geometry.getIndex()!.array, (v) => geometry.getAttribute('position').getY(v));
    expect(Math.max(...ys(g.facade!))).toBeLessThanOrEqual(0.1);
    expect(Math.min(...ys(g.canopy!))).toBeGreaterThanOrEqual(-0.1);
  });

  it('puts a floor line every storey so the flat floor sits on a line', () => {
    expect(storeyHeight(5.8)).toBeCloseTo(2.9);
    expect(storeyHeight(0)).toBe(3);
    const below = new Set([...hostIds(context)].filter((id) => !canopyIds(context).has(id)));
    const lines = floorLineSegments(context, below, storeyHeight(5.8));
    const ys = new Set<number>();
    for (let i = 1; i < lines.length; i += 3) ys.add(Math.round(lines[i]! * 100) / 100);
    expect([...ys]).toEqual([-2.9]); // -5.8 is the ground, 0 the floor of the flat
    expect(lines.length % 6).toBe(0);
  });
});
