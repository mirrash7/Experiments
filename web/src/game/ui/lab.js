// UI Lab (web/ui-lab.html): a minimal ctx (camera, VRM hero, motion pipeline, stub audio/bus) around createUI so
// every screen, the hand cursor, calibration, tutorial verification, HUD and results can be exercised without
// CORE. The "player" is LabBot: the synthetic tracker plus scripted modes (point at a button with closed-loop
// aiming, T-pose, charge-blast, guard pulses, dodges, a latency sweep) and distance / tracking-loss simulation.
// URL: ?source=bot (default) | synthetic | mediapipe (with &fakecam=1: the GIF fake camera)   &screen=title
import * as THREE from 'three';
import { loadVRMHero } from '../../vrm/hero.js';
import { createMotionPipeline } from '../../motion/index.js';
import { SyntheticSource, SYN_PHASES } from '../../sources/syntheticSource.js';
import { Camera } from '../../sources/camera.js';
import { createUI } from './index.js';

const Q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ fake camera (same trick as web/src/main.js)
if (Q.get('fakecam')) {
  const img = new Image(); img.src = Q.get('fakecamSrc') || '/test/demo_desktop.gif';
  const cv = document.createElement('canvas'); cv.width = 640; cv.height = 400;
  const cx = cv.getContext('2d');
  setInterval(() => { if (img.complete && img.naturalWidth) cx.drawImage(img, 0, 52, 320, 200, 0, 0, 640, 400); }, 33);
  navigator.mediaDevices.getUserMedia = async () => cv.captureStream(30);
}

// ------------------------------------------------------------------ LabBot: synthetic player with scripted modes
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const ARM = [0.28, 0.27];
function limb(a, c, [l1, l2], pole) {
  const d = c.clone().sub(a); let L = d.length();
  const max = (l1 + l2) * 0.999;
  if (L > max) { d.multiplyScalar(max / L); c.copy(a).add(d); L = max; }
  d.normalize();
  const n = pole.clone().addScaledVector(d, -pole.dot(d)).normalize();
  const cosA = Math.min(1, Math.max(-1, (l1 * l1 + L * L - l2 * l2) / (2 * l1 * L)));
  return a.clone().addScaledVector(d, l1 * cosA).addScaledVector(n, l1 * Math.sqrt(1 - cosA * cosA));
}
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const CUSTOM = new Set(['still', 'tpose', 'point', 'blast', 'guardPulse', 'dodge', 'sweep']);
class LabBot extends SyntheticSource {
  constructor() {
    super({ rate: 30, latencyMs: 20 });
    this.mode = 'loop';        // 'loop' | SYN_PHASES | 'still' | 'tpose' | 'point' | 'blast' | 'guardPulse' | 'dodge' | 'sweep'
    this.dist = null;          // null | 'tooClose' | 'tooFar' | 'offLeft' | 'offRight'
    this.lost = false;
    this.pointHand = 'right';
    this.handTarget = V(-0.25, 1.4, 0.35);
    this.sweep = { f: 0.7, amp: 0.2, x0: -0.3 };
  }
  clock() { return (performance.now() - this.latencyMs - this._t0) / 1000; }
  setArm(P, side, W, pole, hand = 'open', palm = V(0, 0, 1)) {
    const J = P.joints, S = J[side + 'Shoulder'];
    const w = W.clone();
    const E = limb(S, w, ARM, pole);
    J[side + 'Elbow'] = E; J[side + 'Wrist'] = w;
    const along = w.clone().sub(E).normalize();
    J[side + 'Hand'] = w.clone().addScaledVector(along, 0.09);
    let ref = palm.clone().addScaledVector(along, -palm.dot(along));
    if (ref.lengthSq() < 1e-4) ref = V(0, 1, 0).addScaledVector(along, -along.y);
    ref.normalize();
    P.extra[side + 'Index'] = J[side + 'Hand'].clone().addScaledVector(ref, 0.035);
    P.extra[side + 'Pinky'] = J[side + 'Hand'].clone().addScaledVector(ref, -0.035);
    P.hand[side] = hand;
  }
  pose(t) {
    const m = this.mode;
    if (m === 'loop') { this.still = false; this.phase = null; return super.pose(t); }
    if (!CUSTOM.has(m) && SYN_PHASES.includes(m)) { this.still = false; this.phase = m; return super.pose(t); }
    // custom modes: start from the clean standing pose and animate on our own clock
    this.still = true; this.phase = null;
    const P = super.pose(0.5), J = P.joints, tt = this.clock();
    const down = (s) => this.setArm(P, s, V(s === 'left' ? 0.27 : -0.27, 0.95, 0.08), V(s === 'left' ? 0.3 : -0.3, 0, -1), 'relaxed');
    const guard = (s) => this.setArm(P, s, V(s === 'left' ? 0.12 : -0.12, 1.42, 0.3), V(s === 'left' ? 0.4 : -0.4, -1, -0.25), 'fist', V(0, 1, 0.3));
    if (m === 'still') { down('left'); down('right'); }
    else if (m === 'tpose') {
      this.setArm(P, 'left', V(0.73, 1.45, 0), V(0, -0.3, -1)); this.setArm(P, 'right', V(-0.73, 1.45, 0), V(0, -0.3, -1));
    } else if (m === 'point') {
      const s = this.pointHand, o = s === 'left' ? 'right' : 'left';
      const w = this.handTarget.clone();
      if (this.punchT) {                      // a jab from the pointing position: out in 90 ms, hold, retract
        const k = (performance.now() - this.punchT) / 1000;
        const p = k < 0.09 ? sm(0, 0.09, k) : k < 0.16 ? 1 : 1 - sm(0.16, 0.4, k);
        w.z += 0.32 * p; w.y += 0.04 * p;
        if (k > 0.45) this.punchT = 0;
      }
      this.setArm(P, s, w, V(s === 'left' ? 1 : -1, -0.8, -0.4), this.punchT ? 'fist' : 'point', V(0, 1, 0));
      down(o);
    } else if (m === 'sweep') {
      const x = this.sweep.x0 + this.sweep.amp * Math.sin(2 * Math.PI * this.sweep.f * tt);
      this.setArm(P, 'right', V(x, 1.38, 0.38), V(-1, -0.8, -0.4), 'open'); down('left');
    } else if (m === 'blast') {
      // 3.2 s loop: 0-0.25 raise, 0.25-1.55 hold hands up (charge), 1.55-1.7 two-hand push, hold, 2.3-2.8 back to guard
      const u = tt % 3.2;
      const up = sm(0, 0.25, u) * (1 - sm(1.55, 1.68, u));
      const push = sm(1.55, 1.68, u) * (1 - sm(2.3, 2.8, u));
      for (const s of ['left', 'right']) {
        const sg = s === 'left' ? 1 : -1;
        const g = V(sg * 0.12, 1.42, 0.3), hi = V(sg * 0.2, 1.95, 0.05), fw = V(sg * 0.13, 1.4, 0.58);
        const w = g.clone().lerp(hi, up).lerp(fw, push);
        this.setArm(P, s, w, V(sg * 0.5, -1, -0.3), push > 0.5 ? 'open' : 'fist', V(0, 1, 0.3));
      }
    } else if (m === 'guardPulse') {
      const u = tt % 2.0;
      if (u < 1.25) { guard('left'); guard('right'); } else { down('left'); down('right'); }
    } else if (m === 'dodge') {
      guard('left'); guard('right');
      const u = tt % 3.0, lean = u < 1.5 ? 0.42 * sm(0, 0.25, u) * (1 - sm(1.1, 1.4, u)) : -0.42 * sm(1.5, 1.75, u) * (1 - sm(2.6, 2.9, u));
      const hip = J.leftHip.clone().add(J.rightHip).multiplyScalar(0.5);
      const q = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), -lean);
      for (const k of Object.keys(J)) if (!/Hip|Knee|Ankle|Heel|Toe/.test(k)) J[k].sub(hip).applyQuaternion(q).add(hip);
      for (const k of Object.keys(P.extra)) P.extra[k].sub(hip).applyQuaternion(q).add(hip);
    }
    return P;
  }
  _emit() {
    if (this.lost) return;
    const real = this.onPose, d = this.dist;
    if (d) {
      this.onPose = (f) => {
        const sc = d === 'tooClose' ? 1.75 : d === 'tooFar' ? 0.45 : 1, dx = d === 'offLeft' ? -0.34 : d === 'offRight' ? 0.34 : 0;
        for (const p of f.kp2d) { p.x = 0.5 + (p.x - 0.5) * sc + dx; p.y = 0.55 + (p.y - 0.55) * sc; }
        if (d === 'tooClose') { f.conf.leftAnkle = 0.1; f.conf.rightAnkle = 0.1; }
        real(f);
      };
    }
    try { super._emit(); } finally { this.onPose = real; }
  }
}

// ------------------------------------------------------------------ scene
const renderer = new THREE.WebGLRenderer({ canvas: $('view'), antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
{
  const c = document.createElement('canvas'); c.width = 2; c.height = 256;
  const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#1b0b3f'); gr.addColorStop(0.55, '#7a2a7a'); gr.addColorStop(0.75, '#ff8a5c'); gr.addColorStop(1, '#2a1240');
  g.fillStyle = gr; g.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; scene.background = tex;
}
scene.add(new THREE.HemisphereLight(0xffe6f0, 0x3a2050, 1.7));
const sun = new THREE.DirectionalLight(0xffd0b0, 2.2); sun.position.set(-2, 4, 3); scene.add(sun);
const rim = new THREE.DirectionalLight(0x9f8bff, 1.4); rim.position.set(2, 3, -4); scene.add(rim);
const disc = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.6, 0.4, 48), new THREE.MeshStandardMaterial({ color: 0x3a2f4a, roughness: 0.9 }));
disc.position.y = -0.2; scene.add(disc);
const ring = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.18, 64), new THREE.MeshBasicMaterial({ color: 0x4ff3ff, transparent: true, opacity: 0.7 }));
ring.rotation.x = -Math.PI / 2; ring.position.y = 0.005; scene.add(ring);
const camera = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.05, 200);
const CAMS = {
  gameplay: { pos: V(0, 1.55, -4.6), look: V(0, 1.05, 0.6) },
  front: { pos: V(0, 1.3, 4.4), look: V(0, 0.98, 0) },
  orbit: { pos: V(2.6, 1.7, 3.6), look: V(0, 1.0, 0), orbit: true },
};
let camMode = 'orbit', orbitT = 0;
function setCam(m) { camMode = m; const c = CAMS[m]; camera.position.copy(c.pos); camera.lookAt(c.look); }
setCam('orbit');
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });

// ------------------------------------------------------------------ ctx
const sfxLog = [];
const audio = {
  unlock: async () => {}, sfx(name) { sfxLog.push(name); if (sfxLog.length > 200) sfxLog.shift(); },
  sfxLoop(name) { sfxLog.push(name + ':loop'); return { stop() { sfxLog.push(name + ':stop'); } }; },
  setVolume() {}, playSong() {}, stopSong() {}, setIntensity() {}, setOverdrive() {}, latencyMs: 0,
};
const listeners = {};
const bus = { on(t, cb) { (listeners[t] ||= new Set()).add(cb); return () => listeners[t].delete(cb); }, emit(t, d) { listeners[t]?.forEach((cb) => cb(d)); } };
const settings = { tracker: 'demo', mode: 'showcase', seated: Q.get('seated') === '1', upperBodyOnly: Q.get('upper') === '1', difficulty: 'normal', volume: { master: 0.9, music: 0.8, sfx: 0.9 }, judgeOffsetMs: 0, quality: 'high', dev: { debug: Q.get('debug') === '1' } };
const ctx = { THREE, renderer, camera, worldScene: scene, heroScene: scene, hero: null, motion: null, fx: null, audio, quality: { preset: 'high' }, settings, bus, time: { now: 0, dt: 0, beat: 0, act: 0 } };

const lab = { ctx, sfxLog, ready: false, errors: [] };
window.lab = lab;

const hero = await loadVRMHero('/vrm/Sakurada_Fumiriya.vrm', { camera, renderer });
scene.add(hero.root);
ctx.hero = hero;

let source, camDev = null;
const srcName = Q.get('source') || 'bot';
if (srcName === 'mediapipe') {
  camDev = new Camera(Object.assign(document.createElement('video'), { muted: true, playsInline: true }));
  await camDev.start();
  const { MediaPipeSource } = await import('../../sources/mediapipeSource.js');
  source = new MediaPipeSource(camDev);
} else if (srcName === 'synthetic') source = new SyntheticSource();
else source = new LabBot();
const motion = await createMotionPipeline({ hero, source, options: { mirror: false } });
ctx.motion = motion;
await source.start();

const ui = createUI(ctx);
lab.ui = ui; lab.bot = source instanceof LabBot ? source : null; lab.motion = motion; lab.hero = hero;
if (camDev) ui.hud.pip.setVideo(camDev.video);

// ------------------------------------------------------------------ screens wiring (a mini state machine)
const log = (...a) => { lab.lastEvent = a.join(' '); renderInfo(); };
lab.events = [];
const ev = (name, data) => { lab.events.push({ name, data, t: Math.round(performance.now()) }); log(name, data ? JSON.stringify(data) : ''); };
function hudOff() { ui.hud.show(false); hudDemo(false); }
const open = {
  boot: () => { hudOff(); setCam('orbit'); return ui.screens.boot({ current: settings.tracker, onTracker: (t) => { ev('tracker', t); settings.tracker = t; scr.setStatus?.(t === 'demo' ? 'Starting the demo player…' : 'Waiting for camera permission…', 'wait'); } }); },
  calibrate: () => { hudOff(); setCam('front'); return ui.screens.calibrate({ silhouetteCanvas: lab.mirror ? fakeSil.canvas : null, onDone: (r) => { ev('calibrated', r); go('title'); } }); },
  calibMirror: () => { lab.mirror = true; const r = open.calibrate(); lab.mirror = false; return r; },
  clearSpace: () => { hudOff(); setCam('front'); return ui.screens.clearSpace({ autoContinue: lab.autoDrive, onDone: (r) => { ev('clearSpace', r); go('calibrate'); } }); },
  title: () => { hudOff(); setCam('orbit'); return ui.screens.title({ best: 184230, onMode: (m) => ev('mode', m), onPlay: () => { ev('play'); go('countdown'); }, onTutorial: () => { ev('tutorial'); go('tutorial'); }, onSettings: () => { ev('settings'); go('settings'); } }); },
  tutorial: () => { hudOff(); setCam('gameplay'); return ui.screens.tutorial({ onDone: (r) => { ev('tutorialDone', r); go('title'); } }); },
  settings: () => { hudOff(); return ui.screens.settings({ settings, onChange: (k, v) => ev('setting', { k, v }), onClose: () => { ev('settingsClose'); go('title'); } }); },
  pause: () => { setCam('gameplay'); return ui.screens.pause({ reason: 'player-lost' }); },
  pauseUser: () => ui.screens.pause({ reason: 'user', onResume: () => { ev('resume'); go('hud'); }, onQuit: () => { ev('quit'); go('title'); } }),
  countdown: () => {
    ui.screens.hide(); setCam('gameplay'); ui.hud.show(true);
    [3, 2, 1, 0].forEach((n, i) => setTimeout(() => ui.screens.countdown(n), i * 800));
    setTimeout(() => go('hud'), 3300);
    return null;
  },
  hud: () => { ui.screens.hide(); setCam('gameplay'); ui.hud.show(true); hudDemo(true); return null; },
  results: () => { hudOff(); setCam('front'); const r = ui.screens.results({ stats: fakeStats(), onReplay: () => { ev('replay'); simReplay(); }, onAgain: () => { ev('again'); go('countdown'); }, onTitle: () => { ev('title'); go('title'); } }); setTimeout(simReplay, 1200); return r; },
  resultsPlain: () => { hudOff(); setCam('front'); return ui.screens.results({ stats: fakeStats({ newBest: false, best: 201400, replay: null, body: { punchSpeed: 5.1, jumpHeight: 0, reactionMs: null, moves: 96, kcal: 18 } }), onAgain: () => go('countdown'), onTitle: () => go('title') }); },
  hide: () => { hudOff(); return ui.screens.hide(); },
};
let scr = null;
function go(name) { scr = open[name]?.() ?? null; lab.screen = name; autoBot(); renderInfo(); return scr; }
lab.go = go;

function fakeStats(o = {}) {
  return { score: 184230, maxCombo: 87, judgements: { perfect: 142, great: 61, good: 18, miss: 7 }, newBest: true, prevBest: 151870, mode: 'showcase',
    replay: { seconds: 5.2, hits: 9, speed: 0.35 },
    body: { punchSpeed: 7.4, jumpHeight: 34, reactionMs: 362, timingSdMs: 31, moves: 236, kcal: 41, moveCounts: { punch: 132, kick: 28, jump: 14, squat: 16, dodge: 22, guard: 18, blast: 6 } }, ...o };
}
// replay simulation (what CORE sends): bus 'replay' start → progress → end over ~5 s
let replayTimer = null;
function simReplay(seconds = 5) {
  clearInterval(replayTimer);
  const t0 = performance.now();
  bus.emit('replay', { type: 'start', on: true, label: 'Best moment', speed: 0.35, hits: 9, seconds: 5.2 });
  replayTimer = setInterval(() => {
    const p = (performance.now() - t0) / (seconds * 1000);
    if (p >= 1) { clearInterval(replayTimer); bus.emit('replay', { type: 'end', on: false }); return; }
    bus.emit('replay', { type: 'progress', progress: p });
  }, 100);
}
lab.simReplay = simReplay;
// fake "Mirror Moment" silhouette (stands in for the CV team's segmentation canvas): a soft body mask from kp2d
const fakeSil = { canvas: document.createElement('canvas') };
fakeSil.canvas.width = 480; fakeSil.canvas.height = 270;
fakeSil.draw = () => {
  const c = fakeSil.canvas, g = c.getContext('2d'), f = motion.lastFrame;
  g.clearRect(0, 0, c.width, c.height);
  if (!f?.kp2d || !f.edges) return;
  g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
  g.strokeStyle = 'rgba(255,120,230,0.9)'; g.shadowColor = '#ff4fd8'; g.shadowBlur = 18; g.lineWidth = c.height * 0.07;
  g.beginPath();
  for (const [a, b] of f.edges) { const A = f.kp2d[a], B = f.kp2d[b]; if (!A || !B) continue; g.moveTo(A.x * c.width, A.y * c.height); g.lineTo(B.x * c.width, B.y * c.height); }
  g.stroke();
  const nose = f.kp2d[0]; if (nose) { g.fillStyle = 'rgba(255,120,230,0.9)'; g.beginPath(); g.arc(nose.x * c.width, nose.y * c.height, c.height * 0.055, 0, 7); g.fill(); }
  g.restore();
};
lab.fakeSil = fakeSil;
lab.fakeStats = fakeStats;

// tutorial / calibration auto-drive: the bot performs whatever the screen asks for
const DRILL_MODE = { punch: 'punch', kick: 'kick', jump: 'jump', duck: 'squat', dodge: 'dodge', guard: 'guardPulse', blast: 'blast' };
lab.autoDrive = Q.get('auto') !== '0';
function autoBot() {
  const b = lab.bot; if (!b || !lab.autoDrive) return;
  const s = ui.screens.current;
  if (s === 'calibrate') b.mode = 'tpose';
  else if (s === 'clearSpace') b.mode = 'still';
  else if (s === 'tutorial') b.mode = DRILL_MODE[scr?.drill] || 'guard';
  else if (s === 'title' || s === 'boot' || s === 'settings' || s === 'results') { if (!['point', 'wave', 'punch'].includes(b.mode)) b.mode = 'wave'; }
}

// ------------------------------------------------------------------ closed-loop pointing (the bot "looks" at the cursor)
lab.aim = null;   // { el, until }
lab.pointAt = (selOrEl, ms = 4000) => {
  const el = typeof selOrEl === 'string' ? document.querySelector(selOrEl) : selOrEl;
  if (!el || !lab.bot) return false;
  const r = el.getBoundingClientRect();
  const u = (r.left + r.width / 2) / innerWidth, v = (r.top + r.height / 2) / innerHeight;
  const b = lab.bot;
  b.pointHand = u < 0.42 ? 'left' : 'right';
  const L = 0.55, sg = b.pointHand === 'left' ? 1 : -1;
  const relx = -((u - 0.5) * 1.1 * L - sg * 0.2 * L), rely = (0.5 - v) * 0.85 * L - 0.12 * L;
  b.handTarget.set(relx, 1.42 + rely, 0.35);
  b.mode = 'point';
  lab.aim = { el, u, v, until: performance.now() + ms };
  return true;
};
lab.punchAt = (sel, ms = 4000) => { const ok = lab.pointAt(sel, ms); if (ok) lab.aim.punch = true; return ok; };
function aimStep() {
  const a = lab.aim, b = lab.bot;
  if (!a || !b) return;
  if (a.punch && !b.punchT && ui.cursor.state.target === a.el && ui.cursor.state.dwell > 0.12) { b.punchT = performance.now(); a.punch = false; a.freeze = true; }
  if (a.freeze) return;               // hold the aim still while punching
  if (performance.now() > a.until || !a.el.isConnected) { lab.aim = null; b.mode = 'wave'; return; }
  const c = ui.cursor.state;
  if (c.source !== 'hand' || !c.engaged) return;
  // aim with the display-space mapping (reticle px ← raw u: px = (0.03 + 0.94u)W)
  const du = (a.u - 0.03) / 0.94 - c.raw.u, dv = (a.v - 0.04) / 0.92 - c.raw.v;
  const L = 0.55;
  b.handTarget.x -= du * 1.1 * L * 0.08;
  b.handTarget.y -= dv * 0.85 * L * 0.08;
}

// ------------------------------------------------------------------ HUD demo (fake gameplay at 128 BPM)
let demoTimer = null;
const D = { score: 0, combo: 0, hp: 5, flow: 0, od: 0, beat: 0 };
const _p = new THREE.Vector3();
function heroScreenPos(side) {
  const b = side === 'left' ? hero.bones.leftHand : hero.bones.rightHand;
  b.getWorldPosition(_p); _p.z += 0.4; _p.project(camera);
  return { x: (_p.x + 1) / 2 * innerWidth, y: (1 - _p.y) / 2 * innerHeight };
}
function hudDemo(on) {
  clearInterval(demoTimer); demoTimer = null;
  if (!on) return;
  Object.assign(D, { score: 0, combo: 0, hp: 5, flow: 0, od: 0, beat: 0 });
  ui.hud.setHealth(5, 5); ui.hud.setScore(0); ui.hud.setCombo(0, 1); ui.hud.setFlow(0, false); ui.hud.prompt(null);
  ui.hud.banner('ACT 1', 'DUSK OVER THE SKY ISLAND');
  demoTimer = setInterval(() => {
    D.beat++;
    if (D.beat % 2) return;
    const r = Math.random();
    const kind = r < 0.45 ? 'perfect' : r < 0.75 ? 'great' : r < 0.92 ? 'good' : 'miss';
    const side = Math.random() < 0.5 ? 'left' : 'right';
    ui.hud.judgement(heroScreenPos(side), kind, { errMs: kind === 'miss' ? null : Math.round((Math.random() - 0.5) * (kind === 'perfect' ? 160 : 300)) });
    if (kind === 'miss') { D.combo = 0; D.hp = Math.max(0, D.hp - 1); if (D.hp === 0) D.hp = 5; }
    else { D.combo++; D.flow = Math.min(1, D.flow + 0.06); D.score += { perfect: 300, great: 200, good: 100 }[kind] * (D.od > 0 ? 2 : 1) * (1 + Math.min(3, Math.floor(D.combo / 10))); }
    const mult = D.combo >= 50 ? 4 : D.combo >= 25 ? 3 : D.combo >= 10 ? 2 : 1;
    if (D.flow >= 1 && D.od <= 0) { D.od = 21; ui.hud.banner('OVERDRIVE', 'DOUBLE POINTS'); }
    if (D.od > 0) { D.od--; D.flow = D.od / 21; if (D.od === 0) D.flow = 0; }
    ui.hud.setScore(D.score); ui.hud.setCombo(D.combo, mult); ui.hud.setHealth(D.hp, 5); ui.hud.setFlow(D.flow, D.od > 0);
    if (D.beat % 24 === 0) ui.hud.prompt('DUCK!'); else if (D.beat % 24 === 4) ui.hud.prompt(null);
  }, 60000 / 128);
}
lab.hudDemo = hudDemo;

// ------------------------------------------------------------------ latency measurement (sweep mode)
lab.measureLatency = async (seconds = 5) => {
  const b = lab.bot; if (!b) return 'needs the bot source';
  const prevMode = b.mode; b.mode = 'sweep';
  ui.cursor.enable(true);
  await new Promise((r) => setTimeout(r, 1200));
  const S = [];
  const t0 = performance.now();
  await new Promise((resolve) => {
    (function tick() {
      const now = performance.now();
      const tt = (now - b._t0) / 1000;           // physical "now" of the synthetic player (no capture latency)
      const truth = b.sweep.x0 + b.sweep.amp * Math.sin(2 * Math.PI * b.sweep.f * tt);
      S.push({ t: now, truth: -truth, u: ui.cursor.state.raw.u, x: ui.cursor.state.x });
      if (now - t0 < seconds * 1000) requestAnimationFrame(tick); else resolve();
    })();
  });
  b.mode = prevMode; ui.cursor.enable('auto');
  // resample to 2 ms and cross-correlate (lag of the cursor behind the hand)
  const best = (key) => {
    const T0 = S[0].t, T1 = S.at(-1).t, step = 2;
    const at = (arr, t) => { let i = 1; while (i < arr.length - 1 && arr[i].t < t) i++; const a = arr[i - 1], c = arr[i]; const k = (t - a.t) / Math.max(1e-6, c.t - a.t); return { truth: a.truth + (c.truth - a.truth) * k, v: a[key] + (c[key] - a[key]) * k }; };
    const tr = [], cu = [];
    for (let t = T0 + 400; t < T1; t += step) { const r = at(S, t); cu.push(r.v); }
    for (let t = T0; t < T1; t += step) tr.push(at(S, t).truth);
    const norm = (a) => { const m = a.reduce((s, x) => s + x, 0) / a.length; const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) || 1; return a.map((x) => (x - m) / sd); };
    const C = norm(cu);
    let bl = 0, bc = -2;
    for (let lag = 0; lag <= 200; lag++) {               // 0..400 ms
      const seg = norm(tr.slice(200 - lag, 200 - lag + C.length));
      if (seg.length < C.length) break;
      let c = 0; for (let i = 0; i < C.length; i++) c += C[i] * seg[i];
      c /= C.length;
      if (c > bc) { bc = c; bl = lag * step; }
    }
    return { lagMs: bl, corr: +bc.toFixed(3) };
  };
  const res = { raw: best('u'), displayed: best('x'), samples: S.length, trackerLatencyMs: b.latencyMs, trackerRate: b.rate };
  lab.latency = res; renderInfo();
  return res;
};

// ------------------------------------------------------------------ lab panel
const panel = $('lab');
const B = (label, fn, cls = '') => { const b = document.createElement('button'); b.textContent = label; b.className = cls; b.onclick = fn; return b; };
const row = (...kids) => { const d = document.createElement('div'); d.className = 'row'; d.append(...kids); return d; };
const H = (t) => { const e = document.createElement('h4'); e.textContent = t; return e; };
const info = document.createElement('pre');
const title = H('UI lab ▾'); title.onclick = () => panel.classList.toggle('min');
panel.append(title,
  H('Screens'), row(...['boot', 'clearSpace', 'calibrate', 'title', 'tutorial', 'settings', 'pause', 'pauseUser', 'countdown', 'hud', 'results', 'hide'].map((n) => B(n, () => go(n)))),
  H('HUD tests'), row(B('banner', () => ui.hud.banner('WARNING', 'ECLIPSE WARDEN APPROACHES')), B('prompt', () => ui.hud.prompt(ui.hud.state.prompt ? null : 'JUMP!')),
    B('perfect', () => ui.hud.judgement(heroScreenPos('right'), 'perfect', { errMs: 12 })), B('miss', () => ui.hud.judgement(heroScreenPos('left'), 'miss')),
    B('overdrive', () => ui.hud.setFlow(1, !ui.hud.state.overdrive)), B('hurt', () => ui.hud.setHealth(Math.max(0, (ui.hud.state.health || 5) - 1), 5)),
    B('dist', () => ui.hud.distance(ui.hud.state.distanceRaw ? null : 'too-close')),
    B('act0', () => ui.hud.prompt(ui.hud.state.prompt ? null : 'LEFT PUNCH', ui.hud.state.prompt ? { success: true } : { move: 'punchLeft', wait: true, kicker: 'AWAKENING · 1 / 7' })),
    B('collide', () => { ui.hud.banner('WEAK POINT!', 'Charge your Breaklight'); ui.hud.prompt('HANDS UP — CHARGE!'); ui.hud.distance('too-close'); ui.hud.banner('OVERDRIVE!', 'Double points'); })),
  row(B('clearSpace', () => go('clearSpace')), B('calib+mirror', () => go('calibMirror')), B('seated', () => { settings.seated = !settings.seated; renderInfo(); }), B('resultsPlain', () => go('resultsPlain')),
    B('photo', () => { const c = document.createElement('canvas'); c.width = 300; c.height = 400; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 0, 400); gr.addColorStop(0, '#ff4fd8'); gr.addColorStop(1, '#4f6bff'); g.fillStyle = gr; g.fillRect(0, 0, 300, 400); g.fillStyle = '#fff'; g.font = '700 28px sans-serif'; g.fillText('PHOTO CARD', 60, 210); scr?.setPhotoCard?.({ node: c, caption: 'Victory pose · S rank' }); }),
    B('photo…', () => scr?.setPhotoCard?.({ pending: true }))),
  H('Bot player'), row(...['loop', 'wave', 'punch', 'guard', 'still', 'tpose', 'blast', 'guardPulse', 'dodge', 'kick', 'jump', 'squat'].map((m) => B(m, () => { if (lab.bot) { lab.bot.mode = m; lab.aim = null; renderInfo(); } }))),
  row(B('aim PLAY', () => lab.pointAt('[data-ui-button="play"]')), B('aim TUTORIAL', () => lab.pointAt('[data-ui-button="tutorial"]')), B('aim SETTINGS', () => lab.pointAt('[data-ui-button="settings"]'))),
  row(...[null, 'tooClose', 'tooFar', 'offLeft', 'offRight'].map((d) => B(d || 'in view', () => { if (lab.bot) lab.bot.dist = d; renderInfo(); })), B('lose/find', () => { if (lab.bot) lab.bot.lost = !lab.bot.lost; renderInfo(); })),
  H('Measure'), row(B('cursor latency', async () => { info.textContent = 'measuring…'; await lab.measureLatency(); }), B('auto-drive', (e) => { lab.autoDrive = !lab.autoDrive; e.target.classList.toggle('on', lab.autoDrive); })),
  info);
function renderInfo() {
  const c = ui.cursor.state;
  info.textContent = [`screen: ${lab.screen || '-'}  bot: ${lab.bot?.mode ?? srcName}${lab.bot?.dist ? ' / ' + lab.bot.dist : ''}${lab.bot?.lost ? ' / LOST' : ''}`,
    `cursor: ${c.source} ${c.engaged ? 'engaged' : 'idle'} ${c.hand} dwell ${c.dwell.toFixed(2)} selects ${c.selects}`,
    lab.latency ? `latency raw ${lab.latency.raw.lagMs} ms (r ${lab.latency.raw.corr}) shown ${lab.latency.displayed.lagMs} ms` : '',
    lab.lastEvent ? `event: ${lab.lastEvent}` : ''].filter(Boolean).join('\n');
}
setInterval(renderInfo, 500);
if (Q.get('clean')) panel.classList.add('min');

// ------------------------------------------------------------------ loop
let last = performance.now();
lab.frames = 0;
function frame() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  ctx.time.now = now / 1000; ctx.time.dt = dt;
  motion.update(dt, now);
  hero.update(dt);
  if (CAMS[camMode].orbit) { orbitT += dt * 0.12; const r = 4.4; camera.position.set(Math.sin(orbitT) * r * 0.6, 1.6, Math.cos(orbitT) * r); camera.lookAt(CAMS.orbit.look); }
  aimStep();
  if (ui.screens.current === 'calibrate') fakeSil.draw();
  if (ui.screens.current === 'tutorial') autoBot();
  ui.update(dt);
  renderer.render(scene, camera);
  lab.frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
addEventListener('error', (e) => lab.errors.push(String(e.message)));
go(Q.get('screen') || 'title');
lab.ready = true;
