import { describe, expect, it } from 'vitest';
import { buildFittings } from '../geometry/fittings';
import type { Opening, Scene, Vec2 } from '../schema';
import { insideConvex } from './footprint';
import { doorSwingPolygon, openingFrame } from './swing';

/**
 * The swing zone must be the area the leaf that `buildFittings` draws actually sweeps, for every combination of hinge
 * side, swing side and wall angle: the 3D door and the rule that keeps furniture out of its way must agree.
 */

type Variant = 'exact' | 'mirrored-swing' | 'mirrored-hinge';

function leafPoints(scene: Scene): Vec2[] {
  const { fittings } = buildFittings(scene);
  const pts: Vec2[] = [];
  for (const g of fittings.groups) {
    if (g.materialId !== 'builtin:door') continue;
    for (let i = g.start; i < g.start + g.count; i++) {
      const v = fittings.indices[i]!;
      pts.push([fittings.positions[3 * v]!, fittings.positions[3 * v + 2]!]);
    }
  }
  return pts;
}

/** Does every leaf vertex lie in the swing polygon grown by 3 % about its centroid? */
function leafInZone(variant: Variant, angle: number, hinge: 'start' | 'end' | undefined, swing: 'left' | 'right' | undefined, thickness: number): { inside: boolean; leaf: number } {
  const a = (angle * Math.PI) / 180;
  const start: Vec2 = [2, 3];
  const end: Vec2 = [2 + 6 * Math.cos(a), 3 + 6 * Math.sin(a)];
  const door: Record<string, unknown> = { id: 'd', wallId: 'w', type: 'door', offset: 3, width: 0.9, height: 2.04, sill: 0 };
  if (hinge) door.hinge = hinge;
  if (swing) door.swing = swing;
  const scene = { walls: [{ id: 'w', start, end, thickness, height: 2.5 }], openings: [door], rooms: [], items: [] } as unknown as Scene;
  const leaf = leafPoints(scene);
  // the zone of the variant under test: same door with the swing side or the hinge side flipped
  const zoned = { ...door };
  if (variant === 'mirrored-swing') zoned.swing = (swing ?? 'left') === 'left' ? 'right' : 'left';
  if (variant === 'mirrored-hinge') zoned.hinge = (hinge ?? 'start') === 'start' ? 'end' : 'start';
  const poly = doorSwingPolygon(openingFrame(scene, zoned as unknown as Opening)!, zoned as unknown as Opening);
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  const grown = poly.map((p): Vec2 => [cx + (p[0] - cx) * 1.03, cy + (p[1] - cy) * 1.03]);
  return { inside: leaf.length > 0 && leaf.every((p) => insideConvex(p, grown)), leaf: leaf.length };
}

const ANGLES = [0, 17, 45, 90, 135, 180, 225, 270, 315];
const HINGES = ['start', 'end', undefined] as const;
const SWINGS = ['left', 'right', undefined] as const;
const THICKNESSES = [0.07, 0.2];

describe('door swing zone vs the drawn door leaf', () => {
  const combos: [number, (typeof HINGES)[number], (typeof SWINGS)[number], number][] = [];
  for (const a of ANGLES) for (const h of HINGES) for (const s of SWINGS) for (const t of THICKNESSES) combos.push([a, h, s, t]);

  it('covers 162 hinge x swing x wall-angle x thickness combinations', () => {
    expect(combos).toHaveLength(162);
  });

  it('the drawn leaf is inside the swing zone in all 162 combinations', () => {
    const bad = combos.filter(([a, h, s, t]) => {
      const r = leafInZone('exact', a, h, s, t);
      return r.leaf === 0 || !r.inside;
    });
    expect(bad).toEqual([]);
  });

  it('a zone with the swing side mirrored never contains the leaf', () => {
    const fits = combos.filter(([a, h, s, t]) => leafInZone('mirrored-swing', a, h, s, t).inside);
    expect(fits).toEqual([]);
  });

  it('a zone with the hinge side mirrored never contains the leaf', () => {
    const fits = combos.filter(([a, h, s, t]) => leafInZone('mirrored-hinge', a, h, s, t).inside);
    expect(fits).toEqual([]);
  });
});
