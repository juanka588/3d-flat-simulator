import { DEFAULT_LIGHTING } from '@flat/scene';
import type { LightingView } from '@flat/scene';
import { create } from 'zustand';
import type { Selection, ViewMode, ViewState } from '../viewer/view-types';
import { todayIso } from './localTime';

interface ViewStore extends ViewState {
  setView: (partial: Partial<ViewState>) => void;
  setMode: (mode: ViewMode) => void;
  select: (selection: Selection | null) => void;
  /** Merges into the lighting view; no-op (same object) when nothing changes. */
  setLighting: (partial: Partial<LightingView>) => void;
}

export const useViewStore = create<ViewStore>((set) => ({
  mode: 'orbit',
  selection: null,
  lighting: { ...DEFAULT_LIGHTING, date: todayIso(), time: '12:00' },
  setView: (partial) => set(partial),
  setMode: (mode) => set({ mode }),
  select: (selection) => set({ selection }),
  setLighting: (partial) =>
    set((s) => {
      const changed = (Object.keys(partial) as (keyof LightingView)[]).some((k) => partial[k] !== s.lighting[k]);
      return changed ? { lighting: { ...s.lighting, ...partial } } : s;
    }),
}));
