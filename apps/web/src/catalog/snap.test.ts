import { describe, expect, it } from 'vitest';
import { angleDiff, roomEdges, snapAngle, snapPose, snapValue } from './snap';

const room = { id: 'r', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] as [number, number][] };
const dims = { w: 1, d: 0.5 };

describe('basic snaps', () => {
  it('snaps values to the 5 cm grid', () => {
    expect(snapValue(1.234)).toBe(1.25);
    expect(snapValue(1.226)).toBe(1.25);
    expect(snapValue(-0.02)).toBe(0);
  });
  it('snaps angles to 15 degree steps in [0, 360)', () => {
    expect(snapAngle(7)).toBe(0);
    expect(snapAngle(8)).toBe(15);
    expect(snapAngle(-20)).toBe(345);
    expect(snapAngle(359)).toBe(0);
  });
  it('measures angle differences across the wrap', () => {
    expect(angleDiff(350, 10)).toBe(20);
  });
  it('gives inward normals', () => {
    const e = roomEdges(room.polygon);
    expect(e).toHaveLength(4);
    expect(e[0]!.inward[0]).toBeCloseTo(0, 9);
    expect(e[0]!.inward[1]).toBeCloseTo(1, 9);
  });
});

describe('snapPose', () => {
  it('grid only in the middle of a room; Alt (grid off) keeps the raw point', () => {
    const r = snapPose({ point: [2.013, 1.49], rotation: 3, dims, rooms: [room] });
    expect(r.position).toEqual([2, 1.5]);
    expect(r.rotation).toBe(0);
    expect(r.snaps).toEqual(['angle', 'grid']);
    expect(snapPose({ point: [2.013, 1.49], rotation: 3, dims, rooms: [room] }, { grid: false }).position).toEqual([2.013, 1.49]);
  });
  it('Shift (angle off) keeps a free rotation', () => {
    expect(snapPose({ point: [2, 1.5], rotation: 37, dims, rooms: [room] }, { angle: false }).rotation).toBe(37);
  });
  it('pulls the back flush to a wall within 10 cm and faces into the room', () => {
    // back against the north wall (y = 0): front faces +y (rotation 0), centre at depth/2
    const r = snapPose({ point: [2, 0.3], rotation: 0, dims, rooms: [room] });
    expect(r.rotation).toBe(0);
    expect(r.position).toEqual([2, 0.25]);
    expect(r.snaps).toContain('wall');
    // east wall (x = 4): inward normal -x, front faces -x
    const e = snapPose({ point: [3.7, 1.5], rotation: 0, dims, rooms: [room] });
    expect(e.rotation).toBe(270);
    expect(e.position[0]).toBeCloseTo(3.75, 6);
  });
  it('does not snap beyond 10 cm', () => {
    const r = snapPose({ point: [2, 0.45], rotation: 0, dims, rooms: [room] });
    expect(r.snaps).not.toContain('wall');
    expect(r.position).toEqual([2, 0.45]);
  });
  it('snaps into a corner: back to one wall, a side to the next', () => {
    const r = snapPose({ point: [0.55, 0.3], rotation: 0, dims, rooms: [room] });
    expect(r.snaps).toEqual(expect.arrayContaining(['wall', 'corner']));
    expect(r.position[0]).toBeCloseTo(0.5, 6);
    expect(r.position[1]).toBeCloseTo(0.25, 6);
  });
  it('does nothing outside every room and for ceiling mounts', () => {
    expect(snapPose({ point: [9, 9], rotation: 0, dims, rooms: [room] }).snaps).not.toContain('wall');
    expect(snapPose({ point: [2, 0.3], rotation: 0, dims, rooms: [room], mount: 'ceiling' }).snaps).not.toContain('wall');
  });
  it('reports the room under the pointer', () => {
    expect(snapPose({ point: [2, 1], rotation: 0, dims, rooms: [room] }).roomId).toBe('r');
  });
});
