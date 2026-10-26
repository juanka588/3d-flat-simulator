import { z } from 'zod';

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
