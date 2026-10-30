/**
 * What the GPU/driver can do, read once per context. Every feature that needs float textures (the light-probe atlas, the
 * HDR environment) is gated on these flags: a phone GPU (Mali) typically renders to float textures but cannot FILTER
 * them linearly, and a texture sampled that way is "incomplete" and reads as black without any error. That made the
 * whole lit flat render black on a Pixel 8 while the (emissive/unlit-ish) neighbour massing still showed.
 */
export interface GlCaps {
  webgl2: boolean;
  renderer: string;
  vendor: string;
  /** SwiftShader, llvmpipe and the like. */
  software: boolean;
  /** Phone/tablet GPU families (Mali, Adreno, PowerVR, Apple GPU on iOS is not detected here). */
  mobileGpu: boolean;
  floatRender: boolean;
  halfFloatRender: boolean;
  floatLinear: boolean;
  maxTextures: number;
  maxVertexTextures: number;
  maxTextureSize: number;
  max3dTextureSize: number;
  maxFragmentUniformVectors: number;
  maxVertexUniformVectors: number;
  maxVaryingVectors: number;
  maxSamples: number;
  extensions: string[];
}

type AnyGl = WebGLRenderingContext | WebGL2RenderingContext;

export function readGlCaps(gl: AnyGl): GlCaps {
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  const vendor = dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : 'unknown';
  const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  const num = (p: number): number => {
    const v = gl.getParameter(p) as unknown;
    return typeof v === 'number' ? v : 0;
  };
  const g2 = gl as WebGL2RenderingContext;
  return {
    webgl2,
    renderer,
    vendor,
    software: /swiftshader|llvmpipe|software/i.test(renderer),
    mobileGpu: /mali|adreno|powervr|immortalis|xclipse|videocore/i.test(renderer),
    floatRender: !!gl.getExtension('EXT_color_buffer_float'),
    halfFloatRender: !!(gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float')),
    floatLinear: !!gl.getExtension('OES_texture_float_linear'),
    maxTextures: num(gl.MAX_TEXTURE_IMAGE_UNITS),
    maxVertexTextures: num(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
    maxTextureSize: num(gl.MAX_TEXTURE_SIZE),
    max3dTextureSize: webgl2 ? num(g2.MAX_3D_TEXTURE_SIZE) : 0,
    maxFragmentUniformVectors: num(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
    maxVertexUniformVectors: num(gl.MAX_VERTEX_UNIFORM_VECTORS),
    maxVaryingVectors: num(gl.MAX_VARYING_VECTORS),
    maxSamples: webgl2 ? num(g2.MAX_SAMPLES) : 0,
    extensions: gl.getSupportedExtensions() ?? [],
  };
}

const cache = new WeakMap<object, GlCaps>();
export function glCapsOf(gl: AnyGl): GlCaps {
  let c = cache.get(gl);
  if (!c) cache.set(gl, (c = readGlCaps(gl)));
  return c;
}

/** The light-probe atlas is a 3D RGBA32F render target sampled with linear filtering: it needs both float rendering and float filtering. */
export function supportsProbes(c: GlCaps): boolean {
  return c.webgl2 && c.floatRender && c.floatLinear && c.max3dTextureSize >= 64;
}
