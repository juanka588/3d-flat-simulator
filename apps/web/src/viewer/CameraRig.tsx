import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Spherical, TOUCH, Vector3 } from 'three';
import type { OrthographicCamera as ThreeOrthographicCamera, PerspectiveCamera as ThreePerspectiveCamera, Quaternion } from 'three';
import { fitCamera, fitOrbit, sceneBounds3 } from '@flat/scene';
import type { CameraPose, Scene } from '@flat/scene';
import { noteAppliedPose, orbitPosition, topUp, topZoomFor } from './camera-pose';
import type { BuildingFraming } from './building-framing';
import { useClockStore } from '../state/dayClock';
import { useViewStore } from '../state/viewStore';
import { itemKeysApply } from '../ui/useItemKeys';
import { LOOK_REST, arrowsBelongToItem, attachCameraKeys, firstGamepad, lookIdle, readSticks, stepLook, watchGamepad } from './camera-input';
import type { LookState } from './camera-input';
import { onWalkStep } from './walk-input';
import type { ViewMode } from './view-types';

const ORBIT_FOV = 50;
/** Constant near plane: small enough not to clip walls up close, large enough for depth precision. */
const NEAR = 0.05;
/** Closest the orbit camera may get to its target, in metres. */
const MIN_DISTANCE = 1;
/** How far out the user may zoom, as a multiple of the framing distance. */
const MAX_DISTANCE_FACTOR = 3;
/** Top view zoom range relative to the fitted zoom. */
const MIN_ZOOM_FACTOR = 0.4;
const MAX_ZOOM_FACTOR = 30;
const TOP_MARGIN = 1.1;
/** How far beyond the flat the arrows may pan the orbit / top target, metres. */
const PAN_MARGIN = 4;
/** Orbit elevation limits as polar angles (from straight up): not below the floor, not exactly overhead. */
const MIN_POLAR = 0.1;
const MAX_POLAR = Math.PI / 2 - 0.01;

/** The parts of three's OrbitControls the pose follower touches (`_quat` is internal but stable in the pinned version). */
interface OrbitControlsLike {
  object: unknown;
  enableDamping: boolean;
  update: () => unknown;
  target: Vector3;
  minDistance: number;
  maxDistance: number;
  minZoom: number;
  maxZoom: number;
  _quat?: Quaternion;
  _quatInverse?: Quaternion;
}

type RootStateLike = Pick<RootState, 'controls' | 'camera' | 'size'>;

/**
 * Touch gestures. Orbit: one finger rotates, two fingers pinch-zoom and pan. Top view cannot rotate, so
 * there one finger pans (three's default would leave it doing nothing) and two fingers pinch and pan.
 */
const ORBIT_TOUCHES = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };
const TOP_TOUCHES = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_PAN };

/**
 * Orbit and top-down cameras. Remount (via `key`) when the scene or mode changes to re-frame.
 * Walk mode has its own rig, see WalkControls.
 */
export function CameraRig({
  scene,
  mode,
  extraReach = 0,
  framing = null,
  pose,
  onUserCamera,
}: {
  scene: Scene;
  mode: Exclude<ViewMode, 'walk'>;
  /** How far site context extends from the flat; only widens the far plane, the framing stays on the flat. */
  extraReach?: number;
  /** Orbit only: look at the facade nearest to the flat and include a little of the building below (set when the building shows). */
  framing?: BuildingFraming | null;
  /** Followed exactly (target, angles, distance, fov / centre, zoom, rotation) until the user moves the camera. */
  pose?: CameraPose;
  /** The user started moving the camera (drag, wheel, pinch): the pose, if any, no longer applies. */
  onUserCamera?: () => void;
}) {
  const size = useThree((s) => s.size);
  const { fit, far, reach, maxDistance, topZoom } = useMemo(
    () => {
      const bounds = sceneBounds3(scene);
      const aspect = size.width / Math.max(size.height, 1);
      const fit = fitCamera(bounds, { mode, aspect, fovDeg: ORBIT_FOV });
      if (mode === 'orbit' && framing) {
        // Same fit, from the facade side, over a box that reaches below the floor: the flat stays the focus.
        const lowered = { min: [bounds.min[0], -framing.belowReach, bounds.min[2]] as [number, number, number], max: bounds.max };
        const o = fitOrbit(lowered, { azimuthDeg: framing.azimuthDeg, elevationDeg: framing.elevationDeg, fovDeg: ORBIT_FOV, aspect, margin: 0.1 });
        fit.target = o.target;
        fit.position = orbitPosition(o);
      }
      const diagonal = Math.hypot(
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
      );
      const distance = Math.hypot(
        fit.position[0] - fit.target[0],
        fit.position[1] - fit.target[1],
        fit.position[2] - fit.target[2],
      );
      const maxDistance = Math.max(distance * MAX_DISTANCE_FACTOR, MIN_DISTANCE * 2);
      // Top view looks along -Y with screen-up = -Z, so plan x is screen width and plan y screen height.
      const halfWidth = ((bounds.max[0] - bounds.min[0]) / 2) * TOP_MARGIN;
      const halfHeight = ((bounds.max[2] - bounds.min[2]) / 2) * TOP_MARGIN;
      const topZoom = Math.min(size.height / (2 * Math.max(halfHeight, 0.1)), size.width / (2 * Math.max(halfWidth, 0.1)));
      return {
        fit,
        // The camera can sit `maxDistance` from the target and the box is within `diagonal` of it.
        far: maxDistance + diagonal + extraReach + 10,
        reach: diagonal + extraReach + 10,
        maxDistance,
        topZoom,
      };
    },
    // Re-fit on scene/mode only: resizing the canvas must not reset the user's pan and zoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scene, mode],
  );

  const followed = pose && pose.mode === mode ? pose : undefined;
  const poseRef = useRef(followed);
  useLayoutEffect(() => {
    poseRef.current = followed;
  });
  const applied = useRef<{ pose?: CameraPose; controls?: unknown; height?: number }>({});

  // Puts the followed pose on the camera and controls once per pose (and after a resize for the top
  // view, whose zoom depends on the canvas height). Runs before drei's own controls update (priority
  // -1) with damping off, so nothing coasts: the camera sits exactly at the pose.
  useFrame((state) => {
    const p = poseRef.current;
    if (!p) return;
    const controls = state.controls as OrbitControlsLike | null;
    const camera = state.camera;
    const typeOk = p.mode === 'top' ? (camera as ThreeOrthographicCamera).isOrthographicCamera : (camera as ThreePerspectiveCamera).isPerspectiveCamera;
    if (!controls || controls.object !== camera || !typeOk) {
      state.invalidate(); // the rig's camera and controls register just after mount
      return;
    }
    const a = applied.current;
    if (a.pose === p && a.controls === controls && (p.mode !== 'top' || a.height === state.size.height)) return;
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update(); // flush leftover drag momentum, then place the camera
    if (p.mode === 'orbit') {
      const cam = camera as ThreePerspectiveCamera;
      cam.up.set(0, 1, 0);
      cam.fov = p.fovDeg;
      cam.far = Math.max(far, p.distance + reach);
      cam.updateProjectionMatrix();
      controls.minDistance = Math.min(MIN_DISTANCE, p.distance);
      controls.maxDistance = Math.max(maxDistance, p.distance);
      controls.target.set(...p.target);
      cam.position.set(...orbitPosition(p));
    } else if (p.mode === 'top') {
      const cam = camera as ThreeOrthographicCamera;
      const up = topUp(p);
      cam.up.set(...up);
      // The controls rotate offsets into "camera-up-is-up" space once at construction; follow the new up.
      if (controls._quat && controls._quatInverse) {
        controls._quat.setFromUnitVectors(cam.up, new Vector3(0, 1, 0));
        controls._quatInverse.copy(controls._quat).invert();
      }
      const zoom = topZoomFor(p, state.size.height);
      cam.zoom = zoom;
      cam.far = Math.max(far, fit.position[1] + reach);
      cam.updateProjectionMatrix();
      controls.minZoom = Math.min(topZoom * MIN_ZOOM_FACTOR, zoom * MIN_ZOOM_FACTOR);
      controls.maxZoom = Math.max(topZoom * MAX_ZOOM_FACTOR, zoom * MAX_ZOOM_FACTOR);
      controls.target.set(p.center[0], fit.target[1], p.center[1]);
      cam.position.set(p.center[0], fit.position[1], p.center[1]);
    }
    controls.update();
    controls.enableDamping = damping;
    applied.current = { pose: p, controls, height: state.size.height };
    noteAppliedPose(p);
    state.invalidate();
  }, -2);

  // Keyboard / gamepad camera: arrows (left stick) pan the target on the floor; W/A/S/D (ZQSD on AZERTY, right stick)
  // orbit the camera around its target (orbit view only). A selected item keeps the arrows for nudging.
  const invalidate = useThree((s) => s.invalidate);
  const get = useThree((s) => s.get);
  const held = useRef(new Set<string>());
  const look = useRef<LookState>(LOOK_REST);
  const userCamera = useRef(onUserCamera);
  useLayoutEffect(() => {
    userCamera.current = onUserCamera;
  });
  const bounds = useMemo(() => sceneBounds3(scene), [scene]);
  const itemOwnsArrows = () => {
    const v = useViewStore.getState();
    return arrowsBelongToItem(v.mode, v.selection);
  };
  useEffect(() => {
    const detach = attachCameraKeys(held.current, { accepts: itemKeysApply, arrowsFree: () => !itemOwnsArrows(), wake: invalidate });
    const stopPad = watchGamepad(invalidate);
    return () => {
      detach();
      stopPad();
    };
  }, [invalidate]);
  const advance = useCallback(
    (state: RootStateLike, delta: number) => {
      const controls = state.controls as OrbitControlsLike | null;
      const cam = state.camera;
      if (!controls || controls.object !== cam) return;
      const sticks = readSticks(held.current, firstGamepad(), { arrows: !itemOwnsArrows() });
      const turned = stepLook(look.current, mode === 'orbit' ? sticks.look : [0, 0], delta);
      look.current = turned.state;
      const dt = Math.min(delta, 0.1);
      const moving = sticks.move[0] !== 0 || sticks.move[1] !== 0;
      if (!moving && turned.dYaw === 0 && turned.dPitch === 0) {
        if (!lookIdle(look.current)) invalidate();
        return;
      }
      userCamera.current?.();
      const target = controls.target;
      const offset = new Vector3().copy(cam.position).sub(target);
      if (mode === 'orbit' && (turned.dYaw !== 0 || turned.dPitch !== 0)) {
        const sph = new Spherical().setFromVector3(offset);
        sph.theta += turned.dYaw; // D: the camera moves round to its right
        sph.phi = Math.max(MIN_POLAR, Math.min(MAX_POLAR, sph.phi + turned.dPitch)); // W: look up = the camera sinks
        offset.setFromSpherical(sph);
      }
      let dx = 0;
      let dz = 0;
      if (moving) {
        // Forward on the floor: from the camera towards the target (orbit), or screen-up (top).
        let fx: number;
        let fz: number;
        let speed: number;
        if (mode === 'top') {
          fx = cam.up.x;
          fz = cam.up.z;
          speed = (state.size.height / (cam as ThreeOrthographicCamera).zoom) * 0.5;
        } else {
          fx = -offset.x;
          fz = -offset.z;
          speed = Math.max(1.2, offset.length() * 0.6);
        }
        const len = Math.hypot(fx, fz) || 1;
        fx /= len;
        fz /= len;
        const rx = -fz;
        const rz = fx;
        dx = (fx * sticks.move[1] + rx * sticks.move[0]) * speed * dt;
        dz = (fz * sticks.move[1] + rz * sticks.move[0]) * speed * dt;
        // Stay near the flat.
        dx = Math.max(bounds.min[0] - PAN_MARGIN, Math.min(bounds.max[0] + PAN_MARGIN, target.x + dx)) - target.x;
        dz = Math.max(bounds.min[2] - PAN_MARGIN, Math.min(bounds.max[2] + PAN_MARGIN, target.z + dz)) - target.z;
      }
      target.x += dx;
      target.z += dz;
      cam.position.set(target.x + offset.x, target.y + offset.y, target.z + offset.z);
      controls.update();
      invalidate();
    },
    [mode, bounds, invalidate],
  );
  // Test hook (inert unless a test installs a stepper): with the manual clock the camera moves only when stepped.
  useEffect(() => {
    onWalkStep((dtSeconds) => advance(get(), dtSeconds));
    return () => onWalkStep(null);
  }, [get, advance]);
  useFrame((state, delta) => {
    if (useClockStore.getState().source === 'manual') return;
    advance(state, delta);
  }, -1.5);

  if (mode === 'top') {
    return (
      <>
        <OrthographicCamera makeDefault position={fit.position} up={fit.up} zoom={topZoom} near={NEAR} far={far} />
        <OrbitControls
          makeDefault
          onStart={onUserCamera}
          target={fit.target}
          enableRotate={false}
          touches={TOP_TOUCHES}
          screenSpacePanning
          minZoom={topZoom * MIN_ZOOM_FACTOR}
          maxZoom={topZoom * MAX_ZOOM_FACTOR}
        />
      </>
    );
  }
  return (
    <>
      <PerspectiveCamera makeDefault fov={followed?.mode === 'orbit' ? followed.fovDeg : ORBIT_FOV} position={fit.position} up={fit.up} near={NEAR} far={far} />
      <OrbitControls
        makeDefault
        onStart={onUserCamera}
        target={fit.target}
        touches={ORBIT_TOUCHES}
        minDistance={MIN_DISTANCE}
        maxDistance={maxDistance}
        maxPolarAngle={Math.PI / 2 - 0.01}
      />
    </>
  );
}
