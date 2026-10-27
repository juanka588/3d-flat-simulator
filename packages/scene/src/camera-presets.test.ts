import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RADIUS, insideFlat } from './collision';
import { FIXTURES } from './commands/testUtil';
import { type Facing, type FacingTarget, UnknownFacingError, UnknownRoomError, facingToHeadingDeg, orbitPose, roomOverviewPose, topPose, walkPoseInRoom } from './camera-presets';
import { sceneBounds3, type Point3 } from './camera';
import { wallLength, type Scene } from './schema';
import { CameraPose, type OrbitPose, type TopPose } from './view';
import { pointInPolygon } from './validate';

const sub = (a: Point3, b: Point3): Point3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Point3, b: Point3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Point3, b: Point3): Point3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Point3): Point3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

function orbitCamera(p: OrbitPose) {
  const az = (p.azimuthDeg * Math.PI) / 180;
  const el = (p.elevationDeg * Math.PI) / 180;
  const position: Point3 = [
    p.target[0] + p.distance * Math.sin(az) * Math.cos(el),
    p.target[1] + p.distance * Math.sin(el),
    p.target[2] - p.distance * Math.cos(az) * Math.cos(el),
  ];
  return { position, target: p.target };
}

/** Max |NDC| of a world point seen by a perspective camera, and its depth. */
function project(p: OrbitPose, pt: Point3, aspect: number) {
  const { position, target } = orbitCamera(p);
  const f = unit(sub(target, position));
  const r = unit(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const rel = sub(pt, position);
  const depth = dot(rel, f);
  const t = Math.tan((p.fovDeg * Math.PI) / 360);
  return { x: dot(rel, r) / (depth * t * aspect), y: dot(rel, u) / (depth * t), depth, position };
}

function roomCorners(scene: Scene, roomId: string): Point3[] {
  const room = scene.rooms.find((r) => r.id === roomId)!;
  const xs = room.polygon.map((p) => p[0]);
  const ys = room.polygon.map((p) => p[1]);
  const out: Point3[] = [];
  for (const x of [Math.min(...xs), Math.max(...xs)]) for (const y of [Math.min(...ys), Math.max(...ys)]) for (const h of [0, 2.5]) out.push([x, h, y]);
  return out;
}

const angleDiff = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
const headingTo = (from: [number, number], to: [number, number]) => ((Math.atan2(to[0] - from[0], -(to[1] - from[1])) * 180) / Math.PI + 360) % 360;

describe('camera presets', () => {
  it('every preset on every room of both fixtures is a valid CameraPose and survives a JSON round-trip', () => {
    for (const scene of Object.values(FIXTURES)) {
      const poses: CameraPose[] = [topPose(scene), orbitPose(scene)];
      for (const room of scene.rooms) {
        poses.push(roomOverviewPose(scene, room.id), walkPoseInRoom(scene, room.id), topPose(scene, { roomId: room.id }), orbitPose(scene, { roomId: room.id }));
        for (const f of ['N', 'E', 'S', 'W', 45] as Facing[]) poses.push(walkPoseInRoom(scene, room.id, { facing: f }));
      }
      for (const p of poses) {
        const parsed = CameraPose.parse(p);
        expect(parsed).toEqual(p);
        expect(CameraPose.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
        expect(Object.values(JSON.parse(JSON.stringify(p))).flat().every((v) => typeof v !== 'number' || Number.isFinite(v))).toBe(true);
      }
    }
  });

  it('unknown rooms throw UnknownRoomError; unknown targets UnknownFacingError', () => {
    const charme = FIXTURES.charme!;
    for (const fn of [() => roomOverviewPose(charme, 'x'), () => walkPoseInRoom(charme, 'x'), () => topPose(charme, { roomId: 'x' }), () => orbitPose(charme, { roomId: 'x' })]) {
      expect(fn).toThrow(UnknownRoomError);
    }
    expect(() => walkPoseInRoom(charme, 'sejour', { facing: 'nope' })).toThrow(UnknownFacingError);
    expect(() => walkPoseInRoom(charme, 'sejour', { facing: { wallId: 'nope' } })).toThrow(UnknownFacingError);
  });

  it('facingToHeadingDeg honours northAngle', () => {
    const charme = FIXTURES.charme!;
    expect(facingToHeadingDeg(charme, 'N')).toBeCloseTo(355.5, 9);
    expect(facingToHeadingDeg(charme, 'E')).toBeCloseTo(85.5, 9);
    expect(facingToHeadingDeg(charme, 'S')).toBeCloseTo(175.5, 9);
    expect(facingToHeadingDeg(charme, 90)).toBe(90);
    expect(facingToHeadingDeg(charme, -90)).toBe(270);
    expect(facingToHeadingDeg(FIXTURES.sample!, 'N')).toBeCloseTo(FIXTURES.sample!.site.northAngle, 9);
  });

  for (const [name, scene] of Object.entries(FIXTURES)) {
    describe(`${name}: overview`, () => {
      it.each(scene.rooms.map((r) => r.id))('room %s: the room box is in the frustum, above the walls', (id) => {
        for (const aspect of [4 / 3, 16 / 9, 2]) {
          const pose = roomOverviewPose(scene, id);
          let worst = 0;
          for (const c of roomCorners(scene, id)) {
            const p = project(pose, c, aspect);
            expect(p.depth).toBeGreaterThan(0);
            worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y));
          }
          expect(worst).toBeLessThanOrEqual(1 / 1.1 + 1e-9);
        }
        const cam = orbitCamera(roomOverviewPose(scene, id)).position;
        expect(cam[1]).toBeGreaterThan(Math.max(...scene.walls.map((w) => w.height)));
      });

      it('orbit/top of the whole flat fit sceneBounds3', () => {
        const box = sceneBounds3(scene);
        const o = orbitPose(scene);
        const corners: Point3[] = [];
        for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) corners.push([x, y, z]);
        for (const c of corners) {
          const p = project(o, c, 4 / 3);
          expect(Math.max(Math.abs(p.x), Math.abs(p.y))).toBeLessThanOrEqual(1 / 1.1 + 1e-9);
        }
        const t: TopPose = topPose(scene);
        const aspect = 4 / 3;
        for (const c of corners) {
          expect(Math.abs(c[2] - t.center[1])).toBeLessThanOrEqual(t.halfHeight / 1.1 + 1e-9);
          expect(Math.abs(c[0] - t.center[0])).toBeLessThanOrEqual((t.halfHeight * aspect) / 1.1 + 1e-9);
        }
      });
    });

    describe(`${name}: walkPoseInRoom`, () => {
      const inFlat = insideFlat(scene);
      const targets: { room: string; facing: FacingTarget | undefined }[] = [];
      for (const room of scene.rooms) {
        targets.push({ room: room.id, facing: undefined });
        for (const f of ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const) targets.push({ room: room.id, facing: f });
        for (const o of scene.openings) targets.push({ room: room.id, facing: { openingId: o.id } });
        for (const w of scene.walls) targets.push({ room: room.id, facing: { wallId: w.id } });
      }

      it('property: always inside the polygon, clear of walls, heading exact', () => {
        fc.assert(
          fc.property(fc.constantFrom(...targets), fc.double({ min: -360, max: 360, noNaN: true }), fc.boolean(), ({ room, facing }, deg, useDeg) => {
            const f = useDeg ? deg : facing;
            const pose = walkPoseInRoom(scene, room, { facing: f as FacingTarget | undefined });
            const poly = scene.rooms.find((r) => r.id === room)!.polygon;
            expect(pointInPolygon(pose.position, poly, 0)).toBe(true);
            expect(inFlat(pose.position)).toBe(true);
            if (typeof f === 'number') expect(angleDiff(pose.headingDeg, f)).toBeLessThan(1e-6);
            else if (typeof f === 'string') expect(angleDiff(pose.headingDeg, facingToHeadingDeg(scene, f as Facing))).toBeLessThan(1e-6);
          }),
          { numRuns: 400 },
        );
      });

      it('rooms with room to stand keep the body radius from every wall', () => {
        for (const room of scene.rooms) {
          const pose = walkPoseInRoom(scene, room.id);
          const poly = room.polygon;
          let min = Infinity;
          for (let i = 0; i < poly.length; i++) {
            const a = poly[i]!;
            const b = poly[(i + 1) % poly.length]!;
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const t = Math.max(0, Math.min(1, ((pose.position[0] - a[0]) * dx + (pose.position[1] - a[1]) * dy) / (dx * dx + dy * dy)));
            min = Math.min(min, Math.hypot(pose.position[0] - a[0] - t * dx, pose.position[1] - a[1] - t * dy));
          }
          expect(min, room.id).toBeGreaterThanOrEqual(DEFAULT_RADIUS - 1e-6);
        }
      });

      it('opening and wall targets: heading points at the target within 1 degree', () => {
        for (const o of scene.openings) {
          const wall = scene.walls.find((w) => w.id === o.wallId)!;
          const t = o.offset / wallLength(wall);
          const centre: [number, number] = [wall.start[0] + (wall.end[0] - wall.start[0]) * t, wall.start[1] + (wall.end[1] - wall.start[1]) * t];
          for (const room of scene.rooms) {
            const pose = walkPoseInRoom(scene, room.id, { facing: { openingId: o.id } });
            expect(angleDiff(pose.headingDeg, headingTo(pose.position, centre))).toBeLessThan(1);
          }
        }
      });
    });
  }

  it('charme: facing the north windows of ch1 backs away from them', () => {
    const charme = FIXTURES.charme!;
    const pose = walkPoseInRoom(charme, 'ch1', { facing: { openingId: 'win-ch1' } });
    expect(pose.position[1]).toBeGreaterThan(2.5); // in the south half of ch1 (y 0..4.42)
    expect(angleDiff(pose.headingDeg, 0)).toBeLessThan(40);
    expect(walkPoseInRoom(charme, 'ch1', { facing: 'win-ch1' })).toEqual(pose);
    const n = walkPoseInRoom(charme, 'ch1', { facing: 'N' });
    expect(angleDiff(n.headingDeg, 355.5)).toBeLessThan(1e-9);
    expect(n.position[1]).toBeGreaterThan(2.5);
  });
});
