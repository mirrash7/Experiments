// BREAKLIGHT boss: the Eclipse Warden (owner: VISUAL). A towering obsidian-crystal giant half-emerged from the cloud
// sea behind the rift, its head crowned by the eclipse. Glowing cracks (3D noise veins), a cyan/white rim light plus
// an additive silhouette hull so it always reads against the night sky, a halo ring, crystal spires, chest plates
// that open on a blazing core (the weak point), authored attacks (slam / sweep / barrage, each with anticipation,
// impact and recovery), stagger, hits and a multi-stage defeat (cracks flare -> supernova -> shatters into the clouds).
//
// Scale (R1): ~2x the old angular size. From the boss / 3-4 rear gameplay cameras the chest core sits ~5 deg above
// the horizon (clear of the platform trees), the head ~20 deg up with the eclipse directly behind it.
//
// show() plays a crane-friendly ~4 s emergence: 0-3 s it rises from the clouds head bowed, arms crossed; 3-3.8 s it
// straightens, throws the arms wide, the eyes ignite (flare + shake); then idle. `introT` (0..1) reports progress.
import * as THREE from 'three';
import { NOISE_GLSL, crystalGeo, mergeGeos, halo, hullGeometry, ringMaterial, unitQuad, ShardBurst, G, damp } from './common.js';

export const BOSS_POS = new THREE.Vector3(0, -9.8, 118);
const S = 19.3;            // unit model -> world scale (was 11 at z 132)
const K = S / 11;          // FX size factor vs the old tuning
const RISE = 3.0, IGNITE = 0.8;

const BOSS_VERT = /* glsl */`
attribute float aMat;
varying vec3 vView; varying vec3 vObj; varying float vMat; varying vec3 vWN;
void main(){ vMat = aMat; vObj = position; vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz; gl_Position = projectionMatrix * mv; }`;
const BOSS_FRAG = /* glsl */`
#define FBM_OCT 2
uniform vec3 uBase, uFacet, uRim, uBack, uCrack, uAccent, uEmit, uFog;
uniform float uCrackAmt, uFlash, uTime, uFogAmt, uHeat, uAccentGlow, uEmitGlow, uRimI;
varying vec3 vView; varying vec3 vObj; varying float vMat;
${NOISE_GLSL}
void main(){
  vec3 N = normalize(cross(dFdx(vView), dFdy(vView)));
  vec3 V = normalize(-vView);
  float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
  // view-space light from upper-left-front (key) and a back light from behind the boss (eclipse) -> rim
  float l = dot(N, normalize(vec3(-0.5, 0.65, 0.55)));
  float band = l > 0.35 ? 1.0 : (l > -0.1 ? 0.55 : 0.2);
  float up = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  float fres = pow(1.0 - ndv, 4.5);
  float back = pow(1.0 - ndv, 9.0) * (0.5 + 0.5 * up);
  vec3 col;
  float n1 = vnoise3(vObj * 2.6 + vec3(0.0, uTime * 0.03, 0.0));
  float n2 = vnoise3(vObj * 7.0 + 3.1);
  float w = 0.02 + uCrackAmt * 0.022;
  float crack = smoothstep(w, 0.0, abs(n1 - 0.5)) + smoothstep(w * 0.6, 0.0, abs(n2 - 0.5)) * 0.6 * min(uCrackAmt, 1.5);
  float pulse = 0.75 + 0.25 * sin(uTime * 2.2 - vObj.y * 2.5);
  if (vMat < 0.5) {
    col = mix(uBase, uFacet, band) * (0.75 + 0.35 * up);
    col += uRim * fres * uRimI * 0.7 + uBack * back * uRimI * 1.4;
    col += uCrack * crack * (0.9 + uCrackAmt * 1.6) * pulse;
    col = mix(col, vec3(3.5, 3.2, 3.0), uHeat * clamp(crack * 2.0 + uHeat * 0.4, 0.0, 1.0));
  } else if (vMat < 1.5) {
    col = uEmit * (1.5 + uEmitGlow * 3.0);
  } else {
    col = mix(uAccent * 0.3, uAccent * (1.0 + uAccentGlow), band) + uAccent * pow(ndv, 4.0) * (0.6 + uAccentGlow * 2.0) + uRim * fres * uRimI;
    col = mix(col, vec3(3.0), uHeat * 0.6);
  }
  col = mix(col, uFog, uFogAmt * (1.0 - min(1.0, uHeat + uFlash)) * (1.0 - fres));
  col = mix(col, vec3(4.0, 3.8, 4.2), uFlash);
  gl_FragColor = vec4(col, 1.0);
}`;

// additive silhouette rim: inflated back faces (welded normals), only visible outside the body's silhouette
const RIMHULL_VERT = /* glsl */`uniform float uW; varying float vF;
void main(){ vec3 p = position + normalize(normal) * uW; vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 n = normalize(normalMatrix * normal); vF = clamp(n.y * 0.5 + 0.6, 0.25, 1.0); gl_Position = projectionMatrix * mv; }`;
const RIMHULL_FRAG = /* glsl */`uniform vec3 uColor; uniform float uI; varying float vF; void main(){ gl_FragColor = vec4(uColor * uI * vF, 1.0); }`;

function bossMaterial(time) {
  return new THREE.ShaderMaterial({
    vertexShader: BOSS_VERT, fragmentShader: BOSS_FRAG,
    uniforms: {
      uBase: { value: new THREE.Color('#120a26') }, uFacet: { value: new THREE.Color('#3c2f6a') }, uRim: { value: new THREE.Color('#9fe8ff') },
      uBack: { value: new THREE.Color('#e8f6ff') }, uCrack: { value: new THREE.Color('#9a6cff') }, uAccent: { value: new THREE.Color('#7c64d8') },
      uEmit: { value: new THREE.Color('#d8f4ff') }, uFog: { value: new THREE.Color('#2a1c4a') }, uCrackAmt: { value: 0.4 }, uFlash: { value: 0 }, uTime: time,
      uFogAmt: { value: 0.1 }, uHeat: { value: 0 }, uAccentGlow: { value: 0.3 }, uEmitGlow: { value: 0.5 }, uRimI: { value: 1.6 },
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
void main(){ vUv = position.xy * 2.0; vI = iPos.w; vec4 mv = viewMatrix * vec4(iPos.xyz, 1.0); mv.xy += position.xy * (2.0 + iPos.w * 3.0) * ${K.toFixed(3)}; gl_Position = projectionMatrix * mv; }`;
const ORB_FRAG = /* glsl */`uniform vec3 uColor; varying vec2 vUv; varying float vI;
void main(){ float r = length(vUv); if (r > 1.0 || vI < 0.01) discard; float a = pow(1.0 - r, 2.0); vec3 c = uColor * a * 2.0 * vI + vec3(1.0, 0.95, 0.8) * smoothstep(0.3, 0.0, r) * 2.5 * vI; gl_FragColor = vec4(c, 1.0); }`;

// Arm poses: shoulder x (+ = swings forward toward the hero), shoulder z (+ = out for the model-left arm),
// elbow x (+ = forearm folds forward/up). Model-left arm = world -X (screen right in the rear cameras).
const POSE = {
  idle: { sx: 0.32, sz: 0.2, ex: 1.25 },
  crossed: { sx: 1.0, sz: -0.55, ex: 1.5 },
  wide: { sx: -0.15, sz: 1.15, ex: 0.55 },
};
const ease = (x) => x * x * (3 - 2 * x);
const easeOut = (x) => 1 - Math.pow(1 - x, 3);

export function createBoss(ctx, shared) {
  const time = shared.time;
  const object = new THREE.Group(); object.name = 'EclipseWarden';
  object.visible = false;
  const root = new THREE.Group(); root.position.copy(BOSS_POS); root.scale.setScalar(S); // authored facing -Z (toward the hero)
  object.add(root);
  const geo = buildGeometry();
  const matBody = bossMaterial(time);
  const matArmL = bossMaterial(time), matArmR = bossMaterial(time);
  for (const m of [matArmL, matArmR]) for (const k of ['uCrackAmt', 'uFlash', 'uHeat', 'uFog', 'uRim', 'uBack', 'uRimI', 'uFogAmt']) m.uniforms[k] = matBody.uniforms[k];
  const rimMat = new THREE.ShaderMaterial({ vertexShader: RIMHULL_VERT, fragmentShader: RIMHULL_FRAG, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color('#8fe0ff') }, uI: { value: 1.2 }, uW: { value: 0.045 } } });
  const mk = (g, m, parent, rim = true) => {
    const o = new THREE.Mesh(g, m); o.frustumCulled = false; parent.add(o);
    if (rim) { const h = new THREE.Mesh(hullGeometry(g), rimMat); h.frustumCulled = false; h.renderOrder = 2; parent.add(h); }
    return o;
  };
  const body = new THREE.Group(); root.add(body);
  mk(geo.torso, matBody, body);
  const headG = new THREE.Group(); headG.position.set(0, 2.72, 0); body.add(headG);
  mk(geo.head, matBody, headG);
  const haloRing = mk(geo.halo, matBody, body, false); haloRing.position.set(0, 2.85, 0.75);
  const plates = new THREE.Group(); plates.position.set(0, 1.15, -0.78); body.add(plates);
  const plateL = mk(geo.plateL, matBody, plates, false), plateR = mk(geo.plateR, matBody, plates, false);
  // weak point core: blazing white-gold sphere + halo with rays + a closing lock-on ring
  const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff2d0').multiplyScalar(4) });
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 1), coreMat); core.position.set(0, 1.15, -0.55); core.frustumCulled = false; body.add(core);
  const coreHalo = halo({ color: '#ffb84a', core: '#ffffff', intensity: 0.3, coreSize: 0.25, rays: 1, time });
  coreHalo.scale.setScalar(1.2); coreHalo.position.copy(core.position); coreHalo.position.z -= 0.2; coreHalo.renderOrder = 6; body.add(coreHalo);
  const lockRing = new THREE.Mesh(unitQuad(), ringMaterial({ color: '#ffd060', bill: 1, style: 1, time }));
  lockRing.frustumCulled = false; lockRing.renderOrder = 7; lockRing.position.copy(coreHalo.position); lockRing.position.z -= 0.1; lockRing.visible = false; body.add(lockRing);
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
    const fist = new THREE.Object3D(); fist.position.set(0, -1.95, 0); elbow.add(fist);
    arms[name] = { shoulder, elbow, mat, fistHalo, fist, side };
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
  const orbFired = new Uint8Array(ORBS);
  // defeat shards (one big burst)
  const bigShards = new ShardBurst(70, { big: true });
  object.add(bigShards.mesh);

  // rest-pose weak point (valid before the first update: CORE reads it right after show() to aim projectiles/blasts)
  const weakPoint = new THREE.Vector3();
  const restWeak = new THREE.Vector3();
  object.updateMatrixWorld(true); core.getWorldPosition(restWeak); weakPoint.copy(restWeak);

  const st = {
    shown: false, rise: 1, ignite: 1, t: 0, tele: { slam: 0, sweep: 0, barrage: 0 }, teleAge: { slam: 9, sweep: 9, barrage: 9 },
    attack: null, attackT: 0, stagger: 0, open: 0, openTgt: 0, crack: 0.4, flash: 0, defeat: -1, hidden: false, recoil: 0, recoilV: 0,
    ignited: false, slammed: false, sweepFx: 0, lean: 0, twist: 0, eye: 0,
  };
  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _hero = new THREE.Vector3();
  const heroPos = () => { const h = ctx.hero?.bones?.hips; if (h) { h.getWorldPosition(_hero); _hero.y = 0; } else _hero.set(0, 0, 0); return _hero; };
  const glow = shared.worldGlow;

  function show() {
    object.visible = true; st.shown = true; st.rise = 0; st.ignite = 0; st.ignited = false; st.defeat = -1; st.hidden = false; body.visible = true;
    st.crack = 0.4; st.open = st.openTgt = 0; st.flash = 0; matBody.uniforms.uHeat.value = 0; st.d1 = st.boom = false; st.attack = null;
    coreHalo.visible = true; core.visible = true; weakPoint.copy(restWeak);
    for (const a of Object.values(arms)) { a.shoulder.rotation.set(POSE.crossed.sx, 0, a.side * POSE.crossed.sz); a.elbow.rotation.set(POSE.crossed.ex, 0, 0); }
    shared.onBossShow?.(true);
  }
  function hide() { rp.on = false; object.visible = false; st.shown = false; groundRing.visible = false; orbs.visible = false; lockRing.visible = false; shared.onBossShow?.(false); }

  function telegraph(attack, t) {
    if (!(attack in st.tele)) return;
    st.tele[attack] = THREE.MathUtils.clamp(t, 0, 1); st.teleAge[attack] = 0;
  }
  function attack(name) {
    if (!(name in st.tele)) return;
    st.attack = name; st.attackT = 0; st.tele[name] = 0; st.slammed = false; st.burst = false;
    if (name === 'sweep') shared.trauma?.(0.25);
    if (name === 'barrage') { for (let i = 0; i < ORBS; i++) { orbFrom[i].set(orbPos[4 * i], orbPos[4 * i + 1], orbPos[4 * i + 2]); orbFired[i] = 0; } shared.trauma?.(0.2); }
  }
  function stagger() {
    st.stagger = 1; st.recoilV -= 0.9; st.flash = Math.max(st.flash, 0.5); st.crack = Math.min(2.2, st.crack + 0.8);
    shared.shards.fire(weakPoint, _v.set(0, 0.3, -1), '#2a1c4a', '#a080ff', { scale: 1.6 * K, speed: 14 * K, grav: 14 * K, count: 24, life: 1.8 });
    glow.spawn(G.ring, weakPoint.x, weakPoint.y, weakPoint.z, 0, 0, 0, 0.6, 3 * K, 30 * K, '#a080ff', 2.2, 0, 0, 0);
    shared.trauma?.(0.4);
  }
  function openWeakPoint(on = true) {
    st.openTgt = on ? 1 : 0;
    if (on) { glow.spawn(G.star, weakPoint.x, weakPoint.y, weakPoint.z - 2 * K, 0, 0, 0, 0.5, 4 * K, 30 * K, '#ffe0a0', 2.6, 1, 0, 0, 0.3); glow.spawn(G.ring, weakPoint.x, weakPoint.y, weakPoint.z - 2 * K, 0, 0, 0, 0.6, 2 * K, 26 * K, '#fff0c0', 2.4, 0, 0, 0); }
  }
  function hit(kind = 'good') {
    const k = kind === 'perfect' ? 1.4 : kind === 'great' ? 1.15 : 0.9;
    st.flash = Math.max(st.flash, 0.55 * k); st.recoilV -= 0.35 * k; st.crack = Math.min(2.5, st.crack + 0.25 * k);
    const p = weakPoint, z = p.z - 3 * K;
    glow.spawn(G.star, p.x, p.y, z, 0, 0, 0, 0.25, 4 * K, 24 * k * K, '#fff0c8', 3, 1, 0, 0, Math.random() * 3);
    glow.spawn(G.ring, p.x, p.y, z, 0, 0, 0, 0.5, 3 * K, 34 * k * K, '#ffc060', 2.2, 0, 0, 0);
    for (let i = 0; i < 16; i++) { const th = Math.random() * Math.PI * 2, sp = (25 + Math.random() * 30) * K; glow.spawn(G.streak, p.x, p.y, z, Math.cos(th) * sp, Math.sin(th) * sp, -10, 0.5, 1.6 * K, 0.6 * K, '#ffd080', 2.4, 0.8, 2, 8, 0, 0, 4); }
    shared.shards.fire(p, _v.set(0, 0.4, -1), '#2a1c4a', '#c0a0ff', { scale: 1.2 * K, speed: 16 * K, grav: 16 * K, count: 16, life: 1.6 });
  }
  function defeat() { if (st.defeat >= 0) return; st.defeat = 0; st.openTgt = 1; st.attack = null; for (const k in st.tele) st.tele[k] = 0; shared.trauma?.(0.3); }

  // ---- results-screen kill replay: the Warden stands (risen, chest open) while CORE replays the pinned boss-kill clip
  // and re-dies in sync with it. clock() returns the replay's song time; at tDefeat the defeat starts (onKill fires,
  // e.g. the kill blast) and the defeat timeline then runs `rate` x the replay clock, so the supernova + shatter land
  // inside the clip (the live sequence is 1.8 s to the boom; the pinned clip keeps ~1.4 s of song time after the kill).
  const rp = { on: false, clock: null, tDefeat: 0, last: NaN, rate: 1, onKill: null };
  function replayKill({ clock, tDefeat, tEnd, onKill = null } = {}) {
    show();
    st.rise = 1; st.ignite = 1; st.ignited = true; st.open = st.openTgt = 1; st.crack = 1.2; st.eye = 1;
    for (const a of Object.values(arms)) { a.shoulder.rotation.set(POSE.idle.sx, 0, a.side * POSE.idle.sz); a.elbow.rotation.set(POSE.idle.ex, 0, 0); }
    root.position.y = BOSS_POS.y;
    const after = Math.max(0.3, (Number.isFinite(tEnd) ? tEnd : tDefeat + 1.4) - tDefeat);
    Object.assign(rp, { on: true, clock, tDefeat, last: NaN, rate: THREE.MathUtils.clamp(1.8 / (after * 0.72), 1, 4), onKill });
  }
  function endReplay() { if (!rp.on) return; rp.on = false; rp.clock = null; rp.onKill = null; hide(); }
  /** Replay clock step: returns the dt the boss animates by (slow motion, with the defeat sped up to fit the clip). */
  function replayDt(dt) {
    let T = NaN;
    try { T = rp.clock?.(); } catch { /* */ }
    if (!Number.isFinite(T)) return 0;
    if (!Number.isFinite(rp.last) || T < rp.last - 0.05) rp.last = T;     // first frame / clip restarted
    const dT = Math.max(0, T - rp.last); rp.last = T;
    if (st.defeat < 0 && T >= rp.tDefeat) { defeat(); try { rp.onKill?.(); } catch (e) { console.warn('[visual] boss replay kill', e); } }
    return Math.min(0.1, st.defeat >= 0 ? dT * rp.rate : dT);
  }

  // ---- animation
  function armPose(a, sx, sz, ex, k) {
    a.shoulder.rotation.x += (sx - a.shoulder.rotation.x) * k;
    a.shoulder.rotation.z += (a.side * sz - a.shoulder.rotation.z) * k;
    a.elbow.rotation.x += (ex - a.elbow.rotation.x) * k;
  }
  const lerp = THREE.MathUtils.lerp;
  function update(dt) {
    if (!st.shown) return;
    if (rp.on) dt = replayDt(dt);
    st.t += dt; const t = st.t;
    const u = matBody.uniforms;
    // ---- emergence: rise (head bowed, arms crossed) -> ignite (straighten, arms wide, eyes flare)
    if (st.rise < 1) {
      st.rise = Math.min(1, st.rise + dt / RISE);
      if (Math.random() < dt * 40) { const x = (Math.random() - 0.5) * 60; glow.spawn(G.glow, BOSS_POS.x + x, -19, BOSS_POS.z - 14 + (Math.random() - 0.5) * 16, 0, 9, 0, 1.4, 8, 22, Math.random() < 0.5 ? '#8a5cff' : '#7ad8ff', 0.8, 0.1, 0.5, 0); }
    } else if (st.ignite < 1) {
      st.ignite = Math.min(1, st.ignite + dt / IGNITE);
      if (!st.ignited) {
        st.ignited = true; st.flash = 0.35; shared.trauma?.(0.45);
        headG.getWorldPosition(_w);
        glow.spawn(G.star, _w.x, _w.y, _w.z - 10, 0, 0, 0, 0.9, 6, 46, '#c8f4ff', 3.0, 1, 0, 0, 0.2);
        glow.spawn(G.ring, _w.x, _w.y, _w.z - 10, 0, 0, 0, 1.1, 6, 90, '#9ae0ff', 2.2, 0, 0, 0);
        glow.spawn(G.ring, _w.x, _w.y - 20, _w.z - 10, 0, 0, 0, 1.3, 10, 140, '#b090ff', 1.6, 0, 0, 0);
      }
    }
    const rise = easeOut(st.rise), ign = ease(st.ignite), intro = 1 - ign;
    st.eye = ign;
    root.position.y = BOSS_POS.y - (1 - rise) * 48 + Math.sin(t * 0.6) * 0.6;
    // recoil spring (stagger / hits)
    st.recoilV += (-st.recoil * 30 - st.recoilV * 6) * dt; st.recoil += st.recoilV * dt;
    st.flash *= Math.exp(-dt * 6); st.stagger *= Math.exp(-dt * 2);

    // ---- attack timeline (anticipation is the telegraph; attack(): strike -> impact -> recovery)
    for (const kk in st.teleAge) { st.teleAge[kk] += dt; if (st.teleAge[kk] > 0.5) st.tele[kk] = Math.max(0, st.tele[kk] - dt * 2); }
    const ts = st.tele.slam, tw = st.tele.sweep, tb = st.tele.barrage;
    const L = arms.L, R = arms.R;
    const idle = POSE.idle, b1 = Math.sin(t * 0.7) * 0.05;
    // base pose: intro (crossed -> wide flourish) blending into idle
    const flourish = st.rise >= 1 ? Math.sin(Math.min(1, st.ignite) * Math.PI) : 0;
    let lx = lerp(idle.sx + b1, POSE.crossed.sx, intro), lz = lerp(idle.sz, POSE.crossed.sz, intro), le = lerp(idle.ex, POSE.crossed.ex, intro);
    let rx = lerp(idle.sx - b1, POSE.crossed.sx, intro), rz = lerp(idle.sz, POSE.crossed.sz, intro), re = lerp(idle.ex, POSE.crossed.ex, intro);
    lx = lerp(lx, POSE.wide.sx, flourish); lz = lerp(lz, POSE.wide.sz, flourish); le = lerp(le, POSE.wide.ex, flourish);
    rx = lerp(rx, POSE.wide.sx, flourish); rz = lerp(rz, POSE.wide.sz, flourish); re = lerp(re, POSE.wide.ex, flourish);
    let lean = (1 - rise) * 0.55 + intro * 0.3 - flourish * 0.12, twist = 0;
    // slam anticipation: model-left arm (screen right) rises overhead, body leans back
    const tsE = ease(ts);
    lx = lerp(lx, -0.9, tsE); lz = lerp(lz, 2.35, tsE); le = lerp(le, 0.5, tsE); lean -= tsE * 0.18; twist -= tsE * 0.12;
    // sweep anticipation: model-right arm (screen left) winds back across the body, torso twists
    const twE = ease(tw);
    rx = lerp(rx, 0.15, twE); rz = lerp(rz, 1.45, twE); re = lerp(re, 0.25, twE); twist += twE * 0.38;
    // barrage anticipation: both arms open, chest pushes out
    const tbE = ease(tb);
    lz = lerp(lz, 0.85, tbE); rz = lerp(rz, 0.85, tbE); lx = lerp(lx, -0.2, tbE); rx = lerp(rx, -0.2, tbE); le = lerp(le, 0.9, tbE); re = lerp(re, 0.9, tbE); lean -= tbE * 0.1;
    let armK = damp(6, dt);
    if (st.attack) {
      st.attackT += dt; const a = st.attackT;
      if (st.attack === 'slam') {
        // 0-0.16 strike (fast), impact at 0.16, hold 0.3, recover to 0.95
        const strike = Math.min(1, a / 0.16), rec = THREE.MathUtils.clamp((a - 0.46) / 0.5, 0, 1);
        const sx = lerp(-0.9, 0.85, easeOut(strike)), sz = lerp(2.35, 0.35, easeOut(strike)), se = lerp(0.5, 0.1, strike);
        lx = lerp(sx, lx, ease(rec)); lz = lerp(sz, lz, ease(rec)); le = lerp(se, le, ease(rec));
        lean = lerp(-0.18 + strike * 0.42, lean, ease(rec));
        armK = a < 0.5 ? 1 : damp(10, dt);
        if (a >= 0.16 && !st.slammed) {
          st.slammed = true; st.recoilV += 0.5;
          L.fist.getWorldPosition(_w); const y = -19.2;
          for (let i = 0; i < 3; i++) glow.spawn(G.ring, _w.x, y + 1, _w.z, 0, 0, 0, 0.7 + i * 0.2, 2 * K, (10 + i * 6) * K, i === 1 ? '#ffd0a0' : '#ff6a3a', 2.2, 0, 0, 0);
          glow.spawn(G.star, _w.x, y + 4, _w.z, 0, 0, 0, 0.3, 4 * K, 18 * K, '#fff0d8', 2.6, 1, 0, 0, Math.random());
          for (let i = 0; i < 26; i++) glow.spawn(G.glow, _w.x + (Math.random() - 0.5) * 16 * K, y, _w.z + (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 16, 14 + Math.random() * 22, -8, 1.6, 3 * K, 8 * K, i % 3 ? '#c8a8ff' : '#ffa070', 0.9, 0.2, 1, 9);
          for (let i = 0; i < 14; i++) { const th = Math.random() * Math.PI, sp = 40 + Math.random() * 50; glow.spawn(G.streak, _w.x, y + 2, _w.z, Math.cos(th) * sp, Math.sin(th) * sp * 0.8, -10, 0.6, 2 * K, 0.6 * K, '#ffd0a0', 2.4, 0.8, 2, 20, 0, 0, 5); }
          shared.trauma?.(0.6);
          shared.onSlam?.(heroPos());
        }
        if (a > 0.96) st.attack = null;
      } else if (st.attack === 'sweep') {
        // 0-0.3 the arm whips across in a horizontal arc, recover by 0.9
        const s = Math.min(1, a / 0.3), rec = THREE.MathUtils.clamp((a - 0.42) / 0.48, 0, 1);
        const sz = lerp(1.45, -0.55, easeOut(s)), sx = 0.15 + Math.sin(s * Math.PI) * 1.25, se = 0.25;
        rx = lerp(sx, rx, ease(rec)); rz = lerp(sz, rz, ease(rec)); re = lerp(se, re, ease(rec));
        twist = lerp(0.38 - easeOut(s) * 0.7, twist, ease(rec));
        armK = a < 0.42 ? 1 : damp(10, dt);
        if (s < 1) { // arc trail: streak sparks off the fist
          R.fist.getWorldPosition(_w); st.sweepFx += dt * 90;
          while (st.sweepFx > 1) { st.sweepFx -= 1; glow.spawn(G.glow, _w.x + (Math.random() - 0.5) * 6, _w.y + (Math.random() - 0.5) * 6, _w.z, 0, 0, 0, 0.5, 9 * K, 3 * K, Math.random() < 0.5 ? '#ff8a3a' : '#ffe0b0', 1.6, 0.6, 0, 0); }
        }
        if (a > 0.9) st.attack = null;
      } else if (st.attack === 'barrage') {
        // orbs launch in a staggered volley (0.04 s apart) along arcs to the hero area; the chest recoils
        const hp = heroPos();
        lean = lerp(lean, 0.15, Math.min(1, a / 0.12) * (1 - THREE.MathUtils.clamp((a - 0.5) / 0.4, 0, 1)));
        let alive = 0;
        for (let i = 0; i < ORBS; i++) {
          const ai = a - i * 0.04; const s = THREE.MathUtils.clamp(ai / 0.55, 0, 1);
          if (ai > 0 && !orbFired[i]) { orbFired[i] = 1; glow.spawn(G.star, orbFrom[i].x, orbFrom[i].y, orbFrom[i].z, 0, 0, 0, 0.18, 2 * K, 9 * K, '#ffe080', 2.4, 1, 0, 0, Math.random()); }
          _v.set(hp.x + (i % 2 ? 1.3 : -1.3) + ((i * 37) % 7 - 3) * 0.15, 1.1 + (i % 3) * 0.35, hp.z + 1.2);
          _w.copy(orbFrom[i]).lerp(_v, s * s);
          orbPos[4 * i] = _w.x; orbPos[4 * i + 1] = _w.y + Math.sin(s * Math.PI) * 10; orbPos[4 * i + 2] = _w.z; orbPos[4 * i + 3] = s >= 1 ? 0 : 1 - s * 0.75;
          if (s >= 1 && orbFired[i] === 1) { orbFired[i] = 2; glow.spawn(G.star, _w.x, _w.y, _w.z, 0, 0, 0, 0.2, 0.3, 1.6, '#ffd040', 2.6, 1, 0, 0, Math.random()); }
          if (s < 1) alive++;
        }
        orbGeo.attributes.iPos.needsUpdate = true;
        if (a > 0.3 && alive === 0) { st.attack = null; orbs.visible = false; }
        if (a > 1.2) { st.attack = null; orbs.visible = false; }
      }
    }
    armPose(L, lx, lz, le, armK);
    armPose(R, rx, rz, re, armK);
    st.lean += (lean - st.lean) * (st.attack ? damp(18, dt) : damp(5, dt));
    st.twist += (twist - st.twist) * (st.attack ? damp(18, dt) : damp(5, dt));
    body.rotation.x = st.lean + st.recoil * 0.35 + Math.sin(t * 0.5) * 0.015;
    body.rotation.y = st.twist;
    body.rotation.z = Math.sin(t * 0.37) * 0.02;
    headG.rotation.y = Math.sin(t * 0.3) * 0.08 * ign; headG.rotation.x = -0.06 + st.recoil * 0.3 + intro * 0.35 - (ts + tb) * 0.12;
    haloRing.rotation.z = t * 0.12;
    st.crack += (0.4 + st.stagger * 1.2 + st.open * 0.3 - st.crack) * damp(1.5, dt) * (st.defeat >= 0 ? 0 : 1);
    st.open += (st.openTgt - st.open) * damp(4, dt);
    plateL.position.x = st.open * 0.55; plateR.position.x = -st.open * 0.55;
    plateL.rotation.y = -st.open * 0.6; plateR.rotation.y = st.open * 0.6;
    // weak point: unmistakable when open (bigger blazing core, rays, pulsing lock-on ring)
    const beat = 0.5 + 0.5 * Math.sin(t * 7.5);
    const coreI = 0.3 + st.open * (1.4 + beat * 0.6) + st.flash;
    coreHalo.material.uniforms.uIntensity.value = coreI;
    coreHalo.scale.setScalar(1.2 + st.open * (0.6 + beat * 0.3));
    core.scale.setScalar(1 + st.open * (0.2 + beat * 0.12));
    coreMat.color.setRGB(4 + st.open * 4, 3.6 + st.open * 3.4, 3 + st.open * 2.2);
    lockRing.visible = st.open > 0.05 && st.defeat < 0;
    if (lockRing.visible) { const ph = (t * 0.9) % 1; lockRing.material.uniforms.uT.value = ph; lockRing.material.uniforms.uOpacity.value = st.open; lockRing.scale.setScalar(3.0); }
    u.uFlash.value = st.flash * 0.6; u.uCrackAmt.value = st.crack;
    u.uEmitGlow.value = 0.5 + st.stagger + Math.sin(t * 3) * 0.1;
    eyeHalo.material.uniforms.uIntensity.value = (0.08 + st.eye * 0.5) + st.stagger * 1.5 + (ts + tw + tb) * 0.9 + (st.ignite < 1 && st.rise >= 1 ? Math.sin(st.ignite * Math.PI) * 3 : 0);
    eyeHalo.scale.setScalar(0.9 + (st.ignite < 1 && st.rise >= 1 ? Math.sin(st.ignite * Math.PI) * 1.4 : 0));
    // rim follows the palette glow but stays cool / bright so the silhouette always pops
    if (shared.palette) { u.uFog.value.copy(shared.palette.fog); u.uRim.value.copy(shared.palette.rune).lerp(_c.set('#bfefff'), 0.55); rimMat.uniforms.uColor.value.copy(u.uRim.value).multiplyScalar(0.85); }
    u.uRimI.value = 1.6 + st.stagger * 0.8 + (st.defeat >= 0 ? 1 : 0);
    rimMat.uniforms.uI.value = (0.9 + 0.15 * Math.sin(t * 1.7) + st.flash) * (0.35 + 0.65 * rise);

    L.mat.uniforms.uAccentGlow.value = 0.3 + ts * 3; R.mat.uniforms.uAccentGlow.value = 0.3 + tw * 3;
    L.fistHalo.material.uniforms.uIntensity.value = ts * ts * 2.5 + (st.attack === 'slam' ? Math.max(0, 1 - st.attackT * 2) * 2 : 0);
    R.fistHalo.material.uniforms.uIntensity.value = tw * tw * 2.5 + (st.attack === 'sweep' ? Math.max(0, 1 - st.attackT * 2) * 2 : 0);
    matBody.uniforms.uAccentGlow.value = 0.3 + tb * 1.5 + st.open * 0.5;
    // ground telegraph ring at the hero (slam = red closing ring, sweep = orange)
    const gt = Math.max(ts, tw);
    groundRing.visible = gt > 0.01;
    if (groundRing.visible) {
      const hp = heroPos(); groundRing.position.set(hp.x, 0.035, hp.z);
      groundRing.material.uniforms.uT.value = gt;
      groundRing.material.uniforms.uColor.value.set(ts >= tw ? '#ff3446' : '#ff8a2a');
    }
    // barrage orbs gather in a ring in front of the chest during the anticipation
    if (st.attack !== 'barrage') {
      orbs.visible = tb > 0.01;
      if (orbs.visible) {
        for (let i = 0; i < ORBS; i++) {
          const a = (i / ORBS) * Math.PI * 2 + t * 1.6;
          const r = 1.9 - tb * 0.6;
          _v.set(Math.cos(a) * r, 1.15 + Math.sin(a) * r * 0.7, -1.1);
          body.localToWorld(_v);
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
        if (Math.random() < dt * 25) { _v.set((Math.random() - 0.5) * 3, Math.random() * 3.5 - 0.5, -0.6); root.localToWorld(_v); glow.spawn(G.star, _v.x, _v.y, _v.z, 0, 0, 0, 0.3, 2 * K, 9 * K, '#fff0d0', 2.2, 1, 0, 0, Math.random() * 3); }
        if (!st.d1 && d > 0.05) { st.d1 = true; shared.trauma?.(0.5); }
      } else if (!st.boom) {
        st.boom = true; body.visible = false; body.position.set(0, 0, 0);
        // flash sprites sit 55 % of the way to the camera (scaled to match) so the cloud sea doesn't clip them
        const cam = ctx.camera ? ctx.camera.getWorldPosition(_w) : _w.set(0, 2, -4);
        const fp = _v.copy(weakPoint).lerp(cam, 0.55); const fs = 0.45 * K;
        for (let i = 0; i < 4; i++) glow.spawn(G.ring, fp.x, fp.y, fp.z, 0, 0, 0, 1.2 + i * 0.4, 6 * fs, (120 + i * 60) * fs, i % 2 ? '#ffe0a0' : '#b090ff', 2.4, 0, 0, 0);
        glow.spawn(G.star, fp.x, fp.y, fp.z, 0, 0, 0, 0.8, 10 * fs, 130 * fs, '#ffffff', 3.2, 1, 0, 0, 0.2);
        glow.spawn(G.glow, fp.x, fp.y, fp.z, 0, 0, 0, 1.4, 30 * fs, 120 * fs, '#ffd890', 1.6, 1, 0, 0);
        bigShards.fire(weakPoint, _v.set(0, 0.25, -0.6), '#1a1036', '#b090ff', { scale: 2.6 * K, speed: 26 * K, grav: 16 * K, life: 4.0, hot: 1, drag: 0.7 });
        for (let i = 0; i < 40; i++) { const th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI, sp = (40 + Math.random() * 60) * K;
          glow.spawn(G.streak, weakPoint.x, weakPoint.y, weakPoint.z, Math.cos(th) * Math.sin(ph) * sp, Math.cos(ph) * sp, Math.sin(th) * Math.sin(ph) * sp, 1.0, 4 * K, K, i % 2 ? '#ffe0b0' : '#c0a0ff', 2.4, 0.8, 1.5, 10, 0, 0, 4); }
        shared.onDefeatBoom?.(weakPoint);
        shared.trauma?.(1);
      } else if (d > 1.8) {
        const p = Math.min(1, (d - 1.8) / 2.6);
        coreHalo.visible = false; core.visible = false; lockRing.visible = false;
        if (p >= 1 && !st.hidden) { st.hidden = true; groundRing.visible = false; orbs.visible = false; }
      }
    }
    bigShards.update(dt);
    // weak point (world): the rest position until the emergence finishes, then the live core
    if (st.rise >= 1) core.getWorldPosition(weakPoint); else weakPoint.copy(restWeak);
  }

  return {
    object, show, hide, update, telegraph, attack, stagger, openWeakPoint, hit, defeat, weakPoint,
    /** Results replay of the kill: replayKill({ clock: () => songT, tDefeat, tEnd, onKill }) / endReplay() (hides). */
    replayKill, endReplay,
    get replaying() { return rp.on; },
    /** World-space head position (for cameras / sightlines). */
    head: (out = new THREE.Vector3()) => headG.getWorldPosition(out),
    /** Emergence progress 0..1 (1 = idle). */
    get introT() { return st.shown ? Math.min(1, (st.rise * RISE + st.ignite * IGNITE) / (RISE + IGNITE)) : 0; },
    get shown() { return st.shown; },
    get state() { return st.defeat >= 0 ? (st.hidden ? 'defeated' : 'dying') : st.shown ? 'active' : 'hidden'; },
    dispose() {
      object.traverse((o) => { if (o.isMesh) { o.geometry.dispose?.(); o.material.dispose?.(); } });
    },
  };
}
const _c = new THREE.Color();
