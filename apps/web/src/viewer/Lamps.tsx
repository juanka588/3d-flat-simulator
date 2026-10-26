import { useThree } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Color, Object3D } from 'three';
import type { PointLight, SpotLight } from 'three';
import type { LampSpec } from './lighting';

/** Shadow map sizes: small, because lamp shadows are soft room-scale occlusion, not detail. */
export const POINT_SHADOW_MAP = 256;
export const SPOT_SHADOW_MAP = 512;
const SHADOW_NEAR = 0.1;
const SHADOW_FAR = 16;
/** World-space depth bias (metres) of lamp shadows; the light's `bias` is -K / (far - near). */
export const LAMP_SHADOW_BIAS_M = 0.015;
const LAMP_SHADOW_BIAS = -LAMP_SHADOW_BIAS_M / (SHADOW_FAR - SHADOW_NEAR);
const LAMP_NORMAL_BIAS = 0.03;
const PENUMBRA = 0.3;
const LAMP_PREFIX = 'lamp:';

/**
 * Half-angle (radians) of the spot that stands in for an area panel: 87 degrees, so it lights
 * nearly the whole lower half-space like a diffuse panel does.
 */
export const AREA_PROXY_ANGLE = (87 * Math.PI) / 180;

interface LampsProps {
  lamps: readonly LampSpec[];
  /**
   * Changes whenever the geometry that can occlude lamps changes (the scene, the visible context).
   * Shadow maps are only re-rendered then, and when a lamp's own intensity changes.
   */
  geometryKey: object;
  /** Renderer exposure, to keep switched-off fixtures as dark as their surroundings. */
  exposure: number;
}

/**
 * Point and spot lights from the scene's lamps (photometry already applied), plus a small fixture
 * mesh for each.
 *
 * Every lamp always exists and ALWAYS casts shadows (intensity 0 when off). The number of
 * shadow-casting lights is therefore constant, so toggling a lamp or walking around never changes
 * the shader programs (three recompiles every material when the light/shadow counts change).
 * The scene is static, so shadow maps are not re-rendered every frame (`autoUpdate = false`):
 * each light's map is refreshed (`needsUpdate`) only when `geometryKey` or that lamp's intensity
 * changes. Maps are small (point 256, spot 512).
 *
 * Area lamps: a RectAreaLight cannot cast shadows and would light through walls, so an area panel
 * is a downward SpotLight with a very wide cone (87 degrees half-angle), `penumbra = 1` (a smooth
 * fall-off towards the cone edge, roughly the cosine fall-off of a diffuse panel) and the
 * Lambertian peak intensity `cd = lm / pi`. The emissive panel mesh (`Fixture`) provides the look.
 */
export function Lamps({ lamps, geometryKey, exposure }: LampsProps) {
  return (
    <group name="lamps">
      {lamps.map((lamp) => (
        <Lamp key={lamp.id} lamp={lamp} geometryKey={geometryKey} exposure={exposure} />
      ))}
    </group>
  );
}

function Lamp({ lamp, geometryKey, exposure }: { lamp: LampSpec; geometryKey: object; exposure: number }) {
  const color = useMemo(() => new Color().setRGB(...lamp.color), [lamp.color]);
  const [x, y, z] = lamp.position;
  const name = LAMP_PREFIX + lamp.id;
  const light = useRef<PointLight | SpotLight>(null);
  const invalidate = useThree((s) => s.invalidate);

  useLayoutEffect(() => {
    const l = light.current;
    if (!l) return;
    l.shadow.autoUpdate = false;
    l.shadow.needsUpdate = true;
    invalidate();
  }, [geometryKey, lamp.intensity, lamp.type, x, y, z, invalidate]);

  const shadowProps = {
    castShadow: true,
    'shadow-bias': LAMP_SHADOW_BIAS,
    'shadow-normalBias': LAMP_NORMAL_BIAS,
    'shadow-camera-near': SHADOW_NEAR,
    'shadow-camera-far': SHADOW_FAR,
  };
  return (
    <>
      {lamp.type === 'point' && (
        <pointLight ref={light as React.Ref<PointLight>} name={name} position={[x, y, z]} color={color} intensity={lamp.intensity} decay={2} distance={0} shadow-mapSize={[POINT_SHADOW_MAP, POINT_SHADOW_MAP]} {...shadowProps} />
      )}
      {lamp.type !== 'point' && <DownSpot lamp={lamp} lightRef={light as React.Ref<SpotLight>} name={name} color={color} shadowProps={shadowProps} />}
      <Fixture lamp={lamp} exposure={exposure} />
    </>
  );
}

/** A spot pointing straight down: a real spot lamp, or the proxy of an area panel (see `Lamps`). */
function DownSpot({ lamp, lightRef, name, color, shadowProps }: { lamp: LampSpec; lightRef: React.Ref<SpotLight>; name: string; color: Color; shadowProps: Record<string, number | boolean> }) {
  const [x, y, z] = lamp.position;
  // The target must be part of the scene for the direction to update.
  const target = useMemo(() => new Object3D(), []);
  const area = lamp.type === 'area';
  return (
    <>
      <primitive object={target} position={[x, 0, z]} />
      <spotLight
        ref={lightRef}
        name={name}
        position={[x, y, z]}
        target={target}
        color={color}
        intensity={lamp.intensity}
        angle={area ? AREA_PROXY_ANGLE : lamp.angle}
        penumbra={area ? 1 : PENUMBRA}
        decay={2}
        distance={0}
        shadow-mapSize={[SPOT_SHADOW_MAP, SPOT_SHADOW_MAP]}
        {...shadowProps}
      />
    </>
  );
}

const OFF_COLOR = new Color('#cfcfd2');
const BLACK = new Color(0, 0, 0);

/**
 * Small body: a bulb, a downlight disc or a flat panel. One material type (standard) in both
 * states, so toggling a lamp never compiles a program. Off: lit light grey, as dark as its
 * surroundings. On: black with an emissive glow of `1 / exposure`, which the exposure brings back
 * to a constant, fully lit colour whatever the time of day.
 */
function Fixture({ lamp, exposure }: { lamp: LampSpec; exposure: number }) {
  const glow = useMemo(() => {
    const max = Math.max(...lamp.color, 1e-6);
    return new Color().setRGB(lamp.color[0] / max, lamp.color[1] / max, lamp.color[2] / max).multiplyScalar(1 / Math.max(exposure, 1e-6));
  }, [lamp.color, exposure]);
  const [x, y, z] = lamp.position;
  return (
    <mesh name={`fixture:${lamp.id}`} position={[x, lamp.type === 'point' ? y : y + 0.02, z]} rotation={[0, (lamp.rotation * Math.PI) / 180, 0]} scale={lamp.type === 'area' ? [lamp.width, 1, lamp.depth] : 1} raycast={noRaycast}>
      {lamp.type === 'point' && <sphereGeometry args={[0.07, 12, 8]} />}
      {lamp.type === 'spot' && <cylinderGeometry args={[0.07, 0.07, 0.04, 16]} />}
      {lamp.type === 'area' && <boxGeometry args={[1, 0.03, 1]} />}
      <meshStandardMaterial color={lamp.on ? BLACK : OFF_COLOR} emissive={lamp.on ? glow : BLACK} roughness={0.6} />
    </mesh>
  );
}

const noRaycast = () => undefined;
