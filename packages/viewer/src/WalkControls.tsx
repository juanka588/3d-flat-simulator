import { PerspectiveCamera, PointerLockControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PerspectiveCamera as ThreePerspectiveCamera } from 'three';
import { insideFlat, resolveWalk, walkObstacles } from '@flat/scene';
import type { Scene, WalkPose } from '@flat/scene';
import { LOOK_REST, MAX_PITCH_RAD, attachCameraKeys, clampDisc, clampPitch, firstGamepad, lookIdle, readSticks, stepLook, watchGamepad } from './camera-input';
import type { LookState } from './camera-input';
import { BODY_RADIUS } from './walk-start';
import type { PersonPlacement } from './walk-start';
import { clearVirtualKeys, onVirtualWake, onWalkStep, virtualKeysHeld } from './walk-input';
import { eyeHeightM, walkFovDeg } from './walk-camera';
import { headingToYaw, noteAppliedPose } from './camera-pose';

const WALK_SPEED = 1.4; // m/s
const RUN_SPEED = 2.8;
const TURN_SPEED = 1.6; // rad/s for the on-screen turn buttons
const LOOK_SPEED = 0.003; // rad per px for mouse drag-to-look
const TOUCH_LOOK_SPEED = 0.005; // rad per px for finger drag-to-look (a thumb covers less screen)
/** Soft near plane: close enough that a wall 25 cm away is never sliced, far enough for depth precision. */
const NEAR = 0.03;
export const VIEWER_ELEMENT_ID = 'flat-viewer';

/** Keystrokes aimed at form controls or editable text belong to them, not to the walker. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(target.tagName);
}

interface WalkControlsProps {
  scene: Scene;
  /** Where the walk starts (see `personPlacement`): the position and the yaw (three.js `rotation.y`, degrees). */
  start: PersonPlacement;
  /** Called when the walk view unmounts, with where the walker stood and looked: the person ghost goes there. */
  onEnd?: (end: PersonPlacement) => void;
  /** Person height in cm; the camera sits `eyeHeightM(personHeightCm)` above the floor. */
  personHeightCm: number;
  onExit: () => void;
  /** Followed exactly (plan position, eye height, heading, pitch, fov) until the user looks or walks. */
  pose?: WalkPose;
  /** The user turned or moved: the pose, if any, no longer applies. */
  onUserCamera?: () => void;
  /** The host steps time by hand (tests): the walker then moves only when stepped with a fixed dt, never with the frame time. */
  isManualClock?: boolean;
  /** Whether a key aimed at this element drives the walker (false for form fields and the like). */
  acceptsKey?: (target: EventTarget | null) => boolean;
}

/** Desktop browsers lock the pointer to look around; phones have no (usable) pointer lock. */
function pointerLockUsable(): boolean {
  return typeof document.documentElement.requestPointerLock === 'function' && !window.matchMedia('(pointer: coarse)').matches;
}

/**
 * First-person walk: pointer lock look on desktop, drag-to-look (mouse, touch, pen) otherwise. Arrow keys / the
 * left stick move, W/A/S/D (ZQSD on AZERTY, by key position) / the right stick look, plus on-screen buttons, wall collision, Esc to leave.
 */
export function WalkControls({ scene, start, onEnd, personHeightCm, onExit, pose, onUserCamera, isManualClock = false, acceptsKey }: WalkControlsProps) {
  const manualClock = useRef(isManualClock);
  const keyFilter = useRef(acceptsKey);
  useLayoutEffect(() => {
    manualClock.current = isManualClock;
    keyFilter.current = acceptsKey;
  });
  const [spawn] = useState(() => ({ position: [start.x, start.z] as [number, number], yaw: start.yawDeg }));
  const obstacles = useMemo(() => walkObstacles(scene), [scene]);
  const inside = useMemo(() => insideFlat(scene), [scene]);
  const eyeHeight = eyeHeightM(personHeightCm);
  const eye = useRef(eyeHeight);
  const [initialEye] = useState(eyeHeight);
  const position = useMemo<[number, number, number]>(
    () => [spawn.position[0], initialEye, spawn.position[1]],
    [spawn, initialEye],
  );
  const rig = useRef<ThreePerspectiveCamera>(null);
  const size = useThree((s) => s.size);
  const fov = walkFovDeg(size.width / Math.max(size.height, 1));
  const [lockable] = useState(pointerLockUsable);
  const rotation = useMemo<[number, number, number, 'YXZ']>(() => [0, (spawn.yaw * Math.PI) / 180, 0, 'YXZ'], [spawn]);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const pressed = useRef(new Set<string>());
  const exit = useRef(onExit);
  const look = useRef<LookState>(LOOK_REST);
  const end = useRef(onEnd);
  const last = useRef<PersonPlacement>(start);
  useEffect(() => {
    end.current = onEnd;
  }, [onEnd]);
  // Remember where the walker stands and looks, so that leaving walk mode puts the person ghost there.
  useFrame((state) => {
    last.current = { x: state.camera.position.x, z: state.camera.position.z, yawDeg: (state.camera.rotation.y * 180) / Math.PI };
  });
  useEffect(() => () => end.current?.(last.current), []);
  useEffect(() => {
    onVirtualWake(invalidate);
    return () => {
      onVirtualWake(null);
      clearVirtualKeys();
    };
  }, [invalidate]);
  const userCamera = useRef(onUserCamera);
  const followed = useRef(pose);
  useEffect(() => {
    exit.current = onExit;
    userCamera.current = onUserCamera;
    followed.current = pose;
  }, [onExit, onUserCamera, pose]);
  const applied = useRef<WalkPose | undefined>(undefined);
  // Put the followed pose on the camera once per pose, before the walker and the render of this frame.
  useFrame(() => {
    const p = followed.current;
    const cam = rig.current;
    if (!p || !cam || applied.current === p) return;
    applied.current = p;
    eye.current = p.eyeHeight;
    cam.position.set(p.position[0], p.eyeHeight, p.position[1]);
    cam.rotation.set((p.pitchDeg * Math.PI) / 180, headingToYaw(p.headingDeg), 0, 'YXZ');
    cam.fov = p.fovDeg;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    noteAppliedPose(p);
    invalidate();
  }, -2);
  // Changing the person height while walking moves the eyes in place.
  useEffect(() => {
    eye.current = eyeHeight;
    if (rig.current) rig.current.position.y = eyeHeight;
    invalidate();
  }, [eyeHeight, invalidate]);

  useEffect(() => {
    // Walking takes over the keyboard: a focused toolbar button would otherwise swallow WASD.
    if (document.activeElement instanceof HTMLElement && isTypingTarget(document.activeElement)) {
      document.activeElement.blur();
    }
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        exit.current();
        return;
      }
      if (e.code.startsWith('Shift') && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)) pressed.current.add(e.code);
    };
    // The camera keys (arrows move, W/A/S/D look: layout independent `code`s) and their releases, focus rules, blur.
    const detach = attachCameraKeys(pressed.current, { accepts: (t) => !isTypingTarget(t) && (keyFilter.current?.(t) ?? true), arrowsFree: () => true, wake: invalidate });
    const stopPad = watchGamepad(invalidate);
    window.addEventListener('keydown', down);
    return () => {
      window.removeEventListener('keydown', down);
      detach();
      stopPad();
    };
  }, [invalidate]);

  // Drag-to-look: mouse when pointer lock is not engaged, and always for touch and pen. One pointer
  // looks at a time; the on-screen buttons are separate elements, so holding "forward" with one thumb
  // while dragging with the other works. Deltas come from clientX/Y: movementX is not reliable for touch.
  useEffect(() => {
    const el = gl.domElement;
    let lookId: number | null = null;
    let last: [number, number] = [0, 0];
    let speed = LOOK_SPEED;
    let dragged = false;
    const end = (e: PointerEvent) => {
      if (e.pointerId === lookId) lookId = null;
    };
    const down = (e: PointerEvent) => {
      dragged = false;
      if (lookId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      lookId = e.pointerId;
      last = [e.clientX, e.clientY];
      speed = e.pointerType === 'mouse' ? LOOK_SPEED : TOUCH_LOOK_SPEED;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // pointer already gone
      }
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== lookId) return;
      const dx = e.clientX - last[0];
      const dy = e.clientY - last[1];
      last = [e.clientX, e.clientY];
      if (document.pointerLockElement || (dx === 0 && dy === 0)) return;
      dragged = true;
      userCamera.current?.();
      camera.rotation.order = 'YXZ';
      camera.rotation.y -= dx * speed;
      camera.rotation.x = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, camera.rotation.x - dy * speed));
      invalidate();
    };
    // A drag must not end in a click that engages pointer lock.
    const click = (e: MouseEvent) => {
      if (dragged) {
        e.stopImmediatePropagation();
        dragged = false;
      }
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    const host = el.closest<HTMLElement>(`#${VIEWER_ELEMENT_ID}`) ?? el;
    host.addEventListener('click', click, true);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      el.removeEventListener('lostpointercapture', end);
      host.removeEventListener('click', click, true);
    };
  }, [camera, gl, invalidate]);

  const advance = useCallback(
    (state: RootState, delta: number) => {
      const keys = pressed.current;
      const sticks = readSticks(keys, firstGamepad());
      const virtual = virtualKeysHeld();
      let [strafe, ahead] = sticks.move;
      if (virtual.size > 0) {
        ahead += (virtual.has('forward') ? 1 : 0) - (virtual.has('back') ? 1 : 0);
        strafe += (virtual.has('right') ? 1 : 0) - (virtual.has('left') ? 1 : 0);
        const turn = (virtual.has('turnLeft') ? 1 : 0) - (virtual.has('turnRight') ? 1 : 0);
        if (turn !== 0) {
          userCamera.current?.();
          state.camera.rotation.order = 'YXZ';
          state.camera.rotation.y += turn * TURN_SPEED * Math.min(delta, 0.1);
          invalidate();
        }
      }
      // Right stick: smooth yaw / pitch (about 90 deg/s with acceleration); right turns clockwise (three's yaw goes down).
      const turned = stepLook(look.current, sticks.look, delta);
      look.current = turned.state;
      if (turned.dYaw !== 0 || turned.dPitch !== 0) {
        userCamera.current?.();
        state.camera.rotation.order = 'YXZ';
        state.camera.rotation.y -= turned.dYaw;
        state.camera.rotation.x = clampPitch(state.camera.rotation.x + turned.dPitch);
        invalidate();
      }
      if (!lookIdle(look.current) || sticks.look[0] !== 0 || sticks.look[1] !== 0) invalidate();
      [strafe, ahead] = clampDisc([strafe, ahead]);
      const magnitude = Math.hypot(strafe, ahead);
      if (magnitude < 1e-6) return;
      userCamera.current?.();
      const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? RUN_SPEED : WALK_SPEED;
      const yaw = state.camera.rotation.y;
      // three: forward = (-sin yaw, -cos yaw) in (x, z); right = (cos yaw, -sin yaw)
      const dx = -Math.sin(yaw) * ahead + Math.cos(yaw) * strafe;
      const dz = -Math.cos(yaw) * ahead - Math.sin(yaw) * strafe;
      const step = Math.min(delta, 0.1) * speed;
      const from: [number, number] = [state.camera.position.x, state.camera.position.z];
      const {
        position: [x, z],
      } = resolveWalk(inside, from, [dx * step, dz * step], obstacles, BODY_RADIUS);
      state.camera.position.set(x, eye.current, z);
      invalidate();
    },
    [inside, obstacles, invalidate],
  );

  // Test hook (inert unless a test installs a stepper): with the manual clock the walker moves only
  // when stepped with a fixed dt, never with the real frame time.
  const get = useThree((s) => s.get);
  useEffect(() => {
    onWalkStep((dtSeconds) => advance(get(), dtSeconds));
    return () => onWalkStep(null);
  }, [get, advance]);

  useFrame((state, delta) => {
    if (manualClock.current) return;
    advance(state, delta);
  });

  return (
    <>
      <PerspectiveCamera ref={rig} makeDefault fov={pose?.fovDeg ?? fov} near={NEAR} far={200} position={position} rotation={rotation} />
      {lockable && <PointerLockControls makeDefault selector={`#${VIEWER_ELEMENT_ID}`} onUnlock={onExit} onChange={() => userCamera.current?.()} />}
    </>
  );
}
