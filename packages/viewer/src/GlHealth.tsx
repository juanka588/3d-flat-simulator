import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import type { Material, Mesh, Object3D, WebGLRenderer } from 'three';
import { glCapsOf } from './gl-caps';
import { debugGlRequested, installLogCapture, useGlDebug } from './gl-debug';
import type { ShaderFailure } from './gl-debug';
import { probeStats } from './probe-runtime';
import { useViewerHealth } from './viewer-health';

type Diagnostics = { runnable?: boolean; programLog?: string; vertexShader?: { log?: string }; fragmentShader?: { log?: string } };
type ProgramLike = { diagnostics?: Diagnostics; name?: string };
type Props = { get: (o: object) => { currentProgram?: ProgramLike } };

/** First useful lines of a GLSL info log (the driver's message, not the dumped source). */
function firstLines(text: string): string {
  return text
    .split('\n')
    .filter((l) => /error|warning|fail|exceed|limit|too many|link/i.test(l))
    .slice(0, 3)
    .join(' | ')
    .slice(0, 400);
}

/** Materials whose shader program failed to compile or link: they are silently not drawn by three.js, so say which. */
export function collectShaderFailures(renderer: WebGLRenderer, root: Object3D): ShaderFailure[] {
  const props = (renderer as unknown as { properties: Props }).properties;
  const out: ShaderFailure[] = [];
  const seen = new Set<Material>();
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (seen.has(m)) continue;
      seen.add(m);
      const program = props.get(m)?.currentProgram;
      const d = program?.diagnostics;
      if (d && d.runnable === false) {
        const log = firstLines([d.programLog, d.vertexShader?.log, d.fragmentShader?.log].filter(Boolean).join('\n')) || 'link failed';
        out.push({ object: o.name || o.parent?.name || o.type, material: `${m.name || m.type} (${m.type})`, log });
      }
    }
  });
  return out;
}

/**
 * Inside the canvas: reads the GPU's capabilities for the `?debug=gl` overlay and watches for materials the driver
 * rejected (a banner names them; three.js itself would just skip drawing them, which looks like "the model is not rendered").
 * Renders nothing.
 */
export function GlHealth() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    installLogCapture();
    const ctx = gl.getContext();
    useGlDebug.getState().set({ caps: glCapsOf(ctx) });
    const timer = setInterval(() => {
      const failures = collectShaderFailures(gl, scene);
      const debug = useGlDebug.getState();
      const info = {
        calls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
        geometries: gl.info.memory.geometries,
        textures: gl.info.memory.textures,
        programs: gl.info.programs?.length ?? 0,
        dpr: gl.getPixelRatio(),
        probes: `${probeStats().mode}${probeStats().error ? ` (failed: ${probeStats().error})` : ''}`,
      };
      // The overlay (?debug=gl) is the only reader of the numbers; failures are always kept for the banner below.
      if (debugGlRequested()) debug.set({ failures, info });
      else if (failures.length !== debug.failures.length) debug.set({ failures });
      const health = useViewerHealth.getState();
      if (failures.length > 0 && health.problem?.source !== 'webgl') {
        health.report({ source: 'webgl', message: `${failures.length} material${failures.length > 1 ? 's' : ''} could not be compiled by this GPU and ${failures.length > 1 ? 'are' : 'is'} not drawn (${failures.slice(0, 2).map((f) => `${f.object}: ${f.log}`).join('; ')}). Open the page with ?debug=gl for details.`, keptLastGood: false });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [gl, scene]);
  return null;
}
