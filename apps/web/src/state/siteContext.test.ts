import { describe, expect, it } from 'vitest';
import type { SiteContext } from '@flat/scene';
import { alignContext, originDriftMeters } from './siteContext';

const context: SiteContext = {
  version: 1,
  source: 'test',
  origin: { latitude: 48.785911, longitude: 2.303968 },
  northAngle: 0,
  buildings: [
    // 10 m "north" of the flat (plan up is -y), standing on the ground 5.8 m below the floor.
    { id: 'n', footprint: [[0, -10], [2, -10], [2, -12]], base: -5.8, height: 20, host: false },
    { id: 'roof', footprint: [[5, 0], [6, 0], [6, 1]], base: 2.8, height: 3, host: false },
  ],
};
const site = { latitude: 48.785911, longitude: 2.303968, northAngle: 0, floorElevation: 5.8 };

describe('alignContext', () => {
  it('returns the very same context when the site still matches', () => {
    const out = alignContext(context, site);
    expect(out.stale).toBe(false);
    expect(out.context).toBe(context);
  });

  it('rotates clockwise on the plan by the northAngle difference', () => {
    // North was at plan up; the site now puts north on the right (90 degrees clockwise).
    const out = alignContext(context, { ...site, northAngle: 90 }).context!;
    const [a] = out.buildings[0]!.footprint;
    expect(a![0]).toBeCloseTo(10, 9); // the building that was 10 m up is now 10 m to the right
    expect(a![1]).toBeCloseTo(0, 9);
    expect(out.northAngle).toBe(90);
    // 180 degrees: up becomes down (+y).
    const down = alignContext(context, { ...site, northAngle: 180 }).context!.buildings[0]!.footprint[0]!;
    expect(down[0]).toBeCloseTo(0, 9);
    expect(down[1]).toBeCloseTo(10, 9);
  });

  it('is relative to the context northAngle and keeps distances from the flat', () => {
    const rotated = { ...context, northAngle: 30 };
    const out = alignContext(rotated, { ...site, northAngle: 30 });
    expect(out.context).toBe(rotated);
    const turned = alignContext(rotated, { ...site, northAngle: 75 }).context!;
    const [x, y] = turned.buildings[0]!.footprint[1]!;
    expect(Math.hypot(x, y)).toBeCloseTo(Math.hypot(2, -10), 9);
  });

  it('shifts the bases by the floor elevation difference', () => {
    const out = alignContext(context, { ...site, floorElevation: 8.8 }).context!; // flat is 3 m higher above the ground
    const bases = out.buildings.map((b) => b.base);
    expect(bases[0]).toBeCloseTo(-8.8, 9);
    expect(bases[1]).toBeCloseTo(-0.2, 9);
    expect(out.buildings[0]!.height).toBe(20);
  });

  it('hides a context whose origin is far from the site, keeps one within 50 m', () => {
    expect(alignContext(context, { ...site, latitude: site.latitude + 0.001 }).stale).toBe(true); // ~111 m
    expect(alignContext(context, { ...site, latitude: site.latitude + 0.0002 }).stale).toBe(false); // ~22 m
    expect(alignContext(context, { ...site, longitude: site.longitude + 0.001 }).context).toBeNull(); // ~73 m at 48.8 N
    expect(originDriftMeters(context, { ...site, latitude: site.latitude + 0.001 })).toBeCloseTo(111.32, 1);
  });
});
