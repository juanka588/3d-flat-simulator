import type { CameraPose, Scene } from '@flat/scene';
import { GeminiImageProvider, OpenAIImageProvider } from './apiProviders';
import { LocalSidecarProvider } from './localSidecar';
import type { ImageInput, ImageProvider } from './types';

/**
 * Process-wide wiring of the reference tool: which provider, and where the control images come from. Both have setters so
 * tests (and later the CG1 `render_passes` implementation) can plug in without touching the tool registry.
 */

// -- control images (CG1 seam) ---------------------------------------------------------------------------------------

export interface ControlImagesRequest {
  scene: Scene;
  roomId: string;
  pose: CameraPose;
  size: { width: number; height: number };
}

/** What the render passes give the sidecar for one camera. Structural edges only: no texture edges (CG0). */
export interface ControlImages {
  canny: ImageInput;
  depth?: ImageInput | undefined;
}

/** The ONLY thing the reference tool needs from CG1 (`render_passes`). */
export interface ControlImageSource {
  getControlImages(req: ControlImagesRequest): Promise<ControlImages>;
}

export class ControlsUnavailableError extends Error {
  constructor() {
    super('control images are not available yet: the render passes (CG1, tool render_passes) are not wired in this build');
    this.name = 'ControlsUnavailableError';
  }
}

/** Default until CG1 lands: says so instead of guessing edges. */
export const unavailableControls: ControlImageSource = {
  async getControlImages() {
    throw new ControlsUnavailableError();
  },
};

let controls: ControlImageSource = unavailableControls;
export const setControlImageSource = (s: ControlImageSource | undefined): void => {
  controls = s ?? unavailableControls;
};
export const getControlImageSource = (): ControlImageSource => controls;

// -- provider --------------------------------------------------------------------------------------------------------

let override: ImageProvider | undefined;
let cached: ImageProvider | undefined;
export const setImageProvider = (p: ImageProvider | undefined): void => {
  override = p;
};

/**
 * `IMAGE_PROVIDER` = local (default) | openai | gemini. Local reads `IMAGEGEN_URL` (default http://127.0.0.1:8790; the
 * sidecar may be another machine) and `IMAGEGEN_TOKEN`. The hosted providers are stubs and stay disabled without their key.
 */
export function providerFromEnv(env: Record<string, string | undefined> = process.env): ImageProvider {
  switch ((env.IMAGE_PROVIDER ?? 'local').trim().toLowerCase()) {
    case 'openai':
      return new OpenAIImageProvider(env);
    case 'gemini':
      return new GeminiImageProvider(env);
    default:
      return new LocalSidecarProvider({ ...(env.IMAGEGEN_URL ? { url: env.IMAGEGEN_URL } : {}), token: env.IMAGEGEN_TOKEN });
  }
}

export function getImageProvider(): ImageProvider {
  return override ?? (cached ??= providerFromEnv());
}
