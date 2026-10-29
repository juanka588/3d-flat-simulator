import { useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Scene, SiteContext } from '@flat/scene';
import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry } from 'three';
import type { Material, Object3D, Scene as ThreeScene } from 'three';
import { GROUND_ALBEDO } from './lighting';
import type { LightingModel } from './lighting';
import { getPerfProfile } from './perf';
import { ProbeBaker } from './probe-baker';
import { BakeMaterials } from './probe-bake-materials';
import type { BakeJob } from './probe-baker';
import { itemBoxes, keyOf, probeIndoor, probeLayout, wallSolids } from './probe-grid';
import type { ProbeSettings } from './probe-grid';
import { PROBE_INDOOR_SKY_GAIN, bakeSky, skyLitRadiance, tuning } from './probe-light';
import { probeStats, resetProbeStats, setProbeStats, subscribeProbeStats } from './probe-runtime';
import { installProbeShader } from './probe-shader';
import { shellFor } from './shell-cache';
import { textureStats } from './texture-cache';
import { modelStats } from './model-runtime';

type OkModel = Extract<LightingModel, { ok: true }>;

/** True for a software renderer (SwiftShader, llvmpipe): baking there costs seconds and the probe lookup slows every frame. */
export function isSoftwareGl(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return /swiftshader|llvmpipe|software/i.test(info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '');
}

/**
 * True while the baked probes carry the indirect light: the profile asks for them, the GPU is a real one (a software renderer keeps
 * the old per-room path, which is cheap there; `?gi=on` forces probes anyway, as the probe tests do) and no bake has failed.
 */
export function useProbesActive(): boolean {
  const gl = useThree((s) => s.gl);
  const settings = getPerfProfile().probes;
  const error = useSyncExternalStore(subscribeProbeStats, () => probeStats().error);
  const usable = useMemo(() => settings !== null && (new URLSearchParams(location.search).get('gi') === 'on' || !isSoftwareGl(gl.getContext())), [settings, gl]);
  return usable && error === null;
}

/** Radius of the bake's sky sphere, metres (the cube cameras' far plane is beyond it). */
const SKY_RADIUS = 60;
/** Objects (by name) that the bake leaves out: contact-shadow decals, selection tints, lamp bodies, the ghost building envelope, the person. */
const SKIPPED = new Set(['contact-shadows', 'selection-highlight', 'host-ghost', 'host-ghost-edges', 'host-facade-edges', 'person']);
const KEPT_ROOTS = new Set(['shell', 'context', 'lamps', 'probe-sky']);
const CONTEXT_BUILDING_ALBEDO = 0.4;
/** Share of the open sky a building's walls see (the rest is ground). */
const FACADE_SKY_SHARE = 0.6;

const SKY_VERTEX = /* glsl */ `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround; varying vec3 vDir;
void main(){
  float h = normalize(vDir).y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.5));
  col = mix(col, uGround, smoothstep(0.0, -0.12, h));
  gl_FragColor = vec4(col, 1.0);
}`;

function makeSky(): Mesh {
  const material = new ShaderMaterial({
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: BackSide,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    uniforms: { uZenith: { value: new Color() }, uHorizon: { value: new Color() }, uGround: { value: new Color() } },
  });
  const mesh = new Mesh(new SphereGeometry(1, 32, 16), material);
  mesh.name = 'probe-sky';
  mesh.scale.setScalar(SKY_RADIUS);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.raycast = () => undefined;
  return mesh;
}

/** `?skygain=N` (tuning/debugging): the factor on the sky the bake sees. */
function skyGainOverride(): number | undefined {
  const v = tuning('skygain');
  return v !== undefined && v > 0 ? v : undefined;
}

/** Which library textures and models are on screen: when this changes the albedo the bake sees changed. */
const readAssets = (): string => `${textureStats().slugs.join(',')}|${modelStats().loaded}`;

const idOf = (() => {
  const ids = new WeakMap<object, number>();
  let next = 0;
  return (o: object | null): number => (o === null ? -1 : (ids.get(o) ?? (ids.set(o, ++next), next)));
})();

/** The settings for this device: a software renderer (SwiftShader, llvmpipe) bakes a coarse grid, one bounce fewer, unless `?probes=fine`. */
function settingsFor(base: ProbeSettings, gl: WebGLRenderingContext | WebGL2RenderingContext): ProbeSettings {
  const fine = typeof location !== 'undefined' && new URLSearchParams(location.search).get('probes') === 'fine';
  const software = !fine && isSoftwareGl(gl);
  const chosen: ProbeSettings = software ? { spacing: Math.max(base.spacing, 1), cube: 8, bounces: 0 } : base;
  // `?spacing=`, `?cube=`, `?bounces=` (tuning and measurements only).
  return { spacing: tuning('spacing') ?? chosen.spacing, cube: tuning('cube') ?? chosen.cube, bounces: tuning('bounces') ?? chosen.bounces };
}

/** The flat's indirect light: a baked grid of spherical-harmonic probes (see probe-grid.ts, probe-shader.ts, docs/photometry.md). Renders nothing itself. */
export function ProbeGI({ scene, model, context }: { scene: Scene; model: OkModel; context: SiteContext | null }) {
  const gl = useThree((s) => s.gl);
  const three = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  const profile = getPerfProfile();
  const settings = useMemo(() => (profile.probes ? settingsFor(profile.probes, gl.getContext()) : null), [profile, gl]);
  const layout = useMemo(() => (settings ? probeLayout(scene, settings) : null), [scene, settings]);
  const geometry = useMemo(() => {
    const shell = shellFor(scene);
    return { solids: wallSolids(scene), boxes: itemBoxes(shell.items) };
  }, [scene]);
  const sky = useMemo(() => makeSky(), []);
  const bakeMaterials = useMemo(() => new BakeMaterials(), []);
  useEffect(() => () => bakeMaterials.dispose(), [bakeMaterials]);
  const [assets, setAssets] = useState(readAssets);

  // Textures and models arrive asynchronously and change the albedo the bake sees: bake again when the set of them changes.
  useEffect(() => {
    const timer = setInterval(() => setAssets(readAssets), 500);
    return () => clearInterval(timer);
  }, []);

  const baker = useMemo(() => {
    installProbeShader();
    return new ProbeBaker(gl, three as ThreeScene, () => invalidate());
  }, [gl, three, invalidate]);

  useLayoutEffect(() => {
    three.add(sky);
    return () => {
      three.remove(sky);
      sky.geometry.dispose();
      (sky.material as Material).dispose();
    };
  }, [three, sky]);

  useLayoutEffect(() => {
    if (layout) baker.mount(layout, geometry.solids, geometry.boxes);
    resetProbeStats('probes');
    const canvas = gl.domElement;
    const restored = () => baker.contextRestored();
    canvas.addEventListener('webglcontextrestored', restored);
    return () => {
      canvas.removeEventListener('webglcontextrestored', restored);
      baker.dispose();
      resetProbeStats('legacy');
    };
    // The displayed grid is mounted once per baker; later layouts are baked into their own grid and swapped in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baker]);

  const key = useMemo(() => {
    if (!layout || !settings) return null;
    return keyOf({
      scene: idOf(scene),
      context: idOf(context),
      assets,
      settings,
      gain: skyGainOverride(),
      sun: [model.sunActive, model.sun.direction, model.sunIntensity],
      sky: [model.ambientIntensity, model.zenith, model.horizon],
      lamps: model.lamps.map((l) => [l.id, l.type, l.position, l.intensity, l.color, l.angle, l.grid?.fixtures]),
    });
  }, [layout, settings, scene, context, assets, model]);

  useLayoutEffect(() => {
    if (!layout || !settings || key === null) return;
    const skyInput = { zenith: model.zenith, horizon: model.horizon, ambientIntensity: model.ambientIntensity, sunIntensity: model.sunIntensity, sunAltitudeDeg: model.sun.altitudeDeg };
    const outdoorSky = bakeSky({ ...skyInput, gain: 1 });
    const indoorSky = bakeSky({ ...skyInput, gain: skyGainOverride() ?? PROBE_INDOOR_SKY_GAIN });
    const centre = [layout.min[0] + layout.size[0] / 2, layout.min[1] + layout.size[1] / 2, layout.min[2] + layout.size[2] / 2] as const;
    const ambient = model.ambientIntensity;
    const job: BakeJob = {
      key,
      keyLux: model.keyLux,
      layout,
      settings,
      solids: geometry.solids,
      boxes: geometry.boxes,
      indoor: probeIndoor(layout, scene),
      prepare: (indoor) => {
        const radiance = indoor ? indoorSky : outdoorSky;
        const undo: (() => void)[] = [];
        const set = <T extends object, K extends keyof T>(o: T, k: K, v: T[K]) => {
          const old = o[k];
          o[k] = v;
          undo.push(() => {
            o[k] = old;
          });
        };
        const u = (sky.material as ShaderMaterial).uniforms as Record<string, { value: Color }>;
        u['uZenith']!.value.setRGB(...radiance.zenith);
        u['uHorizon']!.value.setRGB(...radiance.horizon);
        u['uGround']!.value.setRGB(...radiance.ground);
        sky.position.set(...centre);
        for (const child of three.children) {
          if ((child as { isLight?: boolean }).isLight || (child as { isLightProbeGrid?: boolean }).isLightProbeGrid) {
            if ((child as { isHemisphereLight?: boolean }).isHemisphereLight) set(child as unknown as { intensity: number }, 'intensity', 0);
            continue;
          }
          if (child === sky) set(child, 'visible', true);
          else if (!KEPT_ROOTS.has(child.name)) set(child, 'visible', false);
        }
        // Hide what the bake leaves out, show the ceilings, and draw every PBR material as a diffuse stand-in with the same albedo.
        const emissiveOf = (name: string): number =>
          name === 'context-ground' ? skyLitRadiance(GROUND_ALBEDO, ambient) : name === 'context-buildings' || name === 'host-facade' || name === 'host-solid' ? skyLitRadiance(CONTEXT_BUILDING_ALBEDO, ambient, FACADE_SKY_SHARE) : 0;
        const visit = (c: Object3D, parentName: string) => {
          if (SKIPPED.has(c.name) || c.name.startsWith('fixture:')) {
            set(c, 'visible', false);
            return;
          }
          if (c.name === 'ceilings') set(c, 'visible', true);
          if (!c.visible && c.name !== 'ceilings') return;
          const mesh = c as Mesh;
          if (mesh.isMesh && mesh.material) {
            const emissive = emissiveOf(c.name || parentName);
            const swapped = Array.isArray(mesh.material) ? mesh.material.map((m) => bakeMaterials.get(m, emissive)) : bakeMaterials.get(mesh.material, emissive);
            set(mesh, 'material', swapped);
          }
          for (const child of c.children) visit(child, c.name || parentName);
        };
        for (const root of three.children) if (KEPT_ROOTS.has(root.name) && root !== sky) for (const c of root.children) visit(c, root.name);
        set(three, 'environmentIntensity', 0);
        set(three, 'background', null);
        return () => undo.reverse().forEach((f) => f());
      },
    };
    baker.request(job);
    // The job closes over the lighting it was made for; `key` changes exactly when any of it matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baker, key]);

  useEffect(() => {
    if (!layout) setProbeStats({ pending: false });
  }, [layout]);

  return null;
}
