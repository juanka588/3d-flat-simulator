import { ShaderChunk } from 'three';

/**
 * Wall-aware sampling of three's light-probe grid (`LightProbeGridWebGL`).
 *
 * three's own `getLightProbeGridIrradiance` interpolates the eight probes around a point trilinearly. The flat's walls are
 * thin (7 cm partitions) and the probes 0.5 m apart, so beside a partition half of the weight lands on the probes of the
 * room behind it and a lit room glows into the dark one. This chunk replaces it (same name, same uniforms, same atlas) with
 * an interpolation over the plan corners of the cell weighted by a precomputed visibility (`probe-grid.ts`, `buildVisibility`):
 * the corner probes that a wall hides from the point get weight 0 and the others are renormalised.
 *
 * The visibility lives in the SAME 3D texture as the spherical harmonics, in the slices behind the seven SH sub-volumes
 * (see `probe-baker.ts`), so it costs no texture unit and no extra uniform. Layout of those slices, per texel (float RGBA):
 *   texel 0 = (subdiv, 0, 0, 0); then one texel per subcell, index L = 1 + ((cz * cellsX + cx) * subdiv + sz) * subdiv + sx,
 *   stored at x = L % nx, y = (L / nx) % ny, z = visBase + L / (nx * ny), value = visibility of the cell's corners
 *   (x, z), (x + 1, z), (x, z + 1), (x + 1, z + 1).
 * Points whose four corners are all visible (most of the flat) take three's seven-fetch trilinear path; only points next to
 * a wall pay for the 28 fetches of the weighted path. A grid whose atlas has no visibility slices (the empty atlas of the
 * first bake pass) yields no light.
 */
export const PROBE_CHUNK = /* glsl */ `
#ifdef USE_LIGHT_PROBES_GRID

uniform highp sampler3D probesSH;

uniform vec3 probesMin;
uniform vec3 probesMax;
uniform vec3 probesResolution;

vec3 probeShIrradiance( vec4 s0, vec4 s1, vec4 s2, vec4 s3, vec4 s4, vec4 s5, vec4 s6, vec3 n ) {

	vec3 c0 = s0.xyz;
	vec3 c1 = vec3( s0.w, s1.xy );
	vec3 c2 = vec3( s1.zw, s2.x );
	vec3 c3 = s2.yzw;
	vec3 c4 = s3.xyz;
	vec3 c5 = vec3( s3.w, s4.xy );
	vec3 c6 = vec3( s4.zw, s5.x );
	vec3 c7 = s5.yzw;
	vec3 c8 = s6.xyz;

	float x = n.x, y = n.y, z = n.z;

	vec3 result = c0 * 0.886227;
	result += c1 * 2.0 * 0.511664 * y;
	result += c2 * 2.0 * 0.511664 * z;
	result += c3 * 2.0 * 0.511664 * x;
	result += c4 * 2.0 * 0.429043 * x * y;
	result += c5 * 2.0 * 0.429043 * y * z;
	result += c6 * ( 0.743125 * z * z - 0.247708 );
	result += c7 * 2.0 * 0.429043 * x * z;
	result += c8 * 0.429043 * ( x * x - y * y );

	return max( result, vec3( 0.0 ) );

}

vec3 getLightProbeGridIrradiance( vec3 worldPos, vec3 worldNormal ) {

	vec3 res = probesResolution;
	vec3 spacing = ( probesMax - probesMin ) / ( res - 1.0 );

	// Look half a cell off the surface, along the normal (as three does), so a wall is read from its own side.
	vec3 samplePos = worldPos + worldNormal * vec3( spacing.x, min( spacing.y, spacing.x ), spacing.z ) * 0.5;
	vec3 g = clamp( ( samplePos - probesMin ) / spacing, vec3( 0.0 ), res - 1.0 );
	vec3 i0 = min( floor( g ), res - 2.0 );
	vec3 f = g - i0;

	ivec3 atlas = textureSize( probesSH, 0 );
	int nx = int( res.x + 0.5 );
	int ny = int( res.y + 0.5 );
	int nz = int( res.z + 0.5 );
	int visBase = 7 * ( nz + 2 );
	if ( atlas.z <= visBase ) return vec3( 0.0 );

	float paddedSlices = res.z + 2.0;
	float atlasDepth = float( atlas.z );

	int subdiv = int( texelFetch( probesSH, ivec3( 0, 0, visBase ), 0 ).x + 0.5 );
	if ( subdiv < 1 ) return vec3( 0.0 );

	ivec2 cell = ivec2( i0.xz );
	ivec2 sub = clamp( ivec2( f.xz * float( subdiv ) ), ivec2( 0 ), ivec2( subdiv - 1 ) );
	int cellsX = nx - 1;
	int L = 1 + ( ( cell.y * cellsX + cell.x ) * subdiv + sub.y ) * subdiv + sub.x;
	int perSlice = nx * ny;
	int rem = L % perSlice;
	vec4 vis = texelFetch( probesSH, ivec3( rem % nx, rem / nx, visBase + L / perSlice ), 0 );

	if ( min( min( vis.x, vis.y ), min( vis.z, vis.w ) ) > 0.5 ) {

		// No wall in the way of any corner: plain trilinear interpolation, as three does.
		vec2 txy = ( g.xy + 0.5 ) / res.xy;
		float zBase = g.z + 1.5;
		vec4 s0 = texture( probesSH, vec3( txy, ( zBase ) / atlasDepth ) );
		vec4 s1 = texture( probesSH, vec3( txy, ( zBase + paddedSlices ) / atlasDepth ) );
		vec4 s2 = texture( probesSH, vec3( txy, ( zBase + 2.0 * paddedSlices ) / atlasDepth ) );
		vec4 s3 = texture( probesSH, vec3( txy, ( zBase + 3.0 * paddedSlices ) / atlasDepth ) );
		vec4 s4 = texture( probesSH, vec3( txy, ( zBase + 4.0 * paddedSlices ) / atlasDepth ) );
		vec4 s5 = texture( probesSH, vec3( txy, ( zBase + 5.0 * paddedSlices ) / atlasDepth ) );
		vec4 s6 = texture( probesSH, vec3( txy, ( zBase + 6.0 * paddedSlices ) / atlasDepth ) );
		return probeShIrradiance( s0, s1, s2, s3, s4, s5, s6, worldNormal );

	}

	// Some corner is hidden by a wall: the four plan corners weighted by bilinear weight x visibility. Along Y the hardware
	// filter blends the two levels (the sample sits exactly on the texel centres in X and Z).
	float w0 = ( 1.0 - f.x ) * ( 1.0 - f.z ) * vis.x;
	float w1 = f.x * ( 1.0 - f.z ) * vis.y;
	float w2 = ( 1.0 - f.x ) * f.z * vis.z;
	float w3 = f.x * f.z * vis.w;
	float total = w0 + w1 + w2 + w3;
	if ( total < 1e-5 ) return vec3( 0.0 );

	vec4 a0 = vec4( 0.0 ), a1 = vec4( 0.0 ), a2 = vec4( 0.0 ), a3 = vec4( 0.0 ), a4 = vec4( 0.0 ), a5 = vec4( 0.0 ), a6 = vec4( 0.0 );
	float weights[ 4 ] = float[ 4 ]( w0, w1, w2, w3 );
	float ty = ( g.y + 0.5 ) / res.y;

	for ( int c = 0; c < 4; c ++ ) {

		float w = weights[ c ] / total;
		if ( w <= 0.0 ) continue;
		float tx = ( i0.x + float( c & 1 ) + 0.5 ) / res.x;
		float zBase = i0.z + float( c >> 1 ) + 1.5;
		a0 += w * texture( probesSH, vec3( tx, ty, ( zBase ) / atlasDepth ) );
		a1 += w * texture( probesSH, vec3( tx, ty, ( zBase + paddedSlices ) / atlasDepth ) );
		a2 += w * texture( probesSH, vec3( tx, ty, ( zBase + 2.0 * paddedSlices ) / atlasDepth ) );
		a3 += w * texture( probesSH, vec3( tx, ty, ( zBase + 3.0 * paddedSlices ) / atlasDepth ) );
		a4 += w * texture( probesSH, vec3( tx, ty, ( zBase + 4.0 * paddedSlices ) / atlasDepth ) );
		a5 += w * texture( probesSH, vec3( tx, ty, ( zBase + 5.0 * paddedSlices ) / atlasDepth ) );
		a6 += w * texture( probesSH, vec3( tx, ty, ( zBase + 6.0 * paddedSlices ) / atlasDepth ) );

	}

	return probeShIrradiance( a0, a1, a2, a3, a4, a5, a6, worldNormal );

}

#endif
`;

/** Distance (metres) beyond the probe grid over which the diffuse fill (hemisphere, environment) fades back in. */
export const FILL_FADE_M = 0.3;

/**
 * 1 outside the grid, 0 inside it, for a view-space position: the sky fill (hemisphere light and the diffuse part of the environment
 * map) is unoccluded and so cannot tell a room from the open air. Inside the grid (the flat plus a margin) the probes carry the sky
 * through windows and bounces, so a windowless room stays dark; the fill only remains for what the grid does not cover (the
 * neighbouring buildings, the ground and the host facade below the flat). Y is padded by one probe level beyond the first and last.
 */
export const FILL_CHUNK = /* glsl */ `
#ifdef USE_LIGHT_PROBES_GRID

float probeFillWeight( vec3 viewPos ) {

	vec3 worldPos = ( ( vec4( viewPos, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
	vec3 pad = vec3( 0.0, 0.35, 0.0 );
	vec3 beyond = max( max( probesMin - pad - worldPos, worldPos - probesMax - pad ), vec3( 0.0 ) );
	return smoothstep( 0.0, ${FILL_FADE_M.toFixed(2)}, max( max( beyond.x, beyond.y ), beyond.z ) );

}

#endif
`;

let installed = false;

/** Swaps three's light-probe chunk for the wall-aware one (idempotent). Call before the first material compiles with a grid. */
export function installProbeShader(): void {
  if (installed) return;
  installed = true;
  const chunks = ShaderChunk as Record<string, string>;
  chunks['lightprobes_pars_fragment'] = PROBE_CHUNK + FILL_CHUNK;
  chunks['lights_fragment_begin'] = patchFill(chunks['lights_fragment_begin']!, 'irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );', 'probeFillWeight( geometryPosition ) * getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal )');
  chunks['lights_fragment_maps'] = patchFill(chunks['lights_fragment_maps']!, 'iblIrradiance += getIBLIrradiance( geometryNormal );', 'probeFillWeight( geometryPosition ) * getIBLIrradiance( geometryNormal )');
}

/** `chunk` with the single fill statement `from` (`target += expr;`) multiplied by the fill weight when a probe grid is bound (unchanged otherwise). */
export function patchFill(chunk: string, from: string, weighted: string): string {
  if (!chunk.includes(from)) throw new Error(`three.js shader chunk changed: "${from}" not found (probe fill occlusion)`);
  const target = from.slice(0, from.indexOf('+='));
  return chunk.replace(from, `#ifdef USE_LIGHT_PROBES_GRID\n\t${target}+= ${weighted};\n#else\n\t${from}\n#endif`);
}
