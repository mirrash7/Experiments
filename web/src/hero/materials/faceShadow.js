// SDF face-shadow threshold map + face shading snippet (spec 2.8 "Face shading"). Owner: WP1.
//
// The front of the face ignores N.L. Instead a threshold map T(u, v) says, per texel, at which horizontal
// light angle that texel enters shade. Map frame (rest pose, root space, which equals head-local axes):
//   u = x / FACE.W + 0.5      (u = 0 is the character's RIGHT cheek edge, u = 1 the LEFT edge; left = +X)
//   v = (y - BODY.chinY) / BODY.skullHeight
// The stored map is authored for a key light coming from the character's LEFT (+X): the right half of the
// face (u < 0.5) is the far side. With s = (horizontal light angle from the face's forward axis) / 90 deg,
// in [0, 2], a texel is in shade when s > 2 * map(u, v). Light from the right samples with u mirrored.
//
//   far half  (u < 0.5): T rises 0 -> 1 from the outer cheek edge to the nose line  (front -> side light)
//   near half (u > 0.5): T rises 1 -> 2 from the nose line to the near edge          (light going behind)
//
// Shape rules (QA round 1, P0-9: the shade is ONE connected shape at every angle):
//   * Base sweep follows a sphere's terminator, T = 1 - asin(1 - a) / 90deg, so at the mask border the map
//     agrees with the head-space horizontal N.L used outside the mask (seamless hand-over, see FACE_FUNC).
//   * Every row of T is made monotonic (suffix minimum from the nose line outward), so the shade in each row
//     is ONE run that starts at the far edge. The far edge itself is shaded for any light angle > 0, so all
//     rows connect through it: no islands on the cheek, temple or forehead, no lit gap at ear level.
//   * Inside an ellipse around each eye T is exactly constant (applied after the monotonic pass, blended so
//     rows stay monotonic): the whole socket flips at once and the boundary hooks around it, never crossing.
//   * The cheek bows toward the nose (cheek turns away first); a nose wedge beside/under the nose tip flips
//     together with the eye socket; above the brows T depends on u only (vertical boundary, no band).
//
// Values are stored as half floats (16-bit) with linear filtering so the threshold edge never bands.
// Generated once (~10 ms for 512^2), cached per resolution, shared by every face material.

import * as THREE from 'three';
import dims from '../dims.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Face-space layout derived from dims (all in map uv units). */
export function faceLayout(d = dims) {
  const { FACE, BODY } = d;
  const H = BODY.skullHeight, W = FACE.W;
  const eyeU = (FACE.eye.spacingW / 2);                 // eye centre offset from the nose line, in u
  return {
    W, H, chinY: BODY.chinY,
    eye: { du: eyeU, v: FACE.eye.centreH, ru: (FACE.eye.width / W) * 0.5 * 1.45, rv: (FACE.eye.height / H) * 0.5 * 1.55 },
    noseV: FACE.nose.tickH, mouthV: FACE.mouth.centreH, browV: FACE.brow.centreH,
  };
}

const HALF_PI = Math.PI / 2;
/** Sphere terminator: light angle (in units of 90 deg) at which a point a (0 edge .. 1 nose) enters shade. */
const sphereT = (a) => 1 - Math.asin(Math.min(1, Math.max(0, 1 - a))) / HALF_PI;

/** Raw (pre-monotonic) threshold for the far half, a = 0 at the outer edge .. 1 at the nose line. */
function farRaw(a, v, L) {
  const base = sphereT(a);
  let t = base;
  // cheek bow: below the eye the boundary bulges toward the nose (cheek turns away from the light first)
  const cheek = smooth(L.mouthV - 0.16, L.mouthV + 0.02, v) * (1 - smooth(L.noseV - 0.04, L.eye.v - 0.06, v));
  t -= 0.10 * cheek * Math.sin(Math.PI * Math.min(1, a));
  // chin: stays lit a touch longer near the centre (soft round chin)
  t += 0.04 * (1 - smooth(0.02, 0.12, v)) * a * a;
  // forehead: above the brow line T depends on u only (vertical boundary, no forehead band)
  const fh = smooth(L.browV - 0.06, L.browV + 0.04, v);
  t = t * (1 - fh) + base * fh;
  // nose wedge: beside / under the nose tip on the far side; flips with the far eye socket
  const wedgeTop = L.noseV + 0.06, wedgeBot = L.noseV - 0.10;
  if (v < wedgeTop && v > wedgeBot) {
    const k = (wedgeTop - v) / (wedgeTop - wedgeBot);
    const halfW = 0.02 + 0.06 * Math.sin(Math.PI * Math.min(1, k * 1.15));
    const da = (1 - a) * 0.5;
    const w = smooth(halfW + 0.02, halfW - 0.01, da) * smooth(0, 0.18, k) * smooth(1, 0.75, k);
    t = Math.min(t, t * (1 - w) + eyeT(L) * w);
  }
  return Math.min(1, Math.max(0, t));
}
const eyeT = (L) => sphereT((0.5 - L.eye.du) / 0.5);

/** Eye-socket plateau, applied after the monotonic pass. */
function eyePlateau(t, a, v, L) {
  const eu = 0.5 - L.eye.du, te = eyeT(L), u = a * 0.5;
  const d = Math.hypot((u - eu) / L.eye.ru, (v - L.eye.v) / L.eye.rv);
  const w = smooth(1.4, 1.0, d);
  return t + (te - t) * w;
}

/** One far-half row: n samples, a_i = (i + 0.5) / n. Monotonic non-decreasing in a. */
function farRow(n, v, L, out) {
  for (let i = 0; i < n; i++) out[i] = farRaw((i + 0.5) / n, v, L);
  for (let i = n - 2; i >= 0; i--) if (out[i] > out[i + 1]) out[i] = out[i + 1];  // suffix minimum
  for (let i = 0; i < n; i++) out[i] = eyePlateau(out[i], (i + 0.5) / n, v, L);
  for (let i = 1; i < n; i++) if (out[i] < out[i - 1]) out[i] = out[i - 1];       // safety: keep monotonic
  return out;
}

/** Full map T(u, v) in [0, 2] into a Float32Array (row-major, v up). */
function buildT(size, L, flipV = false) {
  const half = size / 2, row = new Float32Array(half), T = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = flipV ? 1 - (y + 0.5) / size : (y + 0.5) / size;
    farRow(half, v, L, row);
    for (let x = 0; x < half; x++) {
      // far half: column x has a = (x + 0.5) / half ; near half mirrors: T = 2 - far(1 - u)
      T[y * size + x] = row[x];
      T[y * size + (size - 1 - x)] = 2 - row[x];
    }
  }
  return T;
}

const cache = new Map();

/**
 * Build (or fetch the cached) threshold map. Single-channel half-float DataTexture, LinearFilter,
 * ClampToEdge, NoColorSpace. map(u, v) = T / 2, T in [0, 2].
 * @param {number} [size=dims.SHADING.faceShadowMap]
 */
export function createFaceShadowMap(size = dims.SHADING.faceShadowMap) {
  if (cache.has(size)) { const c = cache.get(size); c.refs++; return c.tex; }
  const L = faceLayout();
  const T = buildT(size, L);
  const data = new Uint16Array(size * size);
  for (let i = 0; i < data.length; i++) data[i] = THREE.DataUtils.toHalfFloat(T[i] * 0.5);
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.HalfFloatType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.name = 'heroFaceShadowMap';
  tex.needsUpdate = true;
  cache.set(size, { tex, refs: 1 });
  return tex;
}

export function releaseFaceShadowMap(tex) {
  for (const [k, c] of cache) if (c.tex === tex && --c.refs <= 0) { c.tex.dispose(); cache.delete(k); }
}

/** Debug: paint the threshold map into a canvas (grey = T/2) with optional iso lines. */
export function drawFaceShadowMap(canvas, { size = 256, sweep = null } = {}) {
  const L = faceLayout();
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const img = g.createImageData(size, size);
  const T = buildT(size, L, true);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = T[y * size + x];
      let c = t * 0.5 * 255;
      if (sweep !== null) c = t < sweep ? 70 : 235;
      else if (Math.abs((t * 8) % 1) < 0.04) c = 255;
      const o = (y * size + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = c; img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

/** GLSL uniforms/defines block for the face variant (fragment). */
export const FACE_PARS_GLSL = /* glsl */`
uniform sampler2D uFaceMap;
uniform vec3 uHeadLight;      // key light in head-local space
uniform vec4 uFaceFrame;      // (W, H, chinY, wrap): rest-space face frame + terminator lead (x 90 deg)
`;

/**
 * GLSL: head shading as ONE continuous signed field (> 0 lit, < 0 shade), thresholded once by the caller.
 * Inputs are rest-space (pre-skin) position and normal, which equal head-local axes because the head mesh is
 * rigid on the head bone; uHeadLight is the key light in the same frame (computed in the same render).
 *
 *   face front (mask):   f = (pi/2) * (map - s/2)      SDF threshold map, in N.L units near the terminator
 *   rest of the head:    f = 0.5 * dot(n_h, l_h)        horizontal (head XZ) N.L, the same quantity the map's
 *                                                         sphere profile encodes, so the hand-over is seamless
 *   near-vertical normals / degenerate light: true 3D N.L in head space
 *   creases: min(shadeBias, 0) outside the mask (forehead +0.15 is ignored: it would kink the boundary)
 *
 * Blending the signed fields (not binary lit values) means the boundary is a single iso-line of a
 * continuous field: no 50 percent band, no stripe at the mask's top edge, no extra islands at the border.
 * Returns vec2(field, mask).
 */
export const FACE_FUNC_GLSL = /* glsl */`
vec2 heroFaceField( vec3 restPos, vec3 restN, float bias ) {
  vec2 uv = vec2( restPos.x / uFaceFrame.x + 0.5, ( restPos.y - uFaceFrame.z ) / uFaceFrame.y );
  // mask: front of the skull, inside the face width, chin .. upper forehead (under the bangs)
  float mask = smoothstep( 0.25, 0.55, restN.z )
             * ( 1.0 - smoothstep( 0.38, 0.50, abs( uv.x - 0.5 ) ) )
             * smoothstep( -0.10, 0.04, uv.y ) * ( 1.0 - smoothstep( 0.82, 0.96, uv.y ) );
  vec3 Lh = normalize( uHeadLight );
  vec2 lh = Lh.xz;
  float lenH = length( lh );
  float hv = smoothstep( 0.05, 0.25, lenH );            // 0 = light straight above / below the head
  // horizontal angle from the face forward axis, 0..pi -> s in 0..2 ; light from the right mirrors the map
  float s = atan( abs( lh.x ), lh.y ) / 1.5707963;
  // anime wrap: the terminator leads the light by up to uFaceFrame.w (x 90 deg) in the 25..55 deg range, so
  // the default 35 deg key already shows a clean cheek/temple strip; 0 at front light (no side jump) and at
  // 90 deg (exact nose-line split). ds/ds stays > 0, so the sweep is monotonic.
  float sh = s + uFaceFrame.w * smoothstep( 0.0, 0.3, s ) * ( 1.0 - smoothstep( 0.6, 1.0, s ) );
  vec2 muv = uv;
  if ( lh.x < 0.0 ) muv.x = 1.0 - muv.x;
  float m = texture2D( uFaceMap, clamp( muv, 0.0, 1.0 ) ).r;
  // QA round 2, P1-3: once the light swings past the face plane (s > 1, i.e. profile views with the
  // camera-locked key) the authored detail (cheek bow, eye plateau, nose wedge, mirrored onto the near half)
  // made the shade split into cheek block / lit strip / jaw shade with a stepped edge near the mouth, and the
  // flat eye plateau faded softly. Hand the threshold over to the PLAIN sphere terminator (u only, the same
  // profile the map's base sweep and the head-space N.L outside the mask use), so the shade is ONE region with
  // a clean vertical edge that joins the jaw shade. The ramp is linear in the wrapped angle sh over
  // 1.00 .. 1.30 (90 .. 117 deg; the wrap is 0 there, so sh = s): |T_plain - T_map| <= 0.29 everywhere, so
  // d(sh - T)/dsh >= 1 - 0.29 / 0.30 > 0 and the sweep stays monotonic (a texel never flips back to lit as
  // the light keeps rotating). Up to 90 deg the map is untouched (front sweep C5, exact nose-line split);
  // the default key at 80 .. 90 deg head yaw (s = 1.28 .. 1.39) is fully on the plain terminator.
  float ap = clamp( 1.0 - abs( 2.0 * muv.x - 1.0 ), 0.0, 1.0 );          // 0 outer edge .. 1 nose line
  float tS = 1.0 - asin( 1.0 - ap ) / 1.5707963;
  float mPlain = 0.5 * ( muv.x < 0.5 ? tS : 2.0 - tS );
  m = mix( m, mPlain, clamp( ( sh - 1.0 ) / 0.30, 0.0, 1.0 ) );
  float fMap = 1.5707963 * ( m - 0.5 * sh );
  // horizontal head-space N.L with the same wrap (rotated terminator), so the mask border is seamless
  vec2 nh = restN.xz;
  float lnh = length( nh );
  float phi = acos( clamp( dot( nh / max( lnh, 1e-4 ), lh / max( lenH, 1e-4 ) ), -1.0, 1.0 ) );
  float fH = 0.5 * cos( min( phi + ( sh - s ) * 1.5707963, 3.1415927 ) );
  float f3 = 0.5 * dot( restN, Lh );
  // only near-vertical normals (skull top / flat chin underside) fall back to 3D N.L; the jaw underside
  // stays on the horizontal field and gets its shade from the painted crease (shadeBias -0.3), so no
  // second terminator (lit stripe) appears along the jaw in profile
  float w3 = 1.0 - smoothstep( 0.12, 0.35, lnh );
  float fSide = mix( fH, f3, w3 ) + min( bias, 0.0 );
  float f = mix( fSide, fMap, mask );
  // light from far above / below: the face front goes fully lit (or shaded from below), the rest uses 3D N.L
  f = mix( mix( f3 + min( bias, 0.0 ), 0.5 * ( Lh.z + 0.2 ), mask ), f, hv );
  return vec2( f, mask );
}
`;
