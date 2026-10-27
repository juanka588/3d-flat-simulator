import { create } from 'zustand';

/** A forced render surface: CSS size and device pixel ratio (test hook / `?test&w=&h=&dpr=`). */
export interface Viewport {
  width: number;
  height: number;
  dpr: number;
}

export const MIN_VIEWPORT_PX = 16;
export const MAX_VIEWPORT_PX = 4096;
export const MAX_VIEWPORT_DPR = 4;

/** A valid viewport, or null. */
export function parseViewport(width: unknown, height: unknown, dpr: unknown = 1): Viewport | null {
  const w = Number(width);
  const h = Number(height);
  const d = Number(dpr);
  const okSize = (n: number) => Number.isFinite(n) && n >= MIN_VIEWPORT_PX && n <= MAX_VIEWPORT_PX;
  if (!okSize(w) || !okSize(h) || !Number.isFinite(d) || d <= 0 || d > MAX_VIEWPORT_DPR) return null;
  return { width: Math.round(w), height: Math.round(h), dpr: d };
}

function fromUrl(): Viewport | null {
  if (typeof window === 'undefined') return null;
  const q = new URLSearchParams(window.location.search);
  if (!q.has('test') || !q.has('w') || !q.has('h')) return null;
  return parseViewport(q.get('w'), q.get('h'), q.get('dpr') ?? 1);
}

interface ViewportStore {
  /** null: the canvas fills the stage (the normal responsive layout). */
  forced: Viewport | null;
  force: (viewport: Viewport | null) => void;
}

export const useViewportStore = create<ViewportStore>((set) => ({
  forced: fromUrl(),
  force: (forced) => set({ forced }),
}));
