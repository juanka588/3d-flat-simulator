import { DEFAULT_CEILING_HEIGHT, itemCoalesceKey, itemDims, itemMountOf } from '@flat/scene';
import type { Item, ProductRecord, Relation, Scene, Vec2 } from '@flat/scene';
import { committedScene, useSceneStore } from '../state/sceneStore';
import { useViewStore } from '../state/viewStore';
import { ceilingAt, checkGhost, fullGhostCheck } from './ghost';
import type { GhostPose, GhostSubject, GhostVerdict } from './ghost';
import { flashNotice, useCatalogStore } from './catalogStore';
import type { DragKind } from './catalogStore';
import { moveCommand, placeCommand, snapshotOf, subjectOf } from './place';
import type { PlaceSource } from './place';
import { rotationFacingDir, snapAngle, snapPose, snapValue, normalizeDeg } from './snap';

/** A pointer ray in world space (three.js axes: x east, y up, z = plan y). */
export interface WorldRay {
  origin: [number, number, number];
  dir: [number, number, number];
}

/** Hooks the mounted viewer registers: unprojecting a screen point, and suspending the camera controls during a drag. */
export interface ViewerHooks {
  ray: (clientX: number, clientY: number) => WorldRay | null;
  setControlsEnabled: (enabled: boolean) => void;
}

let viewer: ViewerHooks | null = null;
export function registerViewer(hooks: ViewerHooks | null): void {
  viewer = hooks;
}

/** Plan point where a ray meets the floor plane (y = 0), or null when it points away from it. */
export function floorPoint(ray: WorldRay): Vec2 | null {
  if (ray.dir[1] > -1e-6) return null;
  const t = -ray.origin[1] / ray.dir[1];
  if (t < 0) return null;
  return [ray.origin[0] + ray.dir[0] * t, ray.origin[2] + ray.dir[2] * t];
}

/** Height (y) of the point of the vertical line through plan point (x, z) that is closest to the ray; null when the ray is vertical. */
export function lineHeight(ray: WorldRay, x: number, z: number): number | null {
  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.dir;
  // closest points of P(t) = o + t d and Q(s) = (x, s, z): s = (a e - b dd) / (a - b^2) with u = (0, 1, 0)
  const a = dx * dx + dy * dy + dz * dz;
  const b = dy;
  const dd = (ox - x) * dx + oy * dy + (oz - z) * dz;
  const denom = a - b * b;
  if (denom < 1e-9) return null;
  return (a * oy - b * dd) / denom;
}

export type DragSpec =
  | { kind: 'new'; source: PlaceSource; getRecord?: () => Promise<ProductRecord>; touch: boolean }
  | { kind: 'move'; itemId: string; grab: Vec2; touch: boolean }
  | { kind: 'rotate'; itemId: string; offset: number; touch: boolean }
  | { kind: 'elevate'; itemId: string; grab: number; touch: boolean };

interface Mods {
  shift: boolean;
  alt: boolean;
}

interface Session {
  spec: DragSpec;
  label: string;
  rotBase: number;
  x: number;
  y: number;
  mods: Mods;
  pose: GhostPose | null;
  subject: GhostSubject;
  assetId: string;
  roomId?: string;
  timer?: ReturnType<typeof setTimeout>;
  stop: () => void;
}

let session: Session | null = null;
const IDLE_CHECK_MS = 140;

export const isDragging = (): boolean => session !== null;

function overCanvas(x: number, y: number): boolean {
  const el = document.elementFromPoint(x, y);
  return el instanceof HTMLCanvasElement;
}

const sceneNow = (): Scene | null => committedScene(useSceneStore.getState());

function findItem(scene: Scene, id: string): Item | undefined {
  return scene.items.find((i) => i.id === id);
}

function show(s: Session, pose: GhostPose, verdict: GhostVerdict, always: boolean): void {
  const dims = s.subject.dims;
  useCatalogStore.getState().setGhost(
    always || !verdict.valid
      ? { position: pose.position, rotation: pose.rotation, elevation: pose.elevation, dims, verdict, x: s.x, y: s.y, touch: s.spec.touch, kind: s.spec.kind, label: s.label }
      : null,
  );
}

function recompute(s: Session): void {
  clearTimeout(s.timer);
  const scene = sceneNow();
  if (!scene || !viewer || !overCanvas(s.x, s.y)) {
    s.pose = null;
    useCatalogStore.getState().setGhost(null);
    return;
  }
  const ray = viewer.ray(s.x, s.y);
  const floor = ray ? floorPoint(ray) : null;
  if (!ray || !floor) {
    s.pose = null;
    useCatalogStore.getState().setGhost(null);
    return;
  }
  const spec = s.spec;
  let pose: GhostPose;
  if (spec.kind === 'new') {
    const snapped = snapPose({ point: floor, rotation: s.rotBase, dims: s.subject.dims, rooms: scene.rooms, mount: s.subject.mount }, { grid: !s.mods.alt, angle: !s.mods.shift });
    const ceiling = ceilingAt(scene, snapped.position);
    const room = (Number.isFinite(ceiling) ? ceiling : DEFAULT_CEILING_HEIGHT) - s.subject.dims.h; // an open balcony has no ceiling: cap at the usual height
    // a ceiling mount hangs from THIS room's ceiling; a wall mount keeps its default height, kept under the ceiling
    const lift = spec.source.mount === 'ceiling' ? Math.max(0, room) : Math.max(0, Math.min(spec.source.elevation, room));
    pose = { position: snapped.position, rotation: snapped.rotation, elevation: spec.source.mount === 'floor' ? 0 : lift };
  } else {
    const item = findItem(scene, spec.itemId);
    if (!item) return endDrag(false);
    if (spec.kind === 'move') {
      const want: Vec2 = [floor[0] - spec.grab[0], floor[1] - spec.grab[1]];
      const snapped = snapPose({ point: want, rotation: s.rotBase, dims: s.subject.dims, rooms: scene.rooms, mount: s.subject.mount }, { grid: !s.mods.alt, angle: false });
      pose = { position: snapped.position, rotation: s.mods.shift || snapped.snaps.includes('wall') ? snapped.rotation : s.rotBase, elevation: item.elevation };
    } else if (spec.kind === 'rotate') {
      const raw = normalizeDeg(rotationFacingDir([floor[0] - item.position[0], floor[1] - item.position[1]]) + spec.offset);
      pose = { position: item.position, rotation: s.mods.shift ? Math.round(raw * 10) / 10 : snapAngle(raw), elevation: item.elevation };
    } else {
      const y = lineHeight(ray, item.position[0], item.position[1]);
      if (y === null) return;
      const ceiling = ceilingAt(scene, item.position);
      const top = Math.max(0, (Number.isFinite(ceiling) ? ceiling : DEFAULT_CEILING_HEIGHT) - s.subject.dims.h);
      pose = { position: item.position, rotation: item.rotation, elevation: Math.max(0, Math.min(top, snapValue(y - spec.grab))) };
    }
  }
  s.pose = pose;
  const verdict = checkGhost(scene, s.subject, pose);
  s.roomId = verdict.roomId;
  if (spec.kind !== 'new' && verdict.valid) applyExisting(s, pose);
  show(s, pose, verdict, spec.kind === 'new');
  // The walkway analysis is slower: run it once the pointer rests.
  if (verdict.valid) {
    s.timer = setTimeout(() => {
      if (session !== s || s.pose !== pose) return;
      const cur = sceneNow();
      if (!cur) return;
      show(s, pose, fullGhostCheck(cur, s.subject, pose, { assetId: s.assetId }), spec.kind === 'new');
    }, IDLE_CHECK_MS);
  }
}

/**
 * A valid step of a gizmo drag shows the edit at once as a preview (applied to the committed scene each time); the
 * release commits it as ONE history entry carrying the item's coalesce key (`item:<id>`).
 */
function applyExisting(s: Session, pose: GhostPose): void {
  const spec = s.spec;
  if (spec.kind === 'new') return;
  const key = itemCoalesceKey(spec.itemId);
  const store = useSceneStore.getState();
  if (spec.kind === 'rotate') store.preview({ type: 'item.rotate', id: spec.itemId, rotation: pose.rotation }, { coalesceKey: key });
  else store.preview(moveCommand(spec.itemId, pose, spec.kind === 'elevate' || s.subject.mount !== 'floor'), { coalesceKey: key });
}

/** Starts a drag; the session ends on pointer up / cancel / Escape. Call from a pointerdown (gizmo) or once a card drag is armed. */
export function startDrag(spec: DragSpec, at: { clientX: number; clientY: number; shiftKey?: boolean; altKey?: boolean }): void {
  endDrag(false);
  const scene = sceneNow();
  if (!scene) return;
  let subject: GhostSubject;
  let label: string;
  let assetId: string;
  let rotBase = 0;
  if (spec.kind === 'new') {
    subject = subjectOf(spec.source);
    label = spec.source.label;
    assetId = spec.source.assetId;
  } else {
    const item = findItem(scene, spec.itemId);
    if (!item) return;
    subject = { id: item.id, dims: itemDims(item), mount: itemMountOf(item) };
    label = item.product?.name ?? item.id;
    assetId = item.assetId;
    rotBase = item.rotation;
  }
  const s: Session = {
    spec,
    label,
    rotBase,
    x: at.clientX,
    y: at.clientY,
    mods: { shift: !!at.shiftKey, alt: !!at.altKey },
    pose: null,
    subject,
    assetId,
    stop: () => undefined,
  };
  const onMove = (e: PointerEvent) => {
    s.x = e.clientX;
    s.y = e.clientY;
    s.mods = { shift: e.shiftKey, alt: e.altKey };
    recompute(s);
  };
  const onUp = (e: PointerEvent) => {
    s.x = e.clientX;
    s.y = e.clientY;
    s.mods = { shift: e.shiftKey, alt: e.altKey };
    void finish(s);
  };
  const onCancel = () => endDrag(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      endDrag(false);
    } else if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && spec.kind !== 'rotate' && spec.kind !== 'elevate') {
      s.rotBase = normalizeDeg(s.rotBase + (e.shiftKey ? -90 : 90));
      recompute(s);
    } else if (e.key === 'Shift' || e.key === 'Alt') {
      s.mods = { shift: e.shiftKey, alt: e.altKey };
      recompute(s);
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  s.stop = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    clearTimeout(s.timer);
  };
  session = s;
  viewer?.setControlsEnabled(spec.kind === 'new');
  useCatalogStore.getState().setDrag({ kind: spec.kind as DragKind, label, ...(spec.kind !== 'new' ? { itemId: spec.itemId } : {}) });
  recompute(s);
}

/** Ends the session without dropping. */
export function endDrag(commit: boolean): void {
  const s = session;
  if (!s) return;
  session = null;
  s.stop();
  const store = useSceneStore.getState();
  if (commit) store.commitPreview();
  else store.cancelPreview();
  viewer?.setControlsEnabled(true);
  useCatalogStore.getState().setDrag(null, null);
}

async function finish(s: Session): Promise<void> {
  const scene = sceneNow();
  const pose = s.pose;
  const spec = s.spec;
  if (spec.kind !== 'new') {
    // The preview on screen is the LAST VALID pose of the drag. The release is judged on the FINAL pose, with the same
    // full check the ghost runs at rest: when it is red, or there is no pose at all (released over the sidebar), the
    // edit is reverted, never committed from the last valid step.
    const verdict = scene && pose ? fullGhostCheck(scene, s.subject, pose, { assetId: s.assetId }) : null;
    if (!verdict?.valid) {
      endDrag(false);
      flashNotice(`Can't put ${s.label} there: ${verdict?.message ?? 'drop it inside the view.'}`);
      return;
    }
    endDrag(true);
    return;
  }
  endDrag(false);
  if (!scene || !pose) return;
  const verdict = fullGhostCheck(scene, s.subject, pose, { assetId: s.assetId });
  if (!verdict.valid) {
    flashNotice(`Can't place ${s.label} here: ${verdict.message}`);
    return;
  }
  await placeFromSource(spec.source, pose, verdict.roomId, spec.getRecord);
}

/**
 * Commits a new item from a card at `pose` (the product snapshot is read from the server record, stamped with the
 * record's own date), selects it and tells the user why when it is refused. Shared by the drop and by the
 * "Add to room" button. Returns whether the item was placed.
 */
export async function placeFromSource(source: PlaceSource, pose: GhostPose, roomId: string | undefined, getRecord?: () => Promise<ProductRecord>, relation?: Relation): Promise<boolean> {
  let snapshot;
  if (source.productRef) {
    try {
      if (!getRecord) throw new Error('product record unavailable');
      snapshot = snapshotOf(await getRecord());
    } catch (e) {
      flashNotice(`Can't place ${source.label}: ${e instanceof Error ? e.message : 'the product could not be read'}`);
      return false;
    }
  }
  const result = useSceneStore.getState().dispatch(placeCommand(source, pose, roomId, snapshot, relation), { label: `Place ${source.label}` });
  if (!result.ok) {
    flashNotice(`Can't place ${source.label} here: ${result.errors[0]?.message ?? 'refused'}`);
    return false;
  }
  const placed = result.scene.items[result.scene.items.length - 1];
  if (placed) useViewStore.getState().select({ kind: 'item', entityId: placed.id });
  return true;
}

/** The current drag, for the test hook. */
export function dragState() {
  const { drag, ghost, notice } = useCatalogStore.getState();
  return {
    drag,
    notice,
    ghost: ghost ? { position: ghost.position, rotation: ghost.rotation, elevation: ghost.elevation, valid: ghost.verdict.valid, message: ghost.verdict.message ?? null, kind: ghost.kind } : null,
  };
}

/** Plan point under a screen position (the floor plane y = 0), or null when the viewer is not mounted or the pointer misses the floor. For drags that are not item drags (floor-zone corners). */
export function floorPointAt(clientX: number, clientY: number): Vec2 | null {
  const ray = viewer?.ray(clientX, clientY);
  return ray ? floorPoint(ray) : null;
}

/** Pauses (false) or resumes (true) the camera controls, so a handle drag does not orbit the view. */
export function setViewerControlsEnabled(enabled: boolean): void {
  viewer?.setControlsEnabled(enabled);
}
