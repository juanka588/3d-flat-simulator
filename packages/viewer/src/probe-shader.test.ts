import { ShaderChunk } from 'three';
import { describe, expect, it } from 'vitest';
import { FILL_CHUNK, FILL_FADE_M, installProbeShader, patchFill } from './probe-shader';

describe('the sky fill stays out of the probe grid (a windowless room is dark)', () => {
  it('patches three`s hemisphere and environment diffuse so that a bound probe grid multiplies them by the fill weight', () => {
    installProbeShader();
    const chunks = ShaderChunk as Record<string, string>;
    expect(chunks['lights_fragment_begin']).toContain('probeFillWeight( geometryPosition ) * getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal )');
    expect(chunks['lights_fragment_maps']).toContain('probeFillWeight( geometryPosition ) * getIBLIrradiance( geometryNormal )');
    expect(chunks['lightprobes_pars_fragment']).toContain('float probeFillWeight( vec3 viewPos )');
    // Without a grid (the per-room path) the original statements are what compiles.
    expect(chunks['lights_fragment_begin']).toMatch(/#else\s+irradiance \+= getHemisphereLightIrradiance\( hemisphereLights\[ i \], geometryNormal \);\s+#endif/);
  });

  it('is 0 inside the grid and 1 beyond a fade distance of it, written as one expression of the grid`s own bounds', () => {
    expect(FILL_CHUNK).toContain('probesMin');
    expect(FILL_CHUNK).toContain('probesMax');
    expect(FILL_CHUNK).toContain(`smoothstep( 0.0, ${FILL_FADE_M.toFixed(2)}`);
  });

  it('fails loudly when three.js changes the statement it patches, instead of silently lighting windowless rooms again', () => {
    expect(() => patchFill('nothing here', 'irradiance += x;', 'w * x')).toThrow(/shader chunk changed/);
    expect(patchFill('a\nirradiance += x;\nb', 'irradiance += x;', 'w * x')).toContain('irradiance += w * x;');
  });
});
