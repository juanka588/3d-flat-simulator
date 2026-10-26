import { useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo } from 'react';
import { Color, NeutralToneMapping } from 'three';
import type { LightingView, Scene, SiteContext } from '@flat/scene';
import { ContextMesh } from './ContextMesh';
import { Lamps } from './Lamps';
import { SkyDome } from './SkyDome';
import { SunLight } from './SunLight';
import { computeLighting, groundDisplay, hemisphereColors } from './lighting';

const FALLBACK_BACKGROUND = '#e8ebf0';
const NIGHT_BACKGROUND = '#07090e';

/**
 * All lighting of the flat as a function of scene + lighting view: sun, sky, ambient, lamps and
 * exposure. If the lighting maths is unavailable it falls back to the neutral M1 lights.
 */
export function LightingRig({
  scene,
  lighting,
  context,
}: {
  scene: Scene;
  lighting: LightingView;
  context: SiteContext | null;
}) {
  const model = useMemo(() => computeLighting(scene, lighting), [scene, lighting]);
  const get = useThree((s) => s.get);

  const exposure = model.ok ? model.exposure : 1;
  useLayoutEffect(() => {
    const { gl, invalidate } = get();
    gl.toneMapping = NeutralToneMapping;
    gl.toneMappingExposure = exposure;
    invalidate();
  }, [get, exposure]);

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
  const contextMesh = shownContext ? <ContextMesh context={shownContext} castShadow={model.ok && model.sunActive} /> : null;

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
      <hemisphereLight name="ambient" color={sky!.zenith} groundColor={sky!.ground} intensity={model.ambientIntensity} />
      <SunLight model={model} scene={scene} context={shownContext} />
      <Lamps lamps={model.lamps} geometryKey={geometryKey} exposure={model.exposure} />
    </>
  );
}
