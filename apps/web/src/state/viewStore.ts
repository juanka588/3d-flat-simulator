import { DEFAULT_LIGHTING } from '@flat/scene';
import type { CameraPose, LightingView } from '@flat/scene';
import { create } from 'zustand';
import { BUILDING_MODES, clampPersonHeightCm, DEFAULT_PERSON_HEIGHT_CM } from '@flat/viewer';
import type { BuildingMode, PersonPlacement, Selection, ViewMode, ViewState } from '@flat/viewer';
import { todayIso } from './localTime';
import { WALK_LIGHTS_KEY } from './effectiveLighting';
import { readPref, writePref } from './prefs';

/** Preference: apply the assistant's view messages (server mode). Default off. */
export const FOLLOW_ASSISTANT_KEY = 'flat.followAssistantView';

/** Preference: how the host building is drawn in orbit view (hidden / ghost / solid). Default ghost. */
export const BUILDING_MODE_KEY = 'flat.buildingMode';

function initialBuildingMode(): BuildingMode {
  const stored = readPref(BUILDING_MODE_KEY);
  return BUILDING_MODES.find((m) => m === stored) ?? 'ghost';
}

/** Preference: show the translucent person in orbit and top views. Default on. */
export const SHOW_PERSON_KEY = 'flat.showPerson';

export const PERSON_HEIGHT_STORAGE_KEY = 'flat.personHeightCm';

function initialPersonHeight(): number {
  const stored = readPref(PERSON_HEIGHT_STORAGE_KEY);
  return stored === null ? DEFAULT_PERSON_HEIGHT_CM : clampPersonHeightCm(Number(stored));
}

interface ViewStore extends ViewState {
  /** Preference (persisted, default on): the person ghost in orbit and top views. */
  showPerson: boolean;
  setShowPerson: (on: boolean) => void;
  /** Where the person stands: the last walk pose or a drag of the ghost; null = the default walk start. Not persisted. */
  person: PersonPlacement | null;
  setPerson: (p: PersonPlacement | null) => void;
  /** Preference: in walk mode all lamps are on and the exposure is raised (a derived overlay, see effectiveLighting). Default on. */
  walkLightsOn: boolean;
  setWalkLightsOn: (on: boolean) => void;
  /** Walk-mode comfort: door leaves see-through. Default on, not persisted; the render service turns it off so renders show the doors as they are. */
  translucentDoors: boolean;
  setTranslucentDoors: (on: boolean) => void;
  /** Preference (persisted, default off): show the camera/lighting the assistant sends over the view channel. */
  followAssistant: boolean;
  setFollowAssistant: (on: boolean) => void;
  /** Preference (persisted, default ghost): the host building around the flat in orbit view. */
  buildingMode: BuildingMode;
  setBuildingMode: (mode: BuildingMode) => void;
  /** Follows `pose` exactly and selects its mode; `undefined` hands the camera back to the user. */
  setCamera: (pose: CameraPose | undefined) => void;
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
  showPerson: readPref(SHOW_PERSON_KEY) !== '0',
  setShowPerson: (on) => {
    writePref(SHOW_PERSON_KEY, on ? '1' : '0');
    set({ showPerson: on });
  },
  person: null,
  setPerson: (p) => set({ person: p }),
  walkLightsOn: readPref(WALK_LIGHTS_KEY) !== '0',
  translucentDoors: true,
  buildingMode: initialBuildingMode(),
  setBuildingMode: (mode) => {
    writePref(BUILDING_MODE_KEY, mode);
    set((s) => (s.buildingMode === mode ? s : { buildingMode: mode }));
  },
  setTranslucentDoors: (on) => set((s) => (s.translucentDoors === on ? s : { translucentDoors: on })),
  followAssistant: readPref(FOLLOW_ASSISTANT_KEY) === '1',
  setFollowAssistant: (on) => {
    writePref(FOLLOW_ASSISTANT_KEY, on ? '1' : '0');
    set({ followAssistant: on });
  },
  setCamera: (pose) => set((s) => (pose ? { mode: pose.mode, camera: pose } : s.camera ? { camera: undefined } : s)),
  setWalkLightsOn: (on) => {
    writePref(WALK_LIGHTS_KEY, on ? '1' : '0');
    set({ walkLightsOn: on });
  },
  // Choosing a mode directly drops a followed pose (it belongs to its own mode).
  setView: (partial) => set('mode' in partial && !('camera' in partial) ? { ...partial, camera: undefined } : partial),
  setPersonHeightCm: (cm) => {
    const clamped = clampPersonHeightCm(cm);
    writePref(PERSON_HEIGHT_STORAGE_KEY, String(clamped));
    set({ personHeightCm: clamped });
  },
  setMode: (mode) => set({ mode, camera: undefined }),
  select: (selection) => set({ selection }),
  setLighting: (partial) =>
    set((s) => {
      const changed = (Object.keys(partial) as (keyof LightingView)[]).some((k) => partial[k] !== s.lighting[k]);
      return changed ? { lighting: { ...s.lighting, ...partial } } : s;
    }),
}));
