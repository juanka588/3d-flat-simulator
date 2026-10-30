import type { PersonPlacement } from './walk-start';
import type { CameraPose, LightingView, OwnerKind, WallFace } from '@flat/scene';

export type ViewMode = 'orbit' | 'top' | 'walk';

/**
 * How the host building around the flat (its own storey and the floors above) is drawn in orbit view:
 * `hidden` (invisible, shadow only), `ghost` (translucent envelope, the default) or `solid`. Top and walk always hide it.
 */
export type BuildingMode = 'hidden' | 'ghost' | 'solid';
export const BUILDING_MODES: readonly BuildingMode[] = ['hidden', 'ghost', 'solid'];

/** A picked scene entity (and, for walls, which face of it). */
export interface Selection {
  kind: OwnerKind;
  entityId: string;
  face?: WallFace;
  /** Floor clicks only: the floor zone (`Room.floorZones`) that was hit; `entityId` is then its room. Absent for the rest of the floor. */
  zoneId?: string;
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
  /**
   * When set, the camera follows this pose exactly (no re-fit, no damping drift) until the user
   * moves the camera. `mode` equals `camera.mode` while it is set.
   */
  camera?: CameraPose;
  /** Walk mode draws door leaves see-through (default; `false` keeps them opaque, as renders for the assistant need). */
  translucentDoors?: boolean;
  /** Host-building envelope in orbit view (default `ghost`). */
  buildingMode?: BuildingMode;
  /** Draw the translucent person (at the person height) in orbit and top views. Off unless `true` (renders for the assistant stay clean). */
  showPerson?: boolean;
  /** Ids of walls or rooms to flag in red (the plan-check finding under the pointer). */
  highlight?: readonly string[];
  /** Where the person stands (the last walk pose, or where the user dragged the ghost); null = the default walk start. */
  person?: PersonPlacement | null;
}
