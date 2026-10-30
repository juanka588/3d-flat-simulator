import { debugGlRequested, useGlDebug } from './gl-debug';
import { supportsProbes } from './gl-caps';

/** Shown instead of the canvas when no WebGL2 context can be created. */
export function NoWebGl({ reason }: { reason: string }) {
  return (
    <div className="viewer-nogl" role="alert" data-testid="viewer-nogl" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem', textAlign: 'center', background: '#e8ebf0', color: '#333', zIndex: 3 }}>
      <div style={{ maxWidth: '32rem' }}>
        <h2 style={{ marginTop: 0 }}>The 3D view cannot start on this device</h2>
        <p>{reason}</p>
        <p style={{ fontSize: '0.85em' }}>Add <code>?debug=gl</code> to the address to see the graphics details and take a screenshot.</p>
      </div>
    </div>
  );
}

/** `?debug=gl`: a text panel with the GPU's capabilities, the quality tier, shader failures and the last errors. Readable in a phone screenshot. */
export function GlDebugOverlay() {
  const s = useGlDebug();
  if (!debugGlRequested()) return null;
  const c = s.caps;
  const lines: string[] = [];
  lines.push(`webgl: ${s.support ? (s.support.ok ? 'OK (WebGL2)' : `FAILED - ${s.support.reason}`) : 'not checked'}`);
  if (c) {
    lines.push(`gpu: ${c.vendor} / ${c.renderer}${c.software ? ' [software]' : ''}${c.mobileGpu ? ' [mobile GPU]' : ''}`);
    lines.push(`tex units frag/vert: ${c.maxTextures}/${c.maxVertexTextures}   max tex: ${c.maxTextureSize}   max 3D: ${c.max3dTextureSize}`);
    lines.push(`uniform vec frag/vert: ${c.maxFragmentUniformVectors}/${c.maxVertexUniformVectors}   varyings: ${c.maxVaryingVectors}   MSAA: ${c.maxSamples}`);
    lines.push(`float render: ${c.floatRender}   half-float render: ${c.halfFloatRender}   float linear: ${c.floatLinear}`);
    lines.push(`light probes supported: ${supportsProbes(c)}`);
  }
  lines.push(`tier: ${s.tier || '?'}   dpr: ${typeof devicePixelRatio === 'number' ? devicePixelRatio : '?'}   ua: ${navigator.userAgent.slice(0, 90)}`);
  if (s.profile) {
    const p = s.profile as Record<string, unknown>;
    lines.push(`profile: dpr<=${String(p['maxDpr'])} sunMap ${String(p['sunMap'])} lampShadows<=${String(p['maxShadowLamps'])} env ${String(p['environment'])} contact ${String(p['contactShadows'])} probes ${p['probes'] ? 'on' : 'off'}`);
  }
  if (s.info) lines.push(`render: ${Object.entries(s.info).map(([k, v]) => `${k}=${String(v)}`).join(' ')}`);
  lines.push(`shader failures: ${s.failures.length}`);
  for (const f of s.failures.slice(0, 6)) lines.push(`  ! ${f.object} / ${f.material}: ${f.log}`);
  if (s.logs.length) lines.push('log:');
  for (const l of s.logs.slice(-8)) lines.push(`  ${l}`);
  const text = lines.join('\n');
  return (
    <div data-testid="gl-debug" style={{ position: 'fixed', left: 4, right: 4, bottom: 4, zIndex: 50, maxHeight: '55vh', overflow: 'auto', background: 'rgba(0,0,0,0.82)', color: '#e6ffe6', font: '11px/1.3 monospace', padding: 6, borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      <button type="button" style={{ float: 'right' }} onClick={() => void navigator.clipboard?.writeText(text)}>
        copy
      </button>
      {text}
    </div>
  );
}
