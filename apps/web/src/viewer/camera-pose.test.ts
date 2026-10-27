import { describe, expect, it } from 'vitest';
import { headingToYaw, orbitPosition, topUp, topZoomFor, yawToHeadingDeg } from './camera-pose';

describe('camera pose maths', () => {
  it('orbit azimuth is clockwise from plan-up: 0 north (-z), 90 east (+x), 135 south-east', () => {
    const p = (azimuthDeg: number) => orbitPosition({ mode: 'orbit', target: [0, 0, 0], azimuthDeg, elevationDeg: 0.0001, distance: 10, fovDeg: 50 });
    expect(p(0)[2]).toBeCloseTo(-10);
    expect(p(90)[0]).toBeCloseTo(10);
    expect(p(135)[0]).toBeGreaterThan(0);
    expect(p(135)[2]).toBeGreaterThan(0);
  });

  it('walk heading is the negative of the three.js yaw', () => {
    expect((headingToYaw(90) * 180) / Math.PI).toBeCloseTo(-90);
    expect(yawToHeadingDeg(-37)).toBeCloseTo(37);
    expect(yawToHeadingDeg(37)).toBeCloseTo(323);
    expect(yawToHeadingDeg(0)).toBe(0);
    // heading 90 looks towards +x: forward = (-sin yaw, -cos yaw)
    expect(-Math.sin(headingToYaw(90))).toBeCloseTo(1);
  });

  it('top rotation turns the up vector counter-clockwise (the plan clockwise on screen)', () => {
    const up = topUp({ mode: 'top', center: [0, 0], halfHeight: 5, rotationDeg: 90 });
    expect(up[0]).toBeCloseTo(-1);
    expect(up[2]).toBeCloseTo(0);
    expect(topZoomFor({ mode: 'top', center: [0, 0], halfHeight: 5, rotationDeg: 0 }, 800)).toBe(80);
  });
});
