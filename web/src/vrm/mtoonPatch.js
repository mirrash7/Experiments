// Small, targeted MToon shader patches (anime-rendering.md 1 "Extending MToon": onBeforeCompile on the surface
// materials only, gated by #defines, wrapping three-vrm's own onBeforeCompile / customProgramCacheKey).
//
//   ARENA_PATCH (every tuned surface)
//     * remembers the KEY light's toon shading factor (the key is identified by its view-space direction)
//     * lit-side rim: the parametric rim is multiplied by the key shading (no pale halo on the shaded side)
//     * cool back rim: a crisp fresnel edge on the side facing the (virtual) back light, for figure/ground separation
//       against the warm arena. Not a real light: a real directional light would also lift every shaded area.
//     * emission gate: authored emissive highlights (VRoid hair "spe" maps) only show on the lit side
//   ARENA_FACE_SDF (the face skin material): the key light's N.L is replaced by the SDF face field (vrm/faceShadow.js)
//   ARENA_HAIR_RING (hair): a thin Kajiya-Kay style "angel ring" band, tangent = head up projected on the surface,
//     shifted per texel by the hair texture's luminance so it breaks up along the strands. Lit side only.
import * as THREE from 'three';
import { FACE_PARS_GLSL, FACE_FUNC_GLSL } from './faceShadow.js';

const KEY_DOT = 'float dotNL = clamp( dot( geometryNormal, directLight.direction ), -1.0, 1.0 );';
const SHADING = 'float shading = getShading( dotNL, shadow, material.shadingShift );';
const LIGHTS_BEGIN = '// #include <lights_fragment_begin>';
const RIM_ADD = 'col += rimMix * rim;';
const EMIS_ADD = 'col += totalEmissiveRadiance;';

const FRAG_PARS = /* glsl */`
uniform vec3 uKeyDirView;
uniform vec3 uBackDirView;
uniform vec3 uBackRimColor;
uniform float uArenaRimLit;
uniform float uArenaBackRim;
uniform float uArenaEmisLit;
float arenaKeyShading = 1.0;
#ifdef ARENA_FACE_SDF
  ${FACE_PARS_GLSL}
  uniform float uFaceX0;
  varying vec3 vArenaHeadPos;
  varying vec3 vArenaHeadN;
  float arenaFaceDotNL = 0.0;
  ${FACE_FUNC_GLSL}
#endif
#ifdef ARENA_HAIR_RING
  uniform vec3 uHeadUpView;
  uniform float uHairSpec;
  uniform float uHairSpecShift;
  uniform float uHairLumMean;
#endif
`;

const VERT_PARS = /* glsl */`
#ifdef ARENA_FACE_SDF
  uniform mat4 uHeadInv;
  varying vec3 vArenaHeadPos;
  varying vec3 vArenaHeadN;
#endif
`;

const VERT_MAIN = /* glsl */`
#include <skinning_vertex>
#ifdef ARENA_FACE_SDF
  vArenaHeadPos = ( uHeadInv * ( modelMatrix * vec4( transformed, 1.0 ) ) ).xyz;
  vArenaHeadN = normalize( mat3( uHeadInv ) * ( mat3( modelMatrix ) * objectNormal ) );
#endif
`;

const FRAG_KEY = /* glsl */`
    float dotNL = clamp( dot( geometryNormal, directLight.direction ), -1.0, 1.0 );
    bool arenaIsKey = dot( directLight.direction, uKeyDirView ) > 0.999;
    #ifdef ARENA_FACE_SDF
      if ( arenaIsKey ) dotNL = arenaFaceDotNL;
    #endif`;

const FRAG_SHADING = /* glsl */`
    float shading = getShading( dotNL, shadow, material.shadingShift );
    if ( arenaIsKey ) arenaKeyShading = shading;`;

const FRAG_FACE = /* glsl */`
  #ifdef ARENA_FACE_SDF
  {
    vec2 ff = heroFaceField( vArenaHeadPos - vec3( uFaceX0, 0.0, 0.0 ), normalize( vArenaHeadN ), 0.0 );
    arenaFaceDotNL = clamp( 2.0 * ff.x, -1.0, 1.0 );
  }
  #endif
  ${LIGHTS_BEGIN}`;

const FRAG_RIM = /* glsl */`
  rim *= mix( 1.0, arenaKeyShading, uArenaRimLit );
  col += rimMix * rim;
  {
    // cool back rim: crisp fresnel edge facing the back light
    float fr = 1.0 - saturate( dot( viewDir, normal ) );
    float bk = saturate( dot( normal, uBackDirView ) );
    col += uBackRimColor * uArenaBackRim * smoothstep( 0.5, 0.8, fr ) * smoothstep( 0.05, 0.45, bk )
      * mix( vec3( 1.0 ), diffuseColor.rgb, 0.4 );
  }
  #ifdef ARENA_HAIR_RING
  {
    vec3 up = normalize( uHeadUpView );
    vec3 T = up - normal * dot( normal, up );
    float tl = length( T );
    T = tl > 1e-3 ? T / tl : vec3( 0.0, 1.0, 0.0 );
    float lum = dot( diffuseColor.rgb, vec3( 0.3333 ) );
    vec3 Ts = normalize( T + normal * ( uHairSpecShift + ( lum - uHairLumMean ) * 0.9 ) );
    vec3 Hh = normalize( uKeyDirView + viewDir );
    float th = dot( Ts, Hh );
    float s = sqrt( max( 0.0, 1.0 - th * th ) );
    float band = smoothstep( 0.955, 0.992, s );
    float facing = smoothstep( 0.2, 0.5, dot( normal, viewDir ) ) * smoothstep( -0.2, 0.3, dot( normal, up ) );
    col += uHairSpec * band * facing * arenaKeyShading * mix( diffuseColor.rgb, vec3( 1.0 ), 0.45 );
  }
  #endif`;

const FRAG_EMIS = 'col += totalEmissiveRadiance * mix( 1.0, arenaKeyShading, uArenaEmisLit );';

/**
 * Shared per-hero uniforms (one object, referenced by every patched material).
 */
export function createSharedUniforms() {
  return {
    uKeyDirView: { value: new THREE.Vector3(0, 0, 1) },
    uBackDirView: { value: new THREE.Vector3(0.6, 0.4, -0.6).normalize() },
    uBackRimColor: { value: new THREE.Color(0, 0, 0) },
    uHeadInv: { value: new THREE.Matrix4() },
    uHeadLight: { value: new THREE.Vector3(0, 0, 1) },
    uHeadUpView: { value: new THREE.Vector3(0, 1, 0) },
    uFaceMap: { value: null },
    uFaceFrame: { value: new THREE.Vector4(0.15, 0.24, -0.045, 0.12) },
    uFaceX0: { value: 0 },
  };
}

/**
 * @param {THREE.ShaderMaterial} m  MToon surface material
 * @param {object} shared  createSharedUniforms()
 * @param {{face?: boolean, hair?: boolean, rimLit?: number, backRim?: number, emisLit?: number,
 *          hairSpec?: number, hairShift?: number, hairLum?: number}} o
 */
export function patchMToon(m, shared, o = {}) {
  if (m.userData.arenaPatched) return m.userData.arenaUniforms;
  const own = {
    uArenaRimLit: { value: o.rimLit ?? 1 },
    uArenaBackRim: { value: o.backRim ?? 1 },
    uArenaEmisLit: { value: o.emisLit ?? 0 },
    uHairSpec: { value: o.hairSpec ?? 0 },
    uHairSpecShift: { value: o.hairShift ?? 0 },
    uHairLumMean: { value: o.hairLum ?? 0.5 },
  };
  Object.assign(m.uniforms, shared, own);
  const flags = ['ARENA_PATCH', o.face && 'ARENA_FACE_SDF', o.hair && 'ARENA_HAIR_RING'].filter(Boolean);
  const defines = flags.map((f) => `#define ${f}`).join('\n') + '\n';
  const baseCompile = m.onBeforeCompile, baseKey = m.customProgramCacheKey;
  m.onBeforeCompile = (shader, renderer) => {
    baseCompile.call(m, shader, renderer);
    let fs = shader.fragmentShader, vs = shader.vertexShader;
    const need = (src, s) => { if (!src.includes(s)) console.warn('[mtoonPatch] anchor missing:', s); };
    [KEY_DOT, SHADING, LIGHTS_BEGIN, RIM_ADD, EMIS_ADD].forEach((s) => need(fs, s));
    fs = defines + fs
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace(KEY_DOT, FRAG_KEY)
      .replaceAll(SHADING, FRAG_SHADING)
      .replace(LIGHTS_BEGIN, FRAG_FACE)
      .replace(RIM_ADD, FRAG_RIM)
      .replace(EMIS_ADD, FRAG_EMIS);
    if (o.face) {
      need(vs, '#include <skinning_vertex>');
      vs = defines + vs.replace('#include <common>', '#include <common>\n' + VERT_PARS).replace('#include <skinning_vertex>', VERT_MAIN);
    }
    shader.fragmentShader = fs; shader.vertexShader = vs;
  };
  m.customProgramCacheKey = () => baseKey.call(m) + ',' + flags.join('+');
  m.userData.arenaPatched = true;
  m.userData.arenaUniforms = own;
  m.needsUpdate = true;
  return own;
}
