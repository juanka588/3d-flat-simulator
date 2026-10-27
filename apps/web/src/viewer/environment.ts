import { EquirectangularReflectionMapping, FloatType, PMREMGenerator } from 'three';
import type { DataTexture, Texture, WebGLRenderer } from 'three';

/** Where the environment map lives: `${BASE_URL}env/` (BASE_URL ends with a slash), built by `pnpm env:build`. */
export const ENV_FILE = 'small-empty-room.hdr';
export const envUrl = (): string => `${import.meta.env.BASE_URL}env/${ENV_FILE}`;

export interface EnvironmentMap {
  /** The prefiltered (PMREM) environment: assign to `scene.environment`. */
  texture: Texture;
  /** Mean radiance of the map over the sphere (linear luminance), to scale it against the hemisphere light. */
  meanRadiance: number;
  dispose: () => void;
}

/**
 * Mean luminance of an equirectangular float image over the sphere: rows are weighted by the cosine of their latitude
 * (they cover less solid angle towards the poles).
 */
export function meanRadianceOf(data: ArrayLike<number>, width: number, height: number, channels: number): number {
  let sum = 0;
  let weight = 0;
  for (let y = 0; y < height; y++) {
    const w = Math.cos(((y + 0.5) / height - 0.5) * Math.PI);
    let row = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      row += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
    }
    sum += row * w;
    weight += w * width;
  }
  return weight > 0 ? sum / weight : 0;
}

/** Loads the RGBE map, prefilters it for the renderer and measures its mean radiance. The HDR loader is a lazy chunk. */
export async function loadEnvironment(renderer: WebGLRenderer, url = envUrl()): Promise<EnvironmentMap> {
  const { HDRLoader } = await import('three/examples/jsm/loaders/HDRLoader.js');
  const loader = new HDRLoader();
  loader.setDataType(FloatType);
  const source: DataTexture = await loader.loadAsync(url);
  const image = source.image as { data: ArrayLike<number>; width: number; height: number };
  const meanRadiance = meanRadianceOf(image.data, image.width, image.height, 4);
  source.mapping = EquirectangularReflectionMapping;
  const pmrem = new PMREMGenerator(renderer);
  const target = pmrem.fromEquirectangular(source);
  source.dispose();
  pmrem.dispose();
  return { texture: target.texture, meanRadiance, dispose: () => target.dispose() };
}
