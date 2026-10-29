export * from './types';
export { LocalSidecarProvider, DEFAULT_SIDECAR_URL, type LocalSidecarOptions } from './localSidecar';
export { OpenAIImageProvider, GeminiImageProvider, assertOwnImages } from './apiProviders';
export { FakeImageProvider, TINY_PNG_B64 } from './fake';
export { buildReferencePrompt, buildVisualisationPrompt, ROOM_TEMPLATES, type BuiltPrompt } from './prompts';
export {
  ControlsUnavailableError,
  getControlImageSource,
  getImageProvider,
  providerFromEnv,
  setControlImageSource,
  setImageProvider,
  unavailableControls,
  type ControlImageSource,
  type ControlImages,
  type ControlImagesRequest,
} from './wiring';
