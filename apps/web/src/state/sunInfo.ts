import { dayRange, sunAt } from '@flat/scene';
import type { LightingView, Scene } from '@flat/scene';
import { instantToLocal } from './localTime';

export type SunInfo =
  | {
      available: true;
      date: string;
      time: string;
      altitudeDeg: number;
      azimuthDeg: number;
      isUp: boolean;
      illuminanceLux: number;
      /** World unit vector towards the sun. */
      direction: [number, number, number];
      /** Local HH:mm at the site; absent when the sun does not rise/set that day. */
      sunrise?: string;
      sunset?: string;
      polar?: 'day' | 'night';
      /** Animation/slider range as local HH:mm. */
      rangeStart: string;
      rangeEnd: string;
    }
  | { available: false; error: string };

/** Sun position and daylight times for the lighting view, or the reason they are unavailable. */
export function sunInfoFor(scene: Scene, lighting: LightingView): SunInfo {
  try {
    const { site } = scene;
    const sun = sunAt(site, lighting.date, lighting.time);
    const range = dayRange(site, lighting.date);
    const local = (d: Date | undefined) => (d ? instantToLocal(d, site.timezone).time : undefined);
    return {
      available: true,
      date: lighting.date,
      time: lighting.time,
      altitudeDeg: sun.altitudeDeg,
      azimuthDeg: sun.azimuthDeg,
      isUp: sun.isUp,
      illuminanceLux: sun.illuminanceLux,
      direction: [sun.direction[0], sun.direction[1], sun.direction[2]],
      sunrise: local(range.sunrise),
      sunset: local(range.sunset),
      polar: range.polar,
      rangeStart: local(range.start)!,
      // A range reaching the next midnight (polar day) ends at the last minute of the date.
      rangeEnd: instantToLocal(range.end, site.timezone).date === lighting.date ? local(range.end)! : '23:59',
    };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}
