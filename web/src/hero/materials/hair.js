// Hair variant: angel-ring highlight (spec 2.9; QA round 2 D3 rework). Owner: WP1 (edited by WP3).
//
// ONE broken highlight band at a single crown height in head space: the band lives at a fixed rest-pose
// height h = (y - chinY) / skullHeight = mix(heightH) at 0.6 = 0.74 H (rest positions are head-bone space, so the
// ring turns and tilts with the head). It is broken into per-clump segments only WITHIN that band: each clump's
// segment is lens-shaped across the clump (`hairUV.x`, pointed at both clump edges, so neighbours leave gaps),
// stepped slightly up/down by `clumpJitter` and slanted, giving a gentle zigzag. Everything outside the band
// is killed. View dependence is kept mild (spec 2.9 Kajiya-style |dot(T, H)| gate, widened, plus a small
// slide with the half vector) so the band reads as a ring from front, side and game cams. Hard edged (AA from
// fwidth only), colour = palette `band`.
//
// Inputs: `hairUV` (hair-only, vec2) = (across: cos of the cross-section angle on the outer face, 2 on the
// inner face; along: root -> tip in [0, 1], -1 on the cap). Missing attribute -> (0, 0) -> no ring.

/** Vertex declarations (hair only). */
export const HAIR_VERT_PARS_GLSL = /* glsl */`
attribute vec3 tangent;
attribute float clumpJitter;
attribute vec2 hairUV;
varying vec3 vTangentV;
varying float vJitter;
varying vec2 vHairUV;
`;

/** Vertex body: call after skinbase_vertex (skinMatrix available when skinning). */
export const HAIR_VERT_GLSL = /* glsl */`
  vec3 hairT = tangent;
  #ifdef USE_SKINNING
    hairT = ( skinMatrix * vec4( hairT, 0.0 ) ).xyz;
  #endif
  vTangentV = mat3( modelViewMatrix ) * hairT;
  vJitter = clumpJitter;
  vHairUV = hairUV;
`;

export const HAIR_FRAG_PARS_GLSL = /* glsl */`
varying vec3 vTangentV;
varying float vJitter;
varying vec2 vHairUV;
uniform vec4 uRing;          // (bandMax, heightLo, heightHi, strength)
uniform vec2 uRingFrame;     // (chinY, skullHeight)
`;

/**
 * GLSL function: returns band mask in [0, 1].
 * N, Lv, Vv: view space. restPos: rest-space position. upV: view-space world up.
 */
export const HAIR_FUNC_GLSL = /* glsl */`
float heroAngelRing( vec3 N, vec3 Lv, vec3 Vv, vec3 restPos, vec3 upV ) {
  float along = vHairUV.y, u = vHairUV.x;
  float lens = 1.0 - u * u;                        // 1 on the clump centre line, 0 at its edges, < 0 inside
  if ( along < 0.06 || lens <= 0.0 ) return 0.0;
  vec3 T = normalize( vTangentV + vec3( 1e-6 ) );
  vec3 H = normalize( Lv + Vv );
  float j = vJitter - 0.5;
  // single head-space band height (0.74 H), tiny per-clump step + slant -> broken zigzag, no second height
  float h = ( restPos.y - uRingFrame.x ) / uRingFrame.y;
  float hc = mix( uRing.y, uRing.z, 0.6 ) + j * 0.03 + dot( H, upV ) * 0.012;
  hc += u * 0.022 * ( j > 0.0 ? 1.0 : -1.0 );
  float hw = 0.020 * pow( lens, 0.6 );             // segment: pointed at both clump edges
  float d = abs( h - hc );
  float e = max( fwidth( d ), 1e-4 );
  float dash = 1.0 - smoothstep( hw - e, hw + e, d );
  // the clump must cross the band (not run along it); mild Kajiya gate keeps it view dependent
  dash *= smoothstep( 0.2, 0.4, abs( dot( T, upV ) ) );
  dash *= 1.0 - smoothstep( 0.7, 0.9, abs( dot( T, H ) ) );
  // fade at the buried root and the very tip; only on surfaces facing the viewer
  dash *= smoothstep( 0.06, 0.14, along ) * ( 1.0 - smoothstep( 0.86, 0.96, along ) );
  dash *= smoothstep( 0.05, 0.25, dot( N, Vv ) );
  return dash * uRing.w;
}
`;
