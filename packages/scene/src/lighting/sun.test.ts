import { describe, expect, it } from 'vitest';
import { getTimes } from 'suncalc';
import type { Site } from '../schema';
import {
  autoExposure,
  dayRange,
  localDayBounds,
  localToInstant,
  skyState,
  sunAt,
  sunAtInstant,
  sunDirection,
} from './sun';

const paris: Site = { latitude: 48.8566, longitude: 2.3522, northAngle: 0, timezone: 'Europe/Paris', floorElevation: 0 };
const noon = (site: Site, date: string) => getTimes(new Date(`${date}T12:00:00Z`), site.latitude, site.longitude).solarNoon;

describe('localToInstant', () => {
  it('converts summer and winter times', () => {
    expect(localToInstant('2026-06-21', '12:00', 'Europe/Paris').toISOString()).toBe('2026-06-21T10:00:00.000Z');
    expect(localToInstant('2026-12-21', '12:00', 'Europe/Paris').toISOString()).toBe('2026-12-21T11:00:00.000Z');
  });
  it('resolves the spring-forward gap forward', () => {
    expect(localToInstant('2026-03-29', '02:30', 'Europe/Paris').toISOString()).toBe('2026-03-29T01:30:00.000Z'); // 03:30 CEST
  });
  it('resolves the fall-back overlap to the earlier instant', () => {
    expect(localToInstant('2026-10-25', '02:30', 'Europe/Paris').toISOString()).toBe('2026-10-25T00:30:00.000Z'); // CEST
  });
  it('works for zones west of UTC and half-hour zones', () => {
    expect(localToInstant('2026-01-15', '08:00', 'America/New_York').toISOString()).toBe('2026-01-15T13:00:00.000Z');
    expect(localToInstant('2026-01-15', '08:00', 'Asia/Kolkata').toISOString()).toBe('2026-01-15T02:30:00.000Z');
  });
  it('throws clear errors on bad input', () => {
    expect(() => localToInstant('2026-13-01', '12:00', 'UTC')).toThrow(/Invalid date/);
    expect(() => localToInstant('2026-02-30', '12:00', 'UTC')).toThrow(/no such calendar day/);
    expect(() => localToInstant('21/06/2026', '12:00', 'UTC')).toThrow(/Invalid date/);
    expect(() => localToInstant('2026-06-21', '25:00', 'UTC')).toThrow(/Invalid time/);
    expect(() => localToInstant('2026-06-21', '9:00', 'UTC')).toThrow(/Invalid time/);
    expect(() => localToInstant('2026-06-21', '12:00', 'Mars/Olympus')).toThrow(/time zone/);
  });
});

describe('sunAtInstant', () => {
  it('Paris 21 Jun solar noon: altitude ~64.6, due south', () => {
    const s = sunAtInstant(paris, noon(paris, '2026-06-21'));
    expect(s.altitudeDeg).toBeCloseTo(64.6, 0);
    expect(Math.abs(s.altitudeDeg - 64.6)).toBeLessThan(0.3);
    expect(Math.abs(s.azimuthDeg - 180)).toBeLessThan(1);
    expect(s.isUp).toBe(true);
    expect(s.illuminanceLux).toBeGreaterThan(70_000);
    expect(s.illuminanceLux).toBeLessThan(105_000);
  });
  it('Paris 21 Dec solar noon: altitude ~17.7', () => {
    const s = sunAtInstant(paris, noon(paris, '2026-12-21'));
    expect(Math.abs(s.altitudeDeg - 17.7)).toBeLessThan(0.3);
  });
  it('equator at the equinox: sun at the zenith', () => {
    const eq: Site = { ...paris, latitude: 0, longitude: 0, timezone: 'UTC' };
    const s = sunAtInstant(eq, noon(eq, '2026-03-20'));
    expect(s.altitudeDeg).toBeGreaterThan(88.5);
  });
  it('sunAt goes through local time', () => {
    const s = sunAt(paris, '2026-06-21', '14:00');
    expect(s.instant.toISOString()).toBe('2026-06-21T12:00:00.000Z');
    expect(s.altitudeDeg).toBeGreaterThan(60);
  });
  it('below the horizon: not up, zero illuminance', () => {
    const s = sunAt(paris, '2026-12-21', '23:00');
    expect(s.altitudeDeg).toBeLessThan(0);
    expect(s.isUp).toBe(false);
    expect(s.illuminanceLux).toBe(0);
  });
  it('illuminance is smooth and non-decreasing with altitude on a morning', () => {
    let prev = 0;
    for (let m = 0; m <= 360; m += 5) {
      const s = sunAtInstant(paris, new Date(Date.parse('2026-06-21T02:00:00Z') + m * 60_000));
      expect(s.illuminanceLux).toBeGreaterThanOrEqual(prev - 1e-6);
      if (prev > 0) expect(s.illuminanceLux - prev).toBeLessThan(15_000);
      prev = s.illuminanceLux;
    }
  });
});

describe('sunDirection / northAngle convention', () => {
  const near = (v: number[], w: number[]) => v.forEach((x, i) => expect(x).toBeCloseTo(w[i]!, 9));
  it('northAngle 0: sun due south -> +Z (plan down), Y > 0', () => {
    const d = sunDirection(180, 30, 0);
    expect(d[2]).toBeGreaterThan(0.8);
    expect(d[1]).toBeGreaterThan(0);
    expect(d[0]).toBeCloseTo(0, 9);
  });
  it('northAngle 0: sun due east -> +X, north -> -Z, west -> -X', () => {
    near(sunDirection(90, 0, 0), [1, 0, 0]);
    near(sunDirection(0, 0, 0), [0, 0, -1]);
    near(sunDirection(270, 0, 0), [-1, 0, 0]);
  });
  it('plan bearing = compass bearing + northAngle', () => {
    // north appears at plan bearing northAngle: northAngle 90 -> north points to plan right (+X)
    near(sunDirection(0, 0, 90), [1, 0, 0]);
    // east then appears at plan bearing 180 -> plan down (+Z)
    near(sunDirection(90, 0, 90), [0, 0, 1]);
    near(sunDirection(0, 0, 180), [0, 0, 1]); // north at the bottom
    near(sunDirection(0, 0, 270), [-1, 0, 0]); // north on the left
    near(sunDirection(180, 0, 270), [1, 0, 0]);
  });
  it('is a unit vector and sunAtInstant applies northAngle', () => {
    const t = noon(paris, '2026-06-21');
    const a = sunAtInstant({ ...paris, northAngle: 0 }, t);
    const b = sunAtInstant({ ...paris, northAngle: 90 }, t);
    expect(Math.hypot(...a.direction)).toBeCloseTo(1, 9);
    expect(a.direction[2]).toBeGreaterThan(0.3); // south
    expect(b.direction[0]).toBeLessThan(-0.3); // south with north on the right -> south on the left
  });
});

describe('dayRange', () => {
  it('normal day: sunrise - 30 min to sunset + 30 min', () => {
    const r = dayRange(paris, '2026-06-21');
    expect(r.polar).toBeUndefined();
    expect(r.start.getTime()).toBe(r.sunrise!.getTime() - 30 * 60_000);
    expect(r.end.getTime()).toBe(r.sunset!.getTime() + 30 * 60_000);
    // Paris 21 Jun: sunrise ~05:47 CEST (03:47Z), sunset ~21:58 CEST
    expect(r.sunrise!.toISOString().slice(11, 13)).toBe('03');
    expect(r.solarNoon.getTime()).toBeGreaterThan(r.start.getTime());
    expect(r.solarNoon.getTime()).toBeLessThan(r.end.getTime());
  });
  const tromso: Site = { ...paris, latitude: 69.65, longitude: 18.96, timezone: 'Europe/Oslo' };
  it('polar day / night fall back to the full local day', () => {
    const jun = dayRange(tromso, '2026-06-21');
    expect(jun.polar).toBe('day');
    expect(jun.start.toISOString()).toBe('2026-06-20T22:00:00.000Z');
    expect(jun.end.toISOString()).toBe('2026-06-21T22:00:00.000Z');
    const dec = dayRange(tromso, '2026-12-21');
    expect(dec.polar).toBe('night');
    expect(dec.end.getTime() - dec.start.getTime()).toBe(24 * 3600_000);
  });
  it('local days are 23 h / 25 h on DST days', () => {
    const h = (d: string) => {
      const b = localDayBounds(d, 'Europe/Paris');
      return (b.end.getTime() - b.start.getTime()) / 3600_000;
    };
    expect(h('2026-03-29')).toBe(23);
    expect(h('2026-10-25')).toBe(25);
    expect(h('2026-06-21')).toBe(24);
  });
  it('is monotonic on DST days', () => {
    for (const d of ['2026-03-29', '2026-10-25']) {
      const r = dayRange(paris, d);
      expect(r.start.getTime()).toBeLessThan(r.solarNoon.getTime());
      expect(r.solarNoon.getTime()).toBeLessThan(r.end.getTime());
      const hrs = (r.end.getTime() - r.start.getTime()) / 3600_000;
      expect(hrs).toBeGreaterThan(10);
      expect(hrs).toBeLessThan(25);
    }
  });
});

describe('skyState', () => {
  it('ambient is 0 below -18, monotonic up to 90, and 10-20 klux at high sun', () => {
    expect(skyState(-18.01).ambientLux).toBe(0);
    expect(skyState(-40).ambientLux).toBe(0);
    let prev = -1;
    for (let a = -20; a <= 90; a += 0.1) {
      const v = skyState(a).ambientLux;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    const high = skyState(60).ambientLux;
    expect(high).toBeGreaterThan(10_000);
    expect(high).toBeLessThan(20_000);
  });
  it('is continuous (relative step per 0.1 deg is small, none at -18)', () => {
    for (let a = -18; a < 90; a += 0.1) {
      const x = skyState(a);
      const y = skyState(a + 0.1);
      expect(y.ambientLux - x.ambientLux).toBeLessThan(0.2 * Math.max(x.ambientLux, 1) + 0.01);
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(y.zenithColor[i]! - x.zenithColor[i]!)).toBeLessThan(0.02);
        expect(Math.abs(y.horizonColor[i]! - x.horizonColor[i]!)).toBeLessThan(0.02);
      }
    }
  });
  it('colours are plausible', () => {
    const day = skyState(50);
    expect(day.zenithColor[2]).toBeGreaterThan(day.zenithColor[0] * 3);
    expect(day.zenithColor[2]).toBeGreaterThan(day.zenithColor[1]);
    const dusk = skyState(1);
    expect(dusk.horizonColor[0]).toBeGreaterThan(dusk.horizonColor[2] * 1.5);
    const night = skyState(-30);
    for (const c of [...night.zenithColor, ...night.horizonColor]) expect(c).toBeLessThan(0.02);
  });
});

describe('autoExposure', () => {
  it('maps clear noon to ~1e-4 and a 150 lx room to ~1e-2', () => {
    const sun = sunAtInstant(paris, noon(paris, '2026-06-21')).illuminanceLux;
    const noonExp = autoExposure(sun, skyState(64.6).ambientLux, 0);
    expect(noonExp).toBeGreaterThan(5e-5);
    expect(noonExp).toBeLessThan(3e-4);
    const room = autoExposure(0, 0, 150);
    expect(room).toBeGreaterThan(5e-3);
    expect(room).toBeLessThan(3e-2);
  });
  it('is strictly decreasing in total light and finite in the dark', () => {
    let prev = Infinity;
    for (let e = -3; e <= 5.2; e += 0.05) {
      const v = autoExposure(0, 0, 10 ** e);
      expect(v).toBeLessThan(prev);
      prev = v;
    }
    expect(Number.isFinite(autoExposure(0, 0, 0))).toBe(true);
    expect(autoExposure(1000, 0, 0)).toBeCloseTo(autoExposure(0, 400, 600), 12);
  });
});
