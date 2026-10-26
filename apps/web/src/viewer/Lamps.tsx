import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { Color, Euler, Object3D } from 'three';
import type { Group, Light } from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { rankShadowLamps } from './lamp-rank';
import type { LampSpec } from './lighting';

let areaLightsReady = false;
function initAreaLights(): void {
  if (areaLightsReady) return;
  RectAreaLightUniformsLib.init();
  areaLightsReady = true;
}

const POINT_SHADOW_MAP = 512;
const SPOT_SHADOW_MAP = 1024;
const SHADOW_NEAR = 0.1;
const SHADOW_FAR = 16;
const PENUMBRA = 0.3;
const LAMP_PREFIX = 'lamp:';

interface LampsProps {
  lamps: readonly LampSpec[];
  /** Whether lamp shadows are worth drawing (false in bright daylight). */
  shadows: boolean;
  /** Room whose lamps get shadow priority (the selected room). */
  selectedRoomId?: string;
}

/**
 * Point, spot and area lights from the scene's lamps (photometry already applied), plus a small
 * fixture mesh for each. Every lamp always exists, with intensity 0 when off, so toggling a lamp
 * never changes the number of lights (which would recompile every shader). Only the few lamps
 * nearest the camera (or in the selected room) cast shadows, so light does not cross walls there.
 */
export function Lamps({ lamps, shadows, selectedRoomId }: LampsProps) {
  const group = useRef<Group>(null);
  if (lamps.some((l) => l.type === 'area')) initAreaLights();

  useFrame(({ camera }) => {
    const root = group.current;
    if (!root) return;
    const casters = shadows ? rankShadowLamps(lamps, [camera.position.x, camera.position.y, camera.position.z], selectedRoomId) : new Set<string>();
    root.traverse((o) => {
      const light = o as Light;
      if (light.isLight && o.name.startsWith(LAMP_PREFIX) && light.castShadow !== undefined && 'shadow' in light) {
        light.castShadow = casters.has(o.name.slice(LAMP_PREFIX.length));
      }
    });
  });

  return (
    <group ref={group} name="lamps">
      {lamps.map((lamp) => (
        <Lamp key={lamp.id} lamp={lamp} />
      ))}
    </group>
  );
}

function Lamp({ lamp }: { lamp: LampSpec }) {
  const color = useMemo(() => new Color().setRGB(...lamp.color), [lamp.color]);
  const [x, y, z] = lamp.position;
  const name = LAMP_PREFIX + lamp.id;
  const shadowProps = {
    'shadow-bias': -0.0008,
    'shadow-normalBias': 0.03,
    'shadow-camera-near': SHADOW_NEAR,
    'shadow-camera-far': SHADOW_FAR,
  };
  return (
    <>
      {lamp.type === 'point' && (
        <pointLight name={name} position={[x, y, z]} color={color} intensity={lamp.intensity} decay={2} distance={0} shadow-mapSize={[POINT_SHADOW_MAP, POINT_SHADOW_MAP]} {...shadowProps} />
      )}
      {lamp.type === 'spot' && <SpotLamp lamp={lamp} name={name} color={color} shadowProps={shadowProps} />}
      {lamp.type === 'area' && <AreaLamp lamp={lamp} name={name} color={color} />}
      <Fixture lamp={lamp} />
    </>
  );
}

function SpotLamp({ lamp, name, color, shadowProps }: { lamp: LampSpec; name: string; color: Color; shadowProps: Record<string, number> }) {
  const [x, y, z] = lamp.position;
  // Spots point straight down; the target must be part of the scene for the direction to update.
  const target = useMemo(() => new Object3D(), []);
  return (
    <>
      <primitive object={target} position={[x, 0, z]} />
      <spotLight
        name={name}
        position={[x, y, z]}
        target={target}
        color={color}
        intensity={lamp.intensity}
        angle={lamp.angle}
        penumbra={PENUMBRA}
        decay={2}
        distance={0}
        shadow-mapSize={[SPOT_SHADOW_MAP, SPOT_SHADOW_MAP]}
        {...shadowProps}
      />
    </>
  );
}

function AreaLamp({ lamp, name, color }: { lamp: LampSpec; name: string; color: Color }) {
  // A RectAreaLight emits along -Z: tilt it to face down, then spin it on the plan.
  const rotation = useMemo(() => new Euler(-Math.PI / 2, (lamp.rotation * Math.PI) / 180, 0, 'YXZ'), [lamp.rotation]);
  return (
    <rectAreaLight name={name} position={lamp.position} rotation={rotation} width={lamp.width} height={lamp.depth} color={color} intensity={lamp.intensity} />
  );
}

const OFF_COLOR = new Color('#cfcfd2');

/** Small emissive body: a bulb, a downlight disc or a flat panel. Glows regardless of exposure when on. */
function Fixture({ lamp }: { lamp: LampSpec }) {
  const glow = useMemo(() => {
    const max = Math.max(...lamp.color, 1e-6);
    return new Color().setRGB(lamp.color[0] / max, lamp.color[1] / max, lamp.color[2] / max);
  }, [lamp.color]);
  const [x, y, z] = lamp.position;
  return (
    <mesh name={`fixture:${lamp.id}`} position={[x, lamp.type === 'point' ? y : y + 0.02, z]} rotation={[0, (lamp.rotation * Math.PI) / 180, 0]} scale={lamp.type === 'area' ? [lamp.width, 1, lamp.depth] : 1} raycast={noRaycast}>
      {lamp.type === 'point' && <sphereGeometry args={[0.07, 12, 8]} />}
      {lamp.type === 'spot' && <cylinderGeometry args={[0.07, 0.07, 0.04, 16]} />}
      {lamp.type === 'area' && <boxGeometry args={[1, 0.03, 1]} />}
      {lamp.on ? <meshBasicMaterial color={glow} toneMapped={false} /> : <meshStandardMaterial color={OFF_COLOR} roughness={0.6} />}
    </mesh>
  );
}

const noRaycast = () => undefined;
