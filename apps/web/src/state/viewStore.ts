import { DEFAULT_LIGHTING } from '@flat/scene';
import type { LightingView } from '@flat/scene';
import { create } from 'zustand';
import type { Selection, ViewMode, ViewState } from '../viewer/view-types';
import { DEFAULT_PERSON_HEIGHT_CM, clampPersonHeightCm } from '../viewer/walk-camera';
import { todayIso } from './localTime';
import { WALK_LIGHTS_KEY } from './effectiveLighting';
import { readPref, writePref } from './prefs';

export const PERSON_HEIGHT_STORAGE_KEY = 'flat.personHeightCm';

function initialPersonHeight(): number {
  const stored = readPref(PERSON_HEIGHT_STORAGE_KEY);
  return stored === null ? DEFAULT_PERSON_HEIGHT_CM : clampPersonHeightCm(Number(stored));
}

interface ViewStore extends ViewState {
  /** Preference: in walk mode all lamps are on and the exposure is raised (a derived overlay, see effectiveLighting). Default on. */
  walkLightsOn: boolean;
  setWalkLightsOn: (on: boolean) => void;
  setView: (partial: Partial<ViewState>) => void;
  setMode: (mode: ViewMode) => void;
  select: (selection: Selection | null) => void;
  /** Merges into the lighting view; no-op (same object) when nothing changes. */
  setLighting: (partial: Partial<LightingView>) => void;
  /** Clamps to the supported range and remembers the choice. */
  setPersonHeightCm: (cm: number) => void;
}

export const useViewStore = create<ViewStore>((set) => ({
  mode: 'orbit',
  selection: null,
  lighting: { ...DEFAULT_LIGHTING, date: todayIso(), time: '12:00' },
  personHeightCm: initialPersonHeight(),
  walkLightsOn: readPref(WALK_LIGHTS_KEY) !== '0',
  setWalkLightsOn: (on) => {
    writePref(WALK_LIGHTS_KEY, on ? '1' : '0');
    set({ walkLightsOn: on });
  },
  setView: (partial) => set(partial),
  setPersonHeightCm: (cm) => {
    const clamped = clampPersonHeightCm(cm);
    writePref(PERSON_HEIGHT_STORAGE_KEY, String(clamped));
    set({ personHeightCm: clamped });
  },
  setMode: (mode) => set({ mode }),
  select: (selection) => set({ selection }),
  setLighting: (partial) =>
    set((s) => {
      const changed = (Object.keys(partial) as (keyof LightingView)[]).some((k) => partial[k] !== s.lighting[k]);
      return changed ? { lighting: { ...s.lighting, ...partial } } : s;
    }),
}));
