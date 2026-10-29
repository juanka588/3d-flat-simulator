import { BufferAttribute, BufferGeometry, CapsuleGeometry, SphereGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * A neutral, self-made, low-poly mannequin for the "person ghost" (no external asset, so no licence).
 * Proportions follow the classic 8-heads canon: the head is height/8, the chin at 7/8, shoulders at ~6.5/8,
 * crotch at 4/8, knees at ~2/8, soles at 0. The mesh is normalised so its bounding box is exactly `heightM` tall
 * with its soles on y = 0 and its centre on x = z = 0; the figure faces +z.
 */
export interface PersonPart {
  name: string;
  /** Capsule (radius, straight length) or sphere (radius), in units of the figure's height. */
  shape: 'capsule' | 'sphere';
  radius: number;
  length: number;
  /** Centre, in units of height (x right, y up, z forward). */
  centre: [number, number, number];
  /** Non-uniform scale about the centre. */
  scale?: [number, number, number];
  /** Rotation about z (radians), for the arms hanging slightly away from the body. */
  tilt?: number;
}

const H = 1;
const HEAD = H / 8;

/** The parts, as fractions of the height (pure data: tested). */
export const PERSON_PARTS: readonly PersonPart[] = [
  { name: 'head', shape: 'sphere', radius: HEAD * 0.42, length: 0, centre: [0, H - HEAD * 0.55, 0], scale: [0.9, 1.2, 1] },
  { name: 'neck', shape: 'capsule', radius: HEAD * 0.17, length: HEAD * 0.25, centre: [0, H - HEAD * 1.05, 0] },
  // Torso: shoulders (6.5/8) down to the hips (4/8)
  { name: 'torso', shape: 'capsule', radius: HEAD * 0.62, length: HEAD * 1.35, centre: [0, H - HEAD * 2.55, 0], scale: [1.25, 1, 0.68] },
  { name: 'arm-l', shape: 'capsule', radius: HEAD * 0.17, length: HEAD * 2.1, centre: [-HEAD * 1.02, H - HEAD * 3.05, 0], tilt: 0.06 },
  { name: 'arm-r', shape: 'capsule', radius: HEAD * 0.17, length: HEAD * 2.1, centre: [HEAD * 1.02, H - HEAD * 3.05, 0], tilt: -0.06 },
  { name: 'leg-l', shape: 'capsule', radius: HEAD * 0.3, length: HEAD * 3.0, centre: [-HEAD * 0.34, HEAD * 2.1, 0] },
  { name: 'leg-r', shape: 'capsule', radius: HEAD * 0.3, length: HEAD * 3.0, centre: [HEAD * 0.34, HEAD * 2.1, 0] },
  { name: 'foot-l', shape: 'capsule', radius: HEAD * 0.17, length: HEAD * 0.5, centre: [-HEAD * 0.34, HEAD * 0.17, HEAD * 0.2], scale: [1, 1, 1] },
  { name: 'foot-r', shape: 'capsule', radius: HEAD * 0.17, length: HEAD * 0.5, centre: [HEAD * 0.34, HEAD * 0.17, HEAD * 0.2], scale: [1, 1, 1] },
];

function partGeometry(p: PersonPart): BufferGeometry {
  let g: BufferGeometry;
  if (p.shape === 'sphere') g = new SphereGeometry(p.radius, 14, 10);
  else g = new CapsuleGeometry(p.radius, p.length, 3, 10);
  // Feet lie along z.
  if (p.name.startsWith('foot')) g.rotateX(Math.PI / 2);
  if (p.scale) g.scale(...p.scale);
  if (p.tilt) g.rotateZ(p.tilt);
  g.translate(...p.centre);
  return g;
}

/** The merged mannequin, `heightM` tall, soles on y = 0, centred on the origin on the plan. Dispose it when done. */
export function createPersonGeometry(heightM: number): BufferGeometry {
  const parts = PERSON_PARTS.map(partGeometry);
  const merged = mergeGeometries(parts.map((g) => g.toNonIndexed()), false);
  parts.forEach((g) => g.dispose());
  if (!merged) throw new Error('could not merge the person geometry');
  merged.computeBoundingBox();
  const box = merged.boundingBox!;
  const k = heightM / (box.max.y - box.min.y);
  merged.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  merged.scale(k, k, k);
  merged.computeBoundingBox();
  merged.computeVertexNormals();
  shadeByNormal(merged);
  return merged;
}

/**
 * Baked soft shading (the ghost is drawn unlit so the scene's physical exposure cannot black it out): lighter on top and
 * towards the front, darker below. Adds a `color` attribute; the geometry needs normals.
 */
export function shadeByNormal(g: BufferGeometry): void {
  const normal = g.getAttribute('normal');
  const colors = new Float32Array(normal.count * 3);
  for (let i = 0; i < normal.count; i++) {
    const shade = 0.72 + 0.28 * (normal.getY(i) * 0.6 + normal.getZ(i) * 0.4 + 1) * 0.5;
    colors[i * 3] = shade;
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = shade;
  }
  g.setAttribute('color', new BufferAttribute(colors, 3));
}
