// BREAKLIGHT CV lab: standalone test bed for the Mirror Moment + Photo Booth.
// Camera sources: 'fake' (the demo GIF's video region -> canvas.captureStream(30) -> <video>), 'real' (webcam), 'demo'
// (synthetic player, no camera: skeleton fallback). The pose tracker is the game's MediaPipeSource on that same video,
// driving the VRM hero through the real motion pipeline, so the echo / photo booth see exactly what the game would.
// Automation handle: window.lab.
import * as THREE from 'three';
import { configureRenderer, autoResize } from '../../render/pipeline.js';
import { createPostChain } from '../../render/post.js';
import { createHeroLights } from '../../render/heroLights.js';
import { QualityManager } from '../../render/quality.js';
import { loadVRMHero } from '../../vrm/hero.js';
import { applyPose } from '../../render/posePresets.js';
import { createMotionPipeline } from '../../motion/index.js';
import { MediaPipeSource } from '../../sources/mediapipeSource.js';
import { SyntheticSource } from '../../sources/syntheticSource.js';
import { Camera } from '../../sources/camera.js';
import { createMirror, createPhotoBooth, heroScreenRect, detectVictoryPose, pointsFromHero } from './index.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const qMode = params.get('q') || 'high';
const video = $('srcVideo');

// ------------------------------------------------------------------------------------------ renderer + scenes
const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: false, powerPreference: 'high-performance', stencil: false });
configureRenderer(renderer, { postToneMapping: true });
renderer.info.autoReset = false;
const worldScene = new THREE.Scene();
const heroScene = new THREE.Scene();
worldScene.background = new THREE.Color(0x2a1a3a);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 600);
const post = createPostChain(renderer, worldScene, heroScene, camera);
const heroLights = createHeroLights(heroScene, { sunDirection: new THREE.Vector3(-0.35, 0.55, 0.75).normalize() });
let quality;
autoResize(renderer, camera, { pixelRatio: () => quality?.dpr ?? Math.min(devicePixelRatio, 2), onResize: (w, h) => post.setSize(w, h) });
quality = new QualityManager({ mode: qMode, apply: (p) => { post.setPreset(p); heroLights.setShadows(p.shadows, p.shadowMap); } });
$('quality').value = qMode;
$('quality').onchange = () => { params.set('q', $('quality').value); location.search = params.toString(); };

const CAMS = {
  gameplay: { pos: [0, 2.2, -4.2], look: [0, 1.5, 6] },
  sky: { pos: [0, 1.6, -5], look: [0, 6, 30] },
  front: { pos: [-1.15, 1.05, 3.6], look: [-1.15, 0.95, 0] },
};
let camName = 'gameplay';
function setCam(n) { camName = n; const c = CAMS[n]; camera.position.set(...c.pos); camera.lookAt(new THREE.Vector3(...c.look)); }
setCam('gameplay');

const ctx = { THREE, renderer, camera, worldScene, heroScene, hero: null, motion: null, fx: null, audio: null, quality, settings: {}, bus: null, time: { now: 0, dt: 0, beat: 0, act: 1 } };

// ------------------------------------------------------------------------------------------ hero + motion + stage
const hero = await loadVRMHero('/vrm/Sakurada_Fumiriya.vrm', { camera, renderer, quality: quality.tier });
heroScene.add(hero.root);
hero.setCamera?.(camera);
hero.materials?.setQuality?.(quality.preset.outlines);
heroLights.setHeroHeight(hero.info?.height || 1.6);
const motion = await createMotionPipeline({ hero, options: { mirror: false, predict: true, predictMs: 50, footLock: true, ikArms: true, accents: true, hands: 'pose' } });
hero.fingersExternal = motion.options.hands !== 'off';
ctx.hero = hero; ctx.motion = motion;

let stage = null;
try {
  const { createVisuals } = await import('../visual/index.js');
  const vis = await createVisuals(ctx);
  stage = vis.stage; worldScene.add(stage.object); stage.setAct?.(1);
} catch (e) { console.info('[cv-lab] stage unavailable, plain background', e?.message || e); }

// ------------------------------------------------------------------------------------------ CV modules
const mirror = createMirror({ video, renderer, scene: worldScene, camera, hero, quality: qMode === 'auto' ? 'high' : qMode, model: params.get('model') || 'pose-lite', echo: { position: new THREE.Vector3(0, 13, 74), height: 40 } });
$('calib').appendChild(mirror.canvas);
const replayCanvasHost = $('replay');
const demoStats = () => ({ score: 184250, rank: 'S', accuracy: 0.93, maxCombo: 87, body: { fastestPunch: 6.4, maxJumpCm: 31, bestReactionMs: 287, kcal: 41 }, timingMs: 38 });
const booth = createPhotoBooth({ video, renderer, heroScene, camera, hero, mirror, motion, getStats: demoStats });
let lastCapture = null;
booth.onCapture((blob, dataURL) => { lastCapture = { size: blob?.size || 0, type: blob?.type, dataURLLength: dataURL.length }; console.info('[cv-lab] photo captured', lastCapture.size, 'bytes'); });

// ------------------------------------------------------------------------------------------ camera sources
let source = null, camShimStop = null, gifStop = null, realCam = null, srcName = null;
const camShim = { listeners: new Set(), onFrame(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); } };
function startShim() {
  let on = true;
  const loop = () => { if (!on) return; video.requestVideoFrameCallback((now) => { for (const cb of camShim.listeners) cb(video, now); loop(); }); };
  loop();
  return () => { on = false; };
}

async function startFakeCamera() {
  // GIF frames are decoded into `src`; `cv` (the stream) is repainted at 30 Hz like a real webcam (repeated frames)
  const src = document.createElement('canvas'); src.width = 320; src.height = 200;
  const c = src.getContext('2d');
  const cv = document.createElement('canvas'); cv.width = 320; cv.height = 200;
  const out = cv.getContext('2d');
  let stop = false;
  const pump = setInterval(() => out.drawImage(src, 0, 0), 1000 / 30);
  const data = await (await fetch('/test/demo_desktop.gif')).arrayBuffer();
  if ('ImageDecoder' in window) {
    const dec = new ImageDecoder({ data, type: 'image/gif' });
    await dec.tracks.ready;
    const n = dec.tracks.selectedTrack.frameCount;
    let i = 0;
    const next = async () => {
      if (stop) return;
      const t0 = performance.now();
      let image;
      try { ({ image } = await dec.decode({ frameIndex: i })); } catch { return; }   // decoder closed (source switched)
      c.drawImage(image, 0, 52, 320, 200, 0, 0, 320, 200);
      const dur = (image.duration || 66000) / 1000;
      image.close();
      i = (i + 1) % n;
      setTimeout(next, Math.max(10, dur - (performance.now() - t0)));
    };
    await next();
    gifStop = () => { stop = true; clearInterval(pump); dec.close(); };
  } else {
    const img = new Image(); img.src = URL.createObjectURL(new Blob([data], { type: 'image/gif' }));
    img.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
    document.body.appendChild(img); await img.decode();
    const id = setInterval(() => c.drawImage(img, 0, 52, 320, 200, 0, 0, 320, 200), 33);
    gifStop = () => { clearInterval(id); clearInterval(pump); img.remove(); };
  }
  video.srcObject = cv.captureStream(30);
  await video.play();
}

async function setSource(name) {
  source?.stop?.(); source = null;
  camShimStop?.(); camShimStop = null;
  gifStop?.(); gifStop = null;
  realCam?.stop(); realCam = null;
  if (video.srcObject && name !== 'real') { video.srcObject = null; }
  srcName = name;
  let src;
  if (name === 'demo') {
    video.srcObject = null;
    src = new SyntheticSource();
  } else {
    if (name === 'real') { realCam = new Camera(video); await realCam.start(); src = new MediaPipeSource(realCam); }
    else { await startFakeCamera(); camShimStop = startShim(); src = new MediaPipeSource(camShim); }
  }
  src.onPose = (f) => mirror.setTrackerFrame(f);
  motion.setSource(src);
  await src.start();
  source = src;
  motion.calibrate();
  video.style.display = name === 'demo' ? 'none' : 'block';
  refreshButtons();
  return name;
}

// ------------------------------------------------------------------------------------------ hero pose recording (lab-side 3D replay)
const poseRec = [];
let recording = true, replaying = null, posePreset = null;
function recordPose(now) {
  if (!recording || replaying) return;
  const last = poseRec[poseRec.length - 1];
  if (last && now - last.t < 33) return;
  poseRec.push({ t: now, pose: hero.getHumanoidPose() });
  while (poseRec.length && now - poseRec[0].t > 20000) poseRec.shift();
}
function poseAt(t) { let best = poseRec[0]; for (const p of poseRec) { if (p.t <= t) best = p; else break; } return best; }

function startReplay() {
  const r = mirror.recorded;
  if (!r || poseRec.length < 10) return false;
  const to = Math.min(r.t1, poseRec[poseRec.length - 1].t), from = Math.max(r.t0, poseRec[0].t, to - 5000);
  mirror.playReplay({ from, to, rate: 0.35 });
  replaying = { from, to, t: from };
  replayCanvasHost.appendChild(mirror.canvas);
  $('replay').classList.add('show'); $('replayHero').style.display = 'block'; $('calib').classList.remove('show');
  setCam('front');
  return true;
}
function stopReplay() {
  replaying = null; $('replay').classList.remove('show'); $('replayHero').style.display = 'none';
  $('calib').appendChild(mirror.canvas);
  setCam('gameplay');
  if (recording) mirror.record(true);   // playReplay() froze the buffer
}

// ------------------------------------------------------------------------------------------ UI
let overdrive = false;
function setMode(m) {
  if (replaying && m !== 'replay') stopReplay();
  if (m === 'replay') { if (!startReplay()) return; }
  else mirror.setMode(m);
  $('calib').classList.toggle('show', m === 'calibrate');
  if (m === 'echo') setCam('sky'); else if (m !== 'replay') setCam('gameplay');
  refreshButtons();
}
function refreshButtons() {
  for (const b of document.querySelectorAll('#modeBtns button')) b.classList.toggle('on', b.dataset.v === mirror.mode);
  for (const b of document.querySelectorAll('#srcBtns button')) b.classList.toggle('on', b.dataset.v === srcName);
  $('od').classList.toggle('on', overdrive);
}
for (const [v, label] of [['fake', 'Fake GIF'], ['real', 'Webcam'], ['demo', 'Demo (no cam)']]) {
  const b = document.createElement('button'); b.textContent = label; b.dataset.v = v; b.onclick = () => setSource(v).catch((e) => console.info('[cv-lab] source failed', e.message || e)); $('srcBtns').appendChild(b);
}
for (const v of ['off', 'calibrate', 'echo', 'replay']) {
  const b = document.createElement('button'); b.textContent = v; b.dataset.v = v; b.onclick = () => setMode(v); $('modeBtns').appendChild(b);
}
$('od').onclick = () => { overdrive = !overdrive; refreshButtons(); };
$('pour').onclick = () => pour();
$('framing').onclick = () => { const f = $('framing').textContent.endsWith('full') ? 'auto' : 'full'; mirror.setFraming(f); $('framing').textContent = `Framing: ${f}`; };
$('rec').onclick = () => { recording = !recording; mirror.record(recording); $('rec').classList.toggle('on', recording); };
$('play').onclick = () => setMode('replay');
$('arm').onclick = () => booth.arm();
$('fake').onclick = () => booth.trigger('vpose');
$('save').onclick = () => booth.download();
$('hide').onclick = () => $('panel').classList.toggle('hidden');
addEventListener('keydown', (e) => { if (e.key === 'u' || e.key === 'U') $('panel').classList.toggle('hidden'); });

async function pour(duration = 1150) {
  if (mirror.mode !== 'calibrate') setMode('calibrate');
  await new Promise((r) => setTimeout(r, 50));
  const rect = heroScreenRect(hero, camera, renderer.domElement);
  await mirror.pourInto(rect, { duration });
  mirror.setMode('off');
  $('calib').classList.remove('show');
  refreshButtons();
  return rect;
}

// ------------------------------------------------------------------------------------------ frame loop + perf
const BPM = 128;
let last = performance.now(), t = 0;
const perf = { on: false, frames: 0, frame: [], mirror: [], render: [], motion: [] };
const stageArgs = { beat: 0, act: 1, intensity: 0.7, overdrive: false };
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const rawMs = now - last; last = now;
  const dt = Math.min(0.05, rawMs / 1000);
  t += dt;
  quality.frame?.(rawMs);
  const beat = (t * BPM) / 60;
  const m0 = performance.now();
  if (replaying) {
    replaying.t += dt * 1000 * 0.35;
    if (replaying.t > replaying.to) replaying.t = replaying.from;
    mirror.setReplayTime(replaying.t);
    const p = poseAt(replaying.t); if (p) hero.applyHumanoidPose(p.pose);
  } else if (posePreset) applyPose(hero, posePreset);
  else motion.update(dt, now);
  hero.update(dt);
  recordPose(now);
  const m1 = performance.now();
  mirror.update(dt, { beat, overdrive, act: 1 });
  const m2 = performance.now();
  stageArgs.beat = beat; stageArgs.overdrive = overdrive;
  try { stage?.update(dt, stageArgs); } catch { /* */ }
  const _hp = new THREE.Vector3(); hero.bones.hips.getWorldPosition(_hp);
  heroLights.update(camera, _hp.setY(_hp.y + 0.25));
  renderer.info.reset();
  if (hero.materials?.updateFrame) hero.materials.updateFrame(camera, heroLights);
  post.render(dt);
  const m3 = performance.now();
  if (perf.on) { perf.frames++; perf.frame.push(rawMs); perf.mirror.push(m2 - m1); perf.render.push(m3 - m2); perf.motion.push(m1 - m0); }
  if ((perf.frames & 15) === 0 || !perf.on) statsText(rawMs);
}
let statAcc = 0;
function statsText(ms) {
  if (performance.now() - statAcc < 250) return;
  statAcc = performance.now();
  const s = mirror.stats;
  $('stats').textContent = `source  ${srcName}  → silhouette: ${s.kind}\nseg     ${s.status} ${s.delegate || ''} ${s.inWorker ? 'worker' : 'inline'}  q=${s.quality}\nseg fps ${s.segFps}   worker ${s.workerMs} ms (infer ${s.inferMs})\nmain    pump ${s.mainMs} ms (max ${s.mainMax})\nmirror  dom ${s.domMs} ms  echo ${s.echoMs} ms\nframe   ${ms.toFixed(1)} ms   booth ${booth.state}${booth.pose ? ' ' + booth.pose : ''}`;
}
requestAnimationFrame(frame);

const stat = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const avg = a.reduce((p, c) => p + c, 0) / a.length; return { avg: +avg.toFixed(3), p50: +s[s.length >> 1].toFixed(3), p95: +s[Math.floor(s.length * 0.95)].toFixed(3), max: +s[s.length - 1].toFixed(3) }; };

// ------------------------------------------------------------------------------------------ boot
mirror.record(true);
await setSource(params.get('src') || 'fake');
setMode(params.get('mode') || 'calibrate');
$('loading').remove();

window.lab = {
  mirror, booth, hero, motion, video, THREE, camera,
  setSource, setMode, pour, setCam,
  overdrive(on = true) { overdrive = on; refreshButtons(); },
  replay: () => setMode('replay'),
  arm: (o) => booth.arm(o),
  fake: (pose) => booth.trigger(pose),
  testPose(name) { posePreset = name || null; },
  victory() { const P = pointsFromHero(hero); const r = detectVictoryPose(P); const o = {}; for (const k in P) o[k] = P[k].toArray().map((v) => +v.toFixed(3)); return { ...r, P: o }; },
  lastCapture: () => lastCapture,
  stats: () => mirror.stats,
  heroRect: () => heroScreenRect(hero, camera, renderer.domElement),
  /** Measure ms frames: per-frame mirror.update cost, render, the segmenter's async main-thread work. */
  async perf(ms = 4000) {
    perf.frames = 0; perf.frame = []; perf.mirror = []; perf.render = []; perf.motion = []; perf.on = true;
    const s0 = { ...mirror.segmenter.stats };
    await new Promise((r) => setTimeout(r, ms));
    perf.on = false;
    const s = mirror.stats, st = mirror.segmenter.stats;
    const segEvents = st.frames - s0.frames;
    return { frames: perf.frames, fps: +(perf.frames / (ms / 1000)).toFixed(1), frame: stat(perf.frame), mirrorUpdate: stat(perf.mirror), render: stat(perf.render), motion: stat(perf.motion),
      segFps: +(segEvents / (ms / 1000)).toFixed(1), workerMs: s.workerMs, inferMs: s.inferMs, pumpMainMsPerSeg: s.mainMs, pumpMainMax: s.mainMax,
      segMainMsPerFrame: +((st.mainTotal - s0.mainTotal) / Math.max(1, perf.frames)).toFixed(3), dropped: st.dropped, mode: mirror.mode, kind: s.kind, quality: s.quality };
  },
};
