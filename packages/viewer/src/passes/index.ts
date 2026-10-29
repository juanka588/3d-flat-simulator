/**
 * Render passes (CG1): control images for the image-generation loop. See `render-passes.ts`.
 */
export { PASS_KINDS, isHelper, renderPasses } from './render-passes';
export type { DepthInfo, PassCamera, PassKind, PassSource, PassesRequest, PassesResult } from './render-passes';
export { CLASS_COLORS, PASS_CLASSES, SceneIndex, buildClassLegend, buildLegend, entityColor } from './legend';
export type { ClassLegendEntry, Entity, EntityKind, LegendEntry, PassClass } from './legend';
export { DEFAULT_EDGE_PARAMS, detectEdges } from './edges';
export type { EdgeParams } from './edges';
export { encodePng, pngDataUrl } from './png';
export type { RawImage } from './png';
