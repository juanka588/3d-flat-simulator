import { useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo } from 'react';
import { Color, NeutralToneMapping } from 'three';
import type { LightingView, Scene, SiteContext } from '@flat/scene';
import { ContextMesh } from './ContextMesh';
import { Lamps } from './Lamps';
import { SkyDome } from './SkyDome';
import { SunLight } from './SunLight';
import { AMBIENT_DESATURATION, AMBIENT_FRACTION, LAMP_SHADOW_SUN_LUX_MAX, computeLighting } from './lighting';

const WHITE = new Color(1, 1, 1);
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
  selectedRoomId,
}: {
  scene: Scene;
  lighting: LightingView;
  context: SiteContext | null;
  selectedRoomId?: string;
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

  const sky = useMemo(() => (model.ok ? { zenith: new Color().setRGB(...model.zenith).lerp(WHITE, AMBIENT_DESATURATION), ground: new Color().setRGB(...model.horizon).multiplyScalar(0.35) } : null), [model]);
  useEffect(() => {
    if (!model.ok) console.warn(`Lighting maths unavailable, using neutral lighting: ${model.error}`);
  }, [model]);

  const shownContext = lighting.showContext ? context : null;
  const contextMesh = shownContext ? <ContextMesh context={shownContext} castShadow={model.ok && model.sunActive} /> : null;

  if (!model.ok) {
    return (
      <>
        {contextMesh}
        <hemisphereLight args={['#ffffff', '#8c8578', 1.4]} />
        <directionalLight position={[8, 18, 6]} intensity={1.6} />
        <Lamps lamps={model.lamps} shadows={false} />
      </>
    );
  }

  return (
    <>
      {contextMesh}
      {showSky && <SkyDome direction={model.sun.direction} />}
      <hemisphereLight name="ambient" color={sky!.zenith} groundColor={sky!.ground} intensity={model.ambientLux * AMBIENT_FRACTION} />
      <SunLight model={model} scene={scene} context={shownContext} />
      <Lamps lamps={model.lamps} shadows={model.sunLux < LAMP_SHADOW_SUN_LUX_MAX} selectedRoomId={selectedRoomId} />
    </>
  );
}
