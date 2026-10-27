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

// ---------------------------------------------------------------------------------------------
// Camera pose (M4): a serialisable, renderer-independent description of where the camera is.
// ---------------------------------------------------------------------------------------------

/** Coordinates: metres in WORLD space, X = plan x, Y = up, Z = plan y (see `schema.ts`). */
const World3 = z.tuple([z.number(), z.number(), z.number()]);
/** Metres on the plan, `[x, y]` (y grows down the page). */
const Plan2 = z.tuple([z.number(), z.number()]);
const Degrees = z.number().min(-360).max(360);

/** Orbit camera looking at `target` from `distance` metres away. */
export const OrbitPose = z.strictObject({
  mode: z.literal('orbit'),
  /** World point the camera looks at (X = plan x, Y = up, Z = plan y). */
  target: World3,
  /** Horizontal angle of the camera around `target`, degrees clockwise on the plan from plan-up (-y); 0 = camera north of the target on the plan page, looking down the page. */
  azimuthDeg: Degrees,
  /** Angle above the horizon, degrees (5 = nearly level, 89 = nearly straight down). */
  elevationDeg: z.number().min(5).max(89),
  distance: z.number().positive().max(200),
  fovDeg: z.number().min(10).max(110).default(50),
});

/** First-person camera. */
export const WalkPose = z.strictObject({
  mode: z.literal('walk'),
  /** Eye position on the plan. */
  position: Plan2,
  /** Eye height above the floor, metres (default eye level is about 1.6). */
  eyeHeight: z.number().min(0.3).max(3).default(1.6),
  /**
   * Looking direction on the PLAN, degrees clockwise from plan-up (-y): 0 looks towards the top of
   * the page, 90 towards +x. (three.js `rotation.y` is the negative of this: positive turns left.)
   */
  headingDeg: Degrees,
  /** Up/down tilt, degrees (positive looks up). */
  pitchDeg: z.number().min(-80).max(80).default(0),
  fovDeg: z.number().min(30).max(120).default(70),
});

/** Orthographic plan view looking straight down; plan-up (-y) is screen-up unless rotated. */
export const TopPose = z.strictObject({
  mode: z.literal('top'),
  center: Plan2,
  /** Half of the visible height in metres. */
  halfHeight: z.number().positive().max(200),
  /** Clockwise rotation of the plan on screen, degrees (0 = plan-up is screen-up). */
  rotationDeg: Degrees.default(0),
});

/**
 * Where the camera is, for one render or one `setCamera` call. Discriminated on `mode`.
 * Build poses with the pure presets in `camera-presets.ts`; apply them with `__flat.setCamera`.
 */
export const CameraPose = z.discriminatedUnion('mode', [OrbitPose, WalkPose, TopPose]);
export type OrbitPose = z.infer<typeof OrbitPose>;
export type WalkPose = z.infer<typeof WalkPose>;
export type TopPose = z.infer<typeof TopPose>;
export type CameraPose = z.infer<typeof CameraPose>;
