import { sceneBounds3 } from '@flat/scene';
import type { Scene, SiteContext } from '@flat/scene';
import { dot, fitSunShadow, sunBasis } from './sun-fit';
import type { SunShadowFit, V3 } from './sun-fit';

/** Sideways slack (metres) when deciding whether a context building can shade the flat. */
const SIDE_MARGIN = 0.5;

/** A context building reduced to what the shadow-fit filter needs. */
interface CasterBox {
  /** Footprint vertices at the base and at the roof. */
  points: V3[];
  minY: number;
  maxY: number;
}

export interface SunFitInputs {
  /** Corners of the flat's bounding box (including its balcony): the surfaces that must receive correct shadows. */
  receivers: V3[];
  buildings: CasterBox[];
}

const cache = new WeakMap<Scene, WeakMap<object, SunFitInputs>>();
const NO_CONTEXT = {};

/**
 * Static inputs of the sun's shadow frustum: the flat (and its balcony) as receivers, every
 * context building as a potential caster. Which casters matter depends on the sun direction; see
 * `sunCasters`.
 */
export function sunFitInputs(scene: Scene, context: SiteContext | null): SunFitInputs {
  let byContext = cache.get(scene);
  if (!byContext) cache.set(scene, (byContext = new WeakMap()));
  const key = context ?? NO_CONTEXT;
  let inputs = byContext.get(key);
  if (!inputs) byContext.set(key, (inputs = compute(scene, context)));
  return inputs;
}

function compute(scene: Scene, context: SiteContext | null): SunFitInputs {
  const b = sceneBounds3(scene);
  const receivers: V3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) receivers.push([x, y, z]);
  const buildings: CasterBox[] = (context?.buildings ?? []).map((building) => {
    const points: V3[] = [];
    for (const [x, z] of building.footprint) points.push([x, building.base, z], [x, building.base + building.height, z]);
    return { points, minY: building.base, maxY: building.base + building.height };
  });
  return { receivers, buildings };
}

/**
 * Points whose depth along the sun direction bounds everything that can cast a shadow on the
 * receivers: the flat itself, plus the context buildings that
 *  - project (perpendicular to the sun) onto the receivers' extent, and
 *  - reach the sun side of the receivers, and
 *  - are tall enough for a ray from the receivers towards the sun to meet them.
 * A building's depth is capped where the lowest such ray rises above its roof, so a long
 * building towards a low sun does not stretch the depth range for nothing.
 */
export function sunCasters(direction: V3, inputs: SunFitInputs): V3[] {
  const { dir, right, cameraUp } = sunBasis(direction);
  const { receivers, buildings } = inputs;
  const casters: V3[] = [...receivers];
  if (buildings.length === 0 || !(dir[1] > 1e-3)) return casters;

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, d0 = Infinity, minY = Infinity;
  for (const r of receivers) {
    const x = dot(r, right), y = dot(r, cameraUp);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    d0 = Math.min(d0, dot(r, dir));
    minY = Math.min(minY, r[1]);
  }
  x0 -= SIDE_MARGIN; x1 += SIDE_MARGIN; y0 -= SIDE_MARGIN; y1 += SIDE_MARGIN;
  const horizontal = Math.hypot(dir[0], dir[2]);

  for (const building of buildings) {
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity, bd1 = -Infinity;
    for (const p of building.points) {
      const x = dot(p, right), y = dot(p, cameraUp);
      bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x);
      by0 = Math.min(by0, y); by1 = Math.max(by1, y);
      bd1 = Math.max(bd1, dot(p, dir));
    }
    if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) continue; // off to the side of every light ray
    if (bd1 <= d0) continue; // entirely behind the receivers
    // Deepest useful point: where the lowest ray from a receiver reaches the roof height.
    let cap = -Infinity;
    for (const r of receivers) cap = Math.max(cap, dot(r, dir) + (building.maxY - r[1]) / dir[1]);
    if (building.maxY < minY) continue; // below every receiver
    const depth = Math.min(bd1, cap);
    if (depth <= d0) continue;
    casters.push([dir[0] * depth, dir[1] * depth, dir[2] * depth]);
  }
  void horizontal;
  return casters;
}

/** The sun's shadow frustum for the flat (plus nearby context) and a sun direction. */
export function fitSunForScene(scene: Scene, context: SiteContext | null, direction: V3): SunShadowFit | null {
  const inputs = sunFitInputs(scene, context);
  return fitSunShadow(direction, inputs.receivers, sunCasters(direction, inputs));
}

/** Largest horizontal distance from the flat's centre to any context vertex, plus building heights (for the camera far plane). */
export function contextReach(scene: Scene, context: SiteContext | null): number {
  if (!context) return 0;
  const b = sceneBounds3(scene);
  const cx = (b.min[0] + b.max[0]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  let reach = 0;
  for (const building of context.buildings) {
    for (const [x, z] of building.footprint) reach = Math.max(reach, Math.hypot(x - cx, z - cz));
  }
  return reach;
}
