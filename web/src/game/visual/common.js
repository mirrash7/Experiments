// BREAKLIGHT visual helpers shared by the stage, spirits, boss and VFX (owner: VISUAL).
// Everything here is allocation-free per frame: pools are preallocated, simulation writes into typed arrays.
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const qualityId = (q) => {
  const p = q?.preset ?? q;
  const id = typeof p === 'string' ? p : p?.id;
  return id === 'low' || id === 'medium' ? id : 'high';
};

// ------------------------------------------------------------------------------------------------ GLSL chunks
export const NOISE_GLSL = /* glsl */`
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float h31(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y); }
float vnoise3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z); }
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < FBM_OCT; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return s; }
`;

// faceted crystal: flat normals from screen derivatives, 3-band toon facets, inner glow, fresnel rim, flash.
// aMat: 0 crystal (glowing), 1 armour (gold, matte toon + spec), 2 emissive (eyes / cores)
// aWig: (amplitude, phase) vertical wiggle for merged legs etc.
const CRYSTAL_VERT = /* glsl */`
attribute float aMat; attribute vec2 aWig;
uniform float uTime; uniform float uWigSpeed;
varying vec3 vView; varying float vMat; varying vec3 vObj;
void main(){
  vec3 p = position;
  p.y += sin(uTime * uWigSpeed + aWig.y) * aWig.x;
  vMat = aMat; vObj = position;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;
const CRYSTAL_FRAG = /* glsl */`
uniform vec3 uDeep; uniform vec3 uBright; uniform vec3 uRim; uniform vec3 uArmour; uniform vec3 uEmit;
uniform float uGlow; uniform float uFlash; uniform float uOpacity; uniform float uDissolve;
varying vec3 vView; varying float vMat; varying vec3 vObj;
float hsh(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main(){
  if (uDissolve > 0.0 && hsh(floor(vObj * 14.0)) < uDissolve) discard;
  vec3 N = normalize(cross(dFdx(vView), dFdy(vView)));
  vec3 V = normalize(-vView);
  float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
  float l = dot(N, normalize(vec3(-0.45, 0.75, 0.5)));
  float band = l > 0.3 ? 1.0 : (l > -0.15 ? 0.55 : 0.25);
  vec3 col;
  if (vMat < 0.5) {
    col = band > 0.9 ? uBright * 0.85 : (band > 0.5 ? mix(uDeep, uBright, 0.45) * 0.9 : uDeep * 1.1);
    col += uBright * pow(ndv, 8.0) * (0.25 + uGlow * 1.4);
    col += mix(uBright, uRim, 0.45) * smoothstep(0.6, 0.95, 1.0 - ndv) * (0.7 + uGlow * 1.5);
  } else if (vMat < 1.5) {
    col = uArmour * (band * 0.85 + 0.2);
    col += vec3(1.0, 0.92, 0.7) * step(0.82, l) * 0.9;          // hard toon spec
    col += uRim * pow(1.0 - ndv, 3.0) * 0.8;
  } else {
    col = uEmit * (2.0 + uGlow * 2.0);
  }
  col = mix(col, vec3(5.0, 4.8, 4.5), uFlash);
  gl_FragColor = vec4(col, uOpacity);
}`;

export function crystalMaterial({ deep = '#5a1a08', bright = '#ff8a2a', rim = '#ffd9a0', armour = '#e8b440', emit = '#ffffff', time, transparent = false, wigSpeed = 0 } = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: CRYSTAL_VERT, fragmentShader: CRYSTAL_FRAG, transparent,
    uniforms: {
      uDeep: { value: new THREE.Color(deep) }, uBright: { value: new THREE.Color(bright) }, uRim: { value: new THREE.Color(rim) },
      uArmour: { value: new THREE.Color(armour) }, uEmit: { value: new THREE.Color(emit) },
      uGlow: { value: 0 }, uFlash: { value: 0 }, uOpacity: { value: 1 }, uDissolve: { value: 0 },
      uTime: time ?? { value: 0 }, uWigSpeed: { value: wigSpeed },
    },
  });
}

/** Give a geometry the attributes the crystal shader needs (non-indexed, aMat / aWig). */
export function crystalGeo(g, mat = 0, wig = null) {
  const geo = g.index ? g.toNonIndexed() : g;
  const n = geo.attributes.position.count;
  geo.setAttribute('aMat', new THREE.BufferAttribute(new Float32Array(n).fill(mat), 1));
  const w = new Float32Array(n * 2);
  if (wig) for (let i = 0; i < n; i++) { w[2 * i] = wig[0]; w[2 * i + 1] = wig[1]; }
  geo.setAttribute('aWig', new THREE.BufferAttribute(w, 2));
  for (const k of Object.keys(geo.attributes)) if (!['position', 'aMat', 'aWig'].includes(k)) geo.deleteAttribute(k);
  return geo;
}

/** Merge position-only geometries (keeps aMat/aWig/color if all have them). */
export function mergeGeos(list) {
  const keys = Object.keys(list[0].attributes);
  let total = 0;
  for (const g of list) total += g.attributes.position.count;
  const out = new THREE.BufferGeometry();
  for (const k of keys) {
    const size = list[0].attributes[k].itemSize;
    const arr = new Float32Array(total * size);
    let o = 0;
    for (const g of list) { arr.set(g.attributes[k].array, o); o += g.attributes[k].array.length; }
    out.setAttribute(k, new THREE.BufferAttribute(arr, size));
  }
  out.computeBoundingSphere();
  return out;
}

// ink outline for crystal bodies: inverted hull on a welded (smooth-normal) copy of the geometry
const HULL_VERT = /* glsl */`
attribute vec2 aWig; uniform float uTime; uniform float uWigSpeed; uniform float uW;
void main(){
  vec3 p = position; p.y += sin(uTime * uWigSpeed + aWig.y) * aWig.x;
  p += normalize(normal) * uW;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const HULL_FRAG = /* glsl */`uniform vec3 uInk; void main(){ gl_FragColor = vec4(uInk, 1.0); }`;
const _hullGeo = new WeakMap();
export function hullGeometry(geo) {
  let h = _hullGeo.get(geo);
  if (!h) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', geo.attributes.position);
    if (geo.attributes.aWig) g.setAttribute('aWig', geo.attributes.aWig);
    h = mergeVertices(g, 1e-4); h.computeVertexNormals();
    _hullGeo.set(geo, h);
  }
  return h;
}
export function inkMaterial({ color = '#1a0a10', width = 0.025, time, wigSpeed = 0 } = {}) {
  return new THREE.ShaderMaterial({ vertexShader: HULL_VERT, fragmentShader: HULL_FRAG, side: THREE.BackSide,
    uniforms: { uInk: { value: new THREE.Color(color) }, uW: { value: width }, uTime: time ?? { value: 0 }, uWigSpeed: { value: wigSpeed } } });
}

// --------------------------------------------------------------------------------------- billboard glow sprite
// A single camera-facing quad: soft halo + hot core. Scale the mesh to size it (world metres = scale).
const PULL_GLSL = /* glsl */`
// perspective-invariant depth pull: scaling a view-space position toward the eye keeps its screen position (and,
// applied to the whole quad, its screen size) but moves its depth closer, so bursts draw over the hero's body.
vec3 pullView(vec3 mv, vec3 centre, float pull){ float d = length(centre); return pull > 0.0 ? mv * max(0.05, (d - pull) / max(d, 1e-3)) : mv; }
`;
const BILL_VERT = /* glsl */`
uniform float uPull;
varying vec2 vUv;
${PULL_GLSL}
void main(){
  vUv = position.xy * 2.0;
  float s = length(modelMatrix[0].xyz);
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec3 c = mv.xyz;
  mv.xy += position.xy * s;
  mv.xyz = pullView(mv.xyz, c, uPull);
  gl_Position = projectionMatrix * mv;
}`;
const HALO_FRAG = /* glsl */`
uniform vec3 uColor; uniform vec3 uCore; uniform float uIntensity; uniform float uCoreSize; uniform float uTime; uniform float uRays;
varying vec2 vUv;
void main(){
  float r = length(vUv);
  if (r > 1.0) discard;
  float halo = pow(1.0 - r, 2.2);
  float core = smoothstep(uCoreSize, uCoreSize * 0.55, r);
  float th = atan(vUv.y, vUv.x);
  float rays = uRays * pow(max(0.0, cos(th * 4.0 + uTime * 1.3)), 24.0) * (1.0 - r) * 1.2;
  // R2: the white-hot core saturates at 1.8x (tone-aware: big halos stay coloured instead of burning to white)
  vec3 col = uColor * (halo + rays) * uIntensity + uCore * core * min(1.0 + uIntensity * 0.6, 1.8);
  gl_FragColor = vec4(col, 1.0);
}`;
let _quad = null;
export const unitQuad = () => (_quad ??= new THREE.PlaneGeometry(1, 1));

export function haloMaterial({ color = '#ff8a2a', core = '#fff4d6', intensity = 1, coreSize = 0.22, rays = 0, time, pull = 0 } = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: BILL_VERT, fragmentShader: HALO_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(color) }, uCore: { value: new THREE.Color(core) }, uIntensity: { value: intensity },
      uCoreSize: { value: coreSize }, uTime: time ?? { value: 0 }, uRays: { value: rays }, uPull: { value: pull },
    },
  });
}
export function halo(opts) { const m = new THREE.Mesh(unitQuad(), haloMaterial(opts)); m.frustumCulled = false; m.renderOrder = 5; return m; }

// telegraph ring: closes from 3x to 1x as uT goes 0 -> 1, ticks rotate, flashes near the hit moment.
// uBill 1 = camera-facing, 0 = lies in the mesh's own plane (rotate the mesh flat for ground rings).
const RING_VERT = /* glsl */`
uniform float uBill; varying vec2 vUv;
void main(){
  vUv = position.xy * 2.0;
  if (uBill > 0.5) {
    float s = length(modelMatrix[0].xyz);
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * s;
    gl_Position = projectionMatrix * mv;
  } else gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const RING_FRAG = /* glsl */`
uniform vec3 uColor; uniform float uT; uniform float uTime; uniform float uOpacity; uniform float uStyle;
varying vec2 vUv;
void main(){
  float r = length(vUv);
  if (r > 1.0) discard;
  float th = atan(vUv.y, vUv.x);
  float rad = mix(0.98, 0.33, uT);                        // closing ring (unit = mesh half-size)
  float w = mix(0.018, 0.045, uT);
  float ring = smoothstep(w, 0.0, abs(r - rad));
  // ticks on the closing ring
  float ticks = step(0.86, cos(th * 4.0 - uTime * 2.0 - uT * 3.0)) * smoothstep(w * 3.5, 0.0, abs(r - rad - 0.05));
  // fixed target ring (where it lands)
  float target = smoothstep(0.012, 0.0, abs(r - 0.31)) * (0.35 + 0.65 * uT);
  float dash = step(0.0, sin(th * 12.0 + uTime * 0.7));
  target *= mix(1.0, dash, uStyle);
  float fill = smoothstep(0.31, 0.0, r) * uT * uT * 0.18;
  float flash = smoothstep(0.88, 1.0, uT);
  vec3 col = uColor * (ring * 2.2 + ticks * 2.0 + target * 1.4 + fill) + vec3(1.0) * flash * (ring + target) * 2.5;
  float a = clamp(ring + ticks + target + fill, 0.0, 1.0) * uOpacity * smoothstep(0.0, 0.12, uT + 0.02);
  gl_FragColor = vec4(col * a, a);
}`;
export function ringMaterial({ color = '#ff8a2a', bill = 1, style = 0, time } = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: RING_VERT, fragmentShader: RING_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(color) }, uT: { value: 0 }, uTime: time ?? { value: 0 }, uOpacity: { value: 1 }, uBill: { value: bill }, uStyle: { value: style } },
  });
}

// glow tube: additive cylinder that is bright where it faces the camera (beam body look)
const TUBE_VERT = /* glsl */`
varying vec3 vN; varying vec3 vV; varying vec2 vUv;
void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; vN = normalMatrix * normal; gl_Position = projectionMatrix * mv; }`;
const TUBE_FRAG = /* glsl */`
uniform vec3 uColor; uniform vec3 uCore; uniform float uIntensity; uniform float uTime; uniform float uScroll; uniform float uPow;
varying vec3 vN; varying vec3 vV; varying vec2 vUv;
void main(){
  float ndv = abs(dot(normalize(vN), normalize(vV)));
  float body = pow(ndv, uPow);
  float streak = 0.75 + 0.25 * sin(vUv.y * 40.0 - uTime * uScroll + sin(vUv.x * 6.283 * 3.0) * 2.0);
  float core = smoothstep(0.75, 0.97, ndv);
  vec3 col = (uColor * body * streak + uCore * core) * uIntensity;
  gl_FragColor = vec4(col, 1.0);
}`;
export function tubeMaterial({ color = '#ff3030', core = '#ffe0e0', intensity = 1, pow = 1.5, scroll = 8, time } = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: TUBE_VERT, fragmentShader: TUBE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(color) }, uCore: { value: new THREE.Color(core) }, uIntensity: { value: intensity }, uTime: time ?? { value: 0 }, uScroll: { value: scroll }, uPow: { value: pow } },
  });
}

// ------------------------------------------------------------------------------------- GlowPool (1 draw total)
// Additive camera-facing particles: 0 soft glow, 1 star burst, 2 ring, 3 streak spark, 4 diamond, 5 petal-ish shard
export const G = { glow: 0, star: 1, ring: 2, streak: 3, diamond: 4, cross: 5 };
const GP_VERT = /* glsl */`
attribute vec3 iPos; attribute vec3 iDir; attribute vec4 iColor; attribute vec4 iParam;  // size, stretch, rot, shape
attribute float iLife;
uniform float uPull;
varying vec2 vUv; varying vec4 vColor; varying float vShape; varying float vLife;
${PULL_GLSL}
void main(){
  vUv = position.xy * 2.0; vColor = iColor; vShape = iParam.w; vLife = iLife;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  vec2 c = position.xy * 2.0; float size = iParam.x; vec2 off;
  if (iParam.w > 2.5 && iParam.w < 3.5) {
    vec3 d = (modelViewMatrix * vec4(iDir, 0.0)).xyz;
    vec2 ax = length(d.xy) > 1e-5 ? normalize(d.xy) : vec2(1.0, 0.0); vec2 ay = vec2(-ax.y, ax.x);
    off = ax * c.x * size * iParam.y + ay * c.y * size * 0.16;
  } else { float r = iParam.z; vec2 cs = vec2(cos(r), sin(r)); off = vec2(c.x * cs.x - c.y * cs.y, c.x * cs.y + c.y * cs.x) * size; }
  vec3 c0 = mv.xyz;
  mv.xy += off;
  mv.xyz = pullView(mv.xyz, c0, uPull);
  gl_Position = projectionMatrix * mv;
}`;
const GP_FRAG = /* glsl */`
varying vec2 vUv; varying vec4 vColor; varying float vShape; varying float vLife;
void main(){
  vec2 p = vUv; float r = length(p); float a = 0.0; float core = 0.0;
  if (vShape < 0.5) { a = pow(max(0.0, 1.0 - r), 2.0); core = pow(max(0.0, 1.0 - r * 2.2), 2.0); }
  else if (vShape < 1.5) { float th = atan(p.y, p.x); float sp = 0.18 + 0.82 * pow(abs(cos(th * 2.0)), 18.0) + 0.45 * pow(abs(cos(th * 2.0 + 0.785)), 30.0);
    a = smoothstep(sp, sp * 0.6, r); core = smoothstep(0.3, 0.0, r); }
  else if (vShape < 2.5) { float w = 0.14 * (1.0 - vLife) + 0.02; a = smoothstep(w, 0.0, abs(r - (1.0 - w))); }
  else if (vShape < 3.5) { float d = abs(p.x) + abs(p.y) * 1.0; a = step(d, 1.0); core = step(d, 0.4); }
  else if (vShape < 4.5) { float d = abs(p.x) * 1.6 + abs(p.y); a = step(d, 1.0); core = step(d, 0.45); }
  else { float d = min(abs(p.x) * 6.0 + abs(p.y), abs(p.y) * 6.0 + abs(p.x)); a = smoothstep(1.0, 0.7, d); core = smoothstep(0.4, 0.1, d); }
  if (a < 0.01) discard;
  float fade = 1.0 - smoothstep(0.55, 1.0, vLife);
  vec3 col = vColor.rgb * a + vec3(1.0, 0.97, 0.9) * core * vColor.a;
  gl_FragColor = vec4(col * fade, 1.0);
}`;
const _c = new THREE.Color();
const _colorCache = new Map();
function cachedColor(c) { if (typeof c !== 'string') return c; let v = _colorCache.get(c); if (!v) { v = new THREE.Color(c); _colorCache.set(c, v); } return v; }
export class GlowPool {
  constructor(max = 256, { pull = 0 } = {}) {
    this.max = max;
    const g = new THREE.InstancedBufferGeometry();
    const q = unitQuad(); g.index = q.index; g.attributes.position = q.attributes.position;
    const mk = (n) => new THREE.InstancedBufferAttribute(new Float32Array(max * n), n).setUsage(THREE.DynamicDrawUsage);
    this.aPos = mk(3); this.aDir = mk(3); this.aColor = mk(4); this.aParam = mk(4); this.aLife = mk(1);
    g.setAttribute('iPos', this.aPos); g.setAttribute('iDir', this.aDir); g.setAttribute('iColor', this.aColor);
    g.setAttribute('iParam', this.aParam); g.setAttribute('iLife', this.aLife);
    g.instanceCount = 0; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.mat = new THREE.ShaderMaterial({ vertexShader: GP_VERT, fragmentShader: GP_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uPull: { value: pull } } });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 12; this.mesh.visible = false;
    this.alive = new Uint8Array(max); this.t = new Float32Array(max); this.life = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.drag = new Float32Array(max); this.grav = new Float32Array(max);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max); this.spin = new Float32Array(max); this.hdr = new Float32Array(max);
    this.top = 0; this.cursor = 0; this.scale = 1;
    // R2 flash budget (P1-5): sprites bigger than bigAt metres are capped (intensity <= bigI, white core <= bigCore) and
    // scaled by `flash` (1, or < 1 with settings.reduceFlashes) so stacked additive flashes can't blow out the frame.
    this.flash = 1; this.bigAt = 2.5; this.bigI = 1.5; this.bigCore = 0.3;
  }
  /** color may be a THREE.Color / hex; intensity multiplies (HDR); core = white-hot centre amount. */
  spawn(shape, x, y, z, vx, vy, vz, life, size, size1, color, intensity = 1, core = 0.6, drag = 3, grav = 0, rot = 0, spin = 0, stretch = 1) {
    let i = -1;
    for (let k = 0; k < this.max; k++) { const j = (this.cursor + k) % this.max; if (!this.alive[j]) { i = j; break; } }
    if (i < 0) return -1;
    this.cursor = (i + 1) % this.max;
    if (size1 > this.bigAt) {
      const f = this.flash;
      intensity = Math.min(intensity, this.bigI) * f; core = Math.min(core, this.bigCore) * f;
      if (f < 1) { size1 *= 0.6 + 0.4 * f; life *= 0.7 + 0.3 * f; }
    }
    this.alive[i] = 1; this.t[i] = 0; this.life[i] = life;
    this.vel[3 * i] = vx; this.vel[3 * i + 1] = vy; this.vel[3 * i + 2] = vz;
    this.drag[i] = drag; this.grav[i] = grav; this.s0[i] = size; this.s1[i] = size1; this.spin[i] = spin;
    const X = this.aPos.array; X[3 * i] = x; X[3 * i + 1] = y; X[3 * i + 2] = z;
    const D = this.aDir.array; D[3 * i] = vx; D[3 * i + 1] = vy; D[3 * i + 2] = vz;
    const cc = cachedColor(color); if (cc.isColor) _c.copy(cc); else _c.set(cc);
    const A = this.aColor.array; A[4 * i] = _c.r * intensity; A[4 * i + 1] = _c.g * intensity; A[4 * i + 2] = _c.b * intensity; A[4 * i + 3] = core;
    const P = this.aParam.array; P[4 * i] = size; P[4 * i + 1] = stretch; P[4 * i + 2] = rot; P[4 * i + 3] = shape;
    this.aLife.array[i] = 0;
    if (i + 1 > this.top) this.top = i + 1;
    return i;
  }
  update(dt) {
    const pos = this.aPos.array, dir = this.aDir.array, P = this.aParam.array, L = this.aLife.array, v = this.vel;
    let top = 0;
    for (let i = 0; i < this.top; i++) {
      if (!this.alive[i]) { P[4 * i] = 0; continue; }
      this.t[i] += dt;
      const u = this.t[i] / this.life[i];
      if (u >= 1) { this.alive[i] = 0; P[4 * i] = 0; L[i] = 1; continue; }
      const k = Math.exp(-this.drag[i] * dt);
      v[3 * i] *= k; v[3 * i + 1] = v[3 * i + 1] * k - this.grav[i] * dt; v[3 * i + 2] *= k;
      pos[3 * i] += v[3 * i] * dt; pos[3 * i + 1] += v[3 * i + 1] * dt; pos[3 * i + 2] += v[3 * i + 2] * dt;
      dir[3 * i] = v[3 * i]; dir[3 * i + 1] = v[3 * i + 1]; dir[3 * i + 2] = v[3 * i + 2];
      P[4 * i] = this.s0[i] + (this.s1[i] - this.s0[i]) * (1 - (1 - u) * (1 - u));
      P[4 * i + 2] += this.spin[i] * dt;
      L[i] = u; top = i + 1;
    }
    this.top = top;
    const g = this.mesh.geometry; g.instanceCount = top; this.mesh.visible = top > 0;
    if (top > 0) { this.aPos.needsUpdate = this.aDir.needsUpdate = this.aParam.needsUpdate = this.aLife.needsUpdate = this.aColor.needsUpdate = true; }
  }
  get active() { let n = 0; for (let i = 0; i < this.top; i++) n += this.alive[i]; return n; }
  clear() { this.alive.fill(0); this.top = 0; this.mesh.geometry.instanceCount = 0; this.mesh.visible = false; }
  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); }
}

// ---------------------------------------------------------------------------- ShardBurst (GPU-animated, 1 draw)
// Tumbling crystal shards: per-instance velocity / spin axis / size baked once; the vertex shader integrates
// position + rotation from uT, so a burst costs no CPU per frame beyond one uniform.
const SHARD_VERT = /* glsl */`
attribute vec3 aVel; attribute vec4 aAxis; attribute float aSize;
uniform float uT; uniform vec3 uOrigin; uniform vec3 uImpulse; uniform float uGrav; uniform float uScale; uniform float uSpeed; uniform float uDrag; uniform float uPull;
varying vec3 vView; varying float vSeed;
${PULL_GLSL}
vec3 rot(vec3 v, vec3 a, float ang){ float c = cos(ang), s = sin(ang); return v * c + cross(a, v) * s + a * dot(a, v) * (1.0 - c); }
void main(){
  vSeed = aAxis.w;
  float t = uT;
  float k = (1.0 - exp(-uDrag * t)) / uDrag;              // drag-integrated distance
  vec3 vel = (aVel + uImpulse) * uSpeed;
  vec3 c = uOrigin + vel * k - vec3(0.0, uGrav * t * t * 0.5, 0.0);
  float shrink = 1.0 - smoothstep(0.55, 1.0, t / 1.3);
  vec3 p = rot(position * aSize * uScale * shrink, normalize(aAxis.xyz), t * (4.0 + aAxis.w * 9.0) + aAxis.w * 6.0);
  vec4 mv = viewMatrix * vec4(c + p, 1.0);
  mv.xyz = pullView(mv.xyz, (viewMatrix * vec4(c, 1.0)).xyz, uPull);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;
const SHARD_FRAG = /* glsl */`
uniform vec3 uDeep; uniform vec3 uBright; uniform float uT; uniform float uHot;
varying vec3 vView; varying float vSeed;
void main(){
  vec3 N = normalize(cross(dFdx(vView), dFdy(vView)));
  vec3 V = normalize(-vView);
  float ndv = abs(dot(N, V));
  float l = dot(N, normalize(vec3(-0.45, 0.75, 0.5)));
  vec3 col = mix(uDeep, uBright, l > 0.2 ? 1.0 : 0.45) + uBright * pow(1.0 - ndv, 2.0) * 1.5;
  float hot = exp(-uT * 10.0) * uHot * 0.8;
  col = mix(col, vec3(3.0), hot) * (1.0 + 1.2 * step(0.94, fract(vSeed * 7.0 + uT * 2.0)));   // glints
  gl_FragColor = vec4(col, 1.0);
}`;
let _shardGeo = null;
function shardGeometry() {
  if (_shardGeo) return _shardGeo;
  // an elongated, slightly irregular bipyramid shard
  const g = new THREE.OctahedronGeometry(0.5, 0);
  g.scale(0.55, 1.25, 0.32);
  _shardGeo = g.index ? g.toNonIndexed() : g;
  _shardGeo.deleteAttribute('normal'); _shardGeo.deleteAttribute('uv');
  return _shardGeo;
}
export class ShardBurst {
  constructor(count = 24, { big = false } = {}) {
    this.count = count;
    const base = shardGeometry();
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', base.attributes.position);
    const vel = new Float32Array(count * 3), axis = new Float32Array(count * 4), size = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // random direction biased upward, varied speed
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      const sp = big ? 0.5 + Math.random() * 1.0 : 0.6 + Math.random() * 1.2;
      vel[3 * i] = s * Math.cos(th) * sp; vel[3 * i + 1] = (Math.abs(u) * 0.8 + 0.3) * sp; vel[3 * i + 2] = s * Math.sin(th) * sp;
      axis[4 * i] = Math.random() - 0.5; axis[4 * i + 1] = Math.random() - 0.5; axis[4 * i + 2] = Math.random() - 0.5; axis[4 * i + 3] = Math.random();
      size[i] = (big ? 0.5 : 0.35) + Math.random() * (big ? 1.2 : 0.75);
    }
    g.setAttribute('aVel', new THREE.InstancedBufferAttribute(vel, 3));
    g.setAttribute('aAxis', new THREE.InstancedBufferAttribute(axis, 4));
    g.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 1));
    g.instanceCount = count; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: SHARD_VERT, fragmentShader: SHARD_FRAG,
      uniforms: {
        uT: { value: 0 }, uOrigin: { value: new THREE.Vector3() }, uImpulse: { value: new THREE.Vector3() }, uGrav: { value: 9 },
        uScale: { value: 0.3 }, uSpeed: { value: 5 }, uDrag: { value: 1.6 }, uPull: { value: 0 }, uDeep: { value: new THREE.Color() }, uBright: { value: new THREE.Color() }, uHot: { value: 1 },
      },
    });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.visible = false;
    this.t = 0; this.life = 1.3; this.active = false;
  }
  fire(origin, impulse, deep, bright, { scale = 0.3, speed = 5, grav = 9, life = 1.3, count = this.count, hot = 1, drag = 1.6, pull = 0 } = {}) {
    const u = this.mat.uniforms;
    u.uOrigin.value.copy(origin); u.uImpulse.value.copy(impulse); u.uDeep.value.set(deep); u.uBright.value.set(bright);
    u.uPull.value = pull; u.uScale.value = scale; u.uSpeed.value = speed; u.uGrav.value = grav; u.uT.value = 0; u.uHot.value = hot; u.uDrag.value = drag;
    this.mesh.geometry.instanceCount = Math.min(count, this.count);
    this.t = 0; this.life = life; this.active = true; this.mesh.visible = true;
  }
  update(dt) {
    if (!this.active) return;
    this.t += dt; this.mat.uniforms.uT.value = this.t;
    if (this.t >= this.life) { this.active = false; this.mesh.visible = false; }
  }
  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); }
}

export class ShardPool {
  constructor(n, count, opts) { this.items = Array.from({ length: n }, () => new ShardBurst(count, opts)); this.group = new THREE.Group(); for (const b of this.items) this.group.add(b.mesh); this.i = 0; }
  fire(...a) {
    let b = this.items.find((x) => !x.active);
    if (!b) { b = this.items[this.i]; this.i = (this.i + 1) % this.items.length; }
    b.fire(...a); return b;
  }
  update(dt) { for (const b of this.items) b.update(dt); }
  get active() { let n = 0; for (const b of this.items) n += b.active ? 1 : 0; return n; }
  dispose() { for (const b of this.items) b.dispose(); }
}

// ------------------------------------------------------------------------------------------------ textures
export function canvasTex(size, draw, { srgb = true, repeat = false } = {}) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

export function toonRamp() {
  const t = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; return t;
}

/** Seeded RNG (mulberry32) so the stage looks identical every load. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const damp = (k, dt) => 1 - Math.exp(-k * dt);
