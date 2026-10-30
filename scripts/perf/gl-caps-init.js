/* eslint-disable no-undef, no-empty, @typescript-eslint/no-unused-vars -- Node + browser-side script, not part of the app */
/*
 * Browser init script (Playwright `addInitScript({ path })`): makes a desktop/SwiftShader WebGL2 context look like a phone GPU.
 * Configure first with `window.__GLCAPS = {...}` (a preceding init script). Presets live in scripts/perf/gl-caps.mjs.
 *
 *   renderer / vendor   strings of WEBGL_debug_renderer_info (so the app does not take the context for a software renderer)
 *   params              { GL constant name: value } overrides for getParameter
 *   hide                extension names getExtension()/getSupportedExtensions() pretend not to have. The real extension is never
 *                       enabled, so Chrome itself then refuses what needs it (float render targets, linear filtering of float textures).
 *   webgl2              false: getContext('webgl2') returns null (a WebGL1-only device)
 *   noContext           true: every getContext('webgl*') returns null (WebGL disabled / blocklisted)
 *   failLink            a regexp source: programs whose shader source matches fail to link (emulates a driver that rejects a shader)
 */
(() => {
  const cfg = window.__GLCAPS || {};
  const log = (window.__glcapsLog = []);
  const C = { MAX_TEXTURE_IMAGE_UNITS: 0x8872, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d, MAX_TEXTURE_SIZE: 0x0d33, MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c, MAX_RENDERBUFFER_SIZE: 0x84e8, MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb, MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd, MAX_VARYING_VECTORS: 0x8dfc, MAX_VERTEX_ATTRIBS: 0x8869, MAX_3D_TEXTURE_SIZE: 0x8073, MAX_ARRAY_TEXTURE_LAYERS: 0x88ff, MAX_SAMPLES: 0x8d57, MAX_DRAW_BUFFERS: 0x8824, MAX_FRAGMENT_UNIFORM_COMPONENTS: 0x8b49, MAX_VERTEX_UNIFORM_COMPONENTS: 0x8b4a, MAX_VARYING_COMPONENTS: 0x8b4b, MAX_UNIFORM_BLOCK_SIZE: 0x8a30 };
  const byCode = {};
  for (const [k, v] of Object.entries(cfg.params || {})) if (C[k] !== undefined) byCode[C[k]] = v;
  const hide = new Set(cfg.hide || []);
  const UNMASKED_VENDOR = 0x9245;
  const UNMASKED_RENDERER = 0x9246;

  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if (/webgl/.test(String(type))) {
      if (cfg.noContext || (cfg.webgl2 === false && type === 'webgl2')) {
        log.push(`getContext(${type}) -> null (emulated)`);
        return null;
      }
    }
    return origGetContext.call(this, type, ...rest);
  };

  for (const proto of [window.WebGL2RenderingContext && WebGL2RenderingContext.prototype, window.WebGLRenderingContext && WebGLRenderingContext.prototype]) {
    if (!proto) continue;
    const gp = proto.getParameter;
    proto.getParameter = function (p) {
      if (p in byCode) return byCode[p];
      if (p === UNMASKED_RENDERER && cfg.renderer) return cfg.renderer;
      if (p === UNMASKED_VENDOR && cfg.vendor) return cfg.vendor;
      return gp.call(this, p);
    };
    const ge = proto.getExtension;
    proto.getExtension = function (name) {
      if (hide.has(name)) return null;
      return ge.call(this, name);
    };
    const gs = proto.getSupportedExtensions;
    proto.getSupportedExtensions = function () {
      const list = gs.call(this);
      return list ? list.filter((n) => !hide.has(n)) : list;
    };
    if (cfg.failLink) {
      const re = new RegExp(cfg.failLink);
      const sources = new WeakMap();
      const ss = proto.shaderSource;
      proto.shaderSource = function (shader, src) {
        sources.set(shader, src);
        return ss.call(this, shader, src);
      };
      const lp = proto.getProgramParameter;
      const attached = new WeakMap();
      const as = proto.attachShader;
      proto.attachShader = function (prog, sh) {
        (attached.get(prog) || attached.set(prog, []).get(prog)).push(sh);
        return as.call(this, prog, sh);
      };
      proto.getProgramParameter = function (prog, pname) {
        const v = lp.call(this, prog, pname);
        if (pname === this.LINK_STATUS && v && (attached.get(prog) || []).some((s) => re.test(sources.get(s) || ''))) {
          log.push('forced link failure');
          return false;
        }
        return v;
      };
    }
  }
})();
