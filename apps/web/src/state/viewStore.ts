import { create } from 'zustand';
import type { Selection, ViewMode, ViewState } from '../viewer/view-types';

interface ViewStore extends ViewState {
  setView: (partial: Partial<ViewState>) => void;
  setMode: (mode: ViewMode) => void;
  select: (selection: Selection | null) => void;
}

export const useViewStore = create<ViewStore>((set) => ({
  mode: 'orbit',
  selection: null,
  setView: (partial) => set(partial),
  setMode: (mode) => set({ mode }),
  select: (selection) => set({ selection }),
}));
