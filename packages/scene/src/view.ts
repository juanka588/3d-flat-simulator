import { z } from 'zod';
import type { Light, Site } from './schema';

/**
 * Lighting part of the view state: everything about *when* and *how* the flat is lit that is
 * not part of the flat itself. Lives outside `Scene` (not undoable, not saved with the flat),
 * but is a plain serialisable object so the MCP server can set it (`set_sun_time`).
 */

const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');

export const LampOverride = z.strictObject({
  on: z.boolean().optional(),
  lumens: z.number().nonnegative().optional(),
  kelvin: z.number().min(1000).max(12000).optional(),
});
export type LampOverride = z.infer<typeof LampOverride>;

export const PresetName = z.enum(['day', 'evening', 'night']);
export type PresetName = z.infer<typeof PresetName>;

export const LightingView = z.strictObject({
  /** Local date/time at the site (interpreted in `site.timezone`). */
  date: LocalDate,
  time: LocalTime,
  /** Whether the sun/sky contribute at all (false = "lamps only" study). */
  sunEnabled: z.boolean().default(true),
  /** Per-lamp overrides keyed by light id; absent keys use the scene's values. */
  lamps: z.record(z.string(), LampOverride).default({}),
  /** Manual exposure compensation in EV stops on top of auto exposure. */
  exposureEV: z.number().min(-6).max(6).default(0),
  /** Show neighbouring buildings from the site context when available. */
  showContext: z.boolean().default(true),
});
export type LightingView = z.infer<typeof LightingView>;

export const DEFAULT_LIGHTING: LightingView = {
  date: '2026-06-21',
  time: '12:00',
  sunEnabled: true,
  lamps: {},
  exposureEV: 0,
  showContext: true,
};

/**
 * Applies a lighting preset as a pure transform of the lighting view (the scene is untouched):
 * - day: local 12:00, sun on, every lamp off;
 * - evening: 20:00 on the winter solstice of the view's year (21 Dec, or 21 Jun in the
 *   southern hemisphere), sun on (it is below the horizon), every lamp on;
 * - night: 23:00, sun disabled, every lamp on.
 * Lamp overrides other than `on` (lumens, kelvin) and overrides of unknown ids are preserved.
 */
export function applyPreset(view: LightingView, preset: PresetName, site: Site, lights: Light[]): LightingView {
  const lampsOn = preset !== 'day';
  const lamps: LightingView['lamps'] = { ...view.lamps };
  for (const l of lights) lamps[l.id] = { ...lamps[l.id], on: lampsOn };
  switch (preset) {
    case 'day':
      return { ...view, time: '12:00', sunEnabled: true, lamps };
    case 'evening': {
      const year = view.date.slice(0, 4);
      return { ...view, date: `${year}-${site.latitude < 0 ? '06' : '12'}-21`, time: '20:00', sunEnabled: true, lamps };
    }
    case 'night':
      return { ...view, time: '23:00', sunEnabled: false, lamps };
  }
}
