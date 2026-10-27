import { useThree } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Color, Matrix4, Object3D } from 'three';
import type { InstancedMesh, PointLight, SpotLight } from 'three';
import { LAMP_NORMAL_BIAS_M, LAMP_SHADOW_BIAS, LAMP_SHADOW_FAR, LAMP_SHADOW_NEAR } from './lamp-shadow';
import { AREA_LIGHT_DROP_M, planRenderLights } from './lighting';
import type { LampSpec, RenderLight } from './lighting';
import { getPerfProfile, shadowLampBudget } from './perf';

export { AREA_LIGHT_DROP_M };

/*
 * Shadow map sizes (per cube face for points) come from the perf profile (see perf.ts). Lamp shadows
 * are room-scale occlusion, but a wall seen at a grazing angle from the lamp needs a fine map or the
 * lookup stripes (acne): full quality is 512 (point), 1024 (the big kitchen area panel, spots).
 */
const PENUMBRA = 0.3;
const LAMP_PREFIX = 'lamp:';

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
 * Every lamp always exists (intensity 0 when off) and its shadow flag depends only on its place in the
 * lamp list (`planRenderLights`), never on `on`. The number of lights and of shadow casters is therefore
 * constant while the scene is, so toggling a lamp or walking around never changes the shader programs
 * (three recompiles every material when the light/shadow counts change). Only the first
 * `shadowLampBudget` lights cast shadows (each costs a shadow map and a texture unit; a GPU has 16); the
 * rest are unshadowed with a cut-off distance.
 * The scene is static, so shadow maps are not re-rendered every frame (`autoUpdate = false`):
 * each light's map is refreshed (`needsUpdate`) only when `geometryKey` or that lamp's intensity
 * changes. Maps: point 512 per face, kitchen panel 1024, spot 1024.
 *
 * Area lamps: a RectAreaLight cannot cast shadows and would light through walls, so an area panel
 * is a PointLight (six 90 degree cube faces: robust shadows everywhere, unlike one very wide
 * perspective frustum) a few centimetres below the panel's centre. A Lambertian panel sends all
 * its flux into the lower hemisphere, a point light into the whole sphere, so `cd = lm / (2 pi)`
 * gives the same flux below the ceiling plane (the half above it is absorbed by the ceiling slab).
 * The emissive panel mesh (`Fixture`) provides the look.
 *
 * Grid lamps (rows x cols LED downlights, one scene light): lit by a few tile lights (spots, one per tile of
 * neighbouring fixtures, at the tile centroid, with the tile's flux), drawn as one instanced mesh of emissive discs.
 */
export function Lamps({ lamps, geometryKey, exposure }: LampsProps) {
  const maxTextures = useThree((s) => s.gl.capabilities.maxTextures);
  const profile = getPerfProfile();
  const lights = useMemo(() => planRenderLights(lamps, { shadowLamps: shadowLampBudget(profile, maxTextures), gridTiles: profile.gridTiles }), [lamps, maxTextures, profile]);
  return (
    <group name="lamps">
      {lights.map((light) => (
        <RigLight key={light.key} light={light} lampType={lamps.find((l) => l.id === light.lampId)?.type} geometryKey={geometryKey} />
      ))}
      {lamps.map((lamp) => (lamp.grid ? <GridFixtures key={lamp.id} lamp={lamp} exposure={exposure} /> : lamp.linked ? null : <Fixture key={lamp.id} lamp={lamp} exposure={exposure} />))}
    </group>
  );
}

function RigLight({ light, lampType, geometryKey }: { light: RenderLight; lampType: LampSpec['type'] | undefined; geometryKey: object }) {
  const color = useMemo(() => new Color().setRGB(...light.color), [light.color]);
  const [x, y, z] = light.position;
  const name = LAMP_PREFIX + light.key;
  const ref = useRef<PointLight | SpotLight>(null);
  const invalidate = useThree((s) => s.invalidate);
  const profile = getPerfProfile();

  useLayoutEffect(() => {
    const l = ref.current;
    if (!l || !light.shadow) return;
    l.shadow.autoUpdate = false;
    l.shadow.needsUpdate = true;
    invalidate();
  }, [geometryKey, light.intensity, light.kind, light.shadow, x, y, z, invalidate]);

  const shadowProps: Record<string, number | boolean> = light.shadow
    ? {
        castShadow: true,
        'shadow-bias': LAMP_SHADOW_BIAS,
        'shadow-normalBias': LAMP_NORMAL_BIAS_M,
        'shadow-camera-near': LAMP_SHADOW_NEAR,
        'shadow-camera-far': LAMP_SHADOW_FAR,
      }
    : {};
  if (light.kind === 'spot') {
    return <DownSpot light={light} lightRef={ref as React.Ref<SpotLight>} name={name} color={color} shadowProps={shadowProps} map={profile.spotMap} />;
  }
  const map = lampType === 'area' ? profile.areaMap : profile.pointMap;
  return (
    <pointLight
      ref={ref as React.Ref<PointLight>}
      name={name}
      position={[x, y, z]}
      color={color}
      intensity={light.intensity}
      decay={2}
      distance={light.reach}
      {...(light.shadow ? { 'shadow-mapSize': [map, map] as [number, number] } : {})}
      {...shadowProps}
    />
  );
}

/** A spot lamp pointing straight down. */
function DownSpot({ light, lightRef, name, color, shadowProps, map }: { light: RenderLight; lightRef: React.Ref<SpotLight>; name: string; color: Color; shadowProps: Record<string, number | boolean>; map: number }) {
  const [x, y, z] = light.position;
  // The target must be part of the scene for the direction to update.
  const target = useMemo(() => new Object3D(), []);
  return (
    <>
      <primitive object={target} position={[x, 0, z]} />
      <spotLight
        ref={lightRef}
        name={name}
        position={[x, y, z]}
        target={target}
        color={color}
        intensity={light.intensity}
        angle={light.angle}
        penumbra={PENUMBRA}
        decay={2}
        distance={light.reach}
        {...(light.shadow ? { 'shadow-mapSize': [map, map] as [number, number] } : {})}
        {...shadowProps}
      />
    </>
  );
}

const OFF_COLOR = new Color('#cfcfd2');
const BLACK = new Color(0, 0, 0);

/** Emissive glow of a switched-on fixture: `1 / exposure` brings it back to a constant, fully lit colour whatever the time of day. */
function useGlow(lamp: LampSpec, exposure: number): Color {
  return useMemo(() => {
    const max = Math.max(...lamp.color, 1e-6);
    return new Color().setRGB(lamp.color[0] / max, lamp.color[1] / max, lamp.color[2] / max).multiplyScalar(1 / Math.max(exposure, 1e-6));
  }, [lamp.color, exposure]);
}

/**
 * Small body: a bulb, a downlight disc or a flat panel. One material type (standard) in both
 * states, so toggling a lamp never compiles a program. Off: lit light grey, as dark as its
 * surroundings. On: black with an emissive glow of `1 / exposure`, which the exposure brings back
 * to a constant, fully lit colour whatever the time of day.
 */
function Fixture({ lamp, exposure }: { lamp: LampSpec; exposure: number }) {
  const glow = useGlow(lamp, exposure);
  const [x, y, z] = lamp.position;
  return (
    <mesh name={`fixture:${lamp.id}`} position={[x, lamp.type === 'point' ? y : y + 0.02, z]} rotation={[0, (lamp.rotation * Math.PI) / 180, 0]} receiveShadow scale={lamp.type === 'area' ? [lamp.width, 1, lamp.depth] : 1} raycast={noRaycast}>
      {lamp.type === 'point' && <sphereGeometry args={[0.07, 12, 8]} />}
      {lamp.type === 'spot' && <cylinderGeometry args={[0.07, 0.07, 0.04, 16]} />}
      {lamp.type === 'area' && <boxGeometry args={[1, 0.03, 1]} />}
      <meshStandardMaterial color={lamp.on ? BLACK : OFF_COLOR} emissive={lamp.on ? glow : BLACK} roughness={0.6} />
    </mesh>
  );
}

const MATRIX = new Matrix4();

/** The fixtures of a grid: one instanced mesh of emissive downlight discs (one draw call, whatever the count). */
function GridFixtures({ lamp, exposure }: { lamp: LampSpec; exposure: number }) {
  const glow = useGlow(lamp, exposure);
  const mesh = useRef<InstancedMesh>(null);
  const fixtures = lamp.grid!.fixtures;
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    fixtures.forEach(([x, y, z], i) => m.setMatrixAt(i, MATRIX.makeTranslation(x, y + 0.02, z)));
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
    invalidate();
  }, [fixtures, invalidate]);
  return (
    <instancedMesh key={fixtures.length} ref={mesh} name={`fixture:${lamp.id}`} args={[undefined, undefined, fixtures.length]} receiveShadow raycast={noRaycast} frustumCulled={false}>
      <cylinderGeometry args={[0.05, 0.05, 0.03, 12]} />
      <meshStandardMaterial color={lamp.on ? BLACK : OFF_COLOR} emissive={lamp.on ? glow : BLACK} roughness={0.6} />
    </instancedMesh>
  );
}

const noRaycast = () => undefined;
