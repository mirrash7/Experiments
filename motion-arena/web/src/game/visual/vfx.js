// BREAKLIGHT hero VFX (owner: VISUAL): charge / overdrive aura, the Breaklight blast beam, shockwaves, 3D judgement
// flourishes and ground cue glyphs. Lives in heroScene (composited over the world with shared depth), so the aura
// wraps the hero correctly and the beam is still occluded by world geometry.
//
// Aura (R1): anime ki, not a tube. Soft additive flame cards on the FAR half-ring around the hero (computed per frame
// from the camera, so they always sit behind / beside the silhouette and never wash over the hero's own pixels), a
// soft back glow, noise-scrolled flame tongues, rising embers + streaks and a ground glow ring. Gold Overdrive variant
// (taller, faster, white-gold core, more sparks), detected from the colour or `{ mode: 'overdrive' }`.
// Blast (R1): white-hot core inside a coloured sheath, tapered (narrow at the hands, swelling to full width, flared at
// the far end), travelling distortion rings near the muzzle, and an impact flare at the target (opts.target, else the
// boss' weak point / a core spirit on the ray, else 160 m).
import * as THREE from 'three';
import { NOISE_GLSL, GlowPool, G, halo, damp } from './common.js';

// ---------------------------------------------------------------------------------------------- aura
// instanced quads: iCard = (angle on the far half ring, height scale, width scale, seed); card 0 = the back glow
const AURA_VERT = /* glsl */`
attribute vec4 iCard;
uniform vec3 uCenter; uniform vec3 uRight; uniform vec3 uBack; uniform float uH; uniform float uR; uniform float uTime; uniform float uStrength; uniform float uOD;
varying vec2 vUv; varying float vSeed; varying float vKind;
void main(){
  vSeed = iCard.w; vKind = iCard.y < 0.0 ? 1.0 : 0.0;
  vec2 c = position.xy + vec2(0.0, 0.5);            // x -0.5..0.5, y 0..1
  vUv = c;
  vec3 p;
  if (vKind > 0.5) {                                 // back glow: big soft oval just behind the hero
    float w = uH * 0.95 * (0.9 + uStrength * 0.25), h = uH * (1.25 + uOD * 0.25);
    p = uCenter + uBack * (uR * 0.9) + uRight * c.x * w + vec3(0.0, c.y * h - uH * 0.08, 0.0);
  } else {
    float a = iCard.x;                               // -1.2 .. 1.2 rad around the back
    vec3 off = uRight * sin(a) * uR + uBack * (cos(a) * uR * 0.75 + 0.06);
    float h = uH * iCard.y * (0.95 + 0.25 * sin(uTime * (3.0 + iCard.w * 2.0) + iCard.w * 20.0)) * (0.75 + uStrength * 0.3 + uOD * 0.05);
    float w = uH * 0.34 * iCard.z;
    // cards lean outward a little and sway: flame tongues licking up past the silhouette
    float lean = sin(a) * 0.35 + sin(uTime * 2.3 + iCard.w * 9.0) * 0.08;
    p = uCenter + off + uRight * (c.x * w + lean * c.y * c.y * h * 0.35) + vec3(0.0, c.y * h - 0.05, 0.0);
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const AURA_FRAG = /* glsl */`
#define FBM_OCT 3
uniform vec3 uColor; uniform vec3 uHot; uniform float uTime, uStrength, uOD;
varying vec2 vUv; varying float vSeed; varying float vKind;
${NOISE_GLSL}
void main(){
  vec2 uv = vUv;
  if (vKind > 0.5) {
    vec2 q = vec2(uv.x * 2.0, (uv.y - 0.45) * 1.7);
    float r = length(q);
    float n = fbm(vec2(uv.x * 3.0, uv.y * 2.0 - uTime * 1.2));
    float a = smoothstep(1.0, 0.1, r + (n - 0.5) * 0.35) * 0.5 * uStrength;
    gl_FragColor = vec4(uColor * a, 1.0);
    return;
  }
  float speed = 1.8 + uOD * 1.4;
  float n = fbm(vec2(uv.x * 3.2 + vSeed * 7.0, uv.y * 2.2 - uTime * speed));
  float n2 = vnoise(vec2(uv.x * 7.0 - vSeed * 3.0, uv.y * 5.0 - uTime * speed * 1.7));
  // tongue silhouette: wide at the base, pinching to a flickering tip, displaced sideways by noise
  float x = uv.x + (n - 0.5) * 0.7 * uv.y + sin(uv.y * 9.0 - uTime * 6.0 + vSeed * 20.0) * 0.05 * uv.y;
  float width = mix(0.36, 0.02, pow(uv.y, 0.75)) * (0.75 + n2 * 0.5);
  float body = smoothstep(width, width * 0.2, abs(x));
  float tip = smoothstep(1.0, 0.5 - n * 0.3, uv.y + n2 * 0.12);
  float base = smoothstep(0.0, 0.15, uv.y);
  float m = body * tip * base;
  float a = m * (0.75 + n2 * 0.5);
  float core = smoothstep(0.7, 1.0, m) * (1.0 - uv.y) * 0.8;
  vec3 col = (uColor * a * 1.5 + uHot * core) * (1.0 - uOD * 0.3);
  gl_FragColor = vec4(col * uStrength, 1.0);
}`;
const DISC_FRAG = /* glsl */`
uniform vec3 uColor; uniform float uTime, uStrength; varying vec2 vUv;
void main(){
  vec2 p = vUv * 2.0 - 1.0; float r = length(p); if (r > 1.0) discard;
  float th = atan(p.y, p.x);
  float ring = smoothstep(0.05, 0.0, abs(r - 0.62)) * 0.9 + smoothstep(0.02, 0.0, abs(r - 0.74)) * 0.5;
  float dash = step(0.35, fract(th * 6.0 / 3.14159 + uTime * 0.8)) * smoothstep(0.018, 0.0, abs(r - 0.54));
  float pool = pow(max(0.0, 1.0 - r / 0.8), 2.0) * 0.55;
  vec3 c = uColor * (ring * 1.4 + dash * 1.1 + pool) * uStrength;
  gl_FragColor = vec4(c, 1.0);
}`;
const PLANE_VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// ---------------------------------------------------------------------------------------------- beam
// cylinder along +Z (0..1), radius profile in world metres along the length: narrow at the hands -> full -> flared tip
const BEAM_VERT = /* glsl */`varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying float vDist;
uniform float uTime, uLen, uR, uRipple;
void main(){
  vUv = uv; vec3 p = position;
  float d = uv.y * uLen; vDist = d;
  float prof = mix(0.28, 1.0, smoothstep(0.0, 3.2, d)) * (1.0 + 0.18 * exp(-pow((d - 2.2) / 1.1, 2.0)));
  prof *= mix(1.0, 1.35, smoothstep(uLen - 6.0, uLen, d));
  prof *= 1.0 + uRipple * sin(d * 1.6 - uTime * 48.0);
  p.xy *= prof * uR;
  vec4 mv = modelViewMatrix * vec4(p, 1.0); vV = -mv.xyz; vN = normalMatrix * normal; gl_Position = projectionMatrix * mv; }`;
const BEAM_FRAG = /* glsl */`
#define FBM_OCT 2
uniform vec3 uColor; uniform float uTime, uLen, uI, uMode;
varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying float vDist;
${NOISE_GLSL}
void main(){
  float ndv = abs(dot(normalize(vN), normalize(vV)));
  float ends = smoothstep(0.0, 0.25, vDist) * (1.0 - smoothstep(uLen - 1.5, uLen, vDist));
  vec3 c;
  if (uMode < 0.5) {                                  // white-hot core
    float n = vnoise(vec2(vUv.x * 12.0, vDist * 0.5 - uTime * 40.0));
    c = mix(vec3(1.0, 0.97, 0.9), uColor, 0.22) * (pow(ndv, 3.0) * 1.7 + smoothstep(0.65, 0.9, n) * 0.4 * ndv) + uColor * 0.2 * ndv;
  } else {                                            // coloured sheath with streaming streaks
    float n = vnoise(vec2(vUv.x * 9.0 + uTime * 0.5, vDist * 0.22 - uTime * 26.0));
    float streak = smoothstep(0.45, 0.8, n);
    c = uColor * ndv * (0.22 + streak * 0.5);
  }
  gl_FragColor = vec4(c * uI * ends, 1.0);
}`;
// distortion-like rings travelling along the beam (instanced quads perpendicular to it)
const BRING_VERT = /* glsl */`attribute float iPhase; uniform float uTime, uLen, uR, uI; varying vec2 vUv; varying float vA;
void main(){ vUv = position.xy * 2.0;
  float ph = fract(uTime * 1.6 + iPhase);
  float z = 0.4 + ph * min(uLen, 26.0);
  float r = uR * (0.85 + ph * 1.1);
  vA = (1.0 - ph) * smoothstep(0.0, 0.08, ph) * uI * 0.45;
  vec3 p = vec3(position.xy * 2.0 * r, z);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`;
const BRING_FRAG = /* glsl */`uniform vec3 uColor; varying vec2 vUv; varying float vA;
void main(){ float r = length(vUv); float ring = smoothstep(0.1, 0.0, abs(r - 0.82)) + smoothstep(0.03, 0.0, abs(r - 0.92)) * 0.6;
  if (ring < 0.01) discard; gl_FragColor = vec4((uColor * 1.0 + vec3(0.22)) * ring * vA, 1.0); }`;
const SHOCK_FRAG = /* glsl */`uniform vec3 uColor; uniform float uP; varying vec2 vUv;
void main(){ vec2 p = vUv * 2.0 - 1.0; float r = length(p); float w = 0.05 + 0.1 * (1.0 - uP);
  float ring = smoothstep(w, 0.0, abs(r - uP)) ; float fill = smoothstep(uP, 0.0, r) * 0.25 * (1.0 - uP);
  float a = (ring * 1.8 + fill) * (1.0 - uP);
  gl_FragColor = vec4((uColor * 1.4 + vec3(0.35) * ring * (1.0 - uP)) * a, 1.0); }`;
const DOME_FRAG = /* glsl */`uniform vec3 uColor; uniform float uP; varying vec3 vN; varying vec3 vV;
void main(){ float ndv = abs(dot(normalize(vN), normalize(vV))); float a = pow(1.0 - ndv, 3.0) * (1.0 - uP) * (1.0 - uP) * 0.9; gl_FragColor = vec4(uColor * a, 1.0); }`;
const DOME_VERT = /* glsl */`varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; vN = normalMatrix * normal; gl_Position = projectionMatrix * mv; }`;

// ---------------------------------------------------------------------------------------------- ground cues
// a flat glyph at the hero's feet (in front of the toes) + a closing ring that lands at t = 1
const CUE_FRAG = /* glsl */`uniform sampler2D uTex; uniform vec3 uColor; uniform float uT, uA, uTime, uCell; varying vec2 vUv;
void main(){ vec2 p = vUv * 2.0 - 1.0; float r = length(p);
  vec2 tuv = vec2((vUv.x - 0.5) * 1.5 + 0.5, (vUv.y - 0.5) * 1.5 + 0.5);
  float g = 0.0; if (tuv.x > 0.0 && tuv.x < 1.0 && tuv.y > 0.0 && tuv.y < 1.0) g = texture2D(uTex, vec2((uCell + tuv.x) / 6.0, tuv.y)).r;
  float rad = mix(1.0, 0.62, uT); float ring = smoothstep(0.05, 0.0, abs(r - rad)) * (0.6 + 0.4 * uT);
  float target = smoothstep(0.02, 0.0, abs(r - 0.62)) * 0.6;
  float flash = smoothstep(0.85, 1.0, uT);
  float pulse = 0.75 + 0.25 * sin(uTime * 14.0);
  vec3 c = uColor * (g * (1.1 + flash) * pulse + ring * 1.6 + target) + vec3(1.0) * (g + ring) * flash * 1.2;
  gl_FragColor = vec4(c * uA * 1.8, 1.0); }`;
const CUE_STYLE = {
  jump: { cell: 0, color: '#ff4a4a' }, duck: { cell: 1, color: '#b06cff' }, guard: { cell: 2, color: '#ffb02a' },
  blast: { cell: 3, color: '#ffe7a0' }, dodgeL: { cell: 4, color: '#ffd030' }, dodgeR: { cell: 5, color: '#ffd030' },
};
function cueAtlas() {
  const W = 128, c = document.createElement('canvas'); c.width = W * 6; c.height = W;
  const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = g.fillStyle = '#fff'; g.lineWidth = 11; g.lineJoin = 'round'; g.lineCap = 'round';
  // canvas y is down; the decal is laid flat with its +V axis pointing away from the camera (toward the rift)
  const chev = (ox, y, up) => { g.beginPath(); g.moveTo(ox + 28, y + (up ? 18 : -18)); g.lineTo(ox + 64, y + (up ? -18 : 18)); g.lineTo(ox + 100, y + (up ? 18 : -18)); g.stroke(); };
  chev(0, 48, true); chev(0, 82, true);                                        // jump: double chevron up (away)
  chev(W, 46, false); chev(W, 80, false);                                      // duck: double chevron down (toward)
  { const ox = 2 * W; g.beginPath(); g.moveTo(ox + 64, 18); g.lineTo(ox + 104, 34); g.lineTo(ox + 98, 76); g.quadraticCurveTo(ox + 88, 100, ox + 64, 112); g.quadraticCurveTo(ox + 40, 100, ox + 30, 76); g.lineTo(ox + 24, 34); g.closePath(); g.stroke(); }
  { const ox = 3 * W; g.beginPath(); for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2, r = i % 2 ? 22 : 52; g.lineTo(ox + 64 + Math.cos(a) * r, 64 + Math.sin(a) * r); } g.closePath(); g.stroke(); g.beginPath(); g.arc(ox + 64, 64, 12, 0, Math.PI * 2); g.fill(); }
  const arrow = (ox, dir) => { g.beginPath(); g.moveTo(ox + 64 - dir * 40, 64); g.lineTo(ox + 64 + dir * 36, 64); g.moveTo(ox + 64 + dir * 8, 34); g.lineTo(ox + 64 + dir * 40, 64); g.lineTo(ox + 64 + dir * 8, 94); g.stroke(); };
  arrow(4 * W, -1); arrow(5 * W, 1);                                           // the decal's local +X = world -X (hero right)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.anisotropy = 4; return t;
}

const add = () => ({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
const JUDGE = {
  perfect: { color: '#ffd24a', ring: '#fff6d0', n: 14, size: 1.5 },
  great: { color: '#4ad8ff', ring: '#d8f6ff', n: 9, size: 1.15 },
  good: { color: '#7cff8a', ring: '#e0ffe4', n: 5, size: 0.85 },
  miss: { color: '#ff4a5a', ring: '#ff8a90', n: 0, size: 0.8 },
};
const CARDS = 11;

export function createVfx(ctx, shared) {
  const group = new THREE.Group(); group.name = 'BreaklightVfx';
  const time = shared.time;
  const glow = new GlowPool(384);                  // aura embers / beam sparks (depth-correct around the hero)
  const burst = shared.burstGlow ?? new GlowPool(256, { pull: 1.0 });   // judgement flourishes: pulled toward the camera
  group.add(glow.mesh); if (!shared.burstGlow) group.add(burst.mesh);

  // ---- aura
  const aura = new THREE.Group(); aura.name = 'aura'; aura.visible = false; group.add(aura);
  const auraU = {
    uColor: { value: new THREE.Color('#ffd040') }, uHot: { value: new THREE.Color('#fff6e0') }, uTime: time, uStrength: { value: 0 }, uOD: { value: 0 },
    uCenter: { value: new THREE.Vector3() }, uRight: { value: new THREE.Vector3(1, 0, 0) }, uBack: { value: new THREE.Vector3(0, 0, 1) }, uH: { value: 1.6 }, uR: { value: 0.36 },
  };
  const cardGeo = new THREE.InstancedBufferGeometry();
  { const q = new THREE.PlaneGeometry(1, 1); cardGeo.index = q.index; cardGeo.attributes.position = q.attributes.position; }
  const cardData = new Float32Array(CARDS * 4);
  cardData.set([0, -1, 1, 0], 0);   // back glow
  for (let i = 1; i < CARDS; i++) {
    const u = (i - 1) / (CARDS - 2);
    const a = (u - 0.5) * 2.5;      // -1.25 .. 1.25 rad around the back (sides reach the silhouette edges)
    cardData.set([a, 0.95 + (1 - Math.abs(u - 0.5) * 2) * 0.45 + ((i * 7) % 3) * 0.07, 0.85 + ((i * 5) % 4) * 0.12, (i * 0.618) % 1], i * 4);
  }
  cardGeo.setAttribute('iCard', new THREE.InstancedBufferAttribute(cardData, 4));
  cardGeo.instanceCount = CARDS; cardGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  const cards = new THREE.Mesh(cardGeo, new THREE.ShaderMaterial({ vertexShader: AURA_VERT, fragmentShader: AURA_FRAG, side: THREE.DoubleSide, uniforms: auraU, ...add() }));
  cards.frustumCulled = false; cards.renderOrder = 19; aura.add(cards);
  const disc = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({ vertexShader: PLANE_VERT, fragmentShader: DISC_FRAG, uniforms: auraU, ...add() }));
  disc.position.y = 0.02; disc.renderOrder = 18; aura.add(disc);
  const auraSt = { on: false, cur: 0, tgt: 0, color: new THREE.Color('#ffd040'), emit: 0, od: 0, odTgt: 0 };

  // ---- blast
  const blast = new THREE.Group(); blast.name = 'blast'; blast.visible = false; group.add(blast);
  const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 28, 64, true); beamGeo.rotateX(Math.PI / 2); beamGeo.translate(0, 0, 0.5);
  { const uv = beamGeo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i)); }
  const mkBeam = (color, mode, rad) => new THREE.ShaderMaterial({ vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, side: THREE.DoubleSide, ...add(),
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: time, uLen: { value: 100 }, uR: { value: rad }, uI: { value: 1 }, uMode: { value: mode }, uRipple: { value: mode ? 0.05 : 0.02 } } });
  const beamCore = new THREE.Mesh(beamGeo, mkBeam('#ffe0a0', 0, 0.26)); beamCore.frustumCulled = false; beamCore.renderOrder = 22;
  const beamOuter = new THREE.Mesh(beamGeo, mkBeam('#ff9a30', 1, 0.72)); beamOuter.frustumCulled = false; beamOuter.renderOrder = 21;
  blast.add(beamOuter, beamCore);
  const RINGS = 6;
  const ringGeo = new THREE.InstancedBufferGeometry();
  { const q = new THREE.PlaneGeometry(1, 1); ringGeo.index = q.index; ringGeo.attributes.position = q.attributes.position; }
  ringGeo.setAttribute('iPhase', new THREE.InstancedBufferAttribute(new Float32Array(Array.from({ length: RINGS }, (_, i) => i / RINGS)), 1));
  ringGeo.instanceCount = RINGS; ringGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  const ringMat = new THREE.ShaderMaterial({ vertexShader: BRING_VERT, fragmentShader: BRING_FRAG, side: THREE.DoubleSide, ...add(),
    uniforms: { uColor: { value: new THREE.Color('#ffd070') }, uTime: time, uLen: { value: 100 }, uR: { value: 1 }, uI: { value: 1 } } });
  const beamRings = new THREE.Mesh(ringGeo, ringMat); beamRings.frustumCulled = false; beamRings.renderOrder = 23; blast.add(beamRings);
  const muzzle = halo({ color: '#ffb040', core: '#ffe8b8', intensity: 2, coreSize: 0.3, rays: 0.6, time }); muzzle.renderOrder = 24; blast.add(muzzle);
  const impact = halo({ color: '#ff9a30', core: '#ffe2a8', intensity: 2, coreSize: 0.22, rays: 1, time }); impact.renderOrder = 24; impact.visible = false; group.add(impact);
  const discRing = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ vertexShader: PLANE_VERT, fragmentShader: SHOCK_FRAG, side: THREE.DoubleSide, ...add(),
    uniforms: { uColor: { value: new THREE.Color('#ffc050') }, uP: { value: 1 } } }));
  discRing.renderOrder = 23; discRing.frustumCulled = false; blast.add(discRing);
  const bl = { t: -1, dur: 1.15, len: 160, r: 1.0, dir: new THREE.Vector3(0, 0, 1), origin: new THREE.Vector3(), end: new THREE.Vector3(), hitTarget: false };

  // ---- shockwaves (pool of 4: ground ring + dome)
  const shocks = [];
  for (let i = 0; i < 4; i++) {
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({ vertexShader: PLANE_VERT, fragmentShader: SHOCK_FRAG, ...add(), uniforms: { uColor: { value: new THREE.Color('#ffd890') }, uP: { value: 1 } } }));
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.ShaderMaterial({ vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, side: THREE.DoubleSide, ...add(), uniforms: { uColor: { value: new THREE.Color('#ffd890') }, uP: { value: 1 } } }));
    ring.visible = dome.visible = false; ring.frustumCulled = dome.frustumCulled = false; ring.renderOrder = 18; dome.renderOrder = 18;
    group.add(ring, dome);
    shocks.push({ ring, dome, t: -1, dur: 0.7, size: 9 });
  }

  // ---- ground cues
  const cueTex = cueAtlas();
  const cues = {};
  for (const [kind, sty] of Object.entries(CUE_STYLE)) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({ vertexShader: PLANE_VERT, fragmentShader: CUE_FRAG, ...add(),
      uniforms: { uTex: { value: cueTex }, uColor: { value: new THREE.Color(sty.color) }, uT: { value: 0 }, uA: { value: 0 }, uTime: time, uCell: { value: sty.cell } } }));
    m.visible = false; m.frustumCulled = false; m.renderOrder = 17; m.scale.setScalar(1.15); group.add(m);
    cues[kind] = { mesh: m, t: 0, a: 0, age: 9, fired: false };
  }

  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _z = new THREE.Vector3(0, 0, 1), _hp = new THREE.Vector3(), _cam = new THREE.Vector3(), _c = new THREE.Color(), _hsl = {};
  const heroHeight = () => ctx.hero?.info?.height ?? 1.6;
  function heroPos(out) { const h = ctx.hero?.bones?.hips; if (h) h.getWorldPosition(out); else out.set(0, 0.9, 0); return out; }

  function setAura(on, { color = null, strength = 1, mode = null } = {}) {
    auraSt.on = !!on; auraSt.tgt = on ? THREE.MathUtils.clamp(strength, 0, 2) : 0;
    if (color != null) auraSt.color.set(color);
    // overdrive: explicit, or a saturated mid-value gold (CORE passes 0xffc840); pale gold / cyan = charge
    let od = mode === 'overdrive';
    if (mode == null && color != null) { auraSt.color.getHSL(_hsl); od = _hsl.h > 0.07 && _hsl.h < 0.17 && _hsl.l < 0.72 && _hsl.s > 0.6; }
    if (on) { auraSt.odTgt = od ? 1 : 0; aura.visible = true; }
  }

  // target along the ray: explicit, boss weak point, else the nearest core spirit within 2.5 m of the ray
  function findTarget(o, d) {
    const cands = [];
    if (shared.bossView?.shown && shared.bossView.state === 'active') cands.push([shared.bossView.weakPoint, 14]);
    for (const v of shared.spiritsActive?.() ?? []) if (v.type === 'core' && v.state === 'active') cands.push([v.hitPoint, 2.5]);
    let best = null, bestT = Infinity;
    for (const [p, tol] of cands) {
      _w.subVectors(p, o); const t = _w.dot(d); if (t < 1) continue;
      const perp = _w.addScaledVector(d, -t).length(); if (perp > tol + t * 0.05) continue;
      if (t < bestT) { bestT = t; best = p; }
    }
    return best ? bestT : null;
  }
  function fireBlast(origin, dir, { length = null, radius = 0.62, color = null, target = null } = {}) {
    bl.origin.copy(origin); bl.dir.copy(dir).normalize(); bl.r = radius; bl.t = 0;
    bl.dur = shared.reduceFlashes ? 0.85 : 1.15; bl.fk = shared.flashK ?? 1;
    let L = length;
    if (target) L = _v.subVectors(target, bl.origin).dot(bl.dir);
    if (L == null) L = findTarget(bl.origin, bl.dir);
    bl.hitTarget = L != null; bl.len = L ?? 160;
    bl.end.copy(bl.dir).multiplyScalar(bl.len).add(bl.origin);
    blast.position.copy(bl.origin);
    blast.quaternion.setFromUnitVectors(_z, bl.dir);
    if (color) { beamOuter.material.uniforms.uColor.value.set(color); ringMat.uniforms.uColor.value.set(color); }
    blast.visible = true;
    beamCore.material.uniforms.uLen.value = beamOuter.material.uniforms.uLen.value = ringMat.uniforms.uLen.value = bl.len;
    // muzzle burst
    const o = bl.origin;
    // R2 (P1-5): a coloured muzzle flare, not a white disc (it sits ~1 m from the side two-shot camera)
    const fk = bl.fk;
    glow.spawn(G.star, o.x, o.y, o.z, 0, 0, 0, 0.18, 0.2, 0.7 * (0.6 + 0.4 * fk), '#ffd890', 1.8 * fk, 0.45 * fk, 0, 0, 0.3);
    glow.spawn(G.ring, o.x, o.y, o.z, 0, 0, 0, 0.3, 0.2, 1.0 * (0.6 + 0.4 * fk), '#ffb040', 1.4 * fk, 0, 0, 0);
    for (let i = 0; i < Math.round(26 * (0.5 + 0.5 * fk)); i++) {
      const sp = 14 + Math.random() * 26;
      _v.set((Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5, 1).normalize();
      _v.applyQuaternion(blast.quaternion);
      glow.spawn(G.streak, o.x, o.y, o.z, _v.x * sp, _v.y * sp, _v.z * sp, 0.45 + Math.random() * 0.3, 0.07, 0.03, i % 3 ? '#ffd070' : '#ffffff', 2.4, 0.8, 1.2, 0, 0, 0, 9);
    }
    shared.trauma?.(0.7);
  }
  function shockwave(pos, { color = '#ffd890', size = 9, dur = 0.7 } = {}) {
    let s = shocks.find((x) => x.t < 0) ?? shocks.reduce((a, b) => (a.t > b.t ? a : b));
    s.t = 0; s.dur = dur; s.size = size;
    s.ring.position.set(pos.x, Math.max(0.03, pos.y < 0.5 ? pos.y + 0.03 : 0.03), pos.z);
    s.dome.position.set(pos.x, 0, pos.z);
    s.ring.material.uniforms.uColor.value.set(color); s.dome.material.uniforms.uColor.value.set(color);
    s.ring.visible = s.dome.visible = true;
    glow.spawn(G.glow, pos.x, Math.max(0.3, pos.y), pos.z, 0, 0, 0, 0.35, 1, 4, color, 1.5, 0.6, 0, 0);
  }
  function judgement(pos, kind = 'good') {
    const J = JUDGE[kind] ?? JUDGE.good;
    const p = pos;
    if (kind === 'miss') {
      burst.spawn(G.cross, p.x, p.y, p.z, 0, -0.6, 0, 0.6, 0.2, 0.55, J.color, 1.6, 0.3, 2, 2, 0.785);
      burst.spawn(G.ring, p.x, p.y, p.z, 0, 0, 0, 0.4, 0.2, 0.9, '#806070', 1.2, 0, 0, 0);
      return;
    }
    burst.spawn(G.ring, p.x, p.y, p.z, 0, 0, 0, 0.4, 0.08, 0.4 * J.size, J.ring, 1.8, 0, 0, 0);
    if (kind === 'perfect') {
      burst.spawn(G.star, p.x, p.y, p.z, 0, 0, 0, 0.3, 0.1, 0.7, J.color, 2.6, 1, 0, 0, 0, 2);
      burst.spawn(G.ring, p.x, p.y, p.z, 0, 0, 0, 0.5, 0.08, 0.62, J.color, 1.4, 0, 0, 0);
    }
    for (let i = 0; i < J.n; i++) {
      const th = (i / J.n) * Math.PI * 2 + Math.random() * 0.3, sp = 1.0 + Math.random() * 1.2;
      burst.spawn(i % 2 ? G.cross : G.diamond, p.x, p.y, p.z, Math.cos(th) * sp, Math.sin(th) * sp + 0.6, -0.3, 0.6 + Math.random() * 0.3, 0.09 * J.size, 0.03, i % 3 ? J.color : '#ffffff', 2.2, 0.8, 2.5, 1.5, th, 3);
    }
  }
  /**
   * Ground glyph prompt near the hero's feet. kind: 'jump'|'duck'|'guard'|'blast'|'dodgeL'|'dodgeR' (null clears all).
   * t: 0..1 progress to the move (call every frame from ~2 beats ahead; the ring closes and flashes at 1).
   * A cue fades out by itself ~0.25 s after the last call (or immediately after t >= 1 plays its flash).
   */
  function groundCue(kind, t = 0) {
    if (kind == null) { for (const c of Object.values(cues)) c.age = 9; return; }
    const c = cues[kind]; if (!c) return;
    c.t = THREE.MathUtils.clamp(t, 0, 1); c.age = 0; c.mesh.visible = true;
    if (c.t >= 1 && !c.fired) { c.fired = true; heroPos(_hp); burst.spawn(G.ring, _hp.x, 0.05, _hp.z + 0.85, 0, 0, 0, 0.35, 0.3, 1.2, c.mesh.material.uniforms.uColor.value, 2, 0, 0, 0); }
    if (c.t < 0.9) c.fired = false;
  }

  function update(dt) {
    const t = time.value;
    if (ctx.camera) ctx.camera.getWorldPosition(_cam);
    // aura
    auraSt.cur += (auraSt.tgt - auraSt.cur) * damp(auraSt.tgt > auraSt.cur ? 6 : 4, dt);
    auraSt.od += (auraSt.odTgt - auraSt.od) * damp(5, dt);
    if (aura.visible) {
      heroPos(_hp);
      const h = heroHeight();
      aura.position.set(_hp.x, 0, _hp.z);
      // camera-relative frame: right (horizontal) and back (away from the camera)
      const back = auraU.uBack.value.set(_hp.x - _cam.x, 0, _hp.z - _cam.z);
      if (back.lengthSq() < 1e-6) back.set(0, 0, 1); back.normalize();
      auraU.uRight.value.set(back.z, 0, -back.x);
      auraU.uCenter.value.set(_hp.x, 0, _hp.z);
      auraU.uH.value = h * (1.15 + auraSt.od * 0.06);
      auraU.uR.value = 0.42 + auraSt.od * 0.06;
      auraU.uStrength.value = auraSt.cur;
      auraU.uOD.value = auraSt.od;
      auraU.uColor.value.copy(auraSt.color);
      auraU.uHot.value.setRGB(1, 0.97, 0.88).lerp(_c.setRGB(1, 0.92, 0.6), auraSt.od);
      disc.scale.setScalar(0.9 + auraSt.od * 0.3 + Math.sin(t * 6) * 0.02);
      auraSt.emit += dt * (34 + auraSt.od * 40) * auraSt.cur;
      while (auraSt.emit > 1) {
        auraSt.emit -= 1;
        const a = Math.random() * Math.PI * 2, r = 0.2 + Math.random() * 0.35;
        const streak = Math.random() < 0.3 + auraSt.od * 0.3;
        const col = Math.random() < 0.25 ? '#fff4d8' : auraSt.color;
        if (streak) glow.spawn(G.streak, _hp.x + Math.cos(a) * r, 0.1 + Math.random() * h * 0.9, _hp.z + Math.sin(a) * r, 0, 2.6 + Math.random() * 2.5, 0, 0.35 + Math.random() * 0.25, 0.05, 0.02, col, 2.2, 0.8, 0.3, -1, 0, 0, 4);
        else glow.spawn(Math.random() < 0.5 ? G.diamond : G.glow, _hp.x + Math.cos(a) * r, Math.random() * 0.5, _hp.z + Math.sin(a) * r, (Math.random() - 0.5) * 0.4, 1.4 + Math.random() * 2.2, (Math.random() - 0.5) * 0.4, 0.7 + Math.random() * 0.6,
          0.035 + Math.random() * 0.04, 0.008, col, 2.4, 0.7, 0.4, -0.6, Math.random() * 3, 2);
      }
      if (auraSt.cur < 0.005 && !auraSt.on) aura.visible = false;
    }
    // blast
    if (bl.t >= 0) {
      bl.t += dt;
      const t1 = bl.t, d = bl.dur;
      let r;
      if (t1 < 0.07) r = (t1 / 0.07) * 1.2;
      else if (t1 < 0.2) r = 1.2 - (t1 - 0.07) / 0.13 * 0.2;
      else if (t1 < d - 0.35) r = 1 + Math.sin(t1 * 70) * 0.05 + Math.sin(t1 * 31) * 0.04;
      else r = Math.max(0, (d - t1) / 0.35);
      const grow = Math.min(1, t1 / 0.12), L = bl.len * grow;
      const R = bl.r * r;
      beamCore.scale.set(R, R, L); beamOuter.scale.set(R, R, L);
      beamCore.material.uniforms.uLen.value = beamOuter.material.uniforms.uLen.value = ringMat.uniforms.uLen.value = Math.max(0.5, L);
      const I = (1 + Math.max(0, 0.2 - t1) * 2.5) * (0.65 + 0.35 * (bl.fk ?? 1));
      beamCore.material.uniforms.uI.value = I; beamOuter.material.uniforms.uI.value = I * 0.85;
      ringMat.uniforms.uR.value = R * 1.1; ringMat.uniforms.uI.value = Math.min(1, r);
      muzzle.scale.setScalar(R * 0.8 + 0.2);
      muzzle.material.uniforms.uIntensity.value = (0.8 + 0.5 * r) * (bl.fk ?? 1);
      const p = Math.min(1, t1 / 0.5);
      discRing.scale.setScalar(0.4 + p * 2.4); discRing.material.uniforms.uP.value = p;
      discRing.position.set(0, 0, 0.6 + p * 2);
      if (Math.random() < dt * 60 * Math.min(1, r)) {
        const along = 2 + Math.random() * Math.min(30, L);
        _v.set((Math.random() - 0.5) * R * 3, (Math.random() - 0.5) * R * 3, along).applyQuaternion(blast.quaternion).add(bl.origin);
        _hp.copy(bl.dir).multiplyScalar(30 + Math.random() * 20);
        glow.spawn(G.streak, _v.x, _v.y, _v.z, _hp.x, _hp.y, _hp.z, 0.3, 0.08, 0.04, '#ffe0a0', 2.2, 0.6, 0.5, 0, 0, 0, 10);
      }
      // impact flare at the far end once the beam lands
      const landed = grow >= 1 && t1 < d - 0.1;
      impact.visible = landed;
      if (landed) {
        // R2 (P1-5): impact flare sized ~4-6 % of the distance and kept coloured, so it reads as a hit, not a white-out
        const fk = bl.fk ?? 1;
        const dist = _cam.distanceTo(bl.end), k = Math.max(1.5, dist * 0.05) * (bl.hitTarget ? 1.2 : 0.8) * (0.6 + 0.4 * fk);
        impact.position.copy(bl.end); impact.scale.setScalar(k * (1.5 + Math.sin(t1 * 40) * 0.2) * Math.min(1, r));
        impact.material.uniforms.uIntensity.value = 1.3 * Math.min(1, r) * fk;
        if (Math.random() < dt * 12 * fk) {
          glow.spawn(Math.random() < 0.5 ? G.star : G.ring, bl.end.x, bl.end.y, bl.end.z, 0, 0, 0, 0.25, k * 0.25, k * 1.0, Math.random() < 0.5 ? '#ffd890' : '#ff9a40', 1.6, 0.4, 0, 0, Math.random() * 3);
          const th = Math.random() * Math.PI * 2, sp = k * 8;
          glow.spawn(G.streak, bl.end.x, bl.end.y, bl.end.z, Math.cos(th) * sp, Math.sin(th) * sp, -bl.dir.z * sp * 0.3, 0.35, k * 0.25, k * 0.08, '#ffe0a0', 2.4, 0.8, 1.5, 0, 0, 0, 6);
        }
      }
      if (t1 >= d) { bl.t = -1; blast.visible = false; impact.visible = false; }
    }
    // shockwaves
    for (const s of shocks) {
      if (s.t < 0) continue;
      s.t += dt; const p = Math.min(1, s.t / s.dur);
      const e = 1 - Math.pow(1 - p, 3);
      s.ring.scale.setScalar(s.size * 0.5 * (0.15 + e * 0.85) + 0.01); s.ring.material.uniforms.uP.value = e;
      s.dome.scale.set(s.size * 0.32 * e + 0.01, s.size * 0.2 * e + 0.01, s.size * 0.32 * e + 0.01); s.dome.material.uniforms.uP.value = Math.min(1, p * 1.4);
      if (p >= 1) { s.t = -1; s.ring.visible = s.dome.visible = false; }
    }
    // ground cues: in front of the toes, oriented so the glyph's "up" points away from the camera
    let anyCue = false;
    for (const c of Object.values(cues)) {
      if (!c.mesh.visible) continue;
      c.age += dt;
      const want = c.age < 0.25 && !(c.fired && c.age > 0.12) ? 1 : 0;
      c.a += (want - c.a) * damp(want ? 14 : 8, dt);
      if (c.a < 0.01 && !want) { c.mesh.visible = false; continue; }
      anyCue = true;
      heroPos(_hp);
      c.mesh.position.set(_hp.x, 0.025, _hp.z + 0.85);
      c.mesh.rotation.y = Math.atan2(_hp.x - _cam.x, _hp.z - _cam.z) - Math.PI;
      c.mesh.material.uniforms.uT.value = c.t; c.mesh.material.uniforms.uA.value = c.a;
    }
    void anyCue;
    glow.update(dt);
    if (!shared.burstGlow) burst.update(dt);
  }

  return {
    group, glow, burst,
    api: { aura: setAura, blast: fireBlast, judgement, shockwave, groundCue, update },
    get blasting() { return bl.t >= 0; },
    dispose() { cueTex.dispose(); group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } }); },
  };
}
