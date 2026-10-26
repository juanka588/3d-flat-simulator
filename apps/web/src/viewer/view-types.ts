import type { LightingView, OwnerKind, WallFace } from '@flat/scene';

export type ViewMode = 'orbit' | 'top' | 'walk';

/** A picked scene entity (and, for walls, which face of it). */
export interface Selection {
  kind: OwnerKind;
  entityId: string;
  face?: WallFace;
}

/** Everything the viewer needs besides the Scene. Not part of undo/redo or autosave. */
export interface ViewState {
  mode: ViewMode;
  selection: Selection | null;
  /** Sun date/time, lamp overrides, exposure and context visibility. */
  lighting: LightingView;
}
