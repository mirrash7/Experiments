// BREAKLIGHT boss: the Eclipse Warden (owner: VISUAL). A towering obsidian-crystal guardian half-emerged from the
// cloud sea behind the rift, framed by the eclipse sun. Glowing cracks (3D noise veins), a halo ring, crystal
// spires, chest plates that open on a glowing core (the weak point), telegraphs for slam / sweep / barrage,
// stagger, hits and a multi-stage defeat (cracks flare -> supernova -> it shatters into the clouds).
import * as THREE from 'three';
import { NOISE_GLSL, crystalGeo, mergeGeos, halo, ringMaterial, unitQuad, ShardBurst, G, damp } from './common.js';

export const BOSS_POS = new THREE.Vector3(0, -15, 132);
const S = 11;  // unit model -> world scale

const BOSS_VERT = /* glsl */`
attribute float aMat;
varying vec3 vView; varying vec3 vObj; varying float vMat;
void main(){ vMat = aMat; vObj = position; vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz; gl_Position = projectionMatrix * mv; }`;
const BOSS_FRAG = /* glsl */`
#define FBM_OCT 2
uniform vec3 uBase, uFacet, uRim, uCrack, uAccent, uEmit, uFog;
uniform float uCrackAmt, uFlash, uTime, uFogAmt, uHeat, uAccentGlow, uEmitGlow;
varying vec3 vView; varying vec3 vObj; varying float vMat;
${NOISE_GLSL}
void main(){
  vec3 N = normalize(cross(dFdx(vView), dFdy(vView)));
  vec3 V = normalize(-vView);
  float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
  float l = dot(N, normalize(vec3(-0.5, 0.65, 0.55)));
  float band = l > 0.35 ? 1.0 : (l > -0.1 ? 0.5 : 0.15);
  vec3 col;
  float n1 = vnoise3(vObj * 2.6 + vec3(0.0, uTime * 0.03, 0.0));
  float n2 = vnoise3(vObj * 7.0 + 3.1);
  float w = 0.02 + uCrackAmt * 0.022;
  float crack = smoothstep(w, 0.0, abs(n1 - 0.5)) + smoothstep(w * 0.6, 0.0, abs(n2 - 0.5)) * 0.6 * min(uCrackAmt, 1.5);
  float pulse = 0.75 + 0.25 * sin(uTime * 2.2 - vObj.y * 2.5);
  if (vMat < 0.5) {
    col = mix(uBase, uFacet, band);
    col += uRim * pow(1.0 - ndv, 3.0) * 1.8;
    col += uCrack * crack * (0.9 + uCrackAmt * 1.6) * pulse;
    col = mix(col, vec3(3.5, 3.2, 3.0), uHeat * clamp(crack * 2.0 + uHeat * 0.4, 0.0, 1.0));
  } else if (vMat < 1.5) {
    col = uEmit * (1.5 + uEmitGlow * 3.0);
  } else {
    col = mix(uAccent * 0.25, uAccent * (1.0 + uAccentGlow), band) + uAccent * pow(ndv, 4.0) * (0.6 + uAccentGlow * 2.0) + uRim * pow(1.0 - ndv, 2.0);
    col = mix(col, vec3(3.0), uHeat * 0.6);
  }
  col = mix(col, uFog, uFogAmt * (1.0 - min(1.0, uHeat + uFlash)));
  col = mix(col, vec3(4.0, 3.8, 4.2), uFlash);
  gl_FragColor = vec4(col, 1.0);
}`;

function bossMaterial(time) {
  return new THREE.ShaderMaterial({
    vertexShader: BOSS_VERT, fragmentShader: BOSS_FRAG,
    uniforms: {
      uBase: { value: new THREE.Color('#0e0820') }, uFacet: { value: new THREE.Color('#33265a') }, uRim: { value: new THREE.Color('#b08cff') },
      uCrack: { value: new THREE.Color('#8a5cff') }, uAccent: { value: new THREE.Color('#9a7cff') }, uEmit: { value: new THREE.Color('#d8f4ff') },
      uFog: { value: new THREE.Color('#2a1c4a') }, uCrackAmt: { value: 0.4 }, uFlash: { value: 0 }, uTime: time, uFogAmt: { value: 0.18 },
      uHeat: { value: 0 }, uAccentGlow: { value: 0.3 }, uEmitGlow: { value: 0.5 },
    },
  });
}

function buildGeometry() {
  const oct = (r, sx, sy, sz, mat = 0) => { const g = crystalGeo(new THREE.OctahedronGeometry(r, 0), mat); g.scale(sx, sy, sz); return g; };
  const cyl = (rt, rb, h, seg, mat = 0) => crystalGeo(new THREE.CylinderGeometry(rt, rb, h, seg, 2), mat);
  const cone = (r, h, seg, mat = 2) => crystalGeo(new THREE.ConeGeometry(r, h, seg), mat);
  const box = (x, y, z, mat = 1) => crystalGeo(new THREE.BoxGeometry(x, y, z), mat);
  const torso = [];
  { const ab = cyl(0.78, 0.5, 3.2, 6); ab.translate(0, -1.2, 0); torso.push(ab);
    const chest = oct(1, 1.35, 1.0, 0.8); chest.translate(0, 1.15, 0); torso.push(chest);
    const ribs = oct(0.8, 1.2, 0.8, 0.7); ribs.translate(0, 0.35, 0.05); torso.push(ribs);
    const collar = cyl(0.42, 0.62, 0.45, 6); collar.translate(0, 2.0, 0.05); torso.push(collar);
    for (const x of [-1, 1]) {
      const pad = oct(0.7, 1.05, 0.6, 0.85); pad.translate(x * 1.35, 1.82, 0); torso.push(pad);
      for (let i = 0; i < 4; i++) { const c = cone(0.12 + (i % 2) * 0.06, 0.9 + i * 0.25, 5); c.rotateZ(-x * (0.35 + i * 0.28)); c.rotateX(0.2 - i * 0.12); c.translate(x * (1.45 + i * 0.12), 2.2 + i * 0.06, 0.1 + i * 0.1); torso.push(c); }
      const spire = cone(0.2, 3.2, 5); spire.rotateZ(-x * 0.32); spire.rotateX(-0.25); spire.translate(x * 0.95, 3.1, 0.65); torso.push(spire);
      const spire2 = cone(0.13, 2.2, 5); spire2.rotateZ(-x * 0.6); spire2.rotateX(-0.2); spire2.translate(x * 1.35, 2.75, 0.55); torso.push(spire2);
    }
    // seam light between the plates (visible when closed as a thin glowing line)
    const seam = box(0.05, 1.05, 0.05, 1); seam.translate(0, 1.15, -0.72); torso.push(seam);
  }
  const head = [];
  { const h = oct(0.44, 0.88, 1.3, 0.95); head.push(h);
    const jaw = oct(0.3, 1.1, 0.6, 0.9); jaw.translate(0, -0.32, -0.08); head.push(jaw);
    for (let i = 0; i < 5; i++) { const a = (i - 2) * 0.42; const c = cone(0.07, 0.75 - Math.abs(i - 2) * 0.12, 4); c.rotateZ(-a); c.translate(Math.sin(a) * 0.35, 0.62 + Math.cos(a) * 0.2, 0.05); head.push(c); }
    for (const x of [-1, 1]) { const e = box(0.17, 0.035, 0.04, 1); e.rotateZ(x * 0.22); e.translate(x * 0.14, 0.04, -0.4); head.push(e); }
    const gem = oct(0.06, 1, 1.4, 0.6, 1); gem.translate(0, 0.32, -0.36); head.push(gem);
  }
  const haloG = [];
  { const ring = crystalGeo(new THREE.TorusGeometry(1.15, 0.035, 4, 72), 1); haloG.push(ring);
    const ring2 = crystalGeo(new THREE.TorusGeometry(1.32, 0.012, 3, 72), 1); haloG.push(ring2);
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; const c = oct(0.07, 0.7, 1.8, 0.7, 2); c.rotateZ(a - Math.PI / 2); c.translate(Math.cos(a) * 1.24, Math.sin(a) * 1.24, 0); haloG.push(c); } }
  const plate = (side) => { const p = oct(0.55, 0.95, 1.05, 0.32); p.translate(side * 0.3, 0, 0); return p; };
  const upper = [];
  { const u = oct(0.36, 1, 3.0, 1); u.translate(0, -1.0, 0); upper.push(u); const k = oct(0.3, 1, 1, 1, 2); k.translate(0, -2.05, 0); upper.push(k); }
  const fore = [];
  { const f = oct(0.34, 1, 2.8, 1); f.translate(0, -0.9, 0); fore.push(f);
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; const c = cone(0.12, 1.1 + (i % 2) * 0.5, 4); c.rotateX(Math.PI); c.rotateZ(Math.cos(a) * 0.35); c.rotateX(Math.sin(a) * 0.35); c.translate(Math.cos(a) * 0.18, -2.1, Math.sin(a) * 0.18); fore.push(c); }
    const fist = oct(0.42, 1, 1.1, 1, 2); fist.translate(0, -1.85, 0); fore.push(fist); }
  return { torso: mergeGeos(torso), head: mergeGeos(head), halo: mergeGeos(haloG), plateL: plate(1), plateR: plate(-1), upper: mergeGeos(upper), fore: mergeGeos(fore) };
}

// barrage orbs: instanced billboards (1 draw)
const ORB_VERT = /* glsl */`attribute vec4 iPos; varying vec2 vUv; varying float vI;
void main(){ vUv = position.xy * 2.0; vI = iPos.w; vec4 mv = viewMatrix * vec4(iPos.xyz, 1.0); mv.xy += position.xy * (2.0 + iPos.w * 3.0); gl_Position = projectionMatrix * mv; }`;
const ORB_FRAG = /* glsl */`uniform vec3 uColor; varying vec2 vUv; varying float vI;
void main(){ float r = length(vUv); if (r > 1.0 || vI < 0.01) discard; float a = pow(1.0 - r, 2.0); vec3 c = uColor * a * 2.0 * vI + vec3(1.0, 0.95, 0.8) * smoothstep(0.3, 0.0, r) * 2.5 * vI; gl_FragColor = vec4(c, 1.0); }`;

export function createBoss(ctx, shared) {
  const time = shared.time;
  const object = new THREE.Group(); object.name = 'EclipseWarden';
  object.visible = false;
  const root = new THREE.Group(); root.position.copy(BOSS_POS); root.scale.setScalar(S); // the model is authored facing -Z (toward the hero)
  object.add(root);
  const geo = buildGeometry();
  const matBody = bossMaterial(time);
  const matArmL = bossMaterial(time), matArmR = bossMaterial(time);
  for (const m of [matArmL, matArmR]) { m.uniforms.uCrackAmt = matBody.uniforms.uCrackAmt; m.uniforms.uFlash = matBody.uniforms.uFlash; m.uniforms.uHeat = matBody.uniforms.uHeat; m.uniforms.uFog = matBody.uniforms.uFog; }
  const mats = [matBody, matArmL, matArmR];
  const mk = (g, m, parent) => { const o = new THREE.Mesh(g, m); o.frustumCulled = false; parent.add(o); return o; };
  const body = new THREE.Group(); root.add(body);
  const torso = mk(geo.torso, matBody, body);
  const headG = new THREE.Group(); headG.position.set(0, 2.72, 0); body.add(headG);
  mk(geo.head, matBody, headG);
  const haloRing = mk(geo.halo, matBody, body); haloRing.position.set(0, 2.85, 0.75);
  const plates = new THREE.Group(); plates.position.set(0, 1.15, -0.78); body.add(plates);
  const plateL = mk(geo.plateL, matBody, plates), plateR = mk(geo.plateR, matBody, plates);
  // weak point core
  const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff2d0').multiplyScalar(4) });
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 1), coreMat); core.position.set(0, 1.15, -0.55); core.frustumCulled = false; body.add(core);
  const coreHalo = halo({ color: '#ffb84a', core: '#ffffff', intensity: 0.3, coreSize: 0.25, rays: 1, time });
  coreHalo.scale.setScalar(1.2); coreHalo.position.copy(core.position); coreHalo.position.z -= 0.2; body.add(coreHalo);
  const eyeHalo = halo({ color: '#a8e8ff', core: '#ffffff', intensity: 0.4, coreSize: 0.15, time });
  eyeHalo.scale.setScalar(0.9); eyeHalo.position.set(0, 0.05, -0.5); headG.add(eyeHalo);
  const arms = {};
  for (const [name, side, mat] of [['L', 1, matArmL], ['R', -1, matArmR]]) {
    const shoulder = new THREE.Group(); shoulder.position.set(side * 1.45, 1.75, 0); body.add(shoulder);
    mk(geo.upper, mat, shoulder);
    const elbow = new THREE.Group(); elbow.position.set(0, -2.05, 0); shoulder.add(elbow);
    mk(geo.fore, mat, elbow);
    const fistHalo = halo({ color: '#ff6a3a', core: '#fff0e0', intensity: 0, coreSize: 0.2, rays: 1, time });
    fistHalo.scale.setScalar(2.4); fistHalo.position.set(0, -1.9, -0.3); elbow.add(fistHalo);
    arms[name] = { shoulder, elbow, mat, fistHalo, side, rest: { sx: 0.12, sz: side * 0.18, ex: -0.5 } };
  }
  // telegraph ground ring on the platform (in world space at the hero)
  const groundRing = new THREE.Mesh(unitQuad(), ringMaterial({ color: '#ff3a4a', bill: 0, style: 1, time }));
  groundRing.rotation.x = -Math.PI / 2; groundRing.position.set(0, 0.035, 0); groundRing.scale.setScalar(7); groundRing.visible = false; groundRing.frustumCulled = false; groundRing.renderOrder = 4;
  object.add(groundRing);
  // barrage orbs
  const ORBS = 10;
  const orbGeo = new THREE.InstancedBufferGeometry();
  orbGeo.index = unitQuad().index; orbGeo.attributes.position = unitQuad().attributes.position;
  const orbPos = new Float32Array(ORBS * 4);
  orbGeo.setAttribute('iPos', new THREE.InstancedBufferAttribute(orbPos, 4).setUsage(THREE.DynamicDrawUsage));
  orbGeo.instanceCount = ORBS; orbGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  const orbs = new THREE.Mesh(orbGeo, new THREE.ShaderMaterial({ vertexShader: ORB_VERT, fragmentShader: ORB_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color('#ffc830') } } }));
  orbs.frustumCulled = false; orbs.visible = false; orbs.renderOrder = 9;
  object.add(orbs);
  const orbFrom = Array.from({ length: ORBS }, () => new THREE.Vector3());
  // defeat shards (one big burst)
  const bigShards = new ShardBurst(70, { big: true });
  object.add(bigShards.mesh);

  const weakPoint = new THREE.Vector3();
  const st = {
    shown: false, rise: 1, t: 0, tele: { slam: 0, sweep: 0, barrage: 0 }, teleAge: { slam: 9, sweep: 9, barrage: 9 },
    attack: null, attackT: 0, stagger: 0, open: 0, openTgt: 0, crack: 0.4, flash: 0, defeat: -1, hidden: false, recoil: 0, recoilV: 0,
  };
  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _hero = new THREE.Vector3();
  const heroPos = () => { const h = ctx.hero?.bones?.hips; if (h) { h.getWorldPosition(_hero); _hero.y = 0; } else _hero.set(0, 0, 0); return _hero; };
  const glow = shared.worldGlow;

  function show() {
    object.visible = true; st.shown = true; st.rise = 0; st.defeat = -1; st.hidden = false; body.visible = true;
    st.crack = 0.4; st.open = st.openTgt = 0; st.flash = 0; matBody.uniforms.uHeat.value = 0; st.d1 = st.boom = false; st.attack = null;
    coreHalo.visible = true; core.visible = true;
    shared.onBossShow?.(true);
  }
  function hide() { object.visible = false; st.shown = false; groundRing.visible = false; orbs.visible = false; shared.onBossShow?.(false); }

  function telegraph(attack, t) {
    if (!(attack in st.tele)) return;
    st.tele[attack] = THREE.MathUtils.clamp(t, 0, 1); st.teleAge[attack] = 0;
  }
  function attack(name) {
    st.attack = name; st.attackT = 0; st.tele[name] = 0;
    const hp = heroPos();
    if (name === 'slam') { shared.trauma?.(0.55); }
    if (name === 'sweep') {
      for (let i = 0; i < 18; i++) glow.spawn(G.streak, hp.x + 6, 1.45, hp.z + 0.6 + (Math.random() - 0.5) * 0.6, -40 - Math.random() * 20, (Math.random() - 0.5) * 2, 0, 0.35, 0.4, 0.2, i % 2 ? '#ff6a3a' : '#ffffff', 2.4, 0.6, 1, 0, 0, 0, 10);
      shared.trauma?.(0.35);
    }
    if (name === 'barrage') {
      for (let i = 0; i < ORBS; i++) orbFrom[i].set(orbPos[4 * i], orbPos[4 * i + 1], orbPos[4 * i + 2]);
    }
  }
  function stagger() {
    st.stagger = 1; st.recoilV -= 0.9; st.flash = Math.max(st.flash, 0.5); st.crack = Math.min(2.2, st.crack + 0.8);
    shared.shards.fire(weakPoint, _v.set(0, 0.3, -1), '#2a1c4a', '#a080ff', { scale: 1.6, speed: 14, grav: 14, count: 24, life: 1.8 });
    glow.spawn(G.ring, weakPoint.x, weakPoint.y, weakPoint.z, 0, 0, 0, 0.6, 3, 30, '#a080ff', 2.2, 0, 0, 0);
    shared.trauma?.(0.4);
  }
  function openWeakPoint(on = true) { st.openTgt = on ? 1 : 0; if (on) glow.spawn(G.star, weakPoint.x, weakPoint.y, weakPoint.z - 2, 0, 0, 0, 0.4, 4, 26, '#ffd890', 2.4, 1, 0, 0, 0.3); }
  function hit(kind = 'good') {
    const k = kind === 'perfect' ? 1.4 : kind === 'great' ? 1.15 : 0.9;
    st.flash = Math.max(st.flash, 0.55 * k); st.recoilV -= 0.35 * k; st.crack = Math.min(2.5, st.crack + 0.25 * k);
    const p = weakPoint;
    glow.spawn(G.star, p.x, p.y, p.z - 3, 0, 0, 0, 0.25, 4, 24 * k, '#fff0c8', 3, 1, 0, 0, Math.random() * 3);
    glow.spawn(G.ring, p.x, p.y, p.z - 3, 0, 0, 0, 0.5, 3, 34 * k, '#ffc060', 2.2, 0, 0, 0);
    for (let i = 0; i < 16; i++) { const th = Math.random() * Math.PI * 2, sp = 25 + Math.random() * 30; glow.spawn(G.streak, p.x, p.y, p.z - 3, Math.cos(th) * sp, Math.sin(th) * sp, -10, 0.5, 1.6, 0.6, '#ffd080', 2.4, 0.8, 2, 8, 0, 0, 4); }
    shared.shards.fire(p, _v.set(0, 0.4, -1), '#2a1c4a', '#c0a0ff', { scale: 1.2, speed: 16, grav: 16, count: 16, life: 1.6 });
  }
  function defeat() { if (st.defeat >= 0) return; st.defeat = 0; st.openTgt = 1; st.attack = null; for (const k in st.tele) st.tele[k] = 0; shared.trauma?.(0.3); }

  // ---- animation
  function armPose(a, sx, sz, ex, k) {
    a.shoulder.rotation.x += (sx - a.shoulder.rotation.x) * k;
    a.shoulder.rotation.z += (sz - a.shoulder.rotation.z) * k;
    a.elbow.rotation.x += (ex - a.elbow.rotation.x) * k;
  }
  function update(dt) {
    if (!st.shown) return;
    st.t += dt; const t = st.t;
    // rise from the cloud sea
    if (st.rise < 1) {
      st.rise = Math.min(1, st.rise + dt / 3.2);
      if (Math.random() < dt * 30) { const x = (Math.random() - 0.5) * 40; glow.spawn(G.glow, BOSS_POS.x + x, -19, BOSS_POS.z - 8 + (Math.random() - 0.5) * 10, 0, 6, 0, 1.2, 6, 14, '#8a5cff', 0.7, 0.1, 0.5, 0); }
    }
    const rise = 1 - Math.pow(1 - st.rise, 3);
    root.position.y = BOSS_POS.y - (1 - rise) * 34 + Math.sin(t * 0.6) * 0.5;
    // recoil spring (stagger / hits)
    st.recoilV += (-st.recoil * 30 - st.recoilV * 6) * dt; st.recoil += st.recoilV * dt;
    body.rotation.x = st.recoil * 0.35 + Math.sin(t * 0.5) * 0.015;
    body.rotation.z = Math.sin(t * 0.37) * 0.02;
    headG.rotation.y = Math.sin(t * 0.3) * 0.08; headG.rotation.x = -0.06 + st.recoil * 0.3;
    haloRing.rotation.z = t * 0.12;
    st.flash *= Math.exp(-dt * 6); st.stagger *= Math.exp(-dt * 2);
    st.crack += (0.4 + st.stagger * 1.2 + st.open * 0.3 - st.crack) * damp(1.5, dt) * (st.defeat >= 0 ? 0 : 1);
    st.open += (st.openTgt - st.open) * damp(4, dt);
    plateL.position.x = st.open * 0.55; plateR.position.x = -st.open * 0.55;
    plateL.rotation.y = -st.open * 0.6; plateR.rotation.y = st.open * 0.6;
    const coreI = 0.25 + st.open * 1.6 + st.flash;
    coreHalo.material.uniforms.uIntensity.value = coreI;
    coreHalo.scale.setScalar(1.2 + st.open * 1.6 + Math.sin(t * 6) * 0.08 * st.open);
    coreMat.color.setRGB(4 + st.open * 3, 3.6 + st.open * 2.6, 3 + st.open * 1.6);
    const u = matBody.uniforms;
    u.uFlash.value = st.flash * 0.6; u.uCrackAmt.value = st.crack;
    u.uEmitGlow.value = 0.5 + st.stagger + Math.sin(t * 3) * 0.1;
    eyeHalo.material.uniforms.uIntensity.value = 0.4 + st.stagger * 1.5 + (st.tele.slam + st.tele.sweep + st.tele.barrage) * 0.8;
    // fog / palette follow the stage
    if (shared.palette) { u.uFog.value.copy(shared.palette.fog); u.uRim.value.copy(shared.palette.glow).lerp(_c.set('#c0a8ff'), 0.5); }

    // arms: idle sway, telegraph poses, attacks
    const L = arms.L, R = arms.R; const k = damp(6, dt);
    for (const kk in st.teleAge) { st.teleAge[kk] += dt; if (st.teleAge[kk] > 0.5) st.tele[kk] = Math.max(0, st.tele[kk] - dt * 2); }
    let lx = 0.15 + Math.sin(t * 0.7) * 0.05, lz = 0.2, le = -0.45, rx = 0.15 + Math.sin(t * 0.7 + 1) * 0.05, rz = -0.2, re = -0.45;
    const ts = st.tele.slam, tw = st.tele.sweep, tb = st.tele.barrage;
    // slam: model-left arm (world -X? the model's +X is world -X) raises overhead
    lx -= ts * 2.7; le -= ts * 0.6;
    // sweep: model-right arm pulls back and out
    rz -= tw * 1.3; rx -= tw * 0.6; re -= tw * 0.5;
    // barrage: both arms open
    lz += tb * 0.6; rz -= tb * 0.6; lx -= tb * 0.4; rx -= tb * 0.4;
    if (st.attack) {
      st.attackT += dt; const a = st.attackT;
      if (st.attack === 'slam') {
        const s = Math.min(1, a / 0.18);
        lx = -2.7 + s * 3.3; le = -0.6 + s * 0.4;
        if (a >= 0.18 && !st.slammed) {
          st.slammed = true;
          L.elbow.getWorldPosition(_w); _w.y = -19.5;
          for (let i = 0; i < 3; i++) glow.spawn(G.ring, _w.x, _w.y + 1, _w.z - 6, 0, 0, 0, 0.9 + i * 0.25, 4, 60 + i * 25, '#ff6a3a', 2.0, 0, 0, 0);
          for (let i = 0; i < 20; i++) glow.spawn(G.glow, _w.x + (Math.random() - 0.5) * 20, _w.y, _w.z - 6, (Math.random() - 0.5) * 10, 10 + Math.random() * 14, -6, 1.4, 4, 9, '#ffa070', 0.9, 0.2, 1, 6);
          shared.onSlam?.(heroPos());
        }
        if (a > 0.9) { st.attack = null; st.slammed = false; }
      } else if (st.attack === 'sweep') {
        const s = Math.min(1, a / 0.3);
        rz = -1.3 + s * 2.4; rx = -0.6 - Math.sin(s * Math.PI) * 0.6; re = -0.5;
        if (a > 0.9) st.attack = null;
      } else if (st.attack === 'barrage') {
        const s = Math.min(1, a / 0.55);
        const hp = heroPos();
        for (let i = 0; i < ORBS; i++) {
          _v.set(hp.x + (i % 2 ? 1.2 : -1.2) + (Math.random() - 0.5) * 0.2, 1.2 + (i % 3) * 0.3, hp.z + 1.0);
          _w.copy(orbFrom[i]).lerp(_v, s * s);
          orbPos[4 * i] = _w.x; orbPos[4 * i + 1] = _w.y + Math.sin(s * Math.PI) * 8; orbPos[4 * i + 2] = _w.z; orbPos[4 * i + 3] = 1 - s * 0.7;
        }
        orbGeo.attributes.iPos.needsUpdate = true;
        if (a >= 0.55 && !st.burst) { st.burst = true; for (let i = 0; i < ORBS; i++) glow.spawn(G.star, orbPos[4 * i], orbPos[4 * i + 1], orbPos[4 * i + 2], 0, 0, 0, 0.2, 0.3, 1.6, '#ffd040', 2.6, 1, 0, 0, Math.random()); }
        if (a > 0.7) { st.attack = null; st.burst = false; orbs.visible = false; }
      }
    }
    armPose(L, lx, lz, le, st.attack ? damp(30, dt) : k);
    armPose(R, rx, rz, re, st.attack ? damp(30, dt) : k);
    L.mat.uniforms.uAccentGlow.value = 0.3 + ts * 3; R.mat.uniforms.uAccentGlow.value = 0.3 + tw * 3;
    L.fistHalo.material.uniforms.uIntensity.value = ts * ts * 2.5; R.fistHalo.material.uniforms.uIntensity.value = tw * tw * 2.5;
    matBody.uniforms.uAccentGlow.value = 0.3 + tb * 1.5 + st.open * 0.5;
    // ground telegraph ring at the hero (slam = red closing ring, sweep = orange)
    const gt = Math.max(ts, tw);
    groundRing.visible = gt > 0.01;
    if (groundRing.visible) {
      const hp = heroPos(); groundRing.position.set(hp.x, 0.035, hp.z);
      groundRing.material.uniforms.uT.value = gt;
      groundRing.material.uniforms.uColor.value.set(ts >= tw ? '#ff3446' : '#ff8a2a');
    }
    // barrage orbs gather around the shoulders
    if (!st.attack || st.attack !== 'barrage') {
      orbs.visible = tb > 0.01;
      if (orbs.visible) {
        for (let i = 0; i < ORBS; i++) {
          const a = (i / ORBS) * Math.PI * 2 + t * 0.8;
          _v.set(Math.cos(a) * 2.2, 1.6 + Math.sin(a * 2) * 0.5, -0.6 + Math.sin(a) * 0.4);
          root.localToWorld(_v);
          orbPos[4 * i] = _v.x; orbPos[4 * i + 1] = _v.y; orbPos[4 * i + 2] = _v.z; orbPos[4 * i + 3] = tb;
        }
        orbGeo.attributes.iPos.needsUpdate = true;
      }
    } else orbs.visible = true;

    // defeat sequence
    if (st.defeat >= 0) {
      st.defeat += dt; const d = st.defeat;
      if (d < 1.8) {
        const p = d / 1.8;
        u.uCrackAmt.value = st.crack = 0.6 + p * 3.5; u.uHeat.value = p * p * 0.8;
        body.position.x = (Math.random() - 0.5) * 0.04 * p; body.position.y = (Math.random() - 0.5) * 0.03 * p;
        coreHalo.material.uniforms.uIntensity.value = 1.5 + p * 4; coreHalo.scale.setScalar(2 + p * 5);
        if (Math.random() < dt * 25) { _v.set((Math.random() - 0.5) * 3, Math.random() * 3.5 - 0.5, -0.6); root.localToWorld(_v); glow.spawn(G.star, _v.x, _v.y, _v.z, 0, 0, 0, 0.3, 2, 9, '#fff0d0', 2.2, 1, 0, 0, Math.random() * 3); }
        if (!st.d1 && d > 0.05) { st.d1 = true; shared.trauma?.(0.5); }
      } else if (!st.boom) {
        st.boom = true; body.visible = false; body.position.set(0, 0, 0);
        // flash sprites sit 55 % of the way to the camera (scaled to match) so the cloud sea doesn't clip them
        const cam = ctx.camera ? ctx.camera.getWorldPosition(_w) : _w.set(0, 2, -4);
        const fp = _v.copy(weakPoint).lerp(cam, 0.55); const fs = 0.45;
        for (let i = 0; i < 4; i++) glow.spawn(G.ring, fp.x, fp.y, fp.z, 0, 0, 0, 1.2 + i * 0.4, 6 * fs, (120 + i * 60) * fs, i % 2 ? '#ffe0a0' : '#b090ff', 2.4, 0, 0, 0);
        glow.spawn(G.star, fp.x, fp.y, fp.z, 0, 0, 0, 0.8, 10 * fs, 130 * fs, '#ffffff', 3.2, 1, 0, 0, 0.2);
        glow.spawn(G.glow, fp.x, fp.y, fp.z, 0, 0, 0, 1.4, 30 * fs, 120 * fs, '#ffd890', 1.6, 1, 0, 0);
        bigShards.fire(weakPoint, _v.set(0, 0.25, -0.6), '#1a1036', '#b090ff', { scale: 2.6, speed: 26, grav: 16, life: 4.0, hot: 1, drag: 0.7 });
        for (let i = 0; i < 40; i++) { const th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI, sp = 40 + Math.random() * 60;
          glow.spawn(G.streak, weakPoint.x, weakPoint.y, weakPoint.z, Math.cos(th) * Math.sin(ph) * sp, Math.cos(ph) * sp, Math.sin(th) * Math.sin(ph) * sp, 1.0, 4, 1, i % 2 ? '#ffe0b0' : '#c0a0ff', 2.4, 0.8, 1.5, 10, 0, 0, 4); }
        shared.onDefeatBoom?.(weakPoint);
        shared.trauma?.(1);
      } else if (d > 1.8) {
        const p = Math.min(1, (d - 1.8) / 2.6);
        coreHalo.visible = false; core.visible = false;
        if (p >= 1 && !st.hidden) { st.hidden = true; groundRing.visible = false; orbs.visible = false; }
      }
    }
    bigShards.update(dt);
    // weak point (world)
    core.getWorldPosition(weakPoint);
  }

  return {
    object, show, hide, update, telegraph, attack, stagger, openWeakPoint, hit, defeat, weakPoint,
    get state() { return st.defeat >= 0 ? (st.hidden ? 'defeated' : 'dying') : st.shown ? 'active' : 'hidden'; },
    dispose() {
      object.traverse((o) => { if (o.isMesh) { o.geometry.dispose?.(); o.material.dispose?.(); } });
    },
  };
}
const _c = new THREE.Color();
