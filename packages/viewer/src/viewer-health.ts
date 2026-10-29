import { create } from 'zustand';

/**
 * What went wrong while drawing, shown by `ViewerErrorBanner`. A render failure must never leave the
 * user looking at an empty sky without a word: the viewer keeps the last scene that drew fine
 * (`ViewerGuard`) and reports here.
 */
export interface ViewerProblem {
  /** Which part failed: the flat's geometry/materials ("shell"), the lighting, the camera, the whole page ("app") or the GPU ("webgl"). */
  source: 'shell' | 'lighting' | 'camera' | 'app' | 'webgl';
  message: string;
  /** The last version that drew fine is still on screen. */
  keptLastGood: boolean;
  at: number;
}

interface ViewerHealth {
  problem: ViewerProblem | null;
  report: (problem: Omit<ViewerProblem, 'at'>) => void;
  /** Clears the problem of `source` (a later frame drew fine), or any problem without an argument. */
  clear: (source?: ViewerProblem['source']) => void;
}

export const useViewerHealth = create<ViewerHealth>((set, get) => ({
  problem: null,
  report: (p) => {
    console.error(`[flat] viewer problem (${p.source}): ${p.message}`);
    set({ problem: { ...p, at: Date.now() } });
  },
  clear: (source) => {
    const cur = get().problem;
    if (cur && (!source || cur.source === source)) set({ problem: null });
  },
}));

/**
 * Test-only fault injection (only with `?test` or in dev): a scene whose name starts with this makes the shell
 * throw while it is built, to prove the viewer keeps the last good flat and says so.
 */
export const FAULT_SCENE_PREFIX = '__viewer_fault__';

export function shouldInjectFault(sceneName: string): boolean {
  if (!sceneName.startsWith(FAULT_SCENE_PREFIX)) return false;
  return import.meta.env.DEV || (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('test'));
}

export function messageOf(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.split('\n')[0]!.slice(0, 300);
}
