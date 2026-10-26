import { getPosition, getTimes } from 'suncalc';
import { tzOffset } from '@date-fns/tz';
import type { Site } from '../schema';
import type { Point3 } from '../camera';

/*
 * Sun geometry is exact (suncalc, apparent altitude incl. refraction); brightness is a simple
 * clear-sky model tuned for the screen. See docs/photometry.md.
 *
 * Conventions
 * -----------
 * - suncalc v2 reports azimuth as a compass bearing, clockwise from true north
 *   (0 = N, 90 = E, 180 = S, 270 = W). It is NOT the v1 convention (from south, towards west).
 * - World axes: X = plan x, Z = plan y (plan y points DOWN the page), Y = up.
 * - `site.northAngle` is the clockwise angle (seen on the plan) from plan "up" (-y) to true
 *   north. So true north appears on the plan at bearing `northAngle`, and a compass bearing b
 *   appears at plan bearing
 *
 *       planBearing = b + northAngle          (clockwise from plan "up", degrees)
 *
 *   A plan bearing p is the plan-space unit vector (x, y) = (sin p, -cos p), hence for a sun
 *   with compass azimuth A and altitude h the world direction (towards the sun) is
 *
 *       X =  sin(A + northAngle) * cos(h)
 *       Y =  sin(h)
 *       Z = -cos(A + northAngle) * cos(h)
 *
 *   Check: northAngle 0, sun due south (A = 180) -> X = 0, Z = +cos(h) (plan down). Sun due
 *   east (A = 90) -> X = +cos(h). northAngle 90 puts north on the right of the plan, east at
 *   the bottom (+Z).
 */

const RAD = Math.PI / 180;
/** Altitude of the sun's centre at sunrise/sunset (refraction + semi-diameter). */
export const HORIZON_ALTITUDE_DEG = -0.833;

export interface SunState {
  /** The UTC instant the local date/time resolved to. */
  instant: Date;
  /** Degrees above the horizon (negative below). */
  altitudeDeg: number;
  /** Compass bearing in degrees, clockwise from true north (0 = N, 90 = E, 180 = S). */
  azimuthDeg: number;
  /** Unit vector in world space pointing from the flat towards the sun (X = plan x, Z = plan y, Y = up). */
  direction: Point3;
  /** True when the sun's centre is above the apparent horizon (altitude > -0.833°). */
  isUp: boolean;
  /** Direct-sun illuminance on a surface facing the sun, in lux (0 when down); see docs/photometry.md. */
  illuminanceLux: number;
}

/** World-space unit vector towards a sun at compass `azimuthDeg` / `altitudeDeg` for a plan rotated by `northAngle`. */
export function sunDirection(azimuthDeg: number, altitudeDeg: number, northAngle = 0): Point3 {
  const plan = (azimuthDeg + northAngle) * RAD;
  const h = altitudeDeg * RAD;
  const c = Math.cos(h);
  return [Math.sin(plan) * c, Math.sin(h), -Math.cos(plan) * c];
}

/** Kasten–Young (1989) relative optical air mass for an apparent altitude in degrees (clamped to >= 0). */
export function airMass(altitudeDeg: number): number {
  const h = Math.max(0, altitudeDeg);
  return 1 / (Math.sin(h * RAD) + 0.50572 * Math.pow(h + 6.07995, -1.6364));
}

/** Extraterrestrial-ish illuminance scale and per-air-mass transmission of the clear-sky model. */
const SUN_E0 = 128000;
const SUN_TRANSMISSION = 0.8;

/**
 * Direct-normal illuminance of the sun under a clear sky: `E0 * T^airmass`, faded smoothly to 0
 * between the geometric horizon (-0.833°) and +2° so there is no step at sunrise.
 */
export function directSunLux(altitudeDeg: number): number {
  if (altitudeDeg <= HORIZON_ALTITUDE_DEG) return 0;
  const t = Math.min(1, (altitudeDeg - HORIZON_ALTITUDE_DEG) / (2 - HORIZON_ALTITUDE_DEG));
  const fade = t * t * (3 - 2 * t);
  return SUN_E0 * Math.pow(SUN_TRANSMISSION, airMass(altitudeDeg)) * fade;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseDate(date: string): [number, number, number] {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date "${date}": expected YYYY-MM-DD`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new Error(`Invalid date "${date}": no such calendar day`);
  }
  return [y, mo, d];
}

function parseTime(time: string): [number, number] {
  const m = TIME_RE.exec(time);
  if (!m) throw new Error(`Invalid time "${time}": expected HH:mm`);
  return [Number(m[1]), Number(m[2])];
}

function offsetMinutes(timezone: string, at: Date): number {
  let off: number;
  try {
    off = tzOffset(timezone, at);
  } catch {
    off = NaN;
  }
  if (!Number.isFinite(off)) throw new Error(`Unknown time zone "${timezone}"`);
  return off;
}

/**
 * Resolves a wall-clock date/time at the site to a UTC instant. DST gaps (non-existent local
 * times) resolve forward; DST overlaps (ambiguous times) resolve to the earlier instant.
 * Throws on a malformed or impossible date/time or an unknown time zone.
 */
export function localToInstant(date: string, time: string, timezone: string): Date {
  const [y, mo, d] = parseDate(date);
  const [h, mi] = parseTime(time);
  // The wall-clock time read as if it were UTC.
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const DAY = 24 * 3600_000;
  const before = offsetMinutes(timezone, new Date(wall - DAY)) * 60_000;
  const after = offsetMinutes(timezone, new Date(wall + DAY)) * 60_000;
  const candidates: number[] = [];
  for (const off of new Set([before, after])) {
    const t = wall - off;
    if (offsetMinutes(timezone, new Date(t)) * 60_000 === off) candidates.push(t);
  }
  if (candidates.length > 0) return new Date(Math.min(...candidates)); // overlap: earlier instant
  // Gap: apply the offset in force before the transition, which moves the time forward.
  return new Date(wall - before);
}

/** Sun state for a local date/time at the site. */
export function sunAt(site: Site, date: string, time: string): SunState {
  return sunAtInstant(site, localToInstant(date, time, site.timezone));
}

/** Sun state at a UTC instant. Applies `site.northAngle` when mapping to world space. */
export function sunAtInstant(site: Site, instant: Date): SunState {
  const pos = getPosition(instant, site.latitude, site.longitude);
  const altitudeDeg = pos.altitude;
  const azimuthDeg = ((pos.azimuth % 360) + 360) % 360;
  const isUp = altitudeDeg > HORIZON_ALTITUDE_DEG;
  return {
    instant,
    altitudeDeg,
    azimuthDeg,
    direction: sunDirection(azimuthDeg, altitudeDeg, site.northAngle),
    isUp,
    illuminanceLux: isUp ? directSunLux(altitudeDeg) : 0,
  };
}

export interface DayRange {
  /** Animation range: sunrise − 30 min → sunset + 30 min, or the full local day at the poles. */
  start: Date;
  end: Date;
  sunrise?: Date;
  sunset?: Date;
  solarNoon: Date;
  polar?: 'day' | 'night';
}

/** Date string of the day after `date`. */
function nextDate(date: string): string {
  const [y, mo, d] = parseDate(date);
  return new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
}

/** Start (inclusive) and end (exclusive) instants of a local civil day: 23 h, 24 h or 25 h long. */
export function localDayBounds(date: string, timezone: string): { start: Date; end: Date } {
  return {
    start: localToInstant(date, '00:00', timezone),
    end: localToInstant(nextDate(date), '00:00', timezone),
  };
}

const HALF_HOUR = 30 * 60_000;

/**
 * Daylight range for a local date at the site: sunrise − 30 min → sunset + 30 min, clamped to
 * the local civil day. When the sun does not rise or set that day, the full local day is
 * returned with `polar` set.
 */
export function dayRange(site: Site, date: string): DayRange {
  const { start: dayStart, end: dayEnd } = localDayBounds(date, site.timezone);
  const noon = localToInstant(date, '12:00', site.timezone);
  const utcOffset = offsetMinutes(site.timezone, noon);
  // With a utcOffset, getTimes works on the civil day (fixed offset) containing `noon`.
  const times = getTimes(noon, site.latitude, site.longitude, undefined, utcOffset);
  const solarNoon = times.solarNoon;
  const { sunrise, sunset } = times;
  if (sunrise && sunset) {
    const start = new Date(Math.max(dayStart.getTime(), sunrise.getTime() - HALF_HOUR));
    const end = new Date(Math.min(dayEnd.getTime(), sunset.getTime() + HALF_HOUR));
    if (start < end) return { start, end, sunrise, sunset, solarNoon };
  }
  const polar: 'day' | 'night' = times.alwaysUp
    ? 'day'
    : times.alwaysDown
      ? 'night'
      : getPosition(solarNoon, site.latitude, site.longitude).altitude > HORIZON_ALTITUDE_DEG
        ? 'day'
        : 'night';
  return { start: dayStart, end: dayEnd, solarNoon, polar };
}

export interface SkyState {
  /** Diffuse sky illuminance on a horizontal surface, lux. 0 below astronomical night (−18°). */
  ambientLux: number;
  /** Sky colour at zenith and horizon (linear RGB 0–1) for hemisphere lighting. */
  zenithColor: Point3;
  horizonColor: Point3;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Piecewise smoothstep interpolation through `(x, y[])` keyframes; clamped outside. */
function keyframes(x: number, frames: ReadonlyArray<readonly [number, ...number[]]>): number[] {
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  if (x <= first[0]) return first.slice(1);
  if (x >= last[0]) return last.slice(1);
  let i = 0;
  while (frames[i + 1]![0] < x) i++;
  const a = frames[i]!;
  const b = frames[i + 1]!;
  const t = smooth((x - a[0]) / (b[0] - a[0]));
  return a.slice(1).map((v, k) => v + (b[k + 1]! - v) * t);
}

/** log10(diffuse horizontal illuminance in lux) of a clear sky versus sun altitude. */
const AMBIENT_LOG_LUX: ReadonlyArray<readonly [number, number]> = [
  [-18, -3], // starlight / airglow, ~0.001 lx
  [-12, -1],
  [-6, 0.5], // civil twilight ~ 3 lx
  [-0.833, 2.6], // sunrise ~ 400 lx
  [6, 3.7],
  [15, 4.0],
  [30, 4.15],
  [60, 4.22],
  [90, 4.25], // ~ 17.8 klx
];

// rows: [altitude, r, g, b] in linear RGB
const ZENITH: ReadonlyArray<readonly [number, number, number, number]> = [
  [-18, 0.001, 0.002, 0.006],
  [-6, 0.01, 0.02, 0.07],
  [0, 0.05, 0.1, 0.35],
  [10, 0.08, 0.2, 0.7],
  [30, 0.1, 0.27, 0.9],
];
const HORIZON: ReadonlyArray<readonly [number, number, number, number]> = [
  [-18, 0.003, 0.004, 0.01],
  [-8, 0.02, 0.02, 0.05],
  [0, 0.9, 0.35, 0.12], // warm band at sunrise/sunset
  [6, 0.9, 0.55, 0.35],
  [20, 0.65, 0.75, 0.9],
];

/** Continuous sky/ambient model as a function of sun altitude. */
export function skyState(altitudeDeg: number): SkyState {
  let ambientLux = 0;
  if (altitudeDeg > -18) {
    const [lg] = keyframes(altitudeDeg, AMBIENT_LOG_LUX);
    ambientLux = Math.max(0, Math.pow(10, lg!) - 0.001);
  }
  const z = keyframes(altitudeDeg, ZENITH);
  const h = keyframes(altitudeDeg, HORIZON);
  return {
    ambientLux,
    zenithColor: [z[0]!, z[1]!, z[2]!],
    horizonColor: [h[0]!, h[1]!, h[2]!],
  };
}

/** Power-law exponent of the exposure curve (partial adaptation); see docs/photometry.md. */
const EXPOSURE_GAMMA = 0.7;
const EXPOSURE_K = 0.3718;
/** Soft floor (lux) so a pitch-dark scene gets a finite, bounded exposure without clamping. */
const EXPOSURE_FLOOR_LUX = 0.05;

/**
 * Exposure (multiplier for renderer.toneMappingExposure) for the current light levels, before
 * the user's EV compensation. `exposure = 0.3718 · (E + 0.05)^-0.7` with `E` the total
 * illuminance (sun + sky + lamps, lux): smooth and strictly decreasing. About 1.2e-4 for a
 * clear noon, about 1e-2 for a 150 lx lamp-lit room.
 */
export function autoExposure(sunLux: number, ambientLux: number, lampLux: number): number {
  const e = Math.max(0, sunLux) + Math.max(0, ambientLux) + Math.max(0, lampLux);
  return EXPOSURE_K * Math.pow(e + EXPOSURE_FLOOR_LUX, -EXPOSURE_GAMMA);
}
