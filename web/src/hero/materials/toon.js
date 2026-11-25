// Hero toon shader (spec 2.8). Owner: WP1.
//
// One ShaderMaterial program per variant ('body' | 'face' | 'hair'), built from three's own skinning /
// morph / shadow / fog / clipping chunks so SkinnedMesh, morph targets and the shadow map all work exactly
// like a built-in material. Per-vertex `matId` indexes the palette texture (columns = matId, rows = base,
// shade, deep, highlight, outline, line, rim, band); colours are fetched in the vertex shader into FLAT
// varyings, so material borders are hard and a triangle never blends two palette entries.
//
// Lighting = camera-locked key light only (characterLight.js). Scene lights do not light the hero, but the
// arena shadow map is read and thresholded into the shade tone. The character's own occlusion is removed
// from that lookup by a large depth offset (uSelfShadowDepth, ~0.75 m along the light), so only props far
// from the hero can shade it: no blotchy PCF self-shadow, creases come from the painted `shadeBias`.
//
//   ndl'   = dot(N, L) * 0.5 + 0.5 + shadeBias
//   lit    = smoothstep(0.5 - f, 0.5 + f, ndl')         f = max(0.012, AA from fwidth)
//   lit   *= 1 - detail.G ;  lit *= threshold(arenaShadow)
//   shade  = mix(shade, deep, 0.6 * [shadeBias < -0.2])
//   col    = mix(shade, base, lit) ; detail.R lines ; detail.B highlight ; rim ; hair ring / button spec
//
// toneMapped = false: the authored sRGB palette is final (swatch test: materials/swatch.html).

import * as THREE from 'three';
import dims from '../dims.js';
import defaultPalette from '../palette.js';
import { createCharacterLight } from './characterLight.js';
import { createFaceShadowMap, releaseFaceShadowMap, FACE_PARS_GLSL, FACE_FUNC_GLSL } from './faceShadow.js';
import { HAIR_VERT_PARS_GLSL, HAIR_VERT_GLSL, HAIR_FRAG_PARS_GLSL, HAIR_FUNC_GLSL } from './hair.js';

/** Palette texture rows used by the shaders (rows 0..4 come from palette.createPaletteTexture()). */
export const ROW = Object.freeze({ base: 0, shade: 1, deep: 2, highlight: 3, outline: 4, line: 5, rim: 6, band: 7 });

/**
 * Rim tuning (QA round 1, P0-12). REQUEST(WP0): move into dims.SHADING.rim (currently
 * { edge0: 0.62, edge1: 0.68, litBias: 0.3, intensity: 0.45 }, too weak to separate the silhouette in-game).
 *   edge          fresnel threshold (1 - N.V) of the key rim band (crisp, AA'd single edge)
 *   intensity     cloth + skin mix toward the palette rim colour; hairIntensity for hair
 *   litBias       screen-space N.L bias of the lit-side gate
 *   backDir       camera-relative back light, screen direction (x right, y up): opposite the key (which is
 *                 35 deg to the camera's left), so the far edge gets its own rim
 *   backEdge / backStrength  band threshold / relative strength of the back rim
 *   backPx        minimum on-screen width of the back rim in pixels (added as backPx * fwidth(1 - N.V)), so
 *                 the far edge reads 2-3 px at game-camera distance (QA round 2, P2-5: Behind cam rim was
 *                 1-2 px) without growing in close-ups, where fwidth is small
 * QA round 2, P2-5: backEdge 0.6 -> 0.56, backPx 1.25 (Behind cam 2-3 px; Front view key rim unchanged).
 * REQUEST(WP0): mirror backEdge / backPx into dims.SHADING.rim (dims still lists backEdge 0.6).
 */
export const RIM = Object.freeze({ edge: 0.52, intensity: 0.7, hairIntensity: 0.45, litBias: 0.35, backDir: [0.8, 0.6], backEdge: 0.56, backStrength: 0.85, backPx: 1.25 });

/** Self-shadow suppression distance along the shadow light (metres). Larger than the hero's own depth. */
const SELF_SHADOW_METRES = 0.75;

/**
 * Build the palette texture from the palette module, then fill the reserved rows 5..7 (WP1 owns this
 * instance): line = painted-line colour (skin -> SKIN_LINE base, cloth -> `line` extra, else deep),
 * rim = `rim` extra or highlight, band = hair `band` / gold `spec`, else highlight.
 */
export function createHeroPaletteTexture(palette = defaultPalette) {
  const tex = palette.createPaletteTexture();
  const { PALETTE, MAT } = palette;
  const W = tex.image.width, data = tex.image.data;
  const c = new THREE.Color();
  const put = (row, x, hex) => {
    c.setStyle(hex, THREE.NoColorSpace);
    const o = (row * W + x) * 4;
    data[o] = Math.round(c.r * 255); data[o + 1] = Math.round(c.g * 255); data[o + 2] = Math.round(c.b * 255); data[o + 3] = 255;
  };
  for (let x = 0; x < W; x++) {
    const p = PALETTE[x];
    const line = x === MAT.SKIN ? PALETTE[MAT.SKIN_LINE].base : (p.line ?? p.deep);
    put(ROW.line, x, line);
    put(ROW.rim, x, p.rim ?? p.highlight);
    put(ROW.band, x, p.band ?? p.spec ?? p.highlight);
  }
  tex.needsUpdate = true;
  tex.name = 'heroPalette';
  return tex;
}

function blackTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; t.name = 'heroDetailNone';
  return t;
}

/** Reference size of one pixel (metres, at 1080p) at the game camera distance: outline width curve. */
function gameCamPixelMetres() {
  const { pos, look, fov } = dims.CAMERA.front;
  const dist = Math.hypot(pos[0] - look[0], pos[1] - look[1], pos[2] - look[2]);
  return (2 * dist * Math.tan((fov * Math.PI) / 360)) / dims.OUTLINE.refHeight;
}

/**
 * Shared material environment: palette texture, face map, light, and the uniform objects every hero
 * material references (so one update relights them all). One env per createSharedMaterials(); standalone
 * createToonMaterial() calls share a lazily created default env.
 */
export function createMaterialEnv({ palette = defaultPalette, detailAtlas = null } = {}) {
  const pal = palette || defaultPalette;
  const light = createCharacterLight();
  const paletteTex = createHeroPaletteTexture(pal);
  const faceMap = createFaceShadowMap();
  const noDetail = blackTexture();
  const S = dims.SHADING, O = dims.OUTLINE;
  const MAT = pal.MAT;
  const uniforms = {
    uPalette: { value: paletteTex },
    uDetail: { value: detailAtlas || noDetail },
    uKeyDir: light.uniforms.uKeyDir,
    uHeadLight: light.uniforms.uHeadLight,
    uFaceMap: { value: faceMap },
    // (W, H, chinY, wrap): wrap = face terminator lead, 20 deg / 90 (faceShadow.js FACE_FUNC_GLSL)
    uFaceFrame: { value: new THREE.Vector4(dims.FACE.W, dims.BODY.skullHeight, dims.BODY.chinY, 20 / 90) },
    // (feather, deepThreshold, deepMix, rimIntensity)
    uRamp: { value: new THREE.Vector4(S.rampFeather, S.deepThreshold, S.deepMix, RIM.intensity) },
    // (rimEdge, hairRimIntensity, rimLitBias, maxFog)
    uRim: { value: new THREE.Vector4(RIM.edge, RIM.hairIntensity, RIM.litBias, S.maxFog) },
    // back rim: (screenDir.x, screenDir.y, edge, relative strength); screenDir = view-space xy of the back light
    uRimBack: { value: new THREE.Vector4(RIM.backDir[0] / Math.hypot(...RIM.backDir), RIM.backDir[1] / Math.hypot(...RIM.backDir), RIM.backEdge, RIM.backStrength) },
    // (specPow, specThreshold, goldMatId, skinMatId)
    uSpec: { value: new THREE.Vector4(S.buttonSpec.pow, S.buttonSpec.threshold, MAT.GOLD, MAT.SKIN) },
    uRing: { value: new THREE.Vector4(S.angelRing.band[1], S.angelRing.heightH[0], S.angelRing.heightH[1], 1) },
    uRingFrame: { value: new THREE.Vector2(dims.BODY.chinY, dims.BODY.skullHeight) },
    uSelfShadowDepth: { value: 0.0015 },
    uArenaShadow: { value: 1 },
    uResolution: { value: new THREE.Vector2(1920, 1080) },
    // outline: (basePx, refHeight, maxScale, viewPushBack)
    uOutline: { value: new THREE.Vector4(O.basePx, O.refHeight, O.maxScale, O.viewPushBack) },
    // outline distance curve: (refPixelMetres@1080, exponent, minBoost, maxBoost)
    uOutlineCurve: { value: new THREE.Vector4(gameCamPixelMetres(), 0.2, 0.6, O.closeUpPx[1] / O.basePx * 0.9) },
    // face silhouette + close-up floor: (skinMatId, silhouette width on the face front, closeUpPx, head metres)
    uOutlineFace: { value: new THREE.Vector4(MAT.SKIN, 0.95, 2.6, dims.BODY.visualHead) },
  };

  const _size = new THREE.Vector2();
  const shadowScan = new WeakMap(); // scene -> { light, frame }
  let headCacheSkel = null, headBone = null;

  function updateSelfShadow(scene, frame) {
    if (!scene) return;
    let e = shadowScan.get(scene);
    if (!e || (frame - e.frame > 300)) {
      let found = null;
      scene.traverseVisible((o) => { if (!found && o.isDirectionalLight && o.castShadow) found = o; });
      e = { light: found, frame };
      shadowScan.set(scene, e);
    }
    const l = e.light;
    if (l) {
      const cam = l.shadow.camera;
      uniforms.uSelfShadowDepth.value = SELF_SHADOW_METRES / Math.max(1e-3, cam.far - cam.near);
    }
  }

  /** Per-draw hook installed as material.onBeforeRender on every hero material. All light uniforms
   *  (uKeyDir, uHeadLight, back-rim direction) are updated together in the first hero draw of a render, after
   *  three's updateMatrixWorld, so the face and the body always use the same frame's light. */
  function onBeforeRender(renderer, scene, camera, geometry, object) {
    if (!light.head) {
      // find the head frame once: skinned head -> its 'head' bone; rigid face (swatch/tests) -> the object
      if (object.isSkinnedMesh && object.skeleton) {
        if (object.skeleton !== headCacheSkel) { headCacheSkel = object.skeleton; headBone = object.skeleton.getBoneByName('head') || null; }
        if (headBone) light.updateHead(headBone);
        else if (this.userData.variant === 'face') light.updateHead(object);
      } else if (this.userData.variant === 'face') {
        light.updateHead(object);
      }
      if (light.head) light.setDirty();
    }
    if (light.onRender(renderer, camera)) {
      const rt = renderer.getRenderTarget();
      if (rt) _size.set(rt.width, rt.height); else renderer.getDrawingBufferSize(_size);
      uniforms.uResolution.value.copy(_size);
      updateSelfShadow(scene, renderer.info.render.frame);
      // back rim sits opposite the key on screen (follows the preview key-light slider)
      const kx = light.camSpace.x;
      uniforms.uRimBack.value.x = (kx <= 0 ? 1 : -1) * Math.abs(rimBackX);
    }
  }
  const rimBackX = uniforms.uRimBack.value.x;

  return {
    palette: pal, light, uniforms, paletteTex, faceMap, onBeforeRender,
    /** Hook for the WP2 detail atlas (R line, G shade, B highlight); null = none. */
    setDetailAtlas(tex) { uniforms.uDetail.value = tex || noDetail; },
    dispose() { paletteTex.dispose(); noDetail.dispose(); releaseFaceShadowMap(faceMap); },
  };
}

let defaultEnv = null;
export function getDefaultEnv() { return defaultEnv || (defaultEnv = createMaterialEnv()); }

// ---------------------------------------------------------------- shaders

const VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>

attribute float matId;
attribute float shadeBias;
attribute vec3 outlineNormal;
uniform sampler2D uPalette;
varying vec3 vRimN;

flat varying vec3 vBase;
flat varying vec3 vShade;
flat varying vec3 vDeep;
flat varying vec3 vHi;
flat varying vec3 vLine;
flat varying vec3 vRimCol;
flat varying vec3 vBand;
flat varying float vMat;
varying float vBias;
varying vec3 vNormalV;
varying vec3 vViewPos;
varying vec2 vUv2;
varying vec3 vRestPos;
varying vec3 vRestNormal;

#ifdef HERO_HAIR
${HAIR_VERT_PARS_GLSL}
#endif

vec3 heroPal( int m, int row ) { return texelFetch( uPalette, ivec2( m, row ), 0 ).rgb; }

void main() {
  int m = int( matId + 0.5 );
  vMat = float( m );
  vBase = heroPal( m, ${ROW.base} ); vShade = heroPal( m, ${ROW.shade} ); vDeep = heroPal( m, ${ROW.deep} );
  vHi = heroPal( m, ${ROW.highlight} ); vLine = heroPal( m, ${ROW.line} ); vRimCol = heroPal( m, ${ROW.rim} );
  vBand = heroPal( m, ${ROW.band} );
  vBias = shadeBias;
  vUv2 = uv;
  vRestPos = position;
  vRestNormal = normal;

  #include <morphinstance_vertex>
  #include <morphcolor_vertex>
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
  #include <worldpos_vertex>
  #include <shadowmap_vertex>
  #include <fog_vertex>

  vNormalV = transformedNormal;
  vViewPos = mvPosition.xyz;
  // rim uses the smoothed TRUE surface direction (outlineNormal), not the shading normal: cloth / face
  // shading normals are blended toward smooth proxies and never reach grazing at the silhouette
  vec3 rimN = outlineNormal;
  #ifdef USE_SKINNING
    rimN = ( skinMatrix * vec4( rimN, 0.0 ) ).xyz;
  #endif
  vRimN = normalMatrix * rimN;
  #ifdef HERO_HAIR
  ${HAIR_VERT_GLSL}
  #endif
}
`;

const FRAG = /* glsl */`
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <shadowmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>

uniform vec3 uKeyDir;
uniform sampler2D uDetail;
uniform vec4 uRamp;
uniform vec4 uRim;
uniform vec4 uRimBack;
uniform vec4 uSpec;
uniform float uSelfShadowDepth;
uniform float uArenaShadow;

flat varying vec3 vBase;
flat varying vec3 vShade;
flat varying vec3 vDeep;
flat varying vec3 vHi;
flat varying vec3 vLine;
flat varying vec3 vRimCol;
flat varying vec3 vBand;
flat varying float vMat;
varying float vBias;
varying vec3 vNormalV;
varying vec3 vViewPos;
varying vec2 vUv2;
varying vec3 vRestPos;
varying vec3 vRestNormal;
varying vec3 vRimN;

#ifdef HERO_FACE
${FACE_PARS_GLSL}
${FACE_FUNC_GLSL}
#endif
#ifdef HERO_HAIR
${HAIR_FRAG_PARS_GLSL}
${HAIR_FUNC_GLSL}
#endif

float heroArenaShadow() {
  float s = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    DirectionalLightShadow dls;
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
      dls = directionalLightShadows[ i ];
      s *= getShadow( directionalShadowMap[ i ], dls.shadowMapSize, dls.shadowIntensity, dls.shadowBias - uSelfShadowDepth, dls.shadowRadius, vDirectionalShadowCoord[ i ] );
    }
    #pragma unroll_loop_end
  #endif
  return s;
}

void main() {
  #include <clipping_planes_fragment>
  #include <logdepthbuf_fragment>

  vec3 N = normalize( vNormalV );
  #ifdef DOUBLE_SIDED
    N = gl_FrontFacing ? N : -N;
  #endif
  vec3 V = normalize( -vViewPos );
  if ( isOrthographic ) V = vec3( 0.0, 0.0, 1.0 );
  vec3 L = normalize( ( viewMatrix * vec4( uKeyDir, 0.0 ) ).xyz );

  // ---- 2-tone ramp with crisp, anti-aliased edge
  float ndl = dot( N, L ) * 0.5 + 0.5 + vBias;
  float e = max( uRamp.x, fwidth( ndl ) * 0.75 );
  float lit = smoothstep( 0.5 - e, 0.5 + e, ndl );

  #ifdef HERO_FACE
    // head: one continuous signed field (SDF face front + head-space horizontal N.L + 3D under the jaw),
    // thresholded once, so the shade is a single crisp shape and the mask hand-over has no seam
    vec2 face = heroFaceField( vRestPos, normalize( vRestNormal ), vBias );
    // edge width from screen-space AA only (QA round 2, P1-3): where two smooth fields meet at a shallow
    // angle (mask hand-over in profile) the field gradient is low, and the 0.012 ramp floor smeared the
    // terminator over many pixels (soft blotch). The face edge is now always ~1.5 px: crisp, anti-aliased.
    float ef = max( fwidth( face.x ) * 0.75, 1e-4 );
    lit = smoothstep( -ef, ef, face.x );
  #endif

  vec3 detail = texture2D( uDetail, vUv2 ).rgb;
  lit *= 1.0 - detail.g;

  // ---- arena shadows (props only), thresholded into the shade tone
  float sh = heroArenaShadow();
  lit *= mix( 1.0, smoothstep( 0.35, 0.65, sh ), uArenaShadow );

  // ---- deep crease tone (only in shade, only where shadeBias < -0.2)
  float eb = max( fwidth( vBias ), 0.01 );
  float deepW = 1.0 - smoothstep( uRamp.y - eb, uRamp.y + eb, vBias );
  vec3 shadeCol = mix( vShade, vDeep, uRamp.z * deepW );
  vec3 col = mix( shadeCol, vBase, lit );

  // ---- painted detail: lines (multiplied toward the line colour), highlight strokes on the lit side
  vec3 lineCol = mix( mix( vDeep, vLine, 0.5 ), vLine, lit );
  col = mix( col, lineCol, detail.r );
  col = mix( col, vHi, detail.b * lit );

  // ---- rim light: crisp anime band on the silhouette (QA round 1, P0-12)
  //   key rim  : lit-side edges (screen-space N . L), band from fresnel > uRim.x
  //   back rim : a camera-relative back light (behind the hero, opposite the key), so the far edge also
  //              separates from the sky / sea in the Behind and Side views; slightly narrower band
  vec3 RN = dot( vRimN, vRimN ) > 1e-4 ? normalize( vRimN ) : N;
  #ifdef DOUBLE_SIDED
    RN = gl_FrontFacing ? RN : -RN;
  #endif
  float ndv = 1.0 - max( dot( RN, V ), 0.0 );
  float er = max( fwidth( ndv ) * 0.75, 0.004 );
  vec2 ns = normalize( RN.xy + 1e-5 );
  float litSide = clamp( dot( ns, normalize( L.xy + 1e-5 ) ) + uRim.z, 0.0, 1.0 );
  float bandK = smoothstep( uRim.x - er, uRim.x + er, ndv );
  float bandB = smoothstep( uRimBack.z - er, uRimBack.z + er, ndv + ${RIM.backPx.toFixed(3)} * fwidth( ndv ) );
  float backSide = smoothstep( 0.05, 0.35, dot( ns, uRimBack.xy ) );
  float rim = max( bandK * smoothstep( 0.15, 0.45, litSide ), bandB * backSide * uRimBack.w );
  #ifdef HERO_FACE
    // suppressed on the face front, kept on the jaw edge. The jaw band is also gated by the rest normal
    // (QA round 2, P1-3 follow-up): at 70-80 deg head yaw the flat lower-face plane sits right at the rim
    // threshold, and the height-only jaw window let the back rim paint a soft gradient beside the nose and
    // mouth. Only side / downward-facing jaw normals (the actual jaw silhouette) keep the rim now.
    float jaw = ( 1.0 - smoothstep( 0.18, 0.30, ( vRestPos.y - uFaceFrame.z ) / uFaceFrame.y ) )
              * ( 1.0 - smoothstep( 0.35, 0.65, normalize( vRestNormal ).z ) );
    rim *= 1.0 - face.y * ( 1.0 - jaw );
  #endif
  float rimI = uRamp.w;
  #ifdef HERO_HAIR
    rimI = uRim.y;   // hair keeps the softer spec 2.9 rim
  #endif
  col = mix( col, vRimCol, rim * rimI );

  // ---- button spec: one hard dot on gold
  if ( abs( vMat - uSpec.z ) < 0.5 ) {
    vec3 H = normalize( L + V );
    float sp = pow( max( dot( N, H ), 0.0 ), uSpec.x );
    float es = max( fwidth( sp ), 0.02 );
    col = mix( col, vBand, smoothstep( uSpec.y - es, uSpec.y + es, sp ) );
  }

  #ifdef HERO_HAIR
    vec3 upV = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
    float ring = heroAngelRing( N, L, V, vRestPos, upV );
    col = mix( col, mix( mix( vShade, vBand, 0.55 ), vBand, lit ), ring );
  #endif

  // ---- fog: the hero is (almost) exempt
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float ff = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float ff = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    col = mix( col, fogColor, ff * uRim.w );
  #endif

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Toon material (see materials/index.js for the public contract).
 * @param {object} o  { skinned, palette, detailAtlas, variant, env? }  env: internal, from createMaterialEnv
 */
export function createToon({ skinned = true, palette = null, detailAtlas = null, variant = 'body', env = null } = {}) {
  const E = env || (palette && palette !== defaultPalette ? createMaterialEnv({ palette, detailAtlas }) : getDefaultEnv());
  if (detailAtlas && !env) E.setDetailAtlas(detailAtlas);
  const v = ['body', 'face', 'hair'].includes(variant) ? variant : 'body';
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.lights, THREE.UniformsLib.fog]);
  Object.assign(uniforms, E.uniforms); // shared references (not clones)
  const defines = {};
  if (v === 'face') defines.HERO_FACE = '';
  if (v === 'hair') defines.HERO_HAIR = '';
  const mat = new THREE.ShaderMaterial({
    name: `heroToon_${v}`,
    uniforms, defines, vertexShader: VERT, fragmentShader: FRAG,
    lights: true, fog: true, toneMapped: false,
  });
  mat.userData = { variant: v, skinned, env: E, hero: true, setKeyLight: (yaw, pitch) => E.light.setKeyLight(yaw, pitch) };
  mat.onBeforeRender = E.onBeforeRender;
  return mat;
}
