import type { CameraPose, Scene } from '@flat/scene';
import { GeminiImageProvider, OpenAIImageProvider } from './apiProviders';
import { LocalSidecarProvider, DEFAULT_SIDECAR_URL } from './localSidecar';
import { FakeImageProvider } from './fake';
import { SidecarMatcher, type ImageMatcher } from './match';
import { SidecarScorer, type ImageScorer } from './similarity';
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
  /** Scratch copy of the scene with layout placeholders (never the real scene): draw the passes from it. */
  blockout?: Scene | undefined;
}

/** What the render passes give the sidecar for one camera. Structural edges only: no texture edges (CG0). */
export interface ControlImages {
  canny: ImageInput;
  depth?: ImageInput | undefined;
  /** Inverse depth with the structural edges drawn over it: the one control the Union ControlNet reads best (set with a blockout). */
  blend?: ImageInput | undefined;
  /** For the fidelity filter: the ids pass and the edge pass of the same camera (PNG). */
  check?: { ids: ImageInput; edges: ImageInput } | undefined;
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
    case 'fake':
      // The dry run of the design runner (`design-flat.mjs --close-gap --dry`): canned images, no sidecar. `IMAGEGEN_FAKE_IMAGE` = a PNG file to return.
      return new FakeImageProvider(env.IMAGEGEN_FAKE_IMAGE ? { path: env.IMAGEGEN_FAKE_IMAGE } : {});
    default:
      return new LocalSidecarProvider({ ...(env.IMAGEGEN_URL ? { url: env.IMAGEGEN_URL } : {}), token: env.IMAGEGEN_TOKEN });
  }
}

export function getImageProvider(): ImageProvider {
  return override ?? (cached ??= providerFromEnv());
}

// -- similarity matcher (CG3) ----------------------------------------------------------------------------------------

let matcherOverride: ImageMatcher | undefined;
let matcherCached: ImageMatcher | undefined;
export const setImageMatcher = (m: ImageMatcher | undefined): void => {
  matcherOverride = m;
};
/** The index lives in the local sidecar; there is no hosted variant (catalogue photos never leave this machine). */
export function getImageMatcher(env: Record<string, string | undefined> = process.env): ImageMatcher {
  return matcherOverride ?? (matcherCached ??= new SidecarMatcher(env.IMAGEGEN_URL?.trim() || DEFAULT_SIDECAR_URL, env.IMAGEGEN_TOKEN || undefined));
}

// -- whole-image scoring (CG5) ---------------------------------------------------------------------------------------

let scorerOverride: ImageScorer | undefined;
let scorerCached: ImageScorer | undefined;
export const setImageScorer = (s: ImageScorer | undefined): void => {
  scorerOverride = s;
};
/** CLIP embeddings and the aesthetic predictor live in the local sidecar (our renders and reference images only; no hosted variant). */
export function getImageScorer(env: Record<string, string | undefined> = process.env): ImageScorer {
  return scorerOverride ?? (scorerCached ??= new SidecarScorer(env.IMAGEGEN_URL?.trim() || DEFAULT_SIDECAR_URL, env.IMAGEGEN_TOKEN || undefined));
}
