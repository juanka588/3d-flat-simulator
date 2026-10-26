import { describe, expect, it } from 'vitest';
import charme from '../../fixtures/charme-3205.flat.json';
import sample from '../../fixtures/sample.flat.json';
import { parseScene } from '../parse';
import type { Wall } from '../schema';
import { computeWallJunctions } from './junctions';

const wall = (id: string, start: [number, number], end: [number, number], thickness = 0.2): Wall => ({
  id,
  start,
  end,
  thickness,
  height: 2.5,
  finish: {},
});
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('computeWallJunctions', () => {
  it('leaves an isolated wall untrimmed', () => {
    const fp = computeWallJunctions([wall('a', [0, 0], [4, 0])]).get('a')!;
    expect(fp).toEqual({ startLeft: 0, startRight: 0, endLeft: 4, endRight: 4 });
  });

  it('mitres an L corner: outer face extends, inner face trims', () => {
    // a runs +x then b runs +y (down the page). a's left (-y) is the outer side.
    const fps = computeWallJunctions([wall('a', [0, 0], [4, 0]), wall('b', [4, 0], [4, 3])]);
    const a = fps.get('a')!;
    const b = fps.get('b')!;
    close(a.endLeft, 4.1);
    close(a.endRight, 3.9);
    // Outer corner is at (4.1, -0.1): b's left face (x = 4.1) starts at y = -0.1.
    close(b.startLeft, -0.1);
    close(b.startRight, 0.1);
  });

  it('mitres with mixed thickness', () => {
    const fps = computeWallJunctions([wall('a', [0, 0], [4, 0], 0.2), wall('b', [4, 0], [4, 3], 0.1)]);
    const a = fps.get('a')!;
    const b = fps.get('b')!;
    close(a.endLeft, 4.05);
    close(a.endRight, 3.95);
    close(b.startLeft, -0.1);
    close(b.startRight, 0.1);
  });

  it('works for either wall direction at the node', () => {
    const fps = computeWallJunctions([wall('a', [0, 0], [4, 0]), wall('b', [4, 3], [4, 0])]);
    const b = fps.get('b')!;
    // b runs up the page; its left normal is (-1,0), the inner side, so the left face is trimmed.
    close(b.endLeft, 2.9);
    close(b.endRight, 3.1);
  });

  it('falls back to a butt on the outer side of very acute corners', () => {
    const fps = computeWallJunctions([wall('a', [0, 0], [4, 0]), wall('b', [0, 0], [4, 0.2])]);
    for (const fp of fps.values()) {
      for (const v of Object.values(fp)) expect(Number.isFinite(v)).toBe(true);
    }
    const a = fps.get('a')!;
    // Outer extension is clamped: a's left face (-y side) is not extended past the node.
    expect(a.startLeft).toBeGreaterThanOrEqual(-1e-9);
  });

  it('mitres a 60 degree corner within the limit', () => {
    const fps = computeWallJunctions([
      wall('a', [0, 0], [4, 0], 0.2),
      wall('b', [0, 0], [2, Math.sqrt(3) * 2], 0.2),
    ]);
    const a = fps.get('a')!;
    // Inner trim h/tan(30deg) = 0.1732, outer extension the same amount on the other face.
    expect(Math.max(a.startLeft, a.startRight)).toBeCloseTo(0.1 / Math.tan(Math.PI / 6), 5);
    expect(Math.min(a.startLeft, a.startRight)).toBeCloseTo(-0.1 / Math.tan(Math.PI / 6), 5);
  });

  it('stops a T-junction wall at the host face, not the centreline', () => {
    const fps = computeWallJunctions([wall('host', [0, 0], [10, 0], 0.2), wall('stem', [5, 4], [5, 0], 0.1)]);
    const stem = fps.get('stem')!;
    close(stem.endLeft, 3.9);
    close(stem.endRight, 3.9);
    expect(fps.get('host')).toEqual({ startLeft: 0, startRight: 0, endLeft: 10, endRight: 10 });
  });

  it('stops stems from both sides of a host (cross made of a through wall and two stubs)', () => {
    const fps = computeWallJunctions([
      wall('host', [0, 0], [10, 0], 0.2),
      wall('up', [5, 0], [5, -3], 0.1),
      wall('down', [5, 3], [5, 0], 0.1),
    ]);
    close(fps.get('up')!.startLeft, 0.1);
    close(fps.get('up')!.startRight, 0.1);
    close(fps.get('down')!.endLeft, 2.9);
  });

  it('cuts an oblique T-junction along the host face', () => {
    const fps = computeWallJunctions([wall('host', [0, 0], [10, 0], 0.2), wall('stem', [8, 4], [5, 0], 0.1)]);
    const stem = fps.get('stem')!;
    const length = 5;
    expect(stem.endLeft).toBeLessThan(length);
    expect(stem.endRight).toBeLessThan(length);
    expect(Math.abs(stem.endLeft - stem.endRight)).toBeGreaterThan(0.01);
    // Both end corners must sit on the host face y = 0.1: corner = start + u*s +/- n*0.05.
    const u = [-3 / 5, -4 / 5];
    const n = [u[1]!, -u[0]!];
    for (const [s, sign] of [[stem.endLeft, 1], [stem.endRight, -1]] as const) {
      const y = 4 + u[1]! * s + n[1]! * 0.05 * sign;
      close(y, 0.1);
    }
  });

  it('leaves no gap at a collinear continuation', () => {
    const fps = computeWallJunctions([wall('a', [0, 0], [4, 0]), wall('b', [4, 0], [9, 0])]);
    expect(fps.get('a')).toEqual({ startLeft: 0, startRight: 0, endLeft: 4, endRight: 4 });
    expect(fps.get('b')).toEqual({ startLeft: 0, startRight: 0, endLeft: 5, endRight: 5 });
  });

  it('treats a stem on a collinear pair as a T against the pair', () => {
    const fps = computeWallJunctions([
      wall('a', [0, 0], [4, 0]),
      wall('b', [4, 0], [9, 0]),
      wall('c', [4, 3], [4, 0], 0.1),
    ]);
    expect(fps.get('a')!.endLeft).toBe(4);
    expect(fps.get('b')!.startRight).toBe(0);
    close(fps.get('c')!.endLeft, 2.9);
  });

  it('handles a four-way node with a stable, finite result', () => {
    const fps = computeWallJunctions([
      wall('e', [0, 0], [3, 0]),
      wall('s', [0, 0], [0, 3]),
      wall('w', [0, 0], [-3, 0]),
      wall('n', [0, 0], [0, -3]),
    ]);
    for (const fp of fps.values()) {
      expect(Object.values(fp).every(Number.isFinite)).toBe(true);
      expect(fp.endLeft).toBeGreaterThan(fp.startLeft);
      expect(fp.endRight).toBeGreaterThan(fp.startRight);
    }
  });

  it('handles a three-way non-collinear node', () => {
    const fps = computeWallJunctions([
      wall('a', [0, 0], [3, 0]),
      wall('b', [0, 0], [-1.5, 2.6]),
      wall('c', [0, 0], [-1.5, -2.6]),
    ]);
    for (const fp of fps.values()) {
      expect(Object.values(fp).every(Number.isFinite)).toBe(true);
      expect(fp.endLeft).toBeGreaterThan(fp.startLeft);
      expect(fp.endRight).toBeGreaterThan(fp.startRight);
      expect(Math.max(Math.abs(fp.startLeft), Math.abs(fp.startRight))).toBeLessThan(0.5);
    }
  });

  it('never inverts a short wall squeezed between corners', () => {
    const fps = computeWallJunctions([
      wall('a', [0, 0], [4, 0], 0.4),
      wall('b', [4, 0], [4, 0.1], 0.4),
      wall('c', [4, 0.1], [0, 0.1], 0.4),
    ]);
    const b = fps.get('b')!;
    expect(b.endLeft - b.startLeft).toBeGreaterThan(0);
    expect(b.endRight - b.startRight).toBeGreaterThan(0);
  });

  it('ignores endpoints farther apart than the tolerance', () => {
    const fps = computeWallJunctions([wall('a', [0, 0], [4, 0]), wall('b', [4, 0.01], [4, 3])]);
    expect(fps.get('a')!.endLeft).toBe(4);
  });

  it('survives both fixtures without NaN or inverted faces', () => {
    for (const fixture of [charme, sample]) {
      const parsed = parseScene(fixture);
      if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
      const fps = computeWallJunctions(parsed.scene.walls);
      expect(fps.size).toBe(parsed.scene.walls.length);
      for (const fp of fps.values()) {
        expect(Object.values(fp).every(Number.isFinite)).toBe(true);
        expect(fp.endLeft).toBeGreaterThan(fp.startLeft);
        expect(fp.endRight).toBeGreaterThan(fp.startRight);
      }
    }
  });
});
