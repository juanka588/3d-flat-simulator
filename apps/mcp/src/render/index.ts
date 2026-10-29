export { BrowserRenderer, BUILD_HINT, DEFAULT_DIST, IDLE_MS, QueueBusyError, SerialQueue, SessionError, clampSize, closeSharedRenderer, sharedRenderer, type RenderOutput, type RenderRequest, type RendererOptions } from './browserRenderer';
export { RenderError, type RenderFailureCode } from './errors';
export { McpRenderer, sharedMcpRenderer, type McpRenderResult } from './service';
export { nearestIds, resolveLighting, resolvePose } from './resolve';
export { chromiumShrinker, closeShrinker, type ImageShrinker, type RawImage, type ShrunkImage } from './shrink';
