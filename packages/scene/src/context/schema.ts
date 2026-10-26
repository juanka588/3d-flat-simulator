import { z } from 'zod';
import { Vec2 } from '../schema';

/**
 * Site context: surrounding buildings around a flat, in the flat's plan coordinates (metres,
 * same axes as the Scene), so they can be rendered and cast shadows. Generated offline from
 * IGN BD TOPO by `tools/site-context` and stored next to the flat as `*.context.json`.
 */
export const ContextBuilding = z.strictObject({
  id: z.string(),
  /** Footprint polygon in flat plan coordinates. */
  footprint: z.array(Vec2).min(3),
  /** Ground level relative to the flat's floor (usually −site.floorElevation). */
  base: z.number(),
  /** Building height above its ground level, metres. */
  height: z.number().positive(),
  /** The building that contains the flat (rendered without the flat's own volume). */
  host: z.boolean().default(false),
});
export type ContextBuilding = z.infer<typeof ContextBuilding>;

export const SiteContext = z.strictObject({
  version: z.literal(1),
  source: z.string(),
  /** WGS84 position of the flat's plan origin. */
  origin: z.strictObject({ latitude: z.number(), longitude: z.number() }),
  /**
   * Clockwise angle from plan "up" to true north that aligns the plan with the map; the scene's
   * `site.northAngle` should match it.
   */
  northAngle: z.number(),
  buildings: z.array(ContextBuilding).max(2000),
});
export type SiteContext = z.infer<typeof SiteContext>;
