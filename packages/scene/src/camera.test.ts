import { describe, expect, it } from 'vitest';
import charme from '../fixtures/charme-3205.flat.json';
import { boxCorners, fitCamera, sceneBounds3, type Box3, type CameraFit, type Point3 } from './camera';
import { parseScene } from './parse';

const r = parseScene(charme);
if (!r.ok) throw new Error(r.errors.join('\n'));
const scene = r.scene;

const sub = (a: Point3, b: Point3): Point3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Point3, b: Point3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Point3, b: Point3): Point3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Point3): Point3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Standard lookAt + perspective projection: returns NDC x, y and view depth. */
function project(cam: CameraFit, p: Point3, fovDeg: number, aspect: number) {
  const f = unit(sub(cam.target, cam.position));
  const rgt = unit(cross(f, cam.up));
  const u = cross(rgt, f);
  const rel = sub(p, cam.position);
  const depth = dot(rel, f);
  const t = Math.tan((fovDeg * Math.PI) / 360);
  return { x: dot(rel, rgt) / (depth * t * aspect), y: dot(rel, u) / (depth * t), depth };
}

describe('sceneBounds3', () => {
  it('encloses Charme walls (with thickness), balcony and height', () => {
    const b = sceneBounds3(scene);
    expect(b.min[0]).toBeCloseTo(-1.6 - 0.1, 9); // north wall starts at -1.6, half thickness 0.1
    expect(b.max[0]).toBeCloseTo(10.15 + 0.1, 9);
    expect(b.min[2]).toBeCloseTo(-0.1 - 0.1, 9);
    expect(b.max[2]).toBeCloseTo(8.38 + 0.1, 9);
    expect(b.min[1]).toBe(0);
    expect(b.max[1]).toBe(2.5);
  });
});

describe('fitCamera', () => {
  const box: Box3 = sceneBounds3(scene);
  const cases = [
    { fovDeg: 50, aspect: 16 / 9 },
    { fovDeg: 50, aspect: 1 },
    { fovDeg: 30, aspect: 0.5 },
    { fovDeg: 75, aspect: 2.4 },
  ];

  for (const mode of ['orbit', 'top'] as const) {
    for (const { fovDeg, aspect } of cases) {
      it(`${mode}: every corner projects inside the frustum with a 10% margin (fov ${fovDeg}, aspect ${aspect.toFixed(2)})`, () => {
        const cam = fitCamera(box, { fovDeg, aspect, mode });
        let worst = 0;
        for (const c of boxCorners(box)) {
          const p = project(cam, c, fovDeg, aspect);
          expect(p.depth).toBeGreaterThan(0);
          worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y));
        }
        expect(worst).toBeLessThanOrEqual(1 / 1.1 + 1e-9);
        expect(worst).toBeGreaterThan(1 / 1.1 - 1e-6); // tight: not needlessly far away
      });
    }
  }

  it('orbit looks at the box centre from the south-east at 45 degrees elevation', () => {
    const cam = fitCamera(box, { fovDeg: 50, aspect: 1.5, mode: 'orbit' });
    const d = sub(cam.position, cam.target);
    expect(d[0]).toBeGreaterThan(0); // east
    expect(d[2]).toBeGreaterThan(0); // south (plan +y)
    expect(d[0]).toBeCloseTo(d[2], 9);
    expect(Math.atan2(d[1], Math.hypot(d[0], d[2])) * (180 / Math.PI)).toBeCloseTo(45, 9);
    expect(cam.target).toEqual([(box.min[0] + box.max[0]) / 2, 1.25, (box.min[2] + box.max[2]) / 2]);
    expect(cam.orthoHalfHeight).toBeUndefined();
  });

  it('top looks straight down with plan north (-Z) at the top of the screen and east to the right', () => {
    const cam = fitCamera(box, { fovDeg: 50, aspect: 1.5, mode: 'top' });
    expect(cam.position[0]).toBeCloseTo(cam.target[0], 9);
    expect(cam.position[2]).toBeCloseTo(cam.target[2], 9);
    expect(cam.position[1]).toBeGreaterThan(box.max[1]);
    const north = project(cam, [cam.target[0], 0, cam.target[2] - 3], 50, 1.5);
    const east = project(cam, [cam.target[0] + 3, 0, cam.target[2]], 50, 1.5);
    expect(north.y).toBeGreaterThan(0); // screen up
    expect(Math.abs(north.x)).toBeLessThan(1e-9);
    expect(east.x).toBeGreaterThan(0); // screen right
    expect(Math.abs(east.y)).toBeLessThan(1e-9);
  });

  it('top returns an orthographic half height that contains the box plus margin', () => {
    for (const aspect of [0.5, 1, 2]) {
      const cam = fitCamera(box, { fovDeg: 50, aspect, mode: 'top' });
      const h = cam.orthoHalfHeight!;
      const halfZ = (box.max[2] - box.min[2]) / 2;
      const halfX = (box.max[0] - box.min[0]) / 2;
      expect(h).toBeGreaterThanOrEqual(1.1 * halfZ - 1e-9);
      expect(h * aspect).toBeGreaterThanOrEqual(1.1 * halfX - 1e-9);
      // tight in at least one dimension
      expect(Math.min(h / (1.1 * halfZ), (h * aspect) / (1.1 * halfX))).toBeCloseTo(1, 9);
    }
  });

  it('handles a degenerate (point) box', () => {
    const cam = fitCamera({ min: [1, 0, 1], max: [1, 0, 1] }, { fovDeg: 50, aspect: 1, mode: 'orbit' });
    expect(cam.position.every(Number.isFinite)).toBe(true);
  });
});
