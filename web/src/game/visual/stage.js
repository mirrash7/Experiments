// BREAKLIGHT stage: a floating sky-island at dusk (owner: VISUAL).
// Sky dome (gradient, huge setting sun / eclipse, god-rays, painted cloud deck, stars), a toon cloud sea, puffy
// alpha-tested cumulus billboards, the stone arena platform with beat-pulsed rune circles, broken pillars with
// floating crystals, sakura trees, floating rocks with waterfalls, distant islands, drifting petals/embers (GPU
// animated) and the rift portal on the horizon. Every act has a palette; setAct() tweens all of it.
//
// Draw calls (High): ~16. Triangles: ~64k (R2: detailed platform canopies). No per-frame allocation; petals/clouds/waterfalls animate on the GPU.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { NOISE_GLSL, crystalMaterial, crystalGeo, mergeGeos, canvasTex, toonRamp, rng, damp, qualityId } from './common.js';

// ------------------------------------------------------------------------------------------------ palettes
// hex colours are authored sRGB (THREE.Color converts to linear). az/el: sun azimuth (+ = toward +X = screen-left
// in the rear gameplay camera) and elevation, radians.
// R1 colour script: only the sky, far fog and emissives carry the act hue. Near world lighting stays a WARM key
// against COOL, desaturated hemisphere shadows (local contrast), and the blossom canopies are re-tinted per act
// (fol / folMix) so they never melt into a same-hue sky. moon / mAz / mEl: a crescent moon (act 2 night).
export const PALETTES = {
  title: { top: '#2f4aa0', mid: '#f0a066', hor: '#ffd9a0', low: '#f4b07c', sun: '#fff3cc', glow: '#ffae55', cLit: '#ffe6bc', cShade: '#c87896', cDeep: '#8a4e86',
    fog: '#f2b48a', hemiS: '#d8cce0', hemiG: '#4a3c6c', key: '#ffd6a8', keyI: 2.2, rim: '#ffb070', rune: '#ffc65a', rift: '#ff5fcf', ember: '#ffc070', petal: '#ffc4dc',
    water: '#bfe6ff', fol: '#ffffff', stars: 0, eclipse: 0, az: 0.36, el: 0.075, rays: 0.8, moon: 0, folMix: 0 },
  0: { top: '#3e3488', mid: '#ff9a50', hor: '#ffc27a', low: '#f7a064', sun: '#ffe6a8', glow: '#ff8a30', cLit: '#ffcf94', cShade: '#b0607e', cDeep: '#743e78',
    fog: '#f19c6c', hemiS: '#b4aed4', hemiG: '#3a3058', key: '#ffd2a0', keyI: 2.3, rim: '#ff9a50', rune: '#ffae38', rift: '#ff5ad0', ember: '#ffb050', petal: '#ffbcd0',
    water: '#ffe0c0', fol: '#ffffff', stars: 0, eclipse: 0, az: 0.34, el: 0.05, rays: 1.0, moon: 0, folMix: 0 },
  // R2 (P2-5): act 2 "Crimson Tide" is a moonlit night: deep blue sky, cool moonlight key + cyan rim, blue-teal canopies,
  // with magenta only as accents (the horizon band, the sunken-sun glow, the rift). Act 3 shifts to violet so they differ.
  1: { top: '#040926', mid: '#10306e', hor: '#b8347e', low: '#1a2462', sun: '#ffc0c8', glow: '#8e2a78', cLit: '#86aee6', cShade: '#24306c', cDeep: '#10173e',
    fog: '#25366e', hemiS: '#7c9ee0', hemiG: '#121834', key: '#d4e6ff', keyI: 1.7, rim: '#64eeff', rune: '#62d6ff', rift: '#ff3cc8', ember: '#8ae6ff', petal: '#d6e6ff',
    water: '#a6d2ff', fol: '#4f86c8', stars: 0.65, eclipse: 0, az: 0.31, el: -0.1, rays: 0.1, moon: 1, folMix: 0.85 },
  2: { top: '#08031c', mid: '#24105a', hor: '#9a36a8', low: '#26124c', sun: '#ffb090', glow: '#a63ab4', cLit: '#9884d8', cShade: '#33226a', cDeep: '#140c38',
    fog: '#36245e', hemiS: '#7a70c8', hemiG: '#18122e', key: '#ffbca0', keyI: 1.45, rim: '#b49aff', rune: '#c890ff', rift: '#d050ff', ember: '#ffb0d8', petal: '#d8c8ff',
    water: '#c4b8ff', fol: '#a48ee6', stars: 0.9, eclipse: 0, az: 0.28, el: -0.2, rays: 0.12, moon: 1, folMix: 0.8 },
  boss: { top: '#030209', mid: '#0e0828', hor: '#34205c', low: '#1e1238', sun: '#ffe8c8', glow: '#6a3ad0', cLit: '#7c6cb4', cShade: '#201840', cDeep: '#100c24',
    fog: '#2a1c4a', hemiS: '#7078b8', hemiG: '#121026', key: '#e0d4ff', keyI: 1.5, rim: '#7ad0ff', rune: '#7ef0ff', rift: '#8a5cff', ember: '#9ad8ff', petal: '#c0d0ff',
    water: '#a0b0ff', fol: '#8a94d0', stars: 1, eclipse: 1, az: 0.0, el: 0.33, rays: 0.45, moon: 0, folMix: 0.8 },
  results: { top: '#2c4c9c', mid: '#8eb2e2', hor: '#ffdcc4', low: '#e4b4b4', sun: '#fff6e4', glow: '#ffc4a4', cLit: '#fff2e4', cShade: '#a4a4d2', cDeep: '#6c6ca4',
    fog: '#d4c4da', hemiS: '#e0e0f0', hemiG: '#5a5a8c', key: '#fff0e0', keyI: 2.2, rim: '#ffd0b0', rune: '#9ae4ff', rift: '#a080ff', ember: '#ffe0c0', petal: '#ffd4e4',
    water: '#d8f0ff', fol: '#ffffff', stars: 0.15, eclipse: 0, az: 0.2, el: 0.12, rays: 0.5, moon: 0, folMix: 0 },
};
const COLOR_KEYS = ['top', 'mid', 'hor', 'low', 'sun', 'glow', 'cLit', 'cShade', 'cDeep', 'fog', 'hemiS', 'hemiG', 'key', 'rim', 'rune', 'rift', 'ember', 'petal', 'water', 'fol'];
const NUM_KEYS = ['keyI', 'stars', 'eclipse', 'az', 'el', 'rays', 'moon', 'folMix'];
const OVERDRIVE = { rune: new THREE.Color('#ffd040'), ember: new THREE.Color('#ffd060'), rift: new THREE.Color('#ffe6a0') };
const MOON_DIR = new THREE.Vector3(-Math.sin(0.42) * Math.cos(0.2), Math.sin(0.2), Math.cos(0.42) * Math.cos(0.2)).normalize();   // upper screen-right

export const RIFT_POS = new THREE.Vector3(0, 7.2, 54);
const SEA_Y = -20;

// ------------------------------------------------------------------------------------------------ sky
const SKY_VERT = /* glsl */`varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
const SKY_FRAG = /* glsl */`
#define FBM_OCT __OCT__
uniform vec3 uTop, uMid, uHor, uLow, uSun, uGlow, uCLit, uCShade;
uniform vec3 uSunDir, uMoonDir; uniform float uTime, uStars, uEclipse, uRays, uSunSize, uMoon;
varying vec3 vDir;
${NOISE_GLSL}
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 c = mix(uHor, uMid, smoothstep(0.0, 0.2 - uMoon * 0.15, h));   // moonlit nights: a thin magenta horizon band
  c = mix(c, uTop, smoothstep(0.16, 0.8, h));
  c = mix(c, uLow, smoothstep(0.0, -0.08, h));
  float sd = dot(d, uSunDir);
  float ang = acos(clamp(sd, -1.0, 1.0));
  // horizon glow band strongest toward the sun
  vec2 dh = normalize(d.xz + 1e-5), sh = normalize(uSunDir.xz + 1e-5);
  float az = max(dot(dh, sh), 0.0);
  c += uGlow * exp(-abs(h - uSunDir.y) * 9.0) * pow(az, 3.0) * 0.55 * (1.0 - uEclipse * 0.6);
  c += uGlow * (pow(max(sd, 0.0), 6.0) * 0.45 * (1.0 - uEclipse * 0.55) * (1.0 - uMoon * 0.75) + pow(max(sd, 0.0), 60.0) * 0.9);
  // god-rays: angular streaks around the sun
  vec3 rx = normalize(cross(vec3(0.0, 1.0, 0.0), uSunDir)); vec3 ry = cross(uSunDir, rx);
  float th = atan(dot(d, ry), dot(d, rx));
  float rays = vnoise(vec2(th * 9.0, uTime * 0.05)) * vnoise(vec2(th * 23.0 + 3.0, -uTime * 0.04));
  rays = smoothstep(0.18, 0.75, rays) * smoothstep(1.1, 0.12, ang) * smoothstep(uSunSize * 0.9, uSunSize * 2.2, ang);
  c += uGlow * rays * uRays * 0.55 * step(-0.02, h);
  // painted cloud deck (perspective-projected fbm, two toon tones, lit edge toward the sun)
  if (h > 0.0) {
    vec2 uv = d.xz / (h + 0.06) * 0.55;
    uv.x *= 0.6;
    vec2 drift = vec2(uTime * 0.004, uTime * 0.0015);
    float n = fbm(uv + drift);
    float ns = fbm(uv + drift - sh * 0.06);
    float cov = smoothstep(0.5, 0.53, n) * smoothstep(0.0, 0.03, h) * (1.0 - smoothstep(0.35, 0.7, h));
    float lit = smoothstep(-0.01, 0.02, n - ns);
    float near = pow(max(sd, 0.0), 4.0);
    vec3 cc = mix(uCShade, uCLit * (1.0 + near * 1.6), lit * 0.85 + 0.15 * near);
    cc = mix(cc, uHor, smoothstep(0.08, 0.0, h) * 0.6);
    c = mix(c, cc, cov * 0.92);
  }
  // stars
  if (uStars > 0.001 && h > 0.02) {
    vec3 sp = d * 160.0; vec3 si = floor(sp); float sh2 = h31(si);
    float st = step(0.975, sh2) * smoothstep(0.32, 0.0, length(fract(sp) - 0.5));
    st *= 0.6 + 0.4 * sin(uTime * (2.0 + sh2 * 5.0) + sh2 * 40.0);
    c += vec3(0.9, 0.92, 1.0) * st * uStars * smoothstep(0.02, 0.25, h) * 1.6;
  }
  // sun disc / eclipse
  float disc = 1.0 - smoothstep(uSunSize - 0.0025, uSunSize, ang);
  vec3 sunCol = mix(uSun * 2.4, uSun * 4.0, smoothstep(uSunSize, 0.0, ang));
  float bands = 1.0 - step(0.5, fract((dot(d, ry) / uSunSize) * 3.0 - 0.15)) * step(dot(d, ry), -uSunSize * 0.25) * 0.18;
  sunCol *= bands;
  vec3 eclDisc = vec3(0.012, 0.006, 0.03);
  c = mix(c, mix(sunCol, eclDisc, uEclipse), disc);
  float corona = exp(-max(ang - uSunSize, 0.0) * 30.0) * (1.0 - disc);
  float edge = exp(-abs(ang - uSunSize) * 420.0);
  float streamers = 0.6 + 0.4 * vnoise(vec2(th * 14.0, uTime * 0.2));
  c += uEclipse * (uGlow * corona * 2.4 * streamers + uSun * edge * 6.0);
  // crescent moon: lit disc minus an offset shadow disc, soft halo
  if (uMoon > 0.001) {
    float ma = acos(clamp(dot(d, uMoonDir), -1.0, 1.0));
    vec3 mx = normalize(cross(vec3(0.0, 1.0, 0.0), uMoonDir)); vec3 my = cross(uMoonDir, mx);
    vec2 mp = vec2(dot(d, mx), dot(d, my));
    float mr = 0.034;
    float mdisc = 1.0 - smoothstep(mr - 0.0015, mr, length(mp));
    float mshadow = 1.0 - smoothstep(mr * 0.86 - 0.0015, mr * 0.86, length(mp - vec2(-mr * 0.42, mr * 0.18)));
    float lit = mdisc * (1.0 - mshadow * 0.93);
    c = mix(c, c * 0.6, mdisc * mshadow * uMoon);
    c += vec3(0.92, 0.94, 1.0) * lit * 2.6 * uMoon;
    c += vec3(0.55, 0.6, 1.0) * exp(-max(ma - mr, 0.0) * 22.0) * 0.22 * uMoon * (1.0 - mdisc);
  }
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

// ------------------------------------------------------------------------------------------------ cloud sea
const SEA_VERT = /* glsl */`varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const SEA_FRAG = /* glsl */`
#define FBM_OCT __OCT__
uniform vec3 uLit, uShade, uDeep, uFog, uGlow, uSunDir, uRift, uRiftPos; uniform float uTime, uFar;
varying vec3 vW;
${NOISE_GLSL}
void main(){
  vec3 toP = vW - cameraPosition; float dist = length(toP);
  vec2 sd = normalize(uSunDir.xz + 1e-5);
  vec2 uv = vW.xz * 0.016 + vec2(uTime * 0.004, -uTime * 0.011);
  float n = fbm(uv) * 0.8 + vnoise(uv * 3.1 + 7.0) * 0.28;
  float ns = fbm(uv + sd * 0.05) * 0.8 + vnoise((uv + sd * 0.05) * 3.1 + 7.0) * 0.28;
  float lit = smoothstep(-0.015, 0.02, n - ns);
  vec3 c = mix(mix(uDeep, uShade, 0.55), uShade, smoothstep(0.33, 0.36, n));
  c = mix(c, mix(uShade, uLit, 0.45 + 0.55 * lit), smoothstep(0.46, 0.49, n));
  c = mix(c, uLit * 1.12, smoothstep(0.6, 0.62, n) * (0.4 + 0.6 * lit));
  // glitter path toward the sun
  vec2 vd = normalize(toP.xz + 1e-5);
  float path = pow(max(dot(vd, sd), 0.0), 60.0) * smoothstep(60.0, 260.0, dist);
  c += uGlow * path * (0.4 + 0.6 * lit) * 0.9;
  // rift glow pool
  float rd = length(vW.xz - uRiftPos.xz);
  c += uRift * exp(-rd * 0.035) * 0.55;
  float f = smoothstep(uFar * 0.25, uFar, dist);
  c = mix(c, uFog, f);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

// puffy cumulus billboards (alpha tested, upright cylindrical billboards, 1 draw)
const PUFF_VERT = /* glsl */`
attribute vec3 iPos; attribute vec3 iSize; // w, h, atlas cell
varying vec2 vUv; varying float vDist; varying float vY;
void main(){
  vec3 toCam = cameraPosition - iPos; toCam.y = 0.0; toCam = normalize(toCam);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  vec3 p = iPos + right * position.x * iSize.x + vec3(0.0, (position.y + 0.5) * iSize.y, 0.0);
  float cell = iSize.z;
  vUv = (position.xy + 0.5) * 0.5 + vec2(mod(cell, 2.0), floor(cell / 2.0)) * 0.5;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  vDist = length(mv.xyz); vY = position.y + 0.5;
  gl_Position = projectionMatrix * mv;
}`;
const PUFF_FRAG = /* glsl */`
uniform sampler2D uTex; uniform vec3 uLit, uShade, uFog, uGlow; uniform float uFar;
varying vec2 vUv; varying float vDist; varying float vY;
void main(){
  vec4 t = texture2D(uTex, vUv);
  if (t.r < 0.5) discard;
  vec3 c = mix(mix(uShade, uLit, 0.2), uLit * 1.15, smoothstep(0.4, 0.6, t.g) * (1.0 - t.b * 0.7));
  c = mix(c, uShade * 0.85, t.b * 0.6);                       // flat shaded base
  c = mix(c, uFog, smoothstep(uFar * 0.2, uFar * 1.2, vDist) * 0.55);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

// rune circle (additive, alpha from a baked canvas texture, rotation + beat pulse + outward pulse wave)
const RUNE_VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RUNE_FRAG = /* glsl */`
uniform sampler2D uTex; uniform vec3 uColor; uniform float uRot, uGlow, uWave, uTime;
varying vec2 vUv;
void main(){
  float r = length(vUv);
  float c = cos(uRot), s = sin(uRot);
  vec2 q = mat2(c, -s, s, c) * vUv;
  float m = texture2D(uTex, q * 0.5 + 0.5).r;
  float th = atan(vUv.y, vUv.x);
  float sweep = pow(max(0.0, cos(th - uTime * 0.9)), 16.0) * 0.6;
  float wave = exp(-abs(r - uWave) * 14.0) * step(uWave, 1.2) * (1.2 - uWave);
  float k = m * (uGlow + sweep * uGlow) + m * wave * 3.0 + wave * 0.25 * step(r, 1.0);
  gl_FragColor = vec4(uColor * k, 1.0);
}`;

// waterfalls (scrolling toon streaks)
const WATER_VERT = /* glsl */`attribute float aLen; attribute float aW; varying vec2 vUv; varying float vLen; varying float vW; varying float vDist;
void main(){ vUv = uv; vLen = aLen; vW = aW; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`;
const WATER_FRAG = /* glsl */`
#define FBM_OCT 2
uniform vec3 uBody, uFog; uniform float uTime, uFar;
varying vec2 vUv; varying float vLen; varying float vW; varying float vDist;
${NOISE_GLSL}
// R2 (P2-9): toon waterfall. Three painted tones in flow streaks stretched along the fall and scrolling down, thin bright
// edges, a foam lip where the water leaves the rock, and the lower half breaking into billowing mist above the clouds.
void main(){
  float x = vUv.x, yy = 1.0 - vUv.y, y = yy * vLen;
  float side = min(x, 1.0 - x);
  float edge = smoothstep(0.0, 0.1, side);
  float s1 = vnoise(vec2(x * vW * 3.2, y * 0.045 - uTime * 1.5));
  float s2 = vnoise(vec2(x * vW * 9.0 + 3.0, y * 0.11 - uTime * 2.7));
  float flow = s1 * 0.62 + s2 * 0.38;
  vec3 foamC = mix(uBody, vec3(1.0), 0.75) * 1.15;
  vec3 col = flow > 0.6 ? foamC : (flow > 0.4 ? uBody * 0.95 : uBody * 0.6);
  col = mix(col, foamC, smoothstep(0.16, 0.03, side) * 0.7);                 // thin, bright sheet edges
  float lip = smoothstep(0.06, 0.0, yy) + smoothstep(0.12, 0.02, yy) * step(0.5, s2) * 0.6;
  col = mix(col, foamC * 1.1, clamp(lip, 0.0, 1.0));
  float aWater = edge * (0.72 + 0.28 * step(0.6, flow));
  // mist: slow fbm puffs, rising, wider than the sheet
  float mistZ = smoothstep(0.42, 0.85, yy);
  float m = fbm(vec2(x * 3.4 + 1.7, y * 0.05 + uTime * 0.28));
  float aMist = smoothstep(0.32, 0.7, m) * smoothstep(0.0, 0.35, x) * smoothstep(1.0, 0.65, x) * 0.85;
  col = mix(col, mix(uBody, vec3(1.0), 0.55) * (0.85 + m * 0.4), mistZ);
  float a = mix(aWater, aMist, mistZ) * (1.0 - smoothstep(0.86, 1.0, yy)) * smoothstep(0.0, 0.01, yy + 0.005);
  col = mix(col, uFog, smoothstep(uFar * 0.2, uFar, vDist));
  if (a < 0.02) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

// drifting petals + embers (fully GPU: position = wrap(seed * box + wind * t + swirl))
const PETAL_VERT = /* glsl */`
attribute vec4 aSeed; attribute float aKind;
uniform float uTime; uniform vec3 uMin, uSize, uWind;
varying vec2 vUv; varying float vKind; varying float vFade; varying float vSeed;
void main(){
  vKind = aKind; vSeed = aSeed.w;
  float t = uTime * (0.6 + aSeed.w * 0.8);
  vec3 p = aSeed.xyz * uSize + uWind * t;
  p += vec3(sin(t * 1.3 + aSeed.w * 30.0) * 0.9, sin(t * 0.9 + aSeed.w * 17.0) * 0.6 + (aKind > 0.5 ? t * 0.8 : 0.0), cos(t * 1.1 + aSeed.w * 23.0) * 0.9);
  p = uMin + mod(p, uSize);
  vec3 rel = (p - uMin) / uSize;
  vFade = smoothstep(0.0, 0.08, rel.x) * smoothstep(1.0, 0.92, rel.x) * smoothstep(0.0, 0.1, rel.y) * smoothstep(1.0, 0.9, rel.y) * smoothstep(0.0, 0.1, rel.z) * smoothstep(1.0, 0.9, rel.z);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  vFade *= smoothstep(1.2, 3.0, -mv.z);
  float size = aKind > 0.5 ? 0.05 + aSeed.w * 0.05 : 0.07 + aSeed.w * 0.06;
  float r = t * (1.5 + aSeed.w * 3.0) + aSeed.w * 6.28; vec2 cs = vec2(cos(r), sin(r));
  vec2 c = position.xy * 2.0; vUv = c;
  float flip = aKind > 0.5 ? 1.0 : abs(sin(t * 2.2 + aSeed.w * 9.0)) * 0.8 + 0.2;   // petals flutter
  vec2 off = vec2(c.x * cs.x - c.y * cs.y, c.x * cs.y + c.y * cs.x) * size * vec2(1.0, flip);
  mv.xy += off;
  gl_Position = projectionMatrix * mv;
}`;
const PETAL_FRAG = /* glsl */`
uniform vec3 uPetal, uEmber;
varying vec2 vUv; varying float vKind; varying float vFade; varying float vSeed;
void main(){
  vec2 p = vUv; float a; vec3 col;
  if (vKind > 0.5) { float r = length(p); a = pow(max(0.0, 1.0 - r), 2.0); col = uEmber * (a * 2.6) + vec3(1.0, 0.9, 0.7) * smoothstep(0.35, 0.0, r) * 1.5; }
  else { float notch = smoothstep(0.0, 0.25, abs(p.x)) + step(p.y, 0.55); float d = length(p * vec2(1.6, 1.0));
    a = step(d, 1.0) * min(notch, 1.0); col = uPetal * (0.75 + 0.25 * p.y) * 0.9; }
  if (a < 0.02) discard;
  gl_FragColor = vec4(col * a * vFade, 1.0);
}`;

// rift portal (premultiplied: opaque swirling void inside, additive glow + cracks outside)
const RIFT_VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RIFT_FRAG = /* glsl */`
#define FBM_OCT __OCT__
uniform vec3 uCol, uDeep; uniform float uTime, uPulse, uOpen, uAspect;
varying vec2 vUv;
${NOISE_GLSL}
void main(){
  vec2 p = vUv * 1.3;                                  // lens spans |y| < 1 (= 77 % of the quad), glow fills the rest
  float yy = clamp(p.y, -1.0, 1.0);
  float jag = (vnoise(vec2(p.y * 6.0, uTime * 0.8)) - 0.5) * 0.08 + (vnoise(vec2(p.y * 19.0, uTime * 1.7)) - 0.5) * 0.03;
  float w = (0.46 * pow(max(0.0, 1.0 - yy * yy), 0.85) + jag) * uOpen + 0.004;
  float d = abs(p.x) - w;
  d = max(d, abs(p.y) - 1.0);
  float rx = p.x / max(w, 0.02);
  float r = length(vec2(rx * 0.6, p.y));
  float ang = atan(p.y, rx * 0.5);
  float sw = fbm(vec2(ang * 1.2 + uTime * 0.4 - r * 2.2, r * 2.6 - uTime * 1.1));
  float sw2 = vnoise(vec2(ang * 4.0 - uTime * 0.9, r * 7.0 - uTime * 2.0));
  vec3 inside = mix(uDeep, uCol * 0.9, smoothstep(0.3, 0.75, sw));
  inside += uCol * 2.2 * pow(smoothstep(0.55, 0.9, sw), 2.0);
  inside += vec3(1.0, 0.92, 1.0) * smoothstep(0.75, 0.95, sw2) * 1.6 * smoothstep(0.9, 0.2, r);
  inside += uCol * smoothstep(-0.1, 0.0, d) * 3.5;     // hot inner rim
  inside += vec3(1.2) * smoothstep(0.35, 0.0, r) * 0.8;  // bright heart
  float inA = smoothstep(0.006, -0.006, d);
  float edge = exp(-abs(d) * 38.0) * (2.4 + uPulse * 3.0);
  float outer = exp(-max(d, 0.0) * 4.0) * (0.35 + uPulse * 0.5) + exp(-max(d, 0.0) * 14.0) * 0.6;
  float a2 = atan(p.y, p.x); float rr = length(p * vec2(1.3, 0.85));
  float k = a2 * 9.0 / 6.2831 + (vnoise(vec2(rr * 4.0, floor(a2 * 9.0 / 6.2831 + 0.5) * 3.1 + uTime * 0.2)) - 0.5) * 0.5;
  float crack = smoothstep(0.03, 0.0, abs(fract(k) - 0.5)) * step(0.45, h21(vec2(floor(k), 3.0)));
  crack *= smoothstep(0.3, 0.55, rr) * smoothstep(1.45, 0.75, rr) * (0.7 + uPulse);
  vec3 glow = uCol * (edge + outer + crack * 1.8) * 1.5 + vec3(1.0, 0.95, 1.0) * exp(-abs(d) * 140.0) * 2.4;
  glow *= smoothstep(0.02, 0.25, uOpen);
  inA *= smoothstep(0.02, 0.12, uOpen);
  vec3 col = inside * inA + glow * (1.0 - inA);
  float vign = smoothstep(1.0, 0.8, max(abs(vUv.x), abs(vUv.y)));
  gl_FragColor = vec4(col * vign, inA * 0.97);
}`;

// camera-aware prop fade (near props): per-prop bounding sphere in aProp (world xyz, r)
const PROP_FADE_VERT = /* glsl */`
attribute vec4 aProp; uniform vec4 uFocus; uniform vec4 uFocus2; uniform vec4 uFocus3; uniform vec4 uClear; uniform float uBossAct; varying float vFade;
// R2 (P2-4): in the boss act the two platform sakura step aside (toward the camera line, out to the platform rim) so they
// no longer cut across the Warden from the gameplay / boss cameras; they dissolve out and back in while they move.
float propMoveW(){ vec3 c = aProp.xyz; return (c.y > 0.9 && c.z > 3.5 && length(c.xz) < 8.0) ? 1.0 : 0.0; }
vec3 propShift(){ return propMoveW() * vec3(sign(aProp.x) * 2.3, 0.0, -5.4) * smoothstep(0.0, 1.0, uBossAct); }
float coneFade(vec3 v, vec3 cam, vec4 tgt, float r){
  vec3 d2 = normalize(tgt.xyz - cam); float t2 = dot(v, d2);
  if (t2 <= 0.5) return 0.0;
  float ang = length(v - d2 * t2) / t2; float lim = r / t2 + tgt.w; return smoothstep(lim, lim * 0.6, ang);
}
float propFade(){
  vec3 c = (modelMatrix * vec4(aProp.xyz + propShift(), 1.0)).xyz; float r = aProp.w;
  vec3 cam = cameraPosition; vec3 v = c - cam;
  float f = smoothstep(r + 3.0, r + 1.4, length(v));                       // hugging the camera
  vec3 seg = uFocus.xyz - cam; float L = length(seg); vec3 dir = seg / max(L, 1e-4);
  float t = dot(v, dir);
  if (t > 0.0 && t < L - 0.3) f = max(f, smoothstep(r + 0.7, r * 0.55, length(v - dir * t)));   // between camera and hero
  if (uFocus2.w > 0.0) f = max(f, coneFade(v, cam, uFocus2, r));            // sightline cone (boss weak point)
  if (uFocus3.w > 0.0) f = max(f, coneFade(v, cam, uFocus3, r));            // R2: the boss body (torso + arms + head)
  if (uClear.w > 0.0) { float lim = uClear.w + r; f = max(f, smoothstep(lim, lim * 0.75, length(c - uClear.xyz))); }   // explicit clear sphere
  f = max(f, propMoveW() * sin(clamp(uBossAct, 0.0, 1.0) * 3.14159));
  return f;
}`;
const PROP_FADE_FRAG = /* glsl */`
varying float vFade;
float bayer2(vec2 a){ a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float bayer4(vec2 a){ return bayer2(0.5 * a) * 0.25 + bayer2(a); }`;

// ------------------------------------------------------------------------------------------------ helpers
// World geometry is smooth-shaded (indexed, vertex normals) toon with per-vertex colours, merged into one mesh and
// drawn twice: toon body + an inverted-hull ink outline (anime environment look, 2 draws total).
let _uq = null; const unitQuadGeo = () => (_uq ??= new THREE.PlaneGeometry(1, 1));
function vcolor(geo, fn, fol = 0) {
  const pos = geo.attributes.position, nrm = geo.attributes.normal, n = pos.count;
  const col = new Float32Array(n * 3);
  const p = new THREE.Vector3(), q = new THREE.Vector3(), out = new THREE.Color();
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(pos, i); q.fromBufferAttribute(nrm, i);
    fn(out, q, p, i);
    col[i * 3] = out.r; col[i * 3 + 1] = out.g; col[i * 3 + 2] = out.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aFol', new THREE.BufferAttribute(new Float32Array(n).fill(fol), 1));   // 1 = blossom canopy (per-act tint)
  return geo;
}
/** indexed, smooth vertex normals, position + normal only */
function prep(g, weld = false) {
  g.deleteAttribute('uv');
  let geo = g;
  if (weld || !geo.index) { geo.deleteAttribute('normal'); geo = mergeVertices(geo, 1e-4); }
  geo.computeVertexNormals();
  return geo;
}
const hash = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

const C = (h) => new THREE.Color(h);
const STONE = { top: C('#e0d2c2'), side: C('#c4a890'), band: C('#a88a78'), deep: C('#5a4660'), grass: C('#86c46a'), grassHi: C('#b4e080'), moss: C('#5e9a5c') };

/** Floating rock: grassy domed top, layered cliff sides tapering to a jagged point. Returned in world space. */
function rockGeo(R, H, seed, pos, { grass = true, segs = 18 } = {}) {
  const r = rng(seed);
  const g = new THREE.CylinderGeometry(R, R * 0.1, H, segs, 7, false);
  g.translate(0, -H / 2, 0);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  const ph = r() * 10, ph2 = r() * 10;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const t = -v.y / H; // 0 top .. 1 bottom
    const ang = Math.atan2(v.z, v.x);
    const k = 1 + (Math.sin(ang * 3 + ph) * 0.1 + Math.sin(ang * 5 + ph2) * 0.06) * (0.3 + t) + Math.sin(t * 9 + ang * 2) * 0.04 * t;
    v.x *= k; v.z *= k;
    if (t < 0.001) v.y += (1 - Math.min(1, Math.hypot(v.x, v.z) / R)) * R * 0.12;
    else v.y += Math.sin(ang * 4 + ph) * H * 0.04 * t;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  const geo = prep(g, true);
  vcolor(geo, (out, n, c, i) => {
    const t = THREE.MathUtils.clamp(-c.y / H, 0, 1);
    if (grass && n.y > 0.5 && t < 0.05) out.copy(STONE.grass).lerp(STONE.grassHi, THREE.MathUtils.clamp((n.y - 0.5) * 2, 0, 1) * 0.6);
    else if (grass && t < 0.09) out.copy(STONE.moss);
    else { out.copy(STONE.side).lerp(STONE.band, Math.sin(t * 22 + seed) > 0.6 ? 0.6 : 0).lerp(STONE.deep, Math.pow(t, 0.8)); }
  });
  geo.translate(pos.x, pos.y, pos.z);
  return geo;
}

// R2 (P2-9): painted toon canopy instead of smooth spheres. ~11 lumpy clumps (noise-displaced icospheres) arranged in a
// dome; per-vertex paint: 3 hard tone bands from the light direction, ambient occlusion where clumps tuck under / into
// each other and toward the trunk, a lighter crown and blossom speckles. Branches fork from the trunk into the clumps.
// The act tint (aFol) keeps these luminance steps, and the toon shader adds a stronger rim on foliage.
function sakuraGeo(seed, pos, s = 1) {
  const r = rng(seed);
  const parts = [];
  const bark = C('#6a4048'), barkD = C('#3e2430');
  const trunk = prep(new THREE.CylinderGeometry(0.1 * s, 0.22 * s, 2.3 * s, 8, 4));
  { const tp = trunk.attributes.position; for (let i = 0; i < tp.count; i++) { const y = tp.getY(i) / (2.3 * s) + 0.5; tp.setX(i, tp.getX(i) + Math.sin(y * 2.5) * 0.25 * s * y); } trunk.computeVertexNormals(); }
  trunk.translate(0, 1.15 * s, 0);
  vcolor(trunk, (o, n, p) => o.copy(barkD).lerp(bark, THREE.MathUtils.clamp(0.4 + n.x * 0.4 + p.y / (2.3 * s) * 0.3, 0, 1)));
  parts.push(trunk);
  const top = new THREE.Vector3(0.3 * s, 2.25 * s, 0);
  const clumps = [];
  const n = s > 0.5 ? 11 : 8;
  for (let i = 0; i < n; i++) {
    const ring = i === 0 ? 0 : i < 6 ? 1 : 2;
    const a = (i / 5) * Math.PI * 2 + r() * 0.8;
    const d = ring === 0 ? 0 : ring === 1 ? (1.0 + r() * 0.35) * s : (0.55 + r() * 0.3) * s;
    const y = ring === 0 ? 3.15 : ring === 1 ? 2.55 + r() * 0.35 : 3.3 + r() * 0.3;
    clumps.push({ c: new THREE.Vector3(Math.cos(a) * d + 0.35 * s, y * s, Math.sin(a) * d), rad: (ring === 0 ? 0.95 : ring === 1 ? 0.7 + r() * 0.3 : 0.6 + r() * 0.2) * s });
  }
  const crown = new THREE.Vector3(0.35 * s, 2.9 * s, 0);
  const L = new THREE.Vector3(-0.45, 0.8, -0.4).normalize();      // painted light (upper, toward the camera side)
  const pinkD = C('#c46a9c'), pinkM = C('#f39ac4'), pinkL = C('#ffc8e0'), pinkH = C('#fff0f6'), ao = C('#7a3c6c');
  const det = s > 0.5 && s < 1 ? 3 : 2;              // fine detail only on the two platform trees (closest to camera)
  clumps.forEach(({ c, rad }, ci) => {
    // branch from the trunk top into the clump
    if (ci > 0 && ci < 7) {
      const dir = new THREE.Vector3().subVectors(c, top); const len = dir.length() * 0.8;
      const br = prep(new THREE.CylinderGeometry(0.035 * s, 0.07 * s, len, 5, 1)); br.translate(0, len / 2, 0);
      br.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())); br.translate(top.x, top.y, top.z);
      vcolor(br, (o) => o.copy(barkD)); parts.push(br);
    }
    const b = prep(new THREE.IcosahedronGeometry(rad, det), true);
    const bp = b.attributes.position, v = new THREE.Vector3(), ph = r() * 10;
    for (let k = 0; k < bp.count; k++) {               // lumpy, cauliflower-like silhouette
      v.fromBufferAttribute(bp, k).normalize();
      const lump = 1 + 0.13 * Math.sin(v.x * 5.1 + ph) * Math.sin(v.y * 4.3 + ph * 1.3) * Math.sin(v.z * 4.7 + ph * 0.7) + 0.06 * Math.sin(v.x * 11 + v.z * 9 + ph);
      v.multiplyScalar(rad * lump); v.y *= 0.82; bp.setXYZ(k, v.x, v.y, v.z);
    }
    b.computeVertexNormals();
    b.translate(c.x, c.y, c.z);
    vcolor(b, (o, nn, p) => {
      const l = nn.dot(L);
      // 3 hard bands (painted toon), lighter toward the crown
      o.copy(l > 0.45 ? pinkL : l > -0.05 ? pinkM : pinkD);
      if (nn.y > 0.75 && l > 0.3) o.lerp(pinkH, 0.6);
      // ambient occlusion: under-sides, inward-facing (toward the canopy centre) and inside other clumps' reach
      const toC = new THREE.Vector3().subVectors(crown, p); const inward = Math.max(0, nn.dot(toC.normalize()));
      let occ = Math.max(0, -nn.y) * 0.55 + inward * 0.5;
      for (const q of clumps) if (q.c !== c) { const dd = p.distanceTo(q.c) / q.rad; if (dd < 1.25) occ += (1.25 - dd) * 0.9; }
      o.lerp(ao, Math.min(0.75, occ));
      // blossom speckles
      const sp = hash(Math.floor(p.x * 9 / s) * 7.1 + Math.floor(p.y * 9 / s) * 3.7 + Math.floor(p.z * 9 / s) * 1.3 + seed);
      if (sp > 0.86 && occ < 0.4) o.lerp(pinkH, 0.55);
    }, 1);
    parts.push(b);
  });
  const m = mergeGeometries(parts);
  m.translate(pos.x, pos.y, pos.z);
  return m;
}

function pillarGeo(seed, pos, h) {
  const r = rng(seed);
  const parts = [];
  const base = prep(new THREE.CylinderGeometry(0.7, 0.78, 0.4, 8, 1)); base.translate(0, 0.2, 0); parts.push(base);
  const col = new THREE.CylinderGeometry(0.36, 0.42, h, 12, 6);
  const p = col.attributes.position; const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    if (v.y > h / 2 - 0.01) v.y += Math.sin(Math.atan2(v.z, v.x) * 2 + seed) * 0.28 + (r() - 0.5) * 0.12;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  const cg = prep(col); cg.translate(0, h / 2 + 0.4, 0); parts.push(cg);
  const ring = prep(new THREE.TorusGeometry(0.43, 0.06, 6, 16)); ring.rotateX(Math.PI / 2); ring.translate(0, 1.1, 0); parts.push(ring);
  for (const g of parts) vcolor(g, (o, n, c) => o.copy(STONE.top).lerp(STONE.side, 0.35 - c.y / h * 0.25));
  vcolor(ring, (o) => o.set('#e2b46a'));
  const chunk = prep(new THREE.DodecahedronGeometry(0.32, 0), true); chunk.translate(0.85, 0.22, 0.4);
  vcolor(chunk, (o) => o.copy(STONE.side)); parts.push(chunk);
  const m = mergeGeometries(parts);
  m.translate(pos.x, pos.y, pos.z);
  return m;
}

function platformGeo() {
  // lathe: lip, gold-trimmed wall, then a rocky underside tapering to a point ~12 m below
  const pts = [[6.5, 0.0], [6.72, -0.1], [6.76, -0.5], [6.5, -0.7], [6.35, -1.2], [5.8, -2.2], [4.9, -3.6], [3.7, -5.4], [2.5, -7.4], [1.3, -9.6], [0.15, -12.2]]
    .map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(pts, 64);
  const p = g.attributes.position; const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    if (v.y < -0.9) {
      const ang = Math.atan2(v.z, v.x);
      const t = (-v.y - 0.9) / 11;
      const k = 1 + (Math.sin(ang * 5) * 0.07 + Math.sin(ang * 9 + 1) * 0.04) * (0.5 + t);
      v.x *= k; v.z *= k; v.y += Math.sin(ang * 6) * 0.35 * t;
    }
    p.setXYZ(i, v.x, v.y, v.z);
  }
  const geo = prep(g, true);
  vcolor(geo, (o, n, c) => {
    if (c.y > -0.05) o.copy(STONE.top);
    else if (c.y > -0.75) o.copy(c.y > -0.15 || c.y < -0.62 ? C('#e2b46a') : STONE.side);
    else if (c.y > -1.5) o.copy(STONE.moss);
    else { const t = THREE.MathUtils.clamp((-c.y - 1.5) / 10, 0, 1); o.copy(STONE.side).lerp(STONE.band, Math.sin(-c.y * 2.2) > 0.5 ? 0.6 : 0).lerp(STONE.deep, Math.pow(t, 0.7)); }
  });
  return geo;
}

function platformTopTexture() {
  return canvasTex(1024, (g, S) => {
    const c = S / 2, R = S / 2, m2px = R / 6.5;
    const r = rng(11);
    g.fillStyle = '#6a5866'; g.fillRect(0, 0, S, S);
    const rings = [0, 0.95, 2.0, 3.05, 4.25, 5.4, 6.5];
    for (let k = 0; k < rings.length - 1; k++) {
      const r0 = rings[k] * m2px, r1 = rings[k + 1] * m2px;
      const n = k === 0 ? 1 : Math.round((2 * Math.PI * (rings[k] + rings[k + 1]) / 2) / 1.05);
      const off = r() * Math.PI;
      for (let i = 0; i < n; i++) {
        const a0 = off + (i / n) * Math.PI * 2, a1 = off + ((i + 1) / n) * Math.PI * 2;
        const l = 0.86 + r() * 0.16;
        const base = k === 0 ? [214, 202, 190] : [206, 194, 182];
        g.fillStyle = `rgb(${base[0] * l | 0},${base[1] * l | 0},${base[2] * l * 1.01 | 0})`;
        g.beginPath();
        if (k === 0) g.arc(c, c, r1 - 3, 0, Math.PI * 2);
        else { g.arc(c, c, r1 - 3, a0 + 0.012, a1 - 0.012); g.arc(c, c, r0 + 3, a1 - 0.012, a0 + 0.012, true); }
        g.closePath(); g.fill();
        // lighter top edge (toon bevel)
        g.strokeStyle = 'rgba(255,248,236,0.25)'; g.lineWidth = 3;
        g.beginPath(); g.arc(c, c, r1 - 6, a0 + 0.02, a1 - 0.02); g.stroke();
      }
    }
    // gold inlay rings
    for (const [rad, w] of [[6.2, 6], [3.02, 5], [0.95, 4]]) {
      g.strokeStyle = '#e8b860'; g.lineWidth = w; g.beginPath(); g.arc(c, c, rad * m2px, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = 'rgba(255,240,200,0.6)'; g.lineWidth = w * 0.35; g.beginPath(); g.arc(c, c, rad * m2px - w * 0.2, 0, Math.PI * 2); g.stroke();
    }
    // cracks
    g.strokeStyle = 'rgba(70,52,64,0.55)'; g.lineWidth = 2;
    for (let i = 0; i < 26; i++) {
      let a = r() * Math.PI * 2, rad = (1.2 + r() * 5) * m2px;
      g.beginPath(); g.moveTo(c + Math.cos(a) * rad, c + Math.sin(a) * rad);
      for (let s = 0; s < 4; s++) { a += (r() - 0.5) * 0.12; rad += (r() - 0.3) * 18; g.lineTo(c + Math.cos(a) * rad, c + Math.sin(a) * rad); }
      g.stroke();
    }
    // edge AO
    const gr = g.createRadialGradient(c, c, R * 0.82, c, c, R);
    gr.addColorStop(0, 'rgba(60,40,70,0)'); gr.addColorStop(1, 'rgba(60,40,70,0.35)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  });
}

function glyph(g, x, y, s, r) {
  g.beginPath();
  const n = 2 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const t = Math.floor(r() * 4);
    const ax = x + (r() - 0.5) * s, ay = y + (r() - 0.5) * s;
    if (t === 0) { g.moveTo(ax, y - s / 2); g.lineTo(ax, y + s / 2); }
    else if (t === 1) { g.moveTo(x - s / 2, ay); g.lineTo(x + s / 2, ay); }
    else if (t === 2) { g.moveTo(x - s / 2, y + s / 2); g.lineTo(x, y - s / 2); g.lineTo(x + s / 2, y + s / 2); }
    else { g.moveTo(x + s * 0.35, y); g.arc(x, y, s * 0.35, 0, Math.PI * (1 + r())); }
  }
  g.stroke();
}
function runeTexture(kind) {
  return canvasTex(1024, (g, S) => {
    const c = S / 2; const r = rng(kind === 'inner' ? 3 : 5);
    g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
    g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineCap = 'round';
    g.shadowColor = '#fff'; g.shadowBlur = 10;
    const circle = (rad, w) => { g.lineWidth = w; g.beginPath(); g.arc(c, c, rad * c, 0, Math.PI * 2); g.stroke(); };
    const band = (r0, r1, n, size) => {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2; const rad = ((r0 + r1) / 2) * c;
        g.save(); g.translate(c + Math.cos(a) * rad, c + Math.sin(a) * rad); g.rotate(a + Math.PI / 2);
        g.lineWidth = 3; glyph(g, 0, 0, size, r); g.restore();
      }
    };
    if (kind === 'inner') {
      circle(0.97, 5); circle(0.9, 2.5); band(0.9, 0.97, 30, 22); circle(0.74, 4);
      // 8-point star
      g.lineWidth = 3; g.beginPath();
      for (let i = 0; i <= 8; i++) { const a = (i * 3 / 8) * Math.PI * 2; const x = c + Math.cos(a) * 0.74 * c, y = c + Math.sin(a) * 0.74 * c; i ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke();
      circle(0.42, 3); band(0.3, 0.4, 14, 16); circle(0.29, 2.5);
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; g.beginPath(); g.arc(c + Math.cos(a) * 0.82 * c, c + Math.sin(a) * 0.82 * c, 10, 0, Math.PI * 2); g.stroke(); }
    } else {
      circle(0.995, 4); circle(0.955, 2); band(0.955, 0.995, 72, 16);
      // dashed inner track
      g.lineWidth = 5;
      for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2; g.beginPath(); g.arc(c, c, 0.925 * c, a, a + 0.07); g.stroke(); }
    }
  }, { srgb: false });
}

function cloudAtlas() {
  return canvasTex(512, (g) => {
    const r = rng(21);
    g.fillStyle = '#000'; g.fillRect(0, 0, 512, 512);
    for (let cell = 0; cell < 4; cell++) {
      const ox = (cell % 2) * 256, oy = Math.floor(cell / 2) * 256;
      const circles = [];
      const n = 7 + Math.floor(r() * 4);
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const x = 40 + t * 176 + (r() - 0.5) * 20;
        const rad = 26 + Math.sin(t * Math.PI) * (40 + r() * 30);
        const y = 230 - rad * (0.6 + r() * 0.5);
        circles.push([x, y, rad]);
      }
      const path = new Path2D();
      for (const [x, y, rad] of circles) { path.moveTo(ox + x + rad, oy + y); path.arc(ox + x, oy + y, rad, 0, Math.PI * 2); }
      path.rect(ox + 30, oy + 200, 196, 36);
      g.save(); g.beginPath(); g.rect(ox, oy, 256, 240); g.clip();
      g.fillStyle = '#ff0000'; g.fill(path);
      g.clip(path);
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = '#00ff00';
      for (const [x, y, rad] of circles) { g.beginPath(); g.arc(ox + x - rad * 0.16, oy + y - rad * 0.3, rad * 0.78, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = '#0000ff';
      { const gr = g.createLinearGradient(0, oy + 175, 0, oy + 236); gr.addColorStop(0, 'rgba(0,0,255,0)'); gr.addColorStop(0.35, 'rgba(0,0,255,1)'); g.fillStyle = gr; g.fillRect(ox, oy + 150, 256, 100); }
      g.restore();
      g.globalCompositeOperation = 'source-over';
    }
  }, { srgb: false });
}

// ------------------------------------------------------------------------------------------------ stage
export function createStage(ctx, shared) {
  const q = qualityId(ctx.quality);
  const OCT = q === 'low' ? 3 : 4;
  const time = shared.time;
  const object = new THREE.Group(); object.name = 'BreaklightStage';

  // ---- palette state (cur is what the materials reference; tgt is what setAct() picks)
  const cur = {}, tgt = {}, base = {};
  for (const k of COLOR_KEYS) { cur[k] = new THREE.Color(PALETTES.title[k]); tgt[k] = new THREE.Color(PALETTES.title[k]); base[k] = new THREE.Color(); }
  for (const k of NUM_KEYS) { cur[k] = PALETTES.title[k]; tgt[k] = PALETTES.title[k]; }
  const sunDir = new THREE.Vector3();
  const updateSunDir = () => sunDir.set(Math.sin(cur.az) * Math.cos(cur.el), Math.sin(cur.el), Math.cos(cur.az) * Math.cos(cur.el));
  updateSunDir();

  // ---- sky
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG.replace('__OCT__', OCT), side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
    uniforms: {
      uTop: { value: cur.top }, uMid: { value: cur.mid }, uHor: { value: cur.hor }, uLow: { value: cur.low }, uSun: { value: cur.sun }, uGlow: { value: cur.glow },
      uCLit: { value: cur.cLit }, uCShade: { value: cur.cShade }, uSunDir: { value: sunDir }, uTime: time,
      uStars: { value: 0 }, uEclipse: { value: 0 }, uRays: { value: 1 }, uSunSize: { value: 0.085 }, uMoonDir: { value: MOON_DIR }, uMoon: { value: 0 },
    },
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 48, 24), skyMat);
  sky.name = 'sky'; sky.renderOrder = -100; sky.frustumCulled = false;
  object.add(sky);

  // ---- cloud sea
  const FAR = 340;
  const seaMat = new THREE.ShaderMaterial({
    vertexShader: SEA_VERT, fragmentShader: SEA_FRAG.replace('__OCT__', OCT), fog: false,
    uniforms: { uLit: { value: cur.cLit }, uShade: { value: cur.cShade }, uDeep: { value: cur.cDeep }, uFog: { value: cur.low }, uGlow: { value: cur.glow }, uSunDir: { value: sunDir },
      uRift: { value: cur.rift }, uRiftPos: { value: RIFT_POS }, uTime: time, uFar: { value: FAR } },
  });
  const seaGeo = new THREE.PlaneGeometry(FAR * 2.2, FAR * 2.2, 1, 1); seaGeo.rotateX(-Math.PI / 2);
  const sea = new THREE.Mesh(seaGeo, seaMat); sea.position.y = SEA_Y; sea.name = 'cloudSea'; sea.frustumCulled = false;
  object.add(sea);

  // ---- puffy cumulus billboards
  const puffMax = q === 'low' ? 26 : 56;
  const puffGeo = new THREE.InstancedBufferGeometry();
  const pq = new THREE.PlaneGeometry(1, 1); puffGeo.index = pq.index; puffGeo.attributes.position = pq.attributes.position;
  const pPos = new Float32Array(puffMax * 3), pSize = new Float32Array(puffMax * 3);
  {
    const r = rng(31);
    for (let i = 0; i < puffMax; i++) {
      const band = i % 4; // 0: hugging the island underside, 1: mid, 2-3: horizon towers
      const far = band >= 2;
      const a = (r() - 0.5) * Math.PI * (far ? 1.5 : band === 0 ? 2.0 : 1.8);
      const d = far ? 150 + r() * 160 : band === 0 ? 12 + r() * 16 : 30 + r() * 80;
      const x = Math.sin(a) * d, z = Math.cos(a) * d;
      if (band !== 0 && Math.abs(x) < 10 && z < 30) { pPos[3 * i + 1] = -200; continue; }
      if (band === 0 && z < 4 && Math.abs(x) < 8) { pPos[3 * i + 1] = -200; continue; }
      const w = far ? 40 + r() * 60 : band === 0 ? 7 + r() * 8 : 10 + r() * 18;
      pPos[3 * i] = x; pPos[3 * i + 1] = band === 0 ? -12 - r() * 5 : SEA_Y - w * 0.12; pPos[3 * i + 2] = z;
      pSize[3 * i] = w; pSize[3 * i + 1] = w * (far ? 0.32 + r() * 0.14 : 0.45 + r() * 0.2); pSize[3 * i + 2] = Math.floor(r() * 4);
    }
  }
  puffGeo.setAttribute('iPos', new THREE.InstancedBufferAttribute(pPos, 3));
  puffGeo.setAttribute('iSize', new THREE.InstancedBufferAttribute(pSize, 3));
  puffGeo.instanceCount = puffMax; puffGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  const puffMat = new THREE.ShaderMaterial({ vertexShader: PUFF_VERT, fragmentShader: PUFF_FRAG, fog: false,
    uniforms: { uTex: { value: cloudAtlas() }, uLit: { value: cur.cLit }, uShade: { value: cur.cShade }, uFog: { value: cur.low }, uGlow: { value: cur.glow }, uFar: { value: FAR } } });
  const puffs = new THREE.Mesh(puffGeo, puffMat); puffs.frustumCulled = false; puffs.name = 'cumulus';
  object.add(puffs);

  // ---- toon world (one merged mesh: platform, pillars, trees, floating rocks, distant islands)
  const ramp = toonRamp();
  const stoneMat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp });
  const rimU = { value: cur.rim };
  const folU = { uFol: { value: cur.fol }, uFolMix: { value: 0 } };
  // camera-aware prop clearing (near props only): props near the camera, between the camera and the hero (uFocus) or
  // inside the boss sightline cone (uFocus2.w = cone, radians) dither out. Pure GPU, works for every camera / cut.
  const fadeU = { uFocus: { value: new THREE.Vector4(0, 1.2, 0, 0) }, uFocus2: { value: new THREE.Vector4(0, 0, 0, 0) }, uFocus3: { value: new THREE.Vector4(0, 0, 0, 0) }, uClear: { value: new THREE.Vector4(0, 0, 0, 0) }, uBossAct: { value: 0 } };
  const toonPatch = (fade) => (sh) => {
    sh.uniforms.uRimCol = rimU; Object.assign(sh.uniforms, folU);
    if (fade) Object.assign(sh.uniforms, fadeU);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aFol; varying float vFol;' + (fade ? PROP_FADE_VERT : ''))
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFol = aFol;' + (fade ? '\ntransformed += propShift(); vFade = propFade();' : ''));
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uRimCol; uniform vec3 uFol; uniform float uFolMix; varying float vFol;' + (fade ? PROP_FADE_FRAG : ''))
      .replace('#include <color_fragment>', '#include <color_fragment>\n{ float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)); diffuseColor.rgb = mix(diffuseColor.rgb, uFol * (0.3 + lum * 0.95), vFol * uFolMix); }')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>' + (fade ? '\nif (vFade > 0.002 && vFade * 1.02 > bayer4(gl_FragCoord.xy)) discard;' : ''))
      .replace('#include <opaque_fragment>', 'outgoingLight += uRimCol * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0) * (0.55 + vFol * 0.6);\n#include <opaque_fragment>');
  };
  stoneMat.onBeforeCompile = toonPatch(false);
  stoneMat.customProgramCacheKey = () => 'bl-stone';
  const nearMat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp });
  nearMat.onBeforeCompile = toonPatch(true);
  nearMat.customProgramCacheKey = () => 'bl-stone-near';
  const parts = [platformGeo()];
  const nearParts = [];
  const nearProp = (g) => { g.computeBoundingSphere(); const { center: c, radius: r } = g.boundingSphere; const n = g.attributes.position.count, a = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { a[4 * i] = c.x; a[4 * i + 1] = c.y; a[4 * i + 2] = c.z; a[4 * i + 3] = r; } g.setAttribute('aProp', new THREE.BufferAttribute(a, 4)); nearParts.push(g); return g; };
  // pillars on the front / side arc (never between the rear camera and the hero)
  // R2 (P2-2): the screen-left front pillar moved out from 68 to 88 deg and cut down (no crystal) so nothing of it reaches
  // the HUD's combo / hearts column from the gameplay or boss cameras
  const pillarAngles = q === 'low' ? [-72, 88] : [-68, 88, -106, 106];
  const crystalParts = [];
  pillarAngles.forEach((deg, i) => {
    const a = THREE.MathUtils.degToRad(deg); const R = 6.0;
    // R2 (P2-2): the +X (screen-left) pillars sit under the HUD's combo / hearts column from the gameplay and boss
    // cameras, so they stay short and their floating crystal hovers low and small, below that column
    const left = deg > 0;
    const h = left ? (deg < 90 ? 1.45 : 2.15) : 2.2 + ((i * 37) % 5) * 0.55;
    const pos = new THREE.Vector3(Math.sin(a) * R, 0, Math.cos(a) * R);
    nearProp(pillarGeo(100 + i, pos, h));
    const cr = crystalGeo(new THREE.OctahedronGeometry(left ? 0.22 : 0.32, 0), 0, [left ? 0.06 : 0.12, i * 1.7]);
    cr.scale(0.8, 1.7, 0.8); cr.translate(pos.x, h + (left ? 0.62 : 1.25), pos.z);
    if (!(left && deg < 90)) crystalParts.push(cr);   // no floating crystal over the front-left pillar (HUD column)
  });
  // sakura trees framing the arena
  nearProp(sakuraGeo(41, new THREE.Vector3(-4.3, -0.05, 5.0), 0.72));
  nearProp(sakuraGeo(43, new THREE.Vector3(4.5, -0.05, 4.7), 0.66));
  // floating rocks (with waterfalls on some)
  const ROCKS = [
    { p: [-17, 1.5, 18], R: 4.2, H: 7, fall: 1.6, tree: true },
    { p: [19, -1.5, 24], R: 5.0, H: 8, fall: 2.2 },
    { p: [-30, 5, 44], R: 6.5, H: 11, fall: 3.0, tree: true },
    { p: [33, 7, 52], R: 5.5, H: 9 },
    { p: [-11, -6, 9], R: 2.2, H: 4 },
    { p: [12, 3.5, 11], R: 1.8, H: 3.5 },
    { p: [-48, 12, 85], R: 9, H: 15, fall: 4.0, tree: true },
    { p: [55, 2, 95], R: 10, H: 16, fall: 4.5 },
    { p: [22, 14, 70], R: 3.5, H: 6 },
    { p: [-22, -9, 30], R: 3, H: 5 },
  ].filter((rk, i) => q !== 'low' || i < 8);
  const waterParts = [];
  ROCKS.forEach((rk, i) => {
    const pos = new THREE.Vector3(...rk.p);
    // close islands can get between a cinematic camera and the hero; tree islands up to 60 m can cross the Warden's
    // body from the boss cameras (R2 P2-4), so they join the dithered near-prop mesh too
    const near = pos.length() < (rk.tree ? 60 : 26);
    const rg = rockGeo(rk.R, rk.H, 200 + i, pos);
    if (rk.tree) { const tg = sakuraGeo(300 + i, new THREE.Vector3(pos.x + rk.R * 0.2, pos.y + 0.1, pos.z - rk.R * 0.1), rk.R * 0.32); if (near) nearProp(mergeGeometries([rg, tg])); else parts.push(rg, tg); }
    else if (near) nearProp(rg); else parts.push(rg);
    if (rk.fall) {
      // waterfall leaving the rock lip on the side facing the hero, falling into the cloud sea
      const toO = new THREE.Vector3(-pos.x, 0, -pos.z).normalize();
      const lip = pos.clone().addScaledVector(toO, rk.R * 0.92); lip.y += 0.1;
      const len = lip.y - SEA_Y + 2;
      const w = rk.fall;
      const g = new THREE.PlaneGeometry(1, 1, 1, 12);
      const pp = g.attributes.position;
      for (let k = 0; k < pp.count; k++) {
        const y = pp.getY(k) + 0.5; // 1 top .. 0 bottom
        const spread = 1 + (1 - y) * 0.8;
        const out = Math.sqrt(1 - y) * 1.6 * Math.min(1, w / 2);    // arcs outward from the lip
        pp.setXYZ(k, pp.getX(k) * w * spread, -(1 - y) * len, out);
      }
      g.lookAt(toO); // plane's +Z faces the hero
      g.translate(lip.x, lip.y, lip.z);
      const n = g.attributes.position.count;
      g.setAttribute('aLen', new THREE.BufferAttribute(new Float32Array(n).fill(len), 1));
      g.setAttribute('aW', new THREE.BufferAttribute(new Float32Array(n).fill(w), 1));
      g.deleteAttribute('normal');
      waterParts.push(g.toNonIndexed());
    }
  });
  // distant islands (fog turns them into layered silhouettes)
  const FAR_ISLANDS = [[-120, 4, 210, 28], [140, -2, 230, 34], [-210, 10, 120, 24], [230, 6, 140, 30], [30, 22, 300, 22], [-60, -4, 290, 20], [95, 12, 180, 14], [-160, 16, 250, 18]]
    .filter((v, i) => q !== 'low' || i < 5);
  FAR_ISLANDS.forEach(([x, y, z, R], i) => {
    parts.push(rockGeo(R, R * 1.7, 500 + i, new THREE.Vector3(x, y, z), { segs: 8 }));
    if (i % 2 === 0) parts.push(sakuraGeo(600 + i, new THREE.Vector3(x - R * 0.2, y, z), R * 0.18));
  });
  const worldGeo = mergeGeometries(parts);
  const world = new THREE.Mesh(worldGeo, stoneMat); world.name = 'stageWorld'; world.frustumCulled = false;
  object.add(world);
  // ink outline (inverted hull, width grows with distance so it stays ~1.5 px)
  const ink = new THREE.Color();
  const inkMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uInk: { value: new THREE.Color() }, uWidth: { value: 0.0017 } }]),
    vertexShader: `#include <common>
      #include <fog_pars_vertex>
      uniform float uWidth;
      void main(){ vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); float d = -mvPosition.z;
        mvPosition.xyz += normalize(normalMatrix * normal) * clamp(d * uWidth, 0.006, 0.7);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `#include <common>
      #include <fog_pars_fragment>
      uniform vec3 uInk;
      void main(){ gl_FragColor = vec4(uInk, 1.0);
        #include <fog_fragment>
      }`,
  });
  inkMat.uniforms.uInk.value = ink;
  const outline = new THREE.Mesh(worldGeo, inkMat); outline.name = 'stageInk'; outline.frustumCulled = false;
  if (q !== 'low') object.add(outline);
  // near props: own mesh + ink with the dither fade
  const nearGeo = mergeGeometries(nearParts);
  const nearMesh = new THREE.Mesh(nearGeo, nearMat); nearMesh.name = 'stageNearProps'; nearMesh.frustumCulled = false;
  object.add(nearMesh);
  const nearInkMat = inkMat.clone(); nearInkMat.uniforms = THREE.UniformsUtils.merge([inkMat.uniforms]); nearInkMat.uniforms.uInk.value = ink; nearInkMat.uniforms.uWidth = inkMat.uniforms.uWidth;
  Object.assign(nearInkMat.uniforms, fadeU);
  nearInkMat.vertexShader = inkMat.vertexShader.replace('#include <fog_pars_vertex>', '#include <fog_pars_vertex>' + PROP_FADE_VERT).replace('vec4(position, 1.0)', 'vec4(position + propShift(), 1.0)').replace('gl_Position = projectionMatrix * mvPosition;', 'gl_Position = projectionMatrix * mvPosition; vFade = propFade();');
  nearInkMat.fragmentShader = inkMat.fragmentShader.replace('#include <fog_pars_fragment>', '#include <fog_pars_fragment>' + PROP_FADE_FRAG).replace('void main(){', 'void main(){ if (vFade > 0.002 && vFade * 1.02 > bayer4(gl_FragCoord.xy)) discard;');
  const nearInk = new THREE.Mesh(nearGeo, nearInkMat); nearInk.name = 'stageNearInk'; nearInk.frustumCulled = false;
  if (q !== 'low') object.add(nearInk);

  // platform top (tile texture)
  const topMat = new THREE.MeshToonMaterial({ map: platformTopTexture(), gradientMap: ramp });
  const top = new THREE.Mesh(new THREE.CircleGeometry(6.5, 72), topMat);
  top.rotation.x = -Math.PI / 2; top.name = 'platformTop';
  object.add(top);

  // floating accent crystals above the pillars + under the island
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const cr = crystalGeo(new THREE.ConeGeometry(0.35 + (i % 3) * 0.15, 1.6 + (i % 2) * 1.2, 5), 0, [0.0, 0]);
    cr.rotateX(Math.PI); cr.translate(Math.cos(a) * (2.4 + (i % 3)), -3.2 - (i % 4) * 1.2, Math.sin(a) * (2.4 + (i % 3)));
    crystalParts.push(cr);
  }
  const crystalMat = crystalMaterial({ deep: '#40205a', time, wigSpeed: 1.4 });
  crystalMat.uniforms.uBright.value = cur.rune; crystalMat.uniforms.uRim.value = cur.ember;
  const crystals = new THREE.Mesh(mergeGeos(crystalParts), crystalMat); crystals.frustumCulled = false; crystals.name = 'accentCrystals';
  object.add(crystals);

  // waterfalls
  let waterfalls = null;
  if (waterParts.length) {
    const wg = mergeGeos(waterParts);
    // mergeGeos only merges attributes present on the first: uv/aLen/aW/position all exist on every part
    const wMat = new THREE.ShaderMaterial({ vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
      uniforms: { uBody: { value: cur.water }, uFog: { value: cur.fog }, uTime: time, uFar: { value: 420 } } });
    waterfalls = new THREE.Mesh(wg, wMat); waterfalls.frustumCulled = false; waterfalls.name = 'waterfalls'; waterfalls.renderOrder = 2;
    object.add(waterfalls);
  }

  // rune circles
  const mkRune = (kind, size, y) => {
    const m = new THREE.ShaderMaterial({ vertexShader: RUNE_VERT, fragmentShader: RUNE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTex: { value: runeTexture(kind) }, uColor: { value: cur.rune }, uRot: { value: 0 }, uGlow: { value: 0.6 }, uWave: { value: 9 }, uTime: time } });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size * 2, size * 2), m);
    mesh.rotation.x = -Math.PI / 2; mesh.position.y = y; mesh.renderOrder = 1;
    object.add(mesh); return mesh;
  };
  const runeInner = mkRune('inner', 2.85, 0.012);
  const runeOuter = mkRune('outer', 6.25, 0.01);

  // ---- petals + embers
  const petalMax = q === 'low' ? 220 : q === 'medium' ? 450 : 800;
  const petGeo = new THREE.InstancedBufferGeometry();
  petGeo.index = pq.index; petGeo.attributes.position = pq.attributes.position;
  const seed = new Float32Array(petalMax * 4), kind = new Float32Array(petalMax);
  { const r = rng(51); for (let i = 0; i < petalMax; i++) { seed[4 * i] = r(); seed[4 * i + 1] = r(); seed[4 * i + 2] = r(); seed[4 * i + 3] = r(); kind[i] = r() < 0.45 ? 1 : 0; } }
  petGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
  petGeo.setAttribute('aKind', new THREE.InstancedBufferAttribute(kind, 1));
  petGeo.instanceCount = petalMax; petGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  const petalMat = new THREE.ShaderMaterial({ vertexShader: PETAL_VERT, fragmentShader: PETAL_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: time, uMin: { value: new THREE.Vector3(-22, -3, -8) }, uSize: { value: new THREE.Vector3(44, 16, 62) }, uWind: { value: new THREE.Vector3(0.6, -0.15, -1.6) },
      uPetal: { value: cur.petal }, uEmber: { value: cur.ember } } });
  const petals = new THREE.Mesh(petGeo, petalMat); petals.frustumCulled = false; petals.name = 'petals'; petals.renderOrder = 8;
  object.add(petals);

  // ---- rift portal
  const riftMat = new THREE.ShaderMaterial({ vertexShader: RIFT_VERT, fragmentShader: RIFT_FRAG.replace('__OCT__', OCT), transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, fog: false,
    uniforms: { uCol: { value: cur.rift }, uDeep: { value: new THREE.Color('#1c0830') }, uTime: time, uPulse: { value: 0 }, uOpen: { value: 1 }, uAspect: { value: 1 } } });
  const RW = 15, RH = 15;
  const rift = new THREE.Mesh(new THREE.PlaneGeometry(RW, RH), riftMat);
  rift.position.copy(RIFT_POS); rift.rotation.y = Math.PI; rift.name = 'rift'; rift.renderOrder = 3;
  object.add(rift);
  const riftShards = [];
  { const r = rng(61); for (let i = 0; i < 16; i++) {
    const a = r() * Math.PI * 2, d = 3.6 + r() * 3.2;
    const g = crystalGeo(new THREE.OctahedronGeometry(0.3 + r() * 0.6, 0), 0, [0.4 + r() * 0.6, r() * 6]);
    g.scale(0.6, 1.4, 0.6); g.rotateZ(r() * 3); g.translate(Math.cos(a) * d * 0.7, Math.sin(a) * d, (r() - 0.5) * 3);
    riftShards.push(g);
  } }
  const riftShardMat = crystalMaterial({ deep: '#1a0830', time, wigSpeed: 0.8 });
  riftShardMat.uniforms.uBright.value = cur.rift; riftShardMat.uniforms.uRim.value = cur.rift;
  const riftCrystals = new THREE.Mesh(mergeGeos(riftShards), riftShardMat);
  riftCrystals.position.copy(RIFT_POS); riftCrystals.frustumCulled = false; riftCrystals.name = 'riftShards';
  object.add(riftCrystals);

  // ---- sun shafts: a huge camera-facing fan at the sun, drawn over the world (not the hero) for a volumetric feel
  const shaftMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uCol: { value: cur.glow }, uTime: time, uI: { value: 0.2 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = position.xy * 2.0; vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0); mv.xy += position.xy * 600.0; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `#define FBM_OCT 2
      uniform vec3 uCol; uniform float uTime, uI; varying vec2 vUv;
      ${NOISE_GLSL}
      void main(){ float r = length(vUv); float th = atan(vUv.y, vUv.x);
        float n = vnoise(vec2(th * 14.0, uTime * 0.06)) * vnoise(vec2(th * 31.0 + 7.0, -uTime * 0.05));
        float ray = smoothstep(0.25, 0.7, n) * smoothstep(1.0, 0.05, r) * smoothstep(0.02, 0.08, r);
        gl_FragColor = vec4(uCol * ray * uI, 1.0); }`,
  });
  const shafts = new THREE.Mesh(unitQuadGeo(), shaftMat); shafts.frustumCulled = false; shafts.renderOrder = 30; shafts.name = 'sunShafts';
  if (q !== 'low') object.add(shafts);

  // ---- lights (world only; the hero has its own rig in heroScene)
  const hemi = new THREE.HemisphereLight(cur.hemiS, cur.hemiG, 1.25);
  hemi.color = cur.hemiS; hemi.groundColor = cur.hemiG;
  const key = new THREE.DirectionalLight(cur.key, 2.2); key.color = cur.key;
  key.position.set(7, 11, -5);
  object.add(hemi, key, key.target);

  // ---- fog (owned by the stage; colour tweens with the act)
  const fog = new THREE.Fog(cur.fog.clone(), 60, 420);
  if (ctx.worldScene) ctx.worldScene.fog = fog;

  // ---- state
  const st = { bossAct: 0, riftOpen: 1, riftOpenTgt: 1, act: 'title', pulse: 0, wave: 9, beatPrev: -1, overdrive: 0, intensity: 0, riftPulse: 0, flashRift: 0 };
  const camPos = new THREE.Vector3();
  const focus = { override: null, sight: null, boss: null };
  const _f = new THREE.Vector3();

  function setAct(act) {
    const key = act === undefined || act === null ? 'title' : String(act);
    const P = PALETTES[key] ?? PALETTES.title;
    st.act = key;
    for (const k of COLOR_KEYS) tgt[k].set(P[k]);
    for (const k of NUM_KEYS) tgt[k] = P[k];
  }
  function snap() { for (const k of COLOR_KEYS) cur[k].copy(tgt[k]); for (const k of NUM_KEYS) cur[k] = tgt[k]; st.bossAct = st.act === 'boss' ? 1 : 0; }

  function pulse(strength = 1) {
    st.pulse = Math.min(2.5, st.pulse + strength);
    st.wave = 0; st.riftPulse = Math.min(2, st.riftPulse + strength * 0.7);
  }

  function update(dt, o = {}) {
    const k = damp(1.2, dt);
    const od = o.overdrive ? 1 : 0;
    st.overdrive += (od - st.overdrive) * damp(3, dt);
    for (const c of COLOR_KEYS) {
      base[c].copy(tgt[c]);
      if (st.overdrive > 0.001 && OVERDRIVE[c]) base[c].lerp(OVERDRIVE[c], st.overdrive * 0.75);
      cur[c].lerp(base[c], k);
    }
    for (const c of NUM_KEYS) cur[c] += (tgt[c] - cur[c]) * k;
    updateSunDir();
    st.intensity = o.intensity ?? st.intensity;
    // beat: a light automatic breath on every beat even without explicit pulses
    if (typeof o.beat === 'number') {
      const b = Math.floor(o.beat);
      if (b !== st.beatPrev) { if (st.beatPrev >= 0) { st.pulse = Math.max(st.pulse, 0.35); } st.beatPrev = b; }
    }
    st.pulse *= Math.exp(-dt * 5);
    st.riftPulse *= Math.exp(-dt * 3);
    st.wave += dt * 2.2;
    const u = skyMat.uniforms;
    u.uStars.value = cur.stars; u.uEclipse.value = cur.eclipse; u.uRays.value = cur.rays; u.uMoon.value = cur.moon;
    u.uSunSize.value = 0.085 - cur.eclipse * 0.025;
    key.intensity = cur.keyI;
    fog.color.copy(cur.fog);
    ink.copy(cur.cDeep).multiplyScalar(0.32);
    const t = time.value;
    const glow = 0.55 + st.overdrive * 0.6 + st.intensity * 0.25;
    runeInner.material.uniforms.uGlow.value = glow + st.pulse * 1.6;
    runeOuter.material.uniforms.uGlow.value = glow * 0.8 + st.pulse * 1.1;
    runeInner.material.uniforms.uRot.value = t * 0.08;
    runeOuter.material.uniforms.uRot.value = -t * 0.035;
    runeInner.material.uniforms.uWave.value = st.wave * 1.1;
    runeOuter.material.uniforms.uWave.value = st.wave * 0.5;
    crystalMat.uniforms.uGlow.value = 0.6 + st.pulse * 0.9 + st.overdrive;
    st.riftOpen += (st.riftOpenTgt - st.riftOpen) * damp(1.2, dt);
    riftMat.uniforms.uOpen.value = st.riftOpen;
    riftCrystals.visible = st.riftOpen > 0.05; riftCrystals.scale.setScalar(0.3 + st.riftOpen * 0.7);
    riftMat.uniforms.uPulse.value = st.riftPulse + st.intensity * 0.4 + st.overdrive * 0.5;
    riftShardMat.uniforms.uGlow.value = 0.4 + st.riftPulse;
    riftCrystals.rotation.z = t * 0.05;
    if (ctx.camera) { ctx.camera.getWorldPosition(camPos); sky.position.copy(camPos); shafts.position.copy(camPos).addScaledVector(sunDir, 280); }
    folU.uFolMix.value = cur.folMix;
    // prop clearing focus: the hero's chest (or an override), plus the boss weak point sightline while it stands
    if (focus.override) _f.copy(focus.override);
    else { const h = ctx.hero?.bones?.hips; if (h) { h.getWorldPosition(_f); _f.y += 0.3; } else _f.set(0, 1.2, 0); }
    fadeU.uFocus.value.set(_f.x, _f.y, _f.z, 1);
    const b = focus.boss;
    const bossUp = b && b.shown && (b.state === 'active' || b.state === 'dying');
    if (focus.sight) fadeU.uFocus2.value.set(focus.sight.x, focus.sight.y, focus.sight.z, 0.16);
    else if (bossUp) fadeU.uFocus2.value.set(b.weakPoint.x, b.weakPoint.y, b.weakPoint.z, 0.16);
    else fadeU.uFocus2.value.w = 0;
    // R2 (P2-4): while the Warden stands (fight, kill), near trees / islands that overlap its body dither out from any
    // camera (gameplay rear, boss, kill two-shot): a cone around the torso centre wide enough for the arms.
    st.bossAct += ((st.act === 'boss' ? 1 : 0) - st.bossAct) * damp(2.5, dt);
    if (Math.abs(st.bossAct - (st.act === 'boss' ? 1 : 0)) < 0.002) st.bossAct = st.act === 'boss' ? 1 : 0;
    fadeU.uBossAct.value = st.bossAct;
    if (bossUp) { const w = b.weakPoint; fadeU.uFocus3.value.set(w.x, w.y + 3, w.z, 0.2 * Math.min(1, (b.introT ?? 1) * 1.5 + 0.2)); }
    else fadeU.uFocus3.value.w = 0;
    shaftMat.uniforms.uI.value = 0.16 * cur.rays * (1 - cur.eclipse * 0.5);
    // petals: fewer embers early, more with intensity
    petalMat.uniforms.uWind.value.z = -1.6 - st.overdrive * 1.5;
  }

  function setQuality(qid) {
    puffs.geometry.instanceCount = qid === 'low' ? Math.min(26, puffMax) : puffMax;
    petals.geometry.instanceCount = Math.min(petalMax, qid === 'low' ? 220 : qid === 'medium' ? 450 : 800);
  }

  setAct('title'); snap();

  return {
    object, rift: RIFT_POS.clone(), setAct, pulse, update, snap, setQuality,
    /** 0 = closed slit, 1 = fully open (the boss closes it while it stands behind). */
    setRiftOpen(v) { st.riftOpenTgt = v; },
    /** Prop clearing: override the focus point (default: the hero's chest). null = back to the hero. */
    setFocus(v) { focus.override = v ? (focus.override ?? new THREE.Vector3()).copy(v) : null; },
    /** Prop clearing: extra sightline target kept clear (default: the boss weak point while it stands). */
    setSightline(v) { focus.sight = v ? (focus.sight ?? new THREE.Vector3()).copy(v) : null; },
    setBoss(b) { focus.boss = b; },
    /** Prop clearing: fade every near prop whose bounds come within r metres of pos (e.g. the cinematic camera
     *  position, or a point between camera and subject). setCameraClear(null) turns it off. Additive to the automatic
     *  camera / hero-line / boss-sightline clearing, which is always on. */
    setCameraClear(pos, r = 2.5) { if (pos) fadeU.uClear.value.set(pos.x, pos.y, pos.z, r); else fadeU.uClear.value.w = 0; },
    palette: cur, sunDir, fog,
    parts: { sky, sea, puffs, world, nearMesh, top, crystals, waterfalls, runeInner, runeOuter, petals, rift, riftCrystals },
    get act() { return st.act; },
    dispose() {
      object.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); const m = o.material; for (const v of Object.values(m.uniforms ?? {})) v.value?.isTexture && v.value.dispose(); m.map?.dispose(); m.dispose(); } });
      ramp.dispose();
      if (ctx.worldScene?.fog === fog) ctx.worldScene.fog = null;
    },
  };
}
