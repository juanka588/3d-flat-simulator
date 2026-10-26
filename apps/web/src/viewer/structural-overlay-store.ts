import { create } from 'zustand';
import { readPref, writePref } from '../state/prefs';

export const STRUCTURAL_OVERLAY_KEY = 'flat.structuralOverlay';

interface OverlayStore {
  /** Whether the structural/removable overlay is drawn in the top view. On by default. */
  visible: boolean;
  setVisible: (visible: boolean) => void;
}

export const useStructuralOverlay = create<OverlayStore>((set) => ({
  visible: readPref(STRUCTURAL_OVERLAY_KEY) !== '0',
  setVisible: (visible) => {
    writePref(STRUCTURAL_OVERLAY_KEY, visible ? '1' : '0');
    set({ visible });
  },
}));
