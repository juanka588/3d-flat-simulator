import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Color, Vector3 } from 'three';
import type { Camera } from 'three';
import { roomDaylightFactors } from '@flat/scene';
import type { LightingView, Scene, SiteContext } from '@flat/scene';
import { ContextMesh } from './ContextMesh';
import { ExposureAdapt, adaptiveExposure, settledAtOnce } from './ExposureAdapt';
import { Lamps } from './Lamps';
import { ProbeGI, useProbesActive } from './ProbeGI';
import { probeAmbientSplit } from './probe-light';
import { probeStats, subscribeProbeStats } from './probe-runtime';
import { SkyDome } from './SkyDome';
import { SunLight } from './SunLight';
import type { BuildingMode, ViewMode } from './view-types';
import { computeLighting, environmentLight, gridLimitedExposure, groundDisplay, hemisphereColors, roomAtPoint, roomExposureGain, roomLampLuxById } from './lighting';
import { loadEnvironment } from './environment';
import type { EnvironmentMap } from './environment';
import { getPerfProfile } from './perf';
import { textureCache } from './texture-cache';
import { toneMappingSetting } from './tone';

const FALLBACK_BACKGROUND = '#e8ebf0';
const NIGHT_BACKGROUND = '#07090e';
/** Time constant (s) of the ease of the displayed exposure towards its target in the app. */
const EXPOSURE_EASE_S = 0.25;

/** An orbit camera closer than this to the floor point it looks at is "looking into a room" (a room overview), not at the whole flat. */
const ROOM_VIEW_MAX_DISTANCE_M = 7;
const lookDirection = new Vector3();

/**
 * The room the exposure adapts to: the room the camera stands in (walk), else, for a close
 * orbit camera, the room under the point it looks at (height 1 m). Whole-flat orbits and top views have none.
 */
function viewRoom(scene: Scene, camera: Camera, viewMode: ViewMode): string | undefined {
  const { x, y, z } = camera.position;
  if (viewMode === 'walk') return roomAtPoint(scene, x, z);
  camera.getWorldDirection(lookDirection);
  if (lookDirection.y >= -0.05 || y <= 1) return undefined;
  const t = (y - 1) / -lookDirection.y;
  if (t > ROOM_VIEW_MAX_DISTANCE_M) return undefined;
  return roomAtPoint(scene, x + lookDirection.x * t, z + lookDirection.z * t);
}

/**
 * All lighting of the flat as a function of scene + lighting view: sun, sky, ambient, lamps and
 * exposure. If the lighting maths is unavailable it falls back to the neutral M1 lights.
 */
export function LightingRig({
  scene,
  lighting,
  context,
  viewMode = 'orbit',
  buildingMode = 'hidden',
}: {
  scene: Scene;
  lighting: LightingView;
  context: SiteContext | null;
  viewMode?: ViewMode;
  buildingMode?: BuildingMode;
}) {
  const model = useMemo(() => computeLighting(scene, lighting), [scene, lighting]);
  const get = useThree((s) => s.get);
  const env = useEnvironment();

  const tone = toneMappingSetting();
  const probes = useProbesActive();
  const adaptive = probes && adaptiveExposure();
  // Exposure shown: the live auto exposure, but never more than STALE_GRID_MAX_EV above the one the displayed probe grid was baked for
  // (a stale grid under a much brighter exposure burns out), eased in the app so a change of grid or light never pops. Automation settles at once.
  const gridKeyLux = useSyncExternalStore(subscribeProbeStats, () => (probes ? probeStats().displayedKeyLux : null));
  const exposure = model.ok ? model.exposure : 1;
  const baseTarget = (model.ok && probes ? gridLimitedExposure(model.exposure, model.keyLux, gridKeyLux) : exposure) * tone.exposureScale;
  // Legacy light only (the probes carry the room's real light): the exposure opens up in a room the sky hardly reaches, see `roomExposureGain`.
  const daylight = useMemo(() => roomDaylightFactors(scene), [scene]);
  const roomLamps = useMemo(() => (model.ok ? roomLampLuxById(scene, model.lamps) : {}), [scene, model]);
  const gainFor = (camera: Camera): number => {
    if (!model.ok || probes || viewMode === 'top') return 1;
    const room = viewRoom(scene, camera, viewMode);
    if (!room) return 1;
    const gain = roomExposureGain(model, daylight[room] ?? 1, roomLamps[room] ?? 0);
    // An overview from outside also shows the outer walls, the neighbours and the ground: half the stops only, so they do not burn out.
    return viewMode === 'walk' ? gain : Math.sqrt(gain);
  };
  const shown = useRef(0);
  const apply = (value: number) => {
    const { gl, invalidate } = get();
    gl.toneMapping = tone.mapping;
    gl.toneMappingExposure = value;
    shown.current = value;
    invalidate();
  };
  useLayoutEffect(() => {
    // `?exposure=adapt`: the exposure adapts to the light the camera sees (ExposureAdapt owns it).
    if (adaptive && model.ok) return;
    if (settledAtOnce() || shown.current <= 0) apply(baseTarget * gainFor(get().camera));
    else get().invalidate(); // the useFrame below eases towards the new target
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [get, baseTarget, tone, adaptive, model.ok, probes, viewMode, daylight, roomLamps]);
  useFrame(({ camera }, delta) => {
    if (adaptive && model.ok) return;
    const target = baseTarget * gainFor(camera);
    if (settledAtOnce()) {
      if (shown.current !== target) apply(target);
      return;
    }
    if (Math.abs(Math.log(target / shown.current)) < 1e-3) {
      if (shown.current !== target) apply(target);
      return;
    }
    apply(shown.current * Math.pow(target / shown.current, 1 - Math.exp(-Math.min(delta, 0.25) / EXPOSURE_EASE_S)));
  });

  // Image-based light: a share of the sky's diffuse light comes from the environment map (so glossy surfaces reflect a
  // room), the hemisphere light keeps the rest; at night there is no sky and so no environment either (lamps dominate).
  const ambient = model.ok ? model.ambientIntensity : 0;
  // With baked probes the sky arrives through the windows and bounces (the probes), so the hemisphere is off and the
  // environment map is kept only for reflections; without them it is the old unoccluded hemisphere + environment split.
  const split = useMemo(
    () => (probes ? probeAmbientSplit(ambient, env?.meanRadiance ?? null) : env ? environmentLight(ambient, env.meanRadiance) : { hemisphere: ambient, environment: 0 }),
    [env, ambient, probes],
  );
  useLayoutEffect(() => {
    const { scene: three, invalidate } = get();
    if (!env) return;
    three.environment = env.texture;
    three.environmentIntensity = model.ok ? split.environment : 0;
    invalidate();
    return () => {
      three.environment = null;
    };
  }, [get, env, split, model.ok]);

  const showSky = model.ok && lighting.sunEnabled;
  useLayoutEffect(() => {
    const { scene: three, invalidate } = get();
    three.background = new Color(showSky ? FALLBACK_BACKGROUND : model.ok ? NIGHT_BACKGROUND : FALLBACK_BACKGROUND);
    invalidate();
  }, [get, showSky, model.ok]);

  const sky = useMemo(() => {
    if (!model.ok) return null;
    const c = hemisphereColors(model.zenith, model.horizon);
    const floor = groundDisplay(model.sunIntensity, model.ambientIntensity, model.sun.altitudeDeg, model.exposure, [1, 1, 1]);
    return { zenith: new Color().setRGB(...c.sky), ground: new Color().setRGB(...c.ground), floor };
  }, [model]);
  useEffect(() => {
    if (!model.ok) console.warn(`Lighting maths unavailable, using neutral lighting: ${model.error}`);
  }, [model]);

  const shownContext = lighting.showContext ? context : null;
  // Changes when the geometry that can occlude lamps changes; lamp shadow maps refresh only then.
  const geometryKey = useMemo(() => ({ scene, context: shownContext }), [scene, shownContext]);
  const contextMesh = shownContext ? <ContextMesh context={shownContext} castShadow={model.ok && model.sunActive} viewMode={viewMode} buildingMode={buildingMode} floorElevation={scene.site.floorElevation} /> : null;

  if (!model.ok) {
    return (
      <>
        {contextMesh}
        <hemisphereLight args={['#ffffff', '#8c8578', 1.4]} />
        <directionalLight position={[8, 18, 6]} intensity={1.6} />
        <Lamps lamps={model.lamps} geometryKey={geometryKey} exposure={1} />
      </>
    );
  }

  return (
    <>
      {contextMesh}
      {showSky && <SkyDome direction={model.sun.direction} zenith={model.zenith} horizon={model.horizon} ground={sky!.floor} sunVisibility={model.sunActive ? 1 : 0} />}
      <hemisphereLight name="ambient" color={sky!.zenith} groundColor={sky!.ground} intensity={split.hemisphere} />
      <SunLight model={model} scene={scene} context={shownContext} />
      {probes && <ProbeGI scene={scene} model={model} context={shownContext} />}
      {adaptive && <ExposureAdapt model={model} exposureEV={lighting.exposureEV} viewMode={viewMode} tone={tone} />}
      <Lamps lamps={model.lamps} geometryKey={geometryKey} exposure={model.exposure} />
    </>
  );
}

/**
 * The environment map, loaded once per canvas when the perf profile allows it (it is one more texture lookup per pixel).
 * The load counts as pending work for the test hook (`whenRendered` waits for it), so shader programs are settled by then.
 */
function useEnvironment(): EnvironmentMap | null {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const [env, setEnv] = useState<EnvironmentMap | null>(null);
  const enabled = getPerfProfile().environment;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let loaded: EnvironmentMap | undefined;
    void textureCache.track(
      loadEnvironment(gl).then(
        (map) => {
          if (cancelled) return map.dispose();
          loaded = map;
          setEnv(map);
          invalidate();
        },
        (error: unknown) => console.warn('[lighting] could not load the environment map; glossy surfaces reflect nothing', error),
      ),
    );
    return () => {
      cancelled = true;
      loaded?.dispose();
      setEnv(null);
    };
  }, [gl, enabled, invalidate]);
  return env;
}
