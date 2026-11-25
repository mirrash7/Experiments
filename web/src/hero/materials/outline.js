// Screen-space constant-width inverted-hull outline (spec 2.10). Owner: WP1.
//
// Drawn on a second SkinnedMesh that shares the geometry and skeleton (createSkinnedPair), BackSide only.
// Per vertex:
//   1. skin `position` and the smoothed `outlineNormal` exactly like the main pass (three skinning chunks),
//   2. push the hull back along the view ray by dims.OUTLINE.viewPushBack (0.0015 m) so it never bleeds
//      over inner creases,
//   3. project, take the outline normal's direction in screen pixels, and offset the clip position by
//      width_px * 2 / resolution * clip.w  (constant pixel width regardless of distance).
// width_px = basePx (2.2) * min(resY / 1080, 2) * outlineWidth (per-vertex: 0 face front / eyes, 0.4 hair
// [face front: restored to 0.95 on skin where the hull normal is edge-on to the view, see P1-2 below]
// tips, 0.6 fingers and fur ...) * a gentle distance curve: 1.0 at the game camera, up to ~3.1 px in a
// face close-up, down to 0.6x for tiny far-away figures (keeps the 2.2 px look stable across cameras).
// Colour: palette `outline` row per matId (dark hue of the base, never pure black), fetched in the vertex
// shader into a flat varying.
//
// Note on dims.OUTLINE.maxWorld (0.004 m): at the game camera one 1080p pixel is ~2.8 mm, so 2.2 px is
// ~6 mm of world width; a hard 4 mm clamp would contradict the 2.2 px target, so the close-up limit is
// enforced in pixels (closeUpPx) instead.

import * as THREE from 'three';
import defaultPalette from '../palette.js';
import { getDefaultEnv, createMaterialEnv, ROW } from './toon.js';

const VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>

attribute vec3 outlineNormal;
attribute float outlineWidth;
attribute float matId;
uniform sampler2D uPalette;
uniform vec2 uResolution;
uniform vec4 uOutline;       // (basePx, refHeight, maxScale, viewPushBack)
uniform vec4 uOutlineCurve;  // (refPixelMetres@1080, exponent, minBoost, maxBoost)
uniform vec4 uOutlineFace;   // (skinMatId, silhouetteWidth, closeUpPx, closeUpHeadMetres)
flat varying vec3 vOutline;

void main() {
  vOutline = texelFetch( uPalette, ivec2( int( matId + 0.5 ), ${ROW.outline} ), 0 ).rgb;

  #include <morphinstance_vertex>
  vec3 objectNormal = outlineNormal;
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>

  vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
  vec3 nV = normalize( normalMatrix * objectNormal + vec3( 1e-6 ) );
  vec3 toCam = isOrthographic ? vec3( 0.0, 0.0, 1.0 ) : normalize( -mvPosition.xyz );
  // push back along the view ray
  vec3 ray = isOrthographic ? vec3( 0.0, 0.0, -1.0 ) : normalize( mvPosition.xyz );
  mvPosition.xyz += ray * uOutline.w;
  vec4 clip = projectionMatrix * mvPosition;

  // screen-space direction of the outline normal, in pixels
  vec2 nClip = ( projectionMatrix * vec4( nV, 0.0 ) ).xy;
  vec2 dirPx = nClip * uResolution;
  float dl = length( dirPx );
  vec2 dir = dl > 1e-6 ? dirPx / dl : vec2( 0.0 );

  // width in pixels
  float resScale = min( uResolution.y / uOutline.y, uOutline.z );
  float pixM = clip.w * 2.0 / ( projectionMatrix[ 1 ][ 1 ] * uOutline.y );   // metres per 1080p pixel here
  float boost = clamp( pow( uOutlineCurve.x / max( pixM, 1e-6 ), uOutlineCurve.y ), uOutlineCurve.z, uOutlineCurve.w );
  // face-front suppression only where the face is front-facing (QA round 1, P1-2): on skin, wherever the
  // smoothed hull normal turns edge-on to the view (cheek / jaw / forehead contour at 3/4 and profile) the
  // width comes back, so the head silhouette always draws; head-on the face front stays line-free.
  float w = outlineWidth;
  if ( abs( matId - uOutlineFace.x ) < 0.5 ) {
    float sil = smoothstep( 0.50, 0.22, abs( dot( nV, toCam ) ) );
    // only for suppressed vertices (fingers 0.6, ears 0.7 keep their taper)
    w = max( w, uOutlineFace.y * sil * ( 1.0 - smoothstep( 0.45, 0.6, outlineWidth ) ) );
  }
  float px = uOutline.x * resScale * boost * w;
  // close-up floor (P2-1): once a head-sized object fills > 25 percent of the viewport height, lines are at
  // least closeUpPx (never scaled below 1080p, so a 900p face cam still gets ~2.6 px)
  float headFrac = uOutlineFace.w / max( pixM * uOutline.y, 1e-6 );
  float closeUp = smoothstep( 0.18, 0.26, headFrac );
  px = max( px, closeUp * uOutlineFace.z * max( resScale, 1.0 ) * w );
  clip.xy += dir * ( px * 2.0 / uResolution ) * clip.w;
  gl_Position = clip;

  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */`
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
uniform vec4 uRim;            // .w = max fog
flat varying vec3 vOutline;
void main() {
  #include <clipping_planes_fragment>
  #include <logdepthbuf_fragment>
  vec3 col = vOutline;
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
 * @param {object} o { skinned, palette, env? }  env: internal (shared uniforms from createMaterialEnv)
 */
export function createOutline({ skinned = true, palette = null, env = null } = {}) {
  const E = env || (palette && palette !== defaultPalette ? createMaterialEnv({ palette }) : getDefaultEnv());
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
  for (const k of ['uPalette', 'uResolution', 'uOutline', 'uOutlineCurve', 'uOutlineFace', 'uRim']) uniforms[k] = E.uniforms[k];
  const mat = new THREE.ShaderMaterial({
    name: 'heroOutline',
    uniforms, vertexShader: VERT, fragmentShader: FRAG,
    side: THREE.BackSide, fog: true, toneMapped: false,
  });
  mat.userData = { skinned, env: E, hero: true, outline: true, isOutline: true, setKeyLight: (yaw, pitch) => E.light.setKeyLight(yaw, pitch) };
  mat.onBeforeRender = E.onBeforeRender;
  return mat;
}
