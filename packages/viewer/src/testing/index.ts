/**
 * `@flat/viewer/testing`: the viewer internals that `apps/web/src/testHook*.ts` (the `window.__flat` surface behind the
 * e2e specs and the MCP `render_view`) and e2e specs need. Not for app code.
 */
export { appliedPose, yawToHeadingDeg } from '../camera-pose';
export { setModelOriginOverride } from '../config';
export { setMeshResolverOverride, setProviderFrontOverride, modelsSettled } from '../model-runtime';
export { transformBox } from '../model-math';
export { probeControls, probeStats, probesSettled } from '../probe-runtime';
export { textureStats, texturesSettled } from '../texture-cache';
export { stepWalker } from '../walk-input';
export * from './synthetic-glb';
export * from '../passes';
