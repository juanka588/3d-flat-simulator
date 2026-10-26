import type { Site } from '../schema';
import type { Point3 } from '../camera';

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

/**
 * Resolves a wall-clock date/time at the site to a UTC instant. DST gaps (non-existent local
 * times) resolve forward; DST overlaps (ambiguous times) resolve to the earlier instant. (M2.1 — stub)
 */
export function localToInstant(_date: string, _time: string, _timezone: string): Date {
  throw new Error('not implemented');
}

/** Sun state for a local date/time at the site. (M2.1 — stub) */
export function sunAt(site: Site, date: string, time: string): SunState {
  return sunAtInstant(site, localToInstant(date, time, site.timezone));
}

/** Sun state at a UTC instant. Applies `site.northAngle` when mapping to world space. (M2.1 — stub) */
export function sunAtInstant(_site: Site, _instant: Date): SunState {
  throw new Error('not implemented');
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

/** Daylight range for a local date at the site. (M2.5 — stub) */
export function dayRange(_site: Site, _date: string): DayRange {
  throw new Error('not implemented');
}

export interface SkyState {
  /** Diffuse sky illuminance on a horizontal surface, lux. 0 below astronomical night (−18°). */
  ambientLux: number;
  /** Sky colour at zenith and horizon (linear RGB 0–1) for hemisphere lighting. */
  zenithColor: Point3;
  horizonColor: Point3;
}

/** Continuous sky/ambient model as a function of sun altitude. (M2.4 — stub) */
export function skyState(_altitudeDeg: number): SkyState {
  throw new Error('not implemented');
}

/**
 * Exposure (multiplier for renderer.toneMappingExposure) for the current light levels, before
 * the user's EV compensation. Smooth and monotonic; documented in docs/photometry.md. (M2.0 — stub)
 */
export function autoExposure(_sunLux: number, _ambientLux: number, _lampLux: number): number {
  throw new Error('not implemented');
}
