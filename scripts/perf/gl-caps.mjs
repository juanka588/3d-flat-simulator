/* eslint-disable no-undef, no-empty, @typescript-eslint/no-unused-vars -- Node + browser-side script, not part of the app */
import { fileURLToPath } from 'node:url';

/** Path of the browser-side init script (see gl-caps-init.js). */
export const GL_CAPS_INIT = fileURLToPath(new URL('./gl-caps-init.js', import.meta.url));

const MALI = { vendor: 'ARM', renderer: 'Mali-G715' };

/**
 * Phone-GPU presets for `installGlCaps`.
 * - pixel8: what a Pixel 8 reports through Chrome/ANGLE as far as it matters here (16 texture units); float render targets
 *   are available, float32 linear filtering is NOT (the worst case for the light-probe atlas).
 * - mali-lowend: an older/low-end Mali: 224 fragment uniform vectors, 4096 textures, no float render targets at all.
 * - webgl1: a device (or WebView) with WebGL1 only. three r186 cannot run on it.
 * - nogl: WebGL disabled or blocklisted.
 */
export const GL_PRESETS = {
  pixel8: {
    ...MALI,
    params: { MAX_TEXTURE_IMAGE_UNITS: 16, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32, MAX_TEXTURE_SIZE: 8192, MAX_FRAGMENT_UNIFORM_VECTORS: 1024, MAX_VERTEX_UNIFORM_VECTORS: 1024, MAX_VARYING_VECTORS: 31 },
    hide: ['OES_texture_float_linear', 'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb', 'WEBGL_debug_shaders'],
  },
  'mali-lowend': {
    ...MALI,
    renderer: 'Mali-G52',
    params: { MAX_TEXTURE_IMAGE_UNITS: 16, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16, MAX_TEXTURE_SIZE: 4096, MAX_CUBE_MAP_TEXTURE_SIZE: 4096, MAX_FRAGMENT_UNIFORM_VECTORS: 224, MAX_VERTEX_UNIFORM_VECTORS: 256, MAX_VARYING_VECTORS: 15, MAX_3D_TEXTURE_SIZE: 256, MAX_ARRAY_TEXTURE_LAYERS: 256 },
    hide: ['EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'OES_texture_float_linear', 'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb'],
  },
  webgl1: { ...MALI, webgl2: false },
  nogl: { ...MALI, noContext: true },
};

/** Installs a preset (name or object) on a Playwright context or page, before any page script runs. */
export async function installGlCaps(target, preset) {
  const cfg = typeof preset === 'string' ? GL_PRESETS[preset] : preset;
  if (!cfg) throw new Error(`unknown GL preset ${preset}`);
  await target.addInitScript((c) => void (window.__GLCAPS = c), cfg);
  await target.addInitScript({ path: GL_CAPS_INIT });
}
