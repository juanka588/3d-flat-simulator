import { create } from 'zustand';
import { readGlCaps } from './gl-caps';
import type { GlCaps } from './gl-caps';

/**
 * Everything the `?debug=gl` overlay shows, and the up-front WebGL2 check. Kept in a store so that the overlay also works
 * when the canvas could not be created at all (then there is no renderer, only the reason).
 */
export interface ShaderFailure {
  object: string;
  material: string;
  log: string;
}

export interface GlDebugState {
  /** Result of the pre-flight check: null until it ran. */
  support: { ok: true } | { ok: false; reason: string } | null;
  caps: GlCaps | null;
  /** Profile the viewer picked, and why. */
  profile: Record<string, unknown> | null;
  tier: string;
  failures: ShaderFailure[];
  /** Last console errors/warnings and window errors (so the phone screenshot shows them). */
  logs: string[];
  info: Record<string, number | string> | null;
  set: (patch: Partial<Omit<GlDebugState, 'set'>>) => void;
}

export const useGlDebug = create<GlDebugState>((set) => ({
  support: null,
  caps: null,
  profile: null,
  tier: '',
  failures: [],
  logs: [],
  info: null,
  set: (patch) => set(patch),
}));

export function debugGlRequested(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).get('debug') === 'gl';
}

let logsInstalled = false;
/** Keeps the last console errors and window errors for the overlay. Idempotent; cheap. */
export function installLogCapture(): void {
  if (logsInstalled || typeof window === 'undefined') return;
  logsInstalled = true;
  const push = (line: string) => {
    const logs = [...useGlDebug.getState().logs, line.slice(0, 400)].slice(-12);
    useGlDebug.getState().set({ logs });
  };
  window.addEventListener('error', (e) => push(`error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => push(`rejection: ${String((e.reason as Error)?.message ?? e.reason)}`));
  const origError = console.error.bind(console);
  console.error = (...a: unknown[]) => {
    origError(...a);
    push(`console.error: ${a.map((x) => (typeof x === 'string' ? x : String((x as Error)?.message ?? x))).join(' ')}`);
  };
}

let checked: { ok: true } | { ok: false; reason: string } | null = null;

/**
 * Creates a throwaway WebGL2 context to find out, before the canvas is mounted, whether the viewer can run at all and why not.
 * three r186 needs WebGL2; a WebGL1-only browser, a blocklisted GPU or an exhausted context pool all end here with a reason.
 */
export function checkWebGl2(): { ok: true } | { ok: false; reason: string } {
  if (checked) return checked;
  installLogCapture();
  let reason = '';
  try {
    const canvas = document.createElement('canvas');
    canvas.addEventListener('webglcontextcreationerror', (e) => void (reason = (e as WebGLContextEvent).statusMessage || reason));
    const gl = canvas.getContext('webgl2');
    if (gl) {
      useGlDebug.getState().set({ caps: readGlCaps(gl) });
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      checked = { ok: true };
    } else {
      const gl1 = canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl');
      checked = {
        ok: false,
        reason: gl1
          ? 'this browser only offers WebGL 1; the 3D view needs WebGL 2 (update Chrome / Android System WebView, or try another browser)'
          : `WebGL is not available${reason ? ` (${reason})` : ''}: it may be disabled in the browser settings, blocklisted for this GPU, or the browser ran out of graphics contexts (close other tabs)`,
      };
    }
  } catch (e) {
    checked = { ok: false, reason: `creating a WebGL context threw: ${e instanceof Error ? e.message : String(e)}` };
  }
  useGlDebug.getState().set({ support: checked });
  return checked;
}

/** Forgets the cached pre-flight result (tests). */
export function resetWebGlCheck(): void {
  checked = null;
}
