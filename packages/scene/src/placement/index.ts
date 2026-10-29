export * from './types';
export { solvePlacement, type SolveStats, MAX_SAMPLES, SAMPLE_STEP_M, SOLVE_MAX_EVALUATIONS, DEFAULT_WALL_MOUNT_ELEVATION_M } from './solve';
export { validateLayout } from './validateLayout';
export { footprintOf, rotationFacing, itemDims, itemMountOf, frontOf, rightOf, penetration, overlaps, FLAT_MAX_H, TOUCH_TOLERANCE } from './footprint';
export { doorSwingPolygon, openingFrame, type OpeningFrame, openingZones, LANDING_DEPTH_M, PASSAGE_DEPTH_M, APPROACH_DEPTH_M, type Zone } from './swing';
export { analyzeWalkways, RASTER_STEP_M } from './walkways';
export { checkSubject, layoutContext, CHEAP_RULES, ALL_RULES, type Subject, type Rule, type LayoutContext } from './constraints';
export { compassWord } from './relations';
