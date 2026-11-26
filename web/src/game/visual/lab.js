// BREAKLIGHT visual lab (owner: VISUAL): a standalone showcase for the stage, spirits, boss and VFX.
// Minimal ctx like CORE's: renderer + post chain, world/hero scenes, hero light rig, VRM hero, quality preset.
// Automation: window.lab (setAct, spawn, wave, boss, blast, aura, cam, perf, stageInfo).
import * as THREE from 'three';
import { configureRenderer, autoResize } from '../../render/pipeline.js';
import { createPostChain } from '../../render/post.js';
import { createHeroLights } from '../../render/heroLights.js';
import { QualityManager } from '../../render/quality.js';
import { loadVRMHero } from '../../vrm/hero.js';
import { applyPose } from '../../render/posePresets.js';
import { createFx } from '../../fx/index.js';
import { createVisuals } from './index.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const qMode = params.get('q') || 'high';

const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: false, powerPreference: 'high-performance', stencil: false });
configureRenderer(renderer, { postToneMapping: true });
renderer.info.autoReset = false;
const worldScene = new THREE.Scene();
const heroScene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.05, 600);
const CAMS = {
  gameplay: { pos: [0, 2.2, -4], look: [0, 1.25, 4] },
  front: { pos: [1.6, 1.45, 3.6], look: [0, 1.25, 0] },
  side: { pos: [4.2, 1.7, 1.2], look: [0, 1.6, 6] },
  wide: { pos: [6, 4.5, -9], look: [0, 3, 30] },
  boss: { pos: [0, 1.4, -3], look: [0, 6, 40] },
  low: { pos: [2.5, 0.6, -3], look: [0, 2.2, 10] },
};
let camGoal = CAMS.gameplay; const camLook = new THREE.Vector3();
function setCam(name, snap = true) { camGoal = CAMS[name] ?? CAMS.gameplay; if (snap) { camera.position.set(...camGoal.pos); camLook.set(...camGoal.look); camera.lookAt(camLook); } }
setCam('gameplay');

const post = createPostChain(renderer, worldScene, heroScene, camera);
const heroLights = createHeroLights(heroScene, { sunDirection: new THREE.Vector3(-0.4, 0.6, 0.7) });
let quality;
autoResize(renderer, camera, { pixelRatio: () => quality?.dpr ?? Math.min(devicePixelRatio, 2), onResize: (w, h) => post.setSize(w, h) });
quality = new QualityManager({ mode: qMode, apply: (p) => { post.setPreset(p); heroLights.setShadows(p.shadows, p.shadowMap); } });
$('quality').value = qMode;
$('quality').onchange = () => { params.set('q', $('quality').value); location.search = params.toString(); };

const ctx = { THREE, renderer, camera, worldScene, heroScene, hero: null, motion: null, fx: null, audio: null, quality, settings: {}, bus: null, time: { now: 0, dt: 0, beat: 0, act: 'title' } };

let hero = null;
try {
  hero = await loadVRMHero('/vrm/Sakurada_Fumiriya.vrm', { camera, renderer, quality: quality.tier });
  heroScene.add(hero.root);
  hero.root.rotation.y = 0;
  applyPose(hero, 'armsDown');
  heroLights.setHeroHeight(hero.info?.height || 1.6);
  hero.materials?.setQuality?.(quality.preset.outlines);
  ctx.hero = hero;
} catch (e) { console.warn('[lab] hero failed to load, continuing without it', e); }
ctx.fx = createFx({ scene: heroScene, camera, hero });

const visuals = await createVisuals(ctx);
worldScene.add(visuals.stage.object);
window.visuals = visuals;
$('loading').remove();

// ------------------------------------------------------------------------------------------- spirit paths
const BPM = 128, BEAT = 60 / BPM;
const outcomeModes = ['perfect', 'great', 'good', 'dodge', 'strike'];
let outcome = 'perfect';
const HIT = {
  striker: (s) => new THREE.Vector3(s * 0.42, 1.28, 0.62),
  crawler: (s) => new THREE.Vector3(s * 0.38, 0, 0.72),
  sweep: () => new THREE.Vector3(0, 0, 0.25),
  scythe: () => new THREE.Vector3(0, 1.55, 0.3),
  volley: (s) => new THREE.Vector3(s * 0.55, 1.25, 0.15),
  brute: () => new THREE.Vector3(0, 0, 1.45),
  core: () => new THREE.Vector3(0, 1.45, 2.4),
};
const BEATS = { striker: 3, crawler: 4, sweep: 4, scythe: 4, volley: 3, brute: 6, core: 5 };
const live = [];
const rift = visuals.stage.rift;
function spawn(type, { side = Math.random() < 0.5 ? 1 : -1, result = outcome, delay = 0 } = {}) {
  const hitPos = HIT[type](side);
  let start;
  if (type === 'crawler' || type === 'brute' || type === 'sweep') start = new THREE.Vector3(hitPos.x * 3, 0, 26);
  else start = rift.clone();
  const view = visuals.spirits.create(type, { side: side > 0 ? 'left' : side < 0 ? 'right' : 'center', position: start, target: hitPos });
  live.push({ view, type, start, hitPos, t: -delay, dur: BEATS[type] * BEAT, result, done: false, side, punches: 0 });
  return view;
}
const _p = new THREE.Vector3(), _dir = new THREE.Vector3();
function stepSpirits(dt) {
  for (let i = live.length - 1; i >= 0; i--) {
    const s = live[i];
    s.t += dt;
    if (s.t < 0) continue;
    const u = Math.min(1.25, s.t / s.dur);
    const e = u < 1 ? 1 - Math.pow(1 - u, 1.6) : u;
    _p.lerpVectors(s.start, s.hitPos, e);
    if (s.type !== 'crawler' && s.type !== 'brute' && s.type !== 'sweep') _p.y += Math.sin(Math.min(1, u) * Math.PI) * 2.5 * (1 - u);
    if (u > 1) { _p.z = s.hitPos.z - (u - 1) * 14; } // passes the hero after the hit moment
    if (s.type === 'brute' && u >= 1) _p.copy(s.hitPos);
    if (!s.done) s.view.object.position.copy(_p);
    s.view.setTelegraph(Math.min(1, u));
    if (!s.done && u >= 1) {
      s.done = true;
      const r = s.result;
      if (r === 'dodge') s.view.dodged();
      else if (r === 'strike') { s.view.strikeHero(); visuals.vfx.judgement(s.view.hitPoint, 'miss'); visuals.vfx.shockwave(new THREE.Vector3(0, 0, 0), { color: '#ff4050', size: 4 }); }
      else {
        if (s.type === 'brute') { s.view.block(); setTimeout(() => s.view.impact('great'), 220); setTimeout(() => s.view.impact('great'), 420); }
        const fin = () => {
          if (hero && (s.type === 'striker' || s.type === 'brute')) { applyPose(hero, s.side > 0 ? 'punchL' : 'punchR'); setTimeout(() => hero && applyPose(hero, 'armsDown'), 260); }
          if (hero && s.type === 'crawler') { applyPose(hero, 'frontKick'); setTimeout(() => hero && applyPose(hero, 'armsDown'), 300); }
          if (s.type === 'core') { blast(); }
          s.view.hit(r, _dir.set(0, 0.35, 1));
          visuals.vfx.judgement(s.view.hitPoint, r);
        };
        if (s.type === 'brute') setTimeout(fin, 640); else if (s.type === 'core') { charge(true); setTimeout(() => { charge(false); fin(); }, 700); } else fin();
      }
    }
    if (s.t > s.dur + 1.6) live.splice(i, 1);
  }
}
function wave(n = 8) {
  const types = ['striker', 'striker', 'crawler', 'volley', 'striker', 'sweep', 'scythe', 'crawler', 'volley', 'brute'];
  for (let i = 0; i < n; i++) spawn(types[i % types.length], { delay: i * BEAT });
}

// ------------------------------------------------------------------------------------------- vfx helpers
function handsMid(out) {
  const b = hero?.bones;
  if (b?.leftHand && b?.rightHand) { b.leftHand.getWorldPosition(out); out.add(b.rightHand.getWorldPosition(_p)).multiplyScalar(0.5); }
  else out.set(0, 1.3, 0.4);
  return out;
}
function blast() {
  const o = handsMid(new THREE.Vector3()); o.z += 0.25;
  const target = visuals.boss.state === 'active' ? visuals.boss.weakPoint : new THREE.Vector3(0, 6, 120);
  const dir = target.clone().sub(o).normalize();
  if (hero) { applyPose(hero, 'punchR'); setTimeout(() => hero && applyPose(hero, 'armsDown'), 900); }
  visuals.vfx.blast(o, dir, { length: o.distanceTo(target) + 20 });
  visuals.vfx.shockwave(new THREE.Vector3(o.x, 0, o.z), { color: '#ffd070', size: 10 });
  if (visuals.boss.state === 'active') setTimeout(() => visuals.boss.hit('perfect'), 120);
}
let charging = false, overdrive = false;
function charge(on) { charging = on; if (hero) applyPose(hero, on ? 'armsOverhead' : 'armsDown'); refreshAura(); }
function refreshAura() {
  if (charging) visuals.vfx.aura(true, { color: '#7ae8ff', strength: 1.2 });
  else if (overdrive) visuals.vfx.aura(true, { color: '#ffc840', strength: 1 });
  else visuals.vfx.aura(false);
}

async function bossAttack(name) {
  const dur = 1.4; const t0 = performance.now();
  await new Promise((res) => { const step = () => { const t = (performance.now() - t0) / 1000 / dur; visuals.boss.telegraph(name, Math.min(1, t)); if (t < 1) requestAnimationFrame(step); else res(); }; step(); });
  visuals.boss.attack(name);
}

// ------------------------------------------------------------------------------------------- UI
const mkBtn = (parent, label, fn, cls) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; if (cls) b.className = cls; $(parent).appendChild(b); return b; };
const ACTS = [['title', 'Title'], [0, 'Act 1 amber'], [1, 'Act 2 magenta'], [2, 'Act 3 violet'], ['boss', 'Boss night'], ['results', 'Results']];
let curAct = 'title';
const actBtns = ACTS.map(([a, l]) => mkBtn('acts', l, () => setAct(a)));
function setAct(a) { curAct = a; visuals.stage.setAct(a); actBtns.forEach((b, i) => b.classList.toggle('on', ACTS[i][0] === a)); }
setAct('title');
const outBtns = outcomeModes.map((m) => mkBtn('outcomes', m, () => { outcome = m; outBtns.forEach((b) => b.classList.toggle('on', b.textContent === m)); }));
outBtns[0].classList.add('on');
for (const t of visuals.spirits.types) mkBtn('spawns', t, () => spawn(t));
$('wave').onclick = () => wave(8);
$('clear').onclick = () => { visuals.spirits.releaseAll(); live.length = 0; };
mkBtn('bossBtns', 'Show', () => { setAct('boss'); visuals.boss.show(); });
mkBtn('bossBtns', 'Slam', () => bossAttack('slam'));
mkBtn('bossBtns', 'Sweep', () => bossAttack('sweep'));
mkBtn('bossBtns', 'Barrage', () => bossAttack('barrage'));
mkBtn('bossBtns', 'Stagger', () => visuals.boss.stagger());
let weakOpen = false;
mkBtn('bossBtns', 'Weak point', () => { weakOpen = !weakOpen; visuals.boss.openWeakPoint(weakOpen); });
mkBtn('bossBtns', 'Hit', () => visuals.boss.hit('perfect'));
mkBtn('bossBtns', 'Defeat', () => visuals.boss.defeat());
mkBtn('bossBtns', 'Hide', () => visuals.boss.hide());
mkBtn('vfxBtns', 'Charge aura', () => charge(!charging));
mkBtn('vfxBtns', 'Overdrive', () => { overdrive = !overdrive; refreshAura(); });
mkBtn('vfxBtns', 'BLAST', blast);
mkBtn('vfxBtns', 'Shockwave', () => visuals.vfx.shockwave(new THREE.Vector3(0, 0, 0)));
mkBtn('vfxBtns', 'Judgements', () => { ['perfect', 'great', 'good', 'miss'].forEach((k, i) => visuals.vfx.judgement(new THREE.Vector3(0.9 - i * 0.6, 1.5, 0.8), k)); });
mkBtn('vfxBtns', 'Pulse', () => visuals.stage.pulse(1.5));
for (const c of Object.keys(CAMS)) mkBtn('camBtns', c, () => setCam(c));
let beatOn = true; $('beat').onclick = () => { beatOn = !beatOn; $('beat').classList.toggle('on', beatOn); };
$('hero').onclick = () => { if (hero) { hero.root.visible = !hero.root.visible; $('hero').classList.toggle('on', hero.root.visible); } };
const toggleUI = () => { $('panel').classList.toggle('hidden'); $('stats').style.display = $('panel').classList.contains('hidden') ? 'none' : ''; };
$('hide').onclick = toggleUI;
addEventListener('keydown', (e) => { if (e.key === 'u' || e.key === 'U') toggleUI(); });

// ------------------------------------------------------------------------------------------- loop
const clock = new THREE.Clock();
let songTime = 0, frames = 0, msAcc = 0, fps = 0, lastStat = performance.now(), cpuMs = 0;
const stats = { calls: 0, tris: 0 };
const _hp = new THREE.Vector3();
function frame(dtOverride) {
  const dt = dtOverride ?? Math.min(0.05, clock.getDelta());
  const c0 = performance.now();
  songTime += dt;
  const beat = songTime / BEAT;
  stepSpirits(dt);
  visuals.stage.update(dt, { beat: beatOn ? beat : undefined, act: curAct, intensity: 0.5, overdrive });
  visuals.spirits.update(dt);
  visuals.boss.update(dt);
  visuals.vfx.update(dt);
  if (hero) {
    hero.update?.(dt);
    hero.bones.hips.getWorldPosition(_hp); _hp.y += 0.25;
    heroLights.update(camera, _hp);
  }
  ctx.fx.update(dt);
  renderer.info.reset();
  if (hero?.materials?.updateFrame) { camera.updateMatrixWorld(); hero.materials.updateFrame(camera, heroLights); }
  post.render(dt);
  stats.calls = renderer.info.render.calls; stats.tris = renderer.info.render.triangles;
  cpuMs += performance.now() - c0;
}
function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  frame();
  frames++;
  if (now - lastStat > 500) {
    fps = frames * 1000 / (now - lastStat); msAcc = cpuMs / frames; frames = 0; cpuMs = 0; lastStat = now;
    const v = visuals.stats();
    $('stats').textContent = `${fps.toFixed(0)} fps  cpu ${msAcc.toFixed(2)} ms\ncalls ${stats.calls}  tris ${(stats.tris / 1000).toFixed(1)}k\nspirits ${v.spirits}  sprites ${v.sprites}  shards ${v.shardBursts}\n${quality.preset.id} dpr ${quality.dpr.toFixed(2)}`;
  }
}
loop();

// ------------------------------------------------------------------------------------------- automation
const rt = new THREE.WebGLRenderTarget(64, 64);
window.lab = {
  visuals, hero, camera, renderer, quality, setAct, spawn, wave, blast, charge, setCam, bossAttack,
  outcome: (m) => { outcome = m; },
  overdrive: (on) => { overdrive = on; refreshAura(); },
  /** Advance the simulation n frames synchronously (rAF is throttled in headless/background tabs). */
  step(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) frame(dt); return stats; },
  stats: () => ({ ...stats, ...visuals.stats(), fps, cpuMs: msAcc }),
  /** Draw calls / triangles of the world scene alone (stage + boss + spirits), rendered once off-screen. */
  stageInfo() {
    renderer.info.reset(); renderer.setRenderTarget(rt); renderer.render(worldScene, camera); renderer.setRenderTarget(null);
    return { calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
  },
  /** Average GPU+CPU frame time over n synchronous frames (gl.finish each frame). */
  perf(n = 120) {
    const gl = renderer.getContext(); const t0 = performance.now();
    for (let i = 0; i < n; i++) { frame(1 / 60); gl.finish(); }
    return { msPerFrame: +((performance.now() - t0) / n).toFixed(2), ...stats };
  },
};
