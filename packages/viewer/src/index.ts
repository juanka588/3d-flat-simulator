/**
 * `@flat/viewer`: the react-three-fiber rendering library (docs/architecture/modules.md section 1.4).
 * `<FlatCanvas scene view />` draws a Scene for a ViewState; the host app owns every piece of chrome around it and
 * tells the viewer where its files are with `configureViewer`.
 */
export { FlatCanvas } from './FlatCanvas';
export type { FlatCanvasProps } from './FlatCanvas';

export { configureViewer } from './config';
export type { ViewerAssetConfig } from './config';

// View state and selection.
export { BUILDING_MODES } from './view-types';
export type { BuildingMode, Selection, ViewMode, ViewState } from './view-types';
export { selectionForId, selectionForWallFace, wallRoomsAt, zoneSelectionId } from './selection';
export type { WallFaceTarget } from './selection';
export { adoptSceneIdentity, sceneKey } from './scene-identity';
export { shellFor } from './shell-cache';

// Walk mode.
export { DEFAULT_PERSON_HEIGHT_CM, MAX_PERSON_HEIGHT_CM, MIN_PERSON_HEIGHT_CM, clampPersonHeightCm, eyeHeightM } from './walk-camera';
export type { PersonPlacement } from './walk-start';

// Health, model runtime read API and where the library's files live.
export { messageOf, useViewerHealth } from './viewer-health';
export { modelStats } from './model-runtime';
export type { DimsWarning, ModelStats } from './model-types';
export type { ProbeStats } from './probe-runtime';
export { useModelRevision } from './use-model-revision';
export { hdModelsBase, modelsBase } from './model-env';
export { libraryCatalog, thumbUrl } from './catalog';
export type { PassCamera, PassKind, PassesRequest, PassesResult } from './passes';
