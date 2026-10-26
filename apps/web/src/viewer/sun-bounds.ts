import { sceneBounds3 } from '@flat/scene';
import type { Scene, SiteContext } from '@flat/scene';
import type { V3 } from './sun-fit';

/** Neighbouring buildings closer than this to the flat (metres) are shadow receivers too. */
const NEARBY_M = 8;

export interface SunFitInputs {
  receivers: V3[];
  casters: V3[];
}

const cache = new WeakMap<Scene, WeakMap<object, SunFitInputs>>();
const NO_CONTEXT = {};

/**
 * Points the sun's shadow frustum must cover: the flat and the nearby ground/buildings as
 * receivers; the flat and every context building (base and roof) as casters.
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
  const corners: V3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) corners.push([x, y, z]);
  const receivers = [...corners];
  const casters = [...corners];
  if (context) {
    const near = { x0: b.min[0] - NEARBY_M, x1: b.max[0] + NEARBY_M, z0: b.min[2] - NEARBY_M, z1: b.max[2] + NEARBY_M };
    for (const building of context.buildings) {
      const isNear = building.footprint.some(([x, z]) => x >= near.x0 && x <= near.x1 && z >= near.z0 && z <= near.z1);
      for (const [x, z] of building.footprint) {
        casters.push([x, building.base, z], [x, building.base + building.height, z]);
        if (isNear) receivers.push([x, building.base, z]);
      }
    }
  }
  return { receivers, casters };
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
