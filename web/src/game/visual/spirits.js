// BREAKLIGHT Glitch Spirits (owner: VISUAL). Pooled views; CORE positions view.object, the view animates itself.
//
//   type      look                                   origin (what CORE positions)       hitPoint offset
//   striker   orange faceted crystal wisp            centre (chest height)              (0, 0, 0)
//   crawler   cyan crystal beetle                    ground contact                     (0, 0.32, 0)
//   sweep     red low beam across the floor (X)      ground, beam centre                (0, 0.28, 0)
//   scythe    violet crescent beam (horizontal)      centre (head height)               (0, 0, 0)
//   volley    yellow spiked orb                      centre                             (0, 0, 0)
//   brute     gold armoured crystal spirit           ground contact (2.3 m tall)        (0, 1.3, 0)
//   core      white-gold orb with gyroscope rings    centre                             (0, 0, 0)
//
// A shatter is 1 draw (GPU-animated ShardBurst) + shared additive sprites (GlowPool, 1 draw for everything).
import * as THREE from 'three';
import { crystalMaterial, crystalGeo, mergeGeos, halo, hullGeometry, inkMaterial, ringMaterial, tubeMaterial, unitQuad, G, damp } from './common.js';

export const SPIRIT_STYLE = {
  striker: { deep: '#7a1c04', bright: '#ff8226', rim: '#ffe2a8', glow: '#ff7016', spark: '#ffb060', shards: 22, shardScale: 0.26 },
  crawler: { deep: '#03304e', bright: '#2cd6ff', rim: '#d0faff', glow: '#18b8ff', spark: '#a0f0ff', shards: 22, shardScale: 0.24 },
  sweep: { deep: '#560410', bright: '#ff2638', rim: '#ffc4c4', glow: '#ff1830', spark: '#ff8080', shards: 18, shardScale: 0.22 },
  scythe: { deep: '#26084e', bright: '#a24cff', rim: '#ead4ff', glow: '#9038ff', spark: '#d0a0ff', shards: 20, shardScale: 0.24 },
  volley: { deep: '#5a3c02', bright: '#ffd030', rim: '#fff6b8', glow: '#ffc010', spark: '#fff080', shards: 16, shardScale: 0.2 },
  brute: { deep: '#3a1604', bright: '#ff9418', rim: '#ffe6b0', glow: '#ffa818', spark: '#ffe090', shards: 32, shardScale: 0.42, armour: '#f2c254' },
  core: { deep: '#806030', bright: '#fff0c0', rim: '#ffffff', glow: '#ffe7a0', spark: '#ffffff', shards: 32, shardScale: 0.3 },
};
const HIT_OFFSET = { striker: [0, 0, 0], crawler: [0, 0.32, 0], sweep: [0, 0.28, 0], scythe: [0, 0, 0], volley: [0, 0, 0], brute: [0, 1.3, 0], core: [0, 0, 0] };
const KIND_SCALE = { perfect: 1.35, great: 1.1, good: 0.9 };

// ------------------------------------------------------------------------------------------- ribbon trail
const RIB_VERT = /* glsl */`attribute float aU; attribute float aSide; varying float vU; varying float vSide;
void main(){ vU = aU; vSide = aSide; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RIB_FRAG = /* glsl */`uniform vec3 uColor; uniform float uOpacity; varying float vU; varying float vSide;
void main(){ float across = 1.0 - abs(vSide); float a = pow(1.0 - vU, 1.6) * smoothstep(0.0, 0.6, across) * uOpacity;
  vec3 c = uColor * a * 2.2 + vec3(1.0, 0.95, 0.85) * smoothstep(0.7, 1.0, across) * pow(1.0 - vU, 3.0) * uOpacity * 1.5;
  gl_FragColor = vec4(c, 1.0); }`;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _t = new THREE.Vector3(), _s = new THREE.Vector3(), _cam = new THREE.Vector3();
class Ribbon {
  constructor(n, width, color) {
    this.n = n; this.width = width; this.pts = new Float32Array(n * 3); this.filled = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 6);
    const u = new Float32Array(n * 2), side = new Float32Array(n * 2), idx = [];
    for (let i = 0; i < n; i++) { u[2 * i] = u[2 * i + 1] = i / (n - 1); side[2 * i] = -1; side[2 * i + 1] = 1; }
    for (let i = 0; i < n - 1; i++) { const a = 2 * i; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aU', new THREE.BufferAttribute(u, 1)); g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({ vertexShader: RIB_VERT, fragmentShader: RIB_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: 1 } } });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 6;
  }
  reset(p) { for (let i = 0; i < this.n; i++) { this.pts[3 * i] = p.x; this.pts[3 * i + 1] = p.y; this.pts[3 * i + 2] = p.z; } }
  push(p, camPos) {
    this.pts.copyWithin(3, 0, (this.n - 1) * 3);
    this.pts[0] = p.x; this.pts[1] = p.y; this.pts[2] = p.z;
    const P = this.pts, n = this.n;
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      _t.set(P[3 * i0] - P[3 * i1], P[3 * i0 + 1] - P[3 * i1 + 1], P[3 * i0 + 2] - P[3 * i1 + 2]);
      _a.set(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
      _b.subVectors(camPos, _a);
      _s.crossVectors(_t, _b);
      const l = _s.length();
      const w = this.width * (1 - i / (n - 1) * 0.85);
      if (l > 1e-6) _s.multiplyScalar(w / l); else _s.set(0, w, 0);
      this.pos[6 * i] = _a.x - _s.x; this.pos[6 * i + 1] = _a.y - _s.y; this.pos[6 * i + 2] = _a.z - _s.z;
      this.pos[6 * i + 3] = _a.x + _s.x; this.pos[6 * i + 4] = _a.y + _s.y; this.pos[6 * i + 5] = _a.z + _s.z;
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
  }
}

// ------------------------------------------------------------------------------------------- geometry
let GEO = null;
function geos() {
  if (GEO) return GEO;
  const oct = (r, sx, sy, sz, mat = 0, wig = null) => { const g = crystalGeo(new THREE.OctahedronGeometry(r, 0), mat, wig); g.scale(sx, sy, sz); return g; };
  const cone = (r, h, seg, mat = 0, wig = null) => crystalGeo(new THREE.ConeGeometry(r, h, seg), mat, wig);
  const box = (x, y, z, mat = 1, wig = null) => crystalGeo(new THREE.BoxGeometry(x, y, z), mat, wig);
  // striker: elongated crystal + 4 satellite shards
  const strk = [oct(0.3, 0.85, 1.75, 0.85)];
  for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; const s = oct(0.12, 0.6, 1.6, 0.6); s.rotateZ(0.5); s.translate(Math.cos(a) * 0.48, (i % 2 ? 0.15 : -0.15), Math.sin(a) * 0.48); strk.push(s); }
  // crawler: low faceted carapace, back spikes, glowing eyes, wiggling legs (faces -Z, toward the hero)
  const cr = [];
  { const body = crystalGeo(new THREE.SphereGeometry(0.42, 7, 4), 0); body.scale(1, 0.5, 1.35); body.translate(0, 0.28, 0); cr.push(body); }
  for (let i = 0; i < 3; i++) { const s = cone(0.09, 0.42 - i * 0.06, 4); s.rotateX(0.5); s.translate(0, 0.52, 0.18 - i * 0.2); cr.push(s); }
  for (const x of [-0.12, 0.12]) { const e = oct(0.05, 1.4, 0.7, 1, 2); e.translate(x, 0.33, -0.52); cr.push(e); }
  for (let i = 0; i < 6; i++) {
    const side = i < 3 ? -1 : 1, k = i % 3;
    const l = box(0.38, 0.05, 0.05, 0, [0.06, k * 2.1 + (side > 0 ? 3.14 : 0)]);
    l.rotateZ(side * -0.5); l.translate(side * 0.42, 0.12, -0.25 + k * 0.28); cr.push(l);
  }
  // sweep emitters (beam itself is tubes)
  const sw = [];
  for (const x of [-3.6, 3.6]) { const e = oct(0.22, 0.8, 1.6, 0.8); e.translate(x, 0.28, 0); sw.push(e); const r = oct(0.1, 1, 1, 1, 2); r.translate(x, 0.28, 0); sw.push(r); }
  // volley: orb + 8 spikes
  const vo = [crystalGeo(new THREE.IcosahedronGeometry(0.2, 0), 0)];
  for (let i = 0; i < 8; i++) { const s = cone(0.06, 0.26, 4); s.translate(0, 0.28, 0); const a = (i / 8) * Math.PI * 2; s.rotateZ(a); s.rotateY(i % 2 ? 0.6 : -0.6); vo.push(s); }
  // brute torso (+ head, armour, horns); arms are separate meshes
  const bt = [];
  { const chest = oct(0.62, 0.95, 1.05, 0.62); chest.translate(0, 1.3, 0); bt.push(chest);
    const hips = oct(0.4, 1, 0.8, 0.8); hips.translate(0, 0.72, 0); bt.push(hips);
    const head = oct(0.24, 1, 1.2, 1); head.translate(0, 2.05, -0.05); bt.push(head);
    const helm = box(0.42, 0.16, 0.46); helm.translate(0, 2.18, -0.02); bt.push(helm);
    for (const x of [-0.08, 0.08]) { const e = oct(0.04, 1.6, 0.6, 1, 2); e.translate(x, 2.04, -0.26); bt.push(e); }
    for (const x of [-1, 1]) {
      const horn = cone(0.07, 0.5, 4); horn.rotateZ(-x * 0.6); horn.translate(x * 0.22, 2.38, 0); bt.push(horn);
      const pad = box(0.5, 0.22, 0.56); pad.rotateZ(x * 0.35); pad.translate(x * 0.62, 1.78, 0); bt.push(pad);
      const leg = oct(0.22, 0.9, 1.9, 0.9); leg.translate(x * 0.28, 0.32, 0); bt.push(leg);
      const greave = box(0.24, 0.3, 0.3); greave.translate(x * 0.28, 0.3, -0.04); bt.push(greave);
    }
    const plate = box(0.62, 0.5, 0.18); plate.translate(0, 1.38, -0.5); bt.push(plate);
    const gem = oct(0.1, 1, 1.3, 0.6, 2); gem.translate(0, 1.4, -0.6); bt.push(gem);
  }
  const arm = [];
  { const up = oct(0.18, 0.9, 2.2, 0.9); up.translate(0, -0.35, 0); arm.push(up);
    const gaunt = box(0.34, 0.4, 0.36); gaunt.translate(0, -0.78, 0); arm.push(gaunt);
    const fist = oct(0.24, 1, 1, 1); fist.translate(0, -1.02, 0); arm.push(fist);
    for (let i = 0; i < 3; i++) { const sp = cone(0.04, 0.18, 4, 1); sp.rotateX(-Math.PI / 2); sp.translate(-0.1 + i * 0.1, -0.95, -0.24); arm.push(sp); } }
  // core: inner crystal + gyroscope ring
  const coreIn = oct(0.2, 1, 1.3, 1);
  const ring = crystalGeo(new THREE.TorusGeometry(0.55, 0.025, 4, 48), 2);
  // scythe crescent
  const crescent = new THREE.TorusGeometry(2.4, 0.045, 6, 48, Math.PI * 0.8); crescent.rotateZ(Math.PI * 0.1); crescent.translate(0, -2.4 * 0.62, 0);
  const crescentGlow = new THREE.TorusGeometry(2.4, 0.22, 8, 48, Math.PI * 0.8); crescentGlow.rotateZ(Math.PI * 0.1); crescentGlow.translate(0, -2.4 * 0.62, 0);
  for (const g of [crescent, crescentGlow]) g.rotateX(Math.PI / 2);
  const scy = [oct(0.18, 0.8, 1.5, 0.8)];
  GEO = {
    striker: mergeGeos(strk), crawler: mergeGeos(cr), sweep: mergeGeos(sw), volley: mergeGeos(vo), bruteTorso: mergeGeos(bt), bruteArm: mergeGeos(arm),
    coreIn, ring, crescent, crescentGlow, scythe: mergeGeos(scy),
    beamCore: new THREE.CylinderGeometry(0.05, 0.05, 7.2, 8, 1, true).rotateZ(Math.PI / 2),
    beamGlow: new THREE.CylinderGeometry(0.3, 0.3, 7.2, 16, 1, true).rotateZ(Math.PI / 2),
    warn: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  };
  return GEO;
}

// ground warning stripe (sweep / scythe): chevrons that fill toward the hit moment
const WARN_VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const WARN_FRAG = /* glsl */`uniform vec3 uColor; uniform float uT; uniform float uTime; uniform float uStyle; varying vec2 vUv;
void main(){
  float edge = smoothstep(0.0, 0.08, vUv.y) * smoothstep(1.0, 0.92, vUv.y) * smoothstep(0.0, 0.04, vUv.x) * smoothstep(1.0, 0.96, vUv.x);
  float pat = uStyle < 0.5 ? step(0.5, fract(vUv.x * 9.0 + abs(vUv.y - 0.5) * 2.0 - uTime * 2.0)) : step(0.6, fract(vUv.y * 4.0 + uTime * 1.5));
  float border = 1.0 - step(0.1, vUv.y) * step(vUv.y, 0.9);
  float fill = step(abs(vUv.x - 0.5) * 2.0, uT);
  float a = edge * (border * 0.9 + pat * 0.45 * fill) * smoothstep(0.0, 0.15, uT);
  float flash = smoothstep(0.85, 1.0, uT);
  gl_FragColor = vec4((uColor * 1.6 + flash * 2.0) * a, 1.0);
}`;

// ------------------------------------------------------------------------------------------- view
class SpiritView {
  constructor(type, sys) {
    this.type = type; this.sys = sys; this.style = SPIRIT_STYLE[type];
    this.object = new THREE.Group(); this.object.name = 'spirit-' + type;
    this.inner = new THREE.Group(); this.object.add(this.inner);
    this.hitPoint = new THREE.Vector3(); this.side = 'center';
    this.state = 'free'; this.t = 0; this.tele = 0; this.outro = 0; this.outroKind = ''; this.flash = 0; this._frame = -1;
    this.offset = new THREE.Vector3(...HIT_OFFSET[type]);
    this.prev = new THREE.Vector3(); this.vel = new THREE.Vector3();
    this.mats = []; this.extra = {};
    const s = this.style, time = sys.time, g = geos();
    const cm = (o = {}) => { const m = crystalMaterial({ deep: s.deep, bright: s.bright, rim: s.rim, armour: s.armour ?? '#e8b440', emit: o.emit ?? s.rim, time, transparent: false, wigSpeed: o.wig ?? 0 }); this.mats.push(m); return m; };
    this.hulls = [];
    const add = (geo, mat, parent = this.inner) => {
      const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; parent.add(m);
      if (mat.uniforms?.uDissolve && geo.attributes.aMat) {
        this.ink ??= inkMaterial({ color: new THREE.Color(s.deep).multiplyScalar(0.25), width: type === 'brute' ? 0.04 : 0.03, time, wigSpeed: mat.uniforms.uWigSpeed.value });
        const h = new THREE.Mesh(hullGeometry(geo), this.ink); h.frustumCulled = false; parent.add(h); this.hulls.push(h);
      }
      return m;
    };
    // halo depth-pulled toward the camera so its white-hot core reads over the crystal body from any angle
    this.halo = halo({ color: s.glow, core: '#fff6e0', intensity: 1.2, coreSize: 0.2, time, rays: type === 'core' ? 1 : 0.4, pull: type === 'brute' ? 0.6 : 0.35 });
    this.ring = new THREE.Mesh(unitQuad(), ringMaterial({ color: s.glow, bill: 1, time }));
    this.ring.frustumCulled = false; this.ring.renderOrder = 7;
    this.object.add(this.halo, this.ring);
    this.ribbon = null;
    const flyer = type === 'striker' || type === 'volley' || type === 'core';
    switch (type) {
      case 'striker': this.body = add(g.striker, cm()); this.halo.scale.setScalar(1.5); this.ring.scale.setScalar(2.8); break;
      case 'volley': this.body = add(g.volley, cm()); this.halo.scale.setScalar(1.2); this.ring.scale.setScalar(2.3); break;
      case 'crawler':
        this.body = add(g.crawler, cm({ wig: 18, emit: '#ffffff' }));
        this.halo.scale.setScalar(1.3); this.halo.position.y = 0.32;
        this.ring.material.uniforms.uBill.value = 0; this.ring.rotation.x = -Math.PI / 2; this.ring.position.y = 0.03; this.ring.scale.setScalar(3.0);
        break;
      case 'sweep': {
        this.body = add(g.sweep, cm({ emit: '#ffffff' }));
        this.extra.core = add(g.beamCore, tubeMaterial({ color: s.bright, core: '#fff0f0', intensity: 2.6, pow: 0.6, scroll: 14, time }));
        this.extra.glow = add(g.beamGlow, tubeMaterial({ color: s.glow, core: '#ff8080', intensity: 1.0, pow: 2.2, scroll: 10, time }));
        this.extra.core.position.y = this.extra.glow.position.y = 0.28;
        this.extra.core.renderOrder = this.extra.glow.renderOrder = 6;
        this.halo.visible = false; this.ring.visible = false;
        this.warn = new THREE.Mesh(g.warn, new THREE.ShaderMaterial({ vertexShader: WARN_VERT, fragmentShader: WARN_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
          uniforms: { uColor: { value: new THREE.Color(s.glow) }, uT: { value: 0 }, uTime: time, uStyle: { value: 0 } } }));
        this.warn.scale.set(7.4, 1, 1.1); this.warn.frustumCulled = false; this.warn.renderOrder = 1;
        break;
      }
      case 'scythe': {
        this.body = add(g.scythe, cm({ emit: '#ffffff' }));
        this.extra.blade = new THREE.Group(); this.inner.add(this.extra.blade);
        this.extra.core = add(g.crescent, tubeMaterial({ color: s.bright, core: '#ffffff', intensity: 3.0, pow: 0.5, scroll: 6, time }), this.extra.blade);
        this.extra.glow = add(g.crescentGlow, tubeMaterial({ color: s.glow, core: '#e0c0ff', intensity: 1.1, pow: 2.0, scroll: 6, time }), this.extra.blade);
        this.extra.core.renderOrder = this.extra.glow.renderOrder = 6;
        this.halo.scale.setScalar(1.4); this.ring.visible = false;
        this.warn = new THREE.Mesh(g.warn, new THREE.ShaderMaterial({ vertexShader: WARN_VERT, fragmentShader: WARN_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
          uniforms: { uColor: { value: new THREE.Color(s.glow) }, uT: { value: 0 }, uTime: time, uStyle: { value: 1 } } }));
        this.warn.scale.set(5.2, 1, 1.4); this.warn.frustumCulled = false; this.warn.renderOrder = 1;
        break;
      }
      case 'brute': {
        const m = cm({ emit: '#fff4d0' });
        this.body = add(g.bruteTorso, m);
        this.extra.armL = new THREE.Group(); this.extra.armR = new THREE.Group();
        this.extra.armL.position.set(0.82, 1.72, 0); this.extra.armR.position.set(-0.82, 1.72, 0);
        add(g.bruteArm, m, this.extra.armL); add(g.bruteArm, m, this.extra.armR);
        this.inner.add(this.extra.armL, this.extra.armR);
        this.halo.position.y = 1.3; this.halo.scale.setScalar(3.2); this.halo.material.uniforms.uIntensity.value = 0.6;
        this.ring.position.y = 1.3; this.ring.scale.setScalar(4.2);
        break;
      }
      case 'core': {
        const m = cm({ emit: '#fff2c0' });
        m.uniforms.uDeep.value.set('#c09050'); m.uniforms.uBright.value.set('#fff4d0');
        this.body = add(g.coreIn, m);
        this.extra.rings = [0, 1, 2].map((i) => { const r = add(g.ring, m); r.rotation.set(i * 1.1, i * 0.7, 0); r.scale.setScalar(1 + i * 0.22); return r; });
        this.halo.scale.setScalar(2.6); this.halo.material.uniforms.uIntensity.value = 1.6; this.halo.material.uniforms.uCoreSize.value = 0.3;
        this.ring.scale.setScalar(4.4);
        break;
      }
    }
    if (flyer) { this.ribbon = new Ribbon(14, type === 'core' ? 0.22 : type === 'volley' ? 0.12 : 0.16, s.glow); }
  }

  // ---- contract
  setTelegraph(t) { this.tele = THREE.MathUtils.clamp(t, 0, 1); if (this.state !== 'free') this._syncHitPoint(); }
  /** Safe to call in addition to spirits.update(): each view ticks at most once per rendered frame. */
  update(dt) { const f = this.sys.frameId(); if (this._frame === f) return; this._frame = f; this._tick(dt); }

  hit(kind = 'good', dir = null) {
    if (this.state !== 'active') return;
    const s = this.style, k = KIND_SCALE[kind] ?? 1, sys = this.sys;
    this._syncHitPoint();
    const p = this.hitPoint;
    const imp = _imp.set(0, 0.4, 1);
    if (dir) imp.copy(dir).normalize();
    const big = this.type === 'brute' || this.type === 'core';
    sys.shards.fire(p, imp.multiplyScalar(big ? 0.6 : 0.9), s.deep, s.bright, {
      scale: s.shardScale * (0.9 + k * 0.15), speed: (big ? 6.5 : 5.2) * k, grav: 7, life: 1.25, count: s.shards, hot: 1, pull: 1.0 });
    const gp = sys.burst;
    const col = kind === 'perfect' ? '#fff0c0' : s.spark;
    gp.spawn(G.star, p.x, p.y, p.z, 0, 0, 0, 0.2, 0.15, (big ? 1.5 : 0.85) * k, col, 2.6, 1.0, 0, 0, Math.random() * 3);
    gp.spawn(G.glow, p.x, p.y, p.z, 0, 0, 0, 0.28, 0.3, (big ? 1.6 : 0.8) * k, s.glow, 1.0, 0.4, 0, 0);
    gp.spawn(G.ring, p.x, p.y, p.z, 0, 0, 0, 0.3, 0.1, (big ? 1.3 : 0.58) * k, s.bright, 1.8, 0, 0, 0);
    if (kind === 'perfect') gp.spawn(G.ring, p.x, p.y, p.z, 0, 0, 0, 0.42, 0.1, big ? 1.8 : 0.82, '#fff4d0', 1.4, 0, 0, 0);
    const n = Math.round((big ? 20 : 12) * k);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u), sp = 4 + Math.random() * 7 * k;
      gp.spawn(G.streak, p.x, p.y, p.z, (r * Math.cos(th) + imp.x * 0.6) * sp, (u * 0.8 + 0.3 + imp.y * 0.6) * sp, (r * Math.sin(th) + imp.z * 0.6) * sp,
        0.22 + Math.random() * 0.22, 0.08, 0.04, i % 3 ? s.spark : '#ffffff', 2.2, 0.8, 5, 6, 0, 0, 3.2);
    }
    sys.onHit?.(this, kind);
    this._beginOutro('hit', 0.05);
  }
  dodged() {
    if (this.state !== 'active') return;
    this._beginOutro('dodge', 0.5);
    this._syncHitPoint();
    const p = this.hitPoint, gp = this.sys.glow;
    for (let i = 0; i < 6; i++) gp.spawn(G.diamond, p.x, p.y, p.z, (Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2, 0.6, 0.08, 0.02, this.style.glow, 0.8, 0.2, 1, -0.5);
  }
  strikeHero() {
    if (this.state !== 'active') return;
    this._syncHitPoint();
    const p = this.hitPoint, gp = this.sys.burst, s = this.style;
    gp.spawn(G.star, p.x, p.y, p.z, 0, 0, 0, 0.18, 0.2, 1.0, '#ff4040', 2.6, 1.0, 0, 0, Math.random());
    gp.spawn(G.glow, p.x, p.y, p.z, 0, 0, 0, 0.3, 0.5, 1.4, '#ff2030', 1.2, 0.3, 0, 0);
    for (let i = 0; i < 10; i++) {
      const th = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 6;
      gp.spawn(G.streak, p.x, p.y, p.z, Math.cos(th) * sp, Math.sin(th) * sp, -2, 0.25, 0.12, 0.06, i % 2 ? s.spark : '#ff3a3a', 2.2, 0.6, 4, 3, 0, 0, 3);
    }
    this.flash = 1;
    this._beginOutro('strike', 0.3);
  }
  release() {
    if (this.state === 'free') return;
    if (this.state === 'outro') { this.outroRelease = true; return; } // auto-releases when the outro ends
    this._free();
  }

  // ---- optional extras (brute): non-final punch and a blocked hit
  impact(kind = 'good', dir = null) {
    if (this.state !== 'active') return;
    this._syncHitPoint();
    const p = this.hitPoint, gp = this.sys.burst, s = this.style;
    this.flash = 0.8; this.knock = 1;
    gp.spawn(G.star, p.x, p.y, p.z - 0.4, 0, 0, 0, 0.16, 0.15, 0.9, s.spark, 2.4, 1, 0, 0, Math.random() * 3);
    for (let i = 0; i < 8; i++) { const th = Math.random() * Math.PI * 2, sp = 5 + Math.random() * 6; gp.spawn(G.streak, p.x, p.y, p.z - 0.4, Math.cos(th) * sp, Math.sin(th) * sp, -3, 0.25, 0.12, 0.06, s.spark, 2.2, 0.8, 4, 4, 0, 0, 3); }
    this.sys.shards.fire(p, _imp.set(0, 0.5, dir ? Math.sign(dir.z || 1) : 1), s.deep, s.bright, { scale: 0.2, speed: 4, count: 8, life: 0.9, pull: 1.0 });
  }
  block() {
    if (this.state !== 'active') return;
    this._syncHitPoint();
    const p = this.hitPoint, gp = this.sys.burst;
    gp.spawn(G.ring, p.x, p.y, p.z - 0.8, 0, 0, 0, 0.3, 0.2, 1.2, '#a0e8ff', 2.2, 0, 0, 0);
    gp.spawn(G.cross, p.x, p.y, p.z - 0.8, 0, 0, 0, 0.2, 0.2, 1.0, '#d0f4ff', 2.0, 0.8, 0, 0, 0.785);
    this.knock = 0.6;
  }

  // ---- internals
  _syncHitPoint() { this.hitPoint.copy(this.object.position).add(this.offset); }
  _reset(opts) {
    this.state = 'active'; this.t = 0; this.tele = 0; this.outro = 0; this.outroKind = ''; this.flash = 0; this.knock = 0; this.outroRelease = false;
    this.side = opts.side ?? 'center';
    this.target = opts.target ?? null;
    this.react = !!opts.react; this.pop = this.react ? 0 : 1;
    this.inner.scale.setScalar(1); this.inner.rotation.set(0, 0, 0); this.inner.position.set(0, 0, 0);
    this.object.visible = true; this.inner.visible = true; this.halo.visible = this.type !== 'sweep';
    for (const h of this.hulls) h.visible = true;
    this.ring.visible = this.type !== 'sweep' && this.type !== 'scythe';
    for (const m of this.mats) { m.uniforms.uDissolve.value = 0; m.uniforms.uFlash.value = 0; m.uniforms.uOpacity.value = 1; m.uniforms.uGlow.value = 0; }
    this.halo.material.uniforms.uIntensity.value = this.type === 'brute' ? 0.6 : this.type === 'core' ? 1.6 : 1.2;
    this.ring.material.uniforms.uT.value = 0; this.ring.material.uniforms.uOpacity.value = 1;
    if (this.extra.core) this.extra.core.material.uniforms.uIntensity.value = this.type === 'scythe' ? 3.0 : 2.6;
    if (this.extra.glow) this.extra.glow.material.uniforms.uIntensity.value = 1.0;
    if (opts.position) this.object.position.copy(opts.position);
    this._syncHitPoint();
    this.prev.copy(this.object.position);
    if (this.ribbon) { this.ribbon.reset(this.hitPoint); this.ribbon.mat.uniforms.uOpacity.value = 1; this.sys.fxGroup.add(this.ribbon.mesh); }
    if (this.warn) { this.warn.material.uniforms.uT.value = 0; this.sys.fxGroup.add(this.warn); }
    const parent = opts.parent ?? this.sys.parent;
    if (parent && this.object.parent !== parent) parent.add(this.object);
    if (this.react) this._popIn();
  }
  /** Reaction-test spirit: appears on the spot with a deliberate "reflex check" tell (white flash, rings, pop). */
  _popIn() {
    const p = this.hitPoint, gp = this.sys.burst;
    this.flash = 1; this.inner.scale.setScalar(0.01);
    gp.spawn(G.star, p.x, p.y, p.z, 0, 0, 0, 0.22, 0.2, 1.4, '#ffffff', 3.0, 1, 0, 0, 0.4);
    gp.spawn(G.ring, p.x, p.y, p.z, 0, 0, 0, 0.3, 0.1, 1.1, '#ffffff', 2.4, 0, 0, 0);
    gp.spawn(G.ring, p.x, p.y, p.z, 0, 0, 0, 0.45, 0.05, 0.75, this.style.glow, 2.0, 0, 0, 0);
    for (let i = 0; i < 8; i++) { const th = (i / 8) * Math.PI * 2; gp.spawn(G.streak, p.x, p.y, p.z, Math.cos(th) * 6, Math.sin(th) * 6, 0, 0.18, 0.12, 0.05, '#ffffff', 2.4, 0.8, 6, 0, 0, 0, 3); }
  }
  _beginOutro(kind, dur) {
    this.state = 'outro'; this.outroKind = kind; this.outro = 0; this.outroDur = dur;
    for (const h of this.hulls) h.visible = false;
    if (kind === 'hit') { this.inner.visible = false; this.halo.visible = false; this.ring.visible = false; if (this.ribbon) this.ribbon.mat.uniforms.uOpacity.value = 0; }
    if (this.warn) this.warn.visible = kind !== 'hit';
  }
  _free() {
    this.state = 'free';
    this.object.parent?.remove(this.object);
    this.ribbon?.mesh.parent?.remove(this.ribbon.mesh);
    this.warn?.parent?.remove(this.warn);
    if (this.warn) this.warn.visible = true;
    this.sys._return(this);
  }
  _tick(dt) {
    if (this.state === 'free') return;
    this.t += dt;
    const t = this.t, s = this.sys, tele = this.tele;
    // velocity estimate (for orientation / trail)
    if (dt > 0) { this.vel.subVectors(this.object.position, this.prev).divideScalar(dt); }
    this.prev.copy(this.object.position);
    this._syncHitPoint();
    this.flash *= Math.exp(-dt * (this.pop < 1 ? 5 : 10));
    this.knock = (this.knock ?? 0) * Math.exp(-dt * 7);
    if (this.pop < 1 && this.state === 'active') {     // elastic pop: 0 -> 1.3 -> 1 over 0.35 s
      this.pop = Math.min(1, this.pop + dt / 0.35);
      const x = this.pop, e = 1 + Math.sin(x * Math.PI * 1.5) * (1 - x) * 0.9;
      this.popScale = Math.min(1, x * 3) * e;
    } else this.popScale = 1;
    const glow = tele * tele;
    for (const m of this.mats) { m.uniforms.uGlow.value = glow + Math.sin(t * 9) * 0.08 + 0.15; m.uniforms.uFlash.value = this.flash; }
    this.halo.material.uniforms.uIntensity.value = (this.type === 'brute' ? 0.5 : 1.0) + glow * 1.4 + this.flash * 2;
    const ring = this.ring.material.uniforms;
    ring.uT.value = tele; ring.uOpacity.value = tele >= 1 ? Math.max(0, ring.uOpacity.value - dt * 6) : 1;
    switch (this.type) {
      case 'striker': this.inner.rotation.y = t * 4.2; this.inner.rotation.z = Math.sin(t * 3) * 0.25; this.inner.position.y = Math.sin(t * 6) * 0.04; break;
      case 'volley': this.inner.rotation.y = t * 6; this.inner.rotation.x = t * 3.3; break;
      case 'crawler': {
        this.inner.position.y = Math.abs(Math.sin(t * 18)) * 0.03;
        this.inner.rotation.z = Math.sin(t * 18) * 0.05; break;
      }
      case 'sweep': {
        this.inner.rotation.y = Math.sin(t * 2.4) * 0.12;
        const fl = 0.85 + Math.sin(t * 47) * 0.1 + Math.sin(t * 23) * 0.08;
        this.extra.core.material.uniforms.uIntensity.value = (2.2 + glow * 2.2) * fl;
        this.extra.glow.material.uniforms.uIntensity.value = (0.8 + glow * 0.9) * fl;
        break;
      }
      case 'scythe': {
        this.extra.blade.rotation.y = Math.sin(t * 2.2) * 0.35 - tele * 0.4;
        this.body.rotation.y = t * 5;
        const fl = 0.9 + Math.sin(t * 37) * 0.1;
        this.extra.core.material.uniforms.uIntensity.value = (2.4 + glow * 2.5) * fl;
        this.extra.glow.material.uniforms.uIntensity.value = (0.9 + glow) * fl;
        break;
      }
      case 'brute': {
        const walk = Math.sin(t * 7);
        this.inner.position.y = Math.abs(walk) * 0.06;
        this.inner.rotation.z = walk * 0.04;
        this.inner.rotation.x = -this.knock * 0.25;
        this.inner.position.z = this.knock * 0.3;
        // telegraph: right arm (screen right = hero's right = -X) winds up overhead, fist glows
        const wind = THREE.MathUtils.smoothstep(tele, 0.15, 0.95);
        this.extra.armR.rotation.x = -wind * 2.6 + (tele >= 1 ? 1.6 : 0);
        this.extra.armR.rotation.z = -wind * 0.3;
        this.extra.armL.rotation.x = Math.sin(t * 7) * 0.3;
        this.extra.armL.rotation.z = 0.15;
        break;
      }
      case 'core': {
        this.body.rotation.y = t * 1.5;
        this.extra.rings[0].rotation.x = t * 1.7; this.extra.rings[1].rotation.y = t * 1.3; this.extra.rings[2].rotation.z = t * 2.1;
        this.extra.rings[2].rotation.x = 1.2;
        this.inner.position.y = Math.sin(t * 2) * 0.08;
        this.inner.scale.setScalar(1 + tele * 0.35 + Math.sin(t * 8) * 0.03 * tele);
        if (Math.random() < dt * 20) {
          const a = Math.random() * Math.PI * 2, r = 0.8 + Math.random() * 0.6, p = this.hitPoint;
          s.glow.spawn(G.cross, p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, p.z, -Math.cos(a) * 1.5, -Math.sin(a) * 1.5, 0, 0.5, 0.12, 0.02, '#fff0c0', 2, 0.8, 0.5, 0);
        }
        break;
      }
    }
    if (this.react && this.state === 'active' && this.type !== 'core') this.inner.scale.setScalar(this.popScale);
    if (this.warn) {
      const tz = this.target ? this.target.z : 0;
      this.warn.position.set(this.object.position.x, 0.025, tz);
      this.warn.material.uniforms.uT.value = tele;
    }
    if (this.ribbon && s.camPos) this.ribbon.push(this.hitPoint, s.camPos);
    if (this.state === 'outro') {
      this.outro += dt;
      const u = Math.min(1, this.outro / this.outroDur);
      if (this.outroKind === 'dodge') {
        for (const m of this.mats) { m.uniforms.uDissolve.value = u; }
        this.halo.material.uniforms.uIntensity.value *= (1 - u);
        this.inner.scale.setScalar(1 - u * 0.4);
        this.ring.visible = false;
        if (this.extra.core) { this.extra.core.material.uniforms.uIntensity.value *= (1 - u); this.extra.glow.material.uniforms.uIntensity.value *= (1 - u); }
        if (this.ribbon) this.ribbon.mat.uniforms.uOpacity.value = 1 - u;
        if (this.warn) this.warn.material.uniforms.uT.value = 0;
      } else if (this.outroKind === 'strike') {
        for (const m of this.mats) { m.uniforms.uFlash.value = 1 - u * 0.5; m.uniforms.uDissolve.value = u; }
        this.inner.scale.setScalar(1 + u * 0.6);
        this.halo.material.uniforms.uIntensity.value = 3 * (1 - u);
        this.ring.visible = false;
        if (this.extra.core) { this.extra.core.material.uniforms.uIntensity.value *= (1 - u); this.extra.glow.material.uniforms.uIntensity.value *= (1 - u); }
        if (this.ribbon) this.ribbon.mat.uniforms.uOpacity.value = 1 - u;
      }
      if (u >= 1) this._free();
    }
  }
}
const _imp = new THREE.Vector3();

// ------------------------------------------------------------------------------------------- system
export function createSpirits(ctx, shared) {
  const fxGroup = shared.worldFx;
  const pools = {}, active = new Set();
  const MAX_PER_TYPE = 12;
  const sys = {
    time: shared.time, glow: shared.worldGlow, burst: shared.burstGlow ?? shared.worldGlow, shards: shared.shards, fxGroup,
    parent: ctx.worldScene ?? null, frame: 0, camPos: new THREE.Vector3(),
    // frame id = the renderer's render counter (constant between two rendered frames), so CORE may call
    // view.update() and/or spirits.update() in any order without double-ticking
    frameId: () => (ctx.renderer ? ctx.renderer.info.render.frame : sys.frame),
    _return(v) { active.delete(v); (pools[v.type] ??= []).push(v); },
    onHit: null,
  };
  const TYPES = Object.keys(SPIRIT_STYLE);
  function create(type, opts = {}) {
    if (!SPIRIT_STYLE[type]) { console.warn('[visual] unknown spirit type', type); type = 'striker'; }
    const pool = (pools[type] ??= []);
    let v = pool.pop();
    if (!v) {
      let count = 0; for (const a of active) if (a.type === type) count++;
      if (count >= MAX_PER_TYPE) { // recycle the oldest of that type
        for (const a of active) if (a.type === type) { a._free(); v = pools[type].pop(); break; }
      } else v = new SpiritView(type, sys);
    }
    v._reset(opts);
    active.add(v);
    return v;
  }
  function update(dt) {
    if (ctx.camera) ctx.camera.getWorldPosition(sys.camPos);
    sys.frame++;
    for (const v of active) v.update(dt);
  }
  /** Prebuild pool entries (and compile their programs) so the first spawn doesn't hitch. */
  function warm(n = 2) {
    const tmp = [];
    for (const type of TYPES) for (let i = 0; i < n; i++) tmp.push(create(type, { position: new THREE.Vector3(0, -50, 0) }));
    return () => { for (const v of tmp) v.release(); };
  }
  return {
    create, update, warm, types: TYPES, active, sys,
    releaseAll() { for (const v of [...active]) v._free(); },
    dispose() {
      for (const v of [...active]) v._free();
      for (const list of Object.values(pools)) for (const v of list) { for (const m of v.mats) m.dispose(); v.halo.material.dispose(); v.ring.material.dispose(); v.ribbon?.mesh.geometry.dispose(); v.ribbon?.mat.dispose(); v.warn?.material.dispose(); }
    },
  };
}
