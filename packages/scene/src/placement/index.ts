export * from './types';
export { solvePlacement, MAX_SAMPLES, SAMPLE_STEP_M, SOLVE_BUDGET_MS, DEFAULT_WALL_MOUNT_ELEVATION_M } from './solve';
export { validateLayout } from './validateLayout';
export { footprintOf, itemDims, itemMountOf, frontOf, rightOf, penetration, overlaps, FLAT_MAX_H, TOUCH_TOLERANCE } from './footprint';
export { doorSwingPolygon, openingZones, LANDING_DEPTH_M, PASSAGE_DEPTH_M, APPROACH_DEPTH_M, type Zone } from './swing';
export { analyzeWalkways, RASTER_STEP_M } from './walkways';
export { checkSubject, layoutContext, CHEAP_RULES, ALL_RULES, type Subject, type Rule, type LayoutContext } from './constraints';
export { compassWord } from './relations';
