import { PerspectiveCamera, PointerLockControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { findSpawn, insideFlat, resolveWalk, sceneBounds3, walkObstacles } from '@flat/scene';
import type { Scene } from '@flat/scene';
import { clearVirtualKeys, onVirtualWake, virtualKeysHeld } from './walk-input';

export const EYE_HEIGHT = 1.6;
const BODY_RADIUS = 0.25;
const WALK_SPEED = 1.4; // m/s
const RUN_SPEED = 2.8;
const TURN_SPEED = 1.6; // rad/s for the on-screen turn buttons
const LOOK_SPEED = 0.003; // rad per px for drag-to-look
export const VIEWER_ELEMENT_ID = 'flat-viewer';

const KEY_DIRECTIONS: Record<string, [number, number]> = {
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

/** Keystrokes aimed at form controls or editable text belong to them, not to the walker. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(target.tagName);
}

/** Standing point and look direction (degrees, three.js `rotation.y`); looks towards the flat's centre. */
function spawnPose(scene: Scene): { position: [number, number]; yaw: number } {
  const b = sceneBounds3(scene);
  const centre: [number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2];
  const spawn = findSpawn(scene, BODY_RADIUS);
  const position = spawn?.position ?? centre;
  const dx = centre[0] - position[0];
  const dz = centre[1] - position[1];
  // forward = (-sin yaw, -cos yaw) in (x, z)
  const yaw = Math.hypot(dx, dz) > 0.5 ? (Math.atan2(-dx, -dz) * 180) / Math.PI : 0;
  return { position, yaw };
}

interface WalkControlsProps {
  scene: Scene;
  onExit: () => void;
}

/** First-person walk: pointer lock look (drag fallback), WASD/arrows, wall collision, Esc to leave. */
export function WalkControls({ scene, onExit }: WalkControlsProps) {
  const spawn = useMemo(() => spawnPose(scene), [scene]);
  const obstacles = useMemo(() => walkObstacles(scene), [scene]);
  const inside = useMemo(() => insideFlat(scene), [scene]);
  const position = useMemo<[number, number, number]>(
    () => [spawn.position[0], EYE_HEIGHT, spawn.position[1]],
    [spawn],
  );
  const rotation = useMemo<[number, number, number, 'YXZ']>(() => [0, (spawn.yaw * Math.PI) / 180, 0, 'YXZ'], [spawn]);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const pressed = useRef(new Set<string>());
  const exit = useRef(onExit);
  useEffect(() => {
    onVirtualWake(invalidate);
    return () => {
      onVirtualWake(null);
      clearVirtualKeys();
    };
  }, [invalidate]);
  useEffect(() => {
    exit.current = onExit;
  }, [onExit]);

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
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code in KEY_DIRECTIONS || e.code.startsWith('Shift')) {
        if (e.code in KEY_DIRECTIONS) e.preventDefault();
        pressed.current.add(e.code);
        invalidate();
      }
    };
    // Releases are never filtered, so a key can not stay stuck if focus moved while it was held.
    const up = (e: KeyboardEvent) => pressed.current.delete(e.code);
    const blur = () => pressed.current.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    const keys = pressed.current;
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      keys.clear();
    };
  }, [invalidate]);

  // Drag-to-look fallback for when pointer lock is unavailable or not engaged.
  useEffect(() => {
    const el = gl.domElement;
    let dragged = false;
    const move = (e: PointerEvent) => {
      if (document.pointerLockElement || !(e.buttons & 1)) return;
      dragged = dragged || Math.hypot(e.movementX, e.movementY) > 0;
      camera.rotation.order = 'YXZ';
      camera.rotation.y -= e.movementX * LOOK_SPEED;
      camera.rotation.x = Math.max(-1.4, Math.min(1.4, camera.rotation.x - e.movementY * LOOK_SPEED));
      invalidate();
    };
    const down = () => {
      dragged = false;
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
    const host = el.closest<HTMLElement>(`#${VIEWER_ELEMENT_ID}`) ?? el;
    host.addEventListener('click', click, true);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      host.removeEventListener('click', click, true);
    };
  }, [camera, gl, invalidate]);

  useFrame((state, delta) => {
    const keys = pressed.current;
    let strafe = 0;
    let ahead = 0;
    keys.forEach((code) => {
      const dir = KEY_DIRECTIONS[code];
      if (dir) {
        strafe += dir[0];
        ahead += dir[1];
      }
    });
    const virtual = virtualKeysHeld();
    if (virtual.size > 0) {
      ahead += (virtual.has('forward') ? 1 : 0) - (virtual.has('back') ? 1 : 0);
      strafe += (virtual.has('right') ? 1 : 0) - (virtual.has('left') ? 1 : 0);
      const turn = (virtual.has('turnLeft') ? 1 : 0) - (virtual.has('turnRight') ? 1 : 0);
      if (turn !== 0) {
        state.camera.rotation.order = 'YXZ';
        state.camera.rotation.y += turn * TURN_SPEED * Math.min(delta, 0.1);
        invalidate();
      }
    }
    if (strafe === 0 && ahead === 0) return;
    const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? RUN_SPEED : WALK_SPEED;
    const yaw = state.camera.rotation.y;
    // three: forward = (-sin yaw, -cos yaw) in (x, z); right = (cos yaw, -sin yaw)
    const len = Math.hypot(strafe, ahead);
    const dx = (-Math.sin(yaw) * ahead + Math.cos(yaw) * strafe) / len;
    const dz = (-Math.cos(yaw) * ahead - Math.sin(yaw) * strafe) / len;
    const step = Math.min(delta, 0.1) * speed;
    const from: [number, number] = [state.camera.position.x, state.camera.position.z];
    const {
      position: [x, z],
    } = resolveWalk(inside, from, [dx * step, dz * step], obstacles, BODY_RADIUS);
    state.camera.position.set(x, EYE_HEIGHT, z);
    invalidate();
  });

  return (
    <>
      <PerspectiveCamera makeDefault fov={70} near={0.05} far={200} position={position} rotation={rotation} />
      <PointerLockControls makeDefault selector={`#${VIEWER_ELEMENT_ID}`} onUnlock={onExit} />
    </>
  );
}
