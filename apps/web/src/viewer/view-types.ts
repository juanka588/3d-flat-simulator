import type { LightingView, OwnerKind, WallFace } from '@flat/scene';

export type ViewMode = 'orbit' | 'top' | 'walk';

/** A picked scene entity (and, for walls, which face of it). */
export interface Selection {
  kind: OwnerKind;
  entityId: string;
  face?: WallFace;
  /** Wall face clicks only: the room on the clicked face at the click point (absent for a face with no room). */
  roomId?: string;
  /** Wall face clicks only: metres along the wall (from its start) where the face was hit. */
  along?: number;
}

/** Everything the viewer needs besides the Scene. Not part of undo/redo or autosave. */
export interface ViewState {
  mode: ViewMode;
  selection: Selection | null;
  /** Sun date/time, lamp overrides, exposure and context visibility. */
  lighting: LightingView;
  /** Height of the walking person in cm (sets the walk-mode eye height). A user preference, persisted. */
  personHeightCm: number;
}
