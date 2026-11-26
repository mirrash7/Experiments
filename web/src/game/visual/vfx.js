// BREAKLIGHT hero VFX (owner: VISUAL): charge / overdrive aura, the Breaklight blast beam, shockwaves and 3D
// judgement flourishes. Lives in heroScene (composited over the world with shared depth), so the aura wraps the
// hero correctly from the rear camera and the beam is still occluded by world geometry.
import * as THREE from 'three';
import { NOISE_GLSL, GlowPool, G, halo, damp } from './common.js';

const AURA_VERT = /* glsl */`varying vec2 vUv; varying vec3 vN; varying vec3 vV;
uniform float uTime;
void main(){ vUv = uv; vec3 p = position; float w = sin(uv.x * 25.13 + uTime * 3.0) * 0.03 * uv.y; p.xz *= 1.0 + w + uv.y * 0.15;
  vec4 mv = modelViewMatrix * vec4(p, 1.0); vV = -mv.xyz; vN = normalMatrix * normal; gl_Position = projectionMatrix * mv; }`;
const AURA_FRAG = /* glsl */`
#define FBM_OCT 2
uniform vec3 uColor; uniform float uTime, uStrength;
varying vec2 vUv; varying vec3 vN; varying vec3 vV;
${NOISE_GLSL}
void main(){
  float ndv = abs(dot(normalize(vN), normalize(vV)));
  float edge = pow(1.0 - ndv, 1.4);
  float y = vUv.y;
  float n = fbm(vec2(vUv.x * 9.0, y * 2.4 - uTime * 2.6));
  float tongue = n - y * 0.75 + 0.18;
  float flame = smoothstep(0.0, 0.04, tongue);
  float inner = smoothstep(0.18, 0.24, tongue);
  float a = flame * (0.05 + edge * edge * 1.3) * smoothstep(0.0, 0.06, y) * uStrength;
  vec3 c = uColor * a * 1.8 + vec3(1.0, 0.97, 0.9) * inner * edge * uStrength * 1.2;
  gl_FragColor = vec4(c, 1.0);
}`;
const DISC_FRAG = /* glsl */`
uniform vec3 uColor; uniform float uTime, uStrength; varying vec2 vUv;
void main(){
  vec2 p = vUv * 2.0 - 1.0; float r = length(p); if (r > 1.0) discard;
  float th = atan(p.y, p.x);
  float ring = smoothstep(0.03, 0.0, abs(r - 0.82)) + smoothstep(0.015, 0.0, abs(r - 0.92)) * 0.7;
  float dash = step(0.3, fract(th * 6.0 / 3.14159 + uTime * 0.8)) * smoothstep(0.02, 0.0, abs(r - 0.72));
  float spokes = pow(max(0.0, cos(th * 8.0 - uTime * 2.0)), 30.0) * smoothstep(0.82, 0.3, r) * smoothstep(0.1, 0.35, r);
  float pool = pow(1.0 - r, 2.0) * 0.6;
  vec3 c = uColor * (ring * 2.0 + dash * 1.5 + spokes * 0.8 + pool) * uStrength;
  gl_FragColor = vec4(c, 1.0);
}`;
const PLANE_VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const BEAM_VERT = /* glsl */`varying vec2 vUv; varying vec3 vN; varying vec3 vV; uniform float uTime, uLen, uRipple;
void main(){ vUv = uv; vec3 p = position; p.xy *= 1.0 + uRipple * sin(uv.y * uLen * 0.6 - uTime * 50.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0); vV = -mv.xyz; vN = normalMatrix * normal; gl_Position = projectionMatrix * mv; }`;
const BEAM_FRAG = /* glsl */`
#define FBM_OCT 2
uniform vec3 uColor; uniform float uTime, uLen, uI, uMode;
varying vec2 vUv; varying vec3 vN; varying vec3 vV;
${NOISE_GLSL}
void main(){
  float ndv = abs(dot(normalize(vN), normalize(vV)));
  float tip = smoothstep(0.0, 0.004, vUv.y) * (1.0 - smoothstep(0.9, 1.0, vUv.y));
  vec3 c;
  if (uMode < 0.5) {
    float n = vnoise(vec2(vUv.x * 10.0, vUv.y * uLen * 0.35 - uTime * 40.0));
    float streak = smoothstep(0.5, 0.85, n);
    float core = smoothstep(0.45, 0.92, ndv);
    c = uColor * pow(ndv, 0.7) * (1.2 + streak * 1.6) + vec3(1.0, 0.98, 0.94) * core * 4.0;
  } else {
    float n = vnoise(vec2(vUv.x * 6.0 + uTime, vUv.y * uLen * 0.15 - uTime * 25.0));
    c = uColor * pow(ndv, 2.2) * (0.7 + n * 0.6);
  }
  gl_FragColor = vec4(c * uI * tip, 1.0);
}`;
const SPIRAL_FRAG = /* glsl */`uniform vec3 uColor; uniform float uTime, uI; varying vec2 vUv;
void main(){ float d = step(0.45, fract(vUv.x * 60.0 - uTime * 9.0)); float tip = 1.0 - smoothstep(0.85, 1.0, vUv.x);
  gl_FragColor = vec4((uColor * 2.0 + vec3(0.8)) * d * uI * tip, 1.0); }`;
const SHOCK_FRAG = /* glsl */`uniform vec3 uColor; uniform float uP; varying vec2 vUv;
void main(){ vec2 p = vUv * 2.0 - 1.0; float r = length(p); float w = 0.05 + 0.1 * (1.0 - uP);
  float ring = smoothstep(w, 0.0, abs(r - uP)) ; float fill = smoothstep(uP, 0.0, r) * 0.25 * (1.0 - uP);
  float a = (ring * 1.8 + fill) * (1.0 - uP);
  gl_FragColor = vec4((uColor * 1.6 + vec3(1.0) * ring * (1.0 - uP)) * a, 1.0); }`;
const DOME_FRAG = /* glsl */`uniform vec3 uColor; uniform float uP; varying vec3 vN; varying vec3 vV;
void main(){ float ndv = abs(dot(normalize(vN), normalize(vV))); float a = pow(1.0 - ndv, 3.0) * (1.0 - uP) * (1.0 - uP) * 0.9; gl_FragColor = vec4(uColor * a, 1.0); }`;
const DOME_VERT = /* glsl */`varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; vN = normalMatrix * normal; gl_Position = projectionMatrix * mv; }`;

const add = () => ({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
const JUDGE = {
  perfect: { color: '#ffd24a', ring: '#fff6d0', n: 14, size: 1.5 },
  great: { color: '#4ad8ff', ring: '#d8f6ff', n: 9, size: 1.15 },
  good: { color: '#7cff8a', ring: '#e0ffe4', n: 5, size: 0.85 },
  miss: { color: '#ff4a5a', ring: '#ff8a90', n: 0, size: 0.8 },
};

export function createVfx(ctx, shared) {
  const group = new THREE.Group(); group.name = 'BreaklightVfx';
  const time = shared.time;
  const glow = new GlowPool(384);
  group.add(glow.mesh);

  // ---- aura
  const aura = new THREE.Group(); aura.name = 'aura'; aura.visible = false; group.add(aura);
  const auraU = { uColor: { value: new THREE.Color('#ffd040') }, uTime: time, uStrength: { value: 0 } };
  const shellGeo = new THREE.CylinderGeometry(0.55, 0.42, 1, 32, 1, true); shellGeo.translate(0, 0.5, 0);
  const shell = new THREE.Mesh(shellGeo, new THREE.ShaderMaterial({ vertexShader: AURA_VERT, fragmentShader: AURA_FRAG, side: THREE.DoubleSide, uniforms: auraU, ...add() }));
  shell.renderOrder = 20; shell.frustumCulled = false; aura.add(shell);
  const disc = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({ vertexShader: PLANE_VERT, fragmentShader: DISC_FRAG, uniforms: auraU, ...add() }));
  disc.position.y = 0.02; disc.renderOrder = 19; aura.add(disc);
  const auraSt = { on: false, cur: 0, tgt: 0, color: new THREE.Color('#ffd040'), emit: 0 };

  // ---- blast
  const blast = new THREE.Group(); blast.name = 'blast'; blast.visible = false; group.add(blast);
  const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 28, 1, true); beamGeo.rotateX(Math.PI / 2); beamGeo.translate(0, 0, 0.5);
  // CylinderGeometry uv.y runs along the height (now +Z after rotation): flip so 0 = origin end
  { const uv = beamGeo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i)); }
  const mkBeam = (color, mode) => new THREE.ShaderMaterial({ vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, side: THREE.DoubleSide, ...add(),
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: time, uLen: { value: 100 }, uI: { value: 1 }, uMode: { value: mode }, uRipple: { value: mode ? 0.08 : 0.03 } } });
  const beamCore = new THREE.Mesh(beamGeo, mkBeam('#ffcf5a', 0)); beamCore.frustumCulled = false; beamCore.renderOrder = 22;
  const beamOuter = new THREE.Mesh(beamGeo, mkBeam('#ff8a2a', 1)); beamOuter.frustumCulled = false; beamOuter.renderOrder = 21;
  blast.add(beamOuter, beamCore);
  const helix = (phase) => {
    const pts = []; for (let i = 0; i <= 240; i++) { const t = i / 240; const a = t * Math.PI * 2 * 14 + phase; pts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), t)); }
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 480, 0.035, 5, false);
  };
  const spiralMat = new THREE.ShaderMaterial({ vertexShader: PLANE_VERT, fragmentShader: SPIRAL_FRAG, side: THREE.DoubleSide, ...add(), uniforms: { uColor: { value: new THREE.Color('#ffe08a') }, uTime: time, uI: { value: 1 } } });
  const spirals = [helix(0), helix(Math.PI)].map((g) => { const m = new THREE.Mesh(g, spiralMat); m.frustumCulled = false; m.renderOrder = 23; blast.add(m); return m; });
  const muzzle = halo({ color: '#ffb040', core: '#ffffff', intensity: 2, coreSize: 0.3, rays: 0.35, time }); muzzle.renderOrder = 24; blast.add(muzzle);
  const discRing = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ vertexShader: PLANE_VERT, fragmentShader: SHOCK_FRAG, side: THREE.DoubleSide, ...add(),
    uniforms: { uColor: { value: new THREE.Color('#ffc050') }, uP: { value: 1 } } }));
  discRing.renderOrder = 23; discRing.frustumCulled = false; blast.add(discRing);
  const bl = { t: -1, dur: 1.15, len: 160, r: 1.0, dir: new THREE.Vector3(0, 0, 1), origin: new THREE.Vector3() };

  // ---- shockwaves (pool of 4: ground ring + dome)
  const shocks = [];
  for (let i = 0; i < 4; i++) {
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({ vertexShader: PLANE_VERT, fragmentShader: SHOCK_FRAG, ...add(), uniforms: { uColor: { value: new THREE.Color('#ffd890') }, uP: { value: 1 } } }));
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.ShaderMaterial({ vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, side: THREE.DoubleSide, ...add(), uniforms: { uColor: { value: new THREE.Color('#ffd890') }, uP: { value: 1 } } }));
    ring.visible = dome.visible = false; ring.frustumCulled = dome.frustumCulled = false; ring.renderOrder = 18; dome.renderOrder = 18;
    group.add(ring, dome);
    shocks.push({ ring, dome, t: -1, dur: 0.7, size: 9 });
  }

  const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _z = new THREE.Vector3(0, 0, 1), _hp = new THREE.Vector3(), _c = new THREE.Color();
  const heroHeight = () => ctx.hero?.info?.height ?? 1.6;
  function heroPos(out) { const h = ctx.hero?.bones?.hips; if (h) h.getWorldPosition(out); else out.set(0, 0.9, 0); return out; }

  function setAura(on, { color = null, strength = 1 } = {}) {
    auraSt.on = !!on; auraSt.tgt = on ? THREE.MathUtils.clamp(strength, 0, 2) : 0;
    if (color != null) auraSt.color.set(color);
    if (on) aura.visible = true;
  }
  function fireBlast(origin, dir, { length = 160, radius = 1.0, color = null } = {}) {
    bl.origin.copy(origin); bl.dir.copy(dir).normalize(); bl.len = length; bl.r = radius; bl.t = 0;
    blast.position.copy(bl.origin);
    blast.quaternion.setFromUnitVectors(_z, bl.dir);
    if (color) { beamCore.material.uniforms.uColor.value.set(color); beamOuter.material.uniforms.uColor.value.set(color).offsetHSL(-0.04, 0, -0.1); }
    blast.visible = true;
    beamCore.material.uniforms.uLen.value = beamOuter.material.uniforms.uLen.value = length;
    // muzzle burst
    const o = bl.origin;
    glow.spawn(G.star, o.x, o.y, o.z, 0, 0, 0, 0.3, 0.5, 4.5, '#fff0c0', 3.5, 1, 0, 0, 0.3);
    glow.spawn(G.ring, o.x, o.y, o.z, 0, 0, 0, 0.45, 0.4, 5.5, '#ffc050', 2.5, 0, 0, 0);
    for (let i = 0; i < 26; i++) {
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
      glow.spawn(G.cross, p.x, p.y, p.z, 0, -0.6, 0, 0.6, 0.2, 0.55, J.color, 1.6, 0.3, 2, 2, 0.785);
      glow.spawn(G.ring, p.x, p.y, p.z, 0, 0, 0, 0.4, 0.2, 0.9, '#806070', 1.2, 0, 0, 0);
      return;
    }
    glow.spawn(G.ring, p.x, p.y, p.z, 0, 0, 0, 0.4, 0.08, 0.4 * J.size, J.ring, 1.8, 0, 0, 0);
    if (kind === 'perfect') {
      glow.spawn(G.star, p.x, p.y, p.z, 0, 0, 0, 0.3, 0.1, 0.7, J.color, 2.6, 1, 0, 0, 0, 2);
      glow.spawn(G.ring, p.x, p.y, p.z, 0, 0, 0, 0.5, 0.08, 0.62, J.color, 1.4, 0, 0, 0);
    }
    for (let i = 0; i < J.n; i++) {
      const th = (i / J.n) * Math.PI * 2 + Math.random() * 0.3, sp = 1.0 + Math.random() * 1.2;
      glow.spawn(i % 2 ? G.cross : G.diamond, p.x, p.y, p.z, Math.cos(th) * sp, Math.sin(th) * sp + 0.6, -0.3, 0.6 + Math.random() * 0.3, 0.09 * J.size, 0.03, i % 3 ? J.color : '#ffffff', 2.2, 0.8, 2.5, 1.5, th, 3);
    }
  }

  function update(dt) {
    const t = time.value;
    // aura
    auraSt.cur += (auraSt.tgt - auraSt.cur) * damp(auraSt.tgt > auraSt.cur ? 6 : 4, dt);
    if (aura.visible) {
      heroPos(_hp);
      aura.position.set(_hp.x, 0, _hp.z);
      const h = heroHeight();
      shell.scale.set(1, h * 1.3, 1);
      auraU.uStrength.value = auraSt.cur;
      auraU.uColor.value.copy(auraSt.color);
      auraSt.emit += dt * 40 * auraSt.cur;
      while (auraSt.emit > 1) {
        auraSt.emit -= 1;
        const a = Math.random() * Math.PI * 2, r = 0.25 + Math.random() * 0.35;
        glow.spawn(Math.random() < 0.5 ? G.diamond : G.glow, _hp.x + Math.cos(a) * r, Math.random() * 0.6, _hp.z + Math.sin(a) * r, 0, 1.6 + Math.random() * 2.2, 0, 0.7 + Math.random() * 0.5,
          0.05 + Math.random() * 0.05, 0.01, auraSt.color, 2.2, 0.6, 0.4, -0.5);
      }
      if (auraSt.cur < 0.005 && !auraSt.on) aura.visible = false;
    }
    // blast
    if (bl.t >= 0) {
      bl.t += dt;
      const t1 = bl.t, d = bl.dur;
      let r;
      if (t1 < 0.07) r = (t1 / 0.07) * 1.35;
      else if (t1 < 0.2) r = 1.35 - (t1 - 0.07) / 0.13 * 0.35;
      else if (t1 < d - 0.35) r = 1 + Math.sin(t1 * 70) * 0.06 + Math.sin(t1 * 31) * 0.05;
      else r = Math.max(0, (d - t1) / 0.35);
      const L = bl.len * Math.min(1, t1 / 0.12);
      const R = bl.r * r;
      beamCore.scale.set(R * 0.55, R * 0.55, L);
      beamOuter.scale.set(R * 1.5, R * 1.5, L);
      for (const s of spirals) { s.scale.set(R * 1.05, R * 1.05, L); }
      spirals[0].rotation.z = t * 6; spirals[1].rotation.z = t * 6;
      const I = 1 + Math.max(0, 0.2 - t1) * 6;
      beamCore.material.uniforms.uI.value = I; beamOuter.material.uniforms.uI.value = I * 0.9; spiralMat.uniforms.uI.value = Math.min(1, r);
      muzzle.scale.setScalar(R * 2.4 + 0.4);
      muzzle.material.uniforms.uIntensity.value = 1.5 + r;
      const p = Math.min(1, t1 / 0.5);
      discRing.scale.setScalar(0.5 + p * 6); discRing.material.uniforms.uP.value = p;
      discRing.position.set(0, 0, 0.6 + p * 2);
      if (Math.random() < dt * 60 * Math.min(1, r)) {
        const along = 2 + Math.random() * 30;
        _v.set((Math.random() - 0.5) * R * 3, (Math.random() - 0.5) * R * 3, along).applyQuaternion(blast.quaternion).add(bl.origin);
        _hp.copy(bl.dir).multiplyScalar(30 + Math.random() * 20);
        glow.spawn(G.streak, _v.x, _v.y, _v.z, _hp.x, _hp.y, _hp.z, 0.3, 0.08, 0.04, '#ffe0a0', 2.2, 0.6, 0.5, 0, 0, 0, 10);
      }
      // impact flare at the far end while the beam is fully extended
      if (t1 > 0.12 && t1 < d - 0.3 && Math.random() < dt * 14) {
        _v.copy(bl.dir).multiplyScalar(bl.len * 0.985).add(bl.origin);
        const k = Math.max(4, bl.len * 0.06);
        glow.spawn(Math.random() < 0.5 ? G.star : G.glow, _v.x, _v.y, _v.z, 0, 0, 0, 0.25, k * 0.3, k, '#ffe2a0', 2.2, 1, 0, 0, Math.random() * 3);
      }
      if (t1 >= d) { bl.t = -1; blast.visible = false; }
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
    glow.update(dt);
  }

  return {
    group, glow,
    api: { aura: setAura, blast: fireBlast, judgement, shockwave, update },
    get blasting() { return bl.t >= 0; },
    dispose() { group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } }); },
  };
}
