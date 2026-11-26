// Motion Lab: a standalone test bed for the motion pipeline (web/motion-lab.html). Loads a VRM directly,
// implements the hero contract (applyHumanoidPose + info) on it, runs the pipeline from any source, and shows
// raw keypoints next to the avatar plus live latency / jitter / foot-skate / FK-error metrics.
// URL params: ?vrm=/vrm/x.vrm  &source=synthetic|still|clip|hmr|mediapipe  &fakecam=1 (GIF as the camera)
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { createMotionPipeline, toVRM0Pose } from './index.js';
import { MHRSkeleton } from './mhrFK.js';
import { SyntheticSource } from '../sources/syntheticSource.js';
import { RecordedSource, Recorder } from '../sources/recordedSource.js';
import { HMRSource } from '../sources/hmrSource.js';
import { Camera } from '../sources/camera.js';
import { createFx } from '../fx/index.js';
import { runTriggerTest, formatTriggerTest, runRobustness } from './triggerTest.js';
import { formatBench } from './moveBench.js';

const $ = (id) => document.getElementById(id);
const Q = new URLSearchParams(location.search);

// ------------------------------------------------------------------ fake camera (browser pane has no webcam)
if (Q.get('fakecam')) {
  const img = new Image(); img.src = '/test/demo_desktop.gif';
  const cv = document.createElement('canvas'); cv.width = 640; cv.height = 400;
  const cx = cv.getContext('2d');
  (function draw() { if (img.complete && img.naturalWidth) cx.drawImage(img, 0, 52, 320, 200, 0, 0, 640, 400); requestAnimationFrame(draw); })();
  setInterval(() => { if (img.complete && img.naturalWidth) cx.drawImage(img, 0, 52, 320, 200, 0, 0, 640, 400); }, 33);
  navigator.mediaDevices.getUserMedia = async () => cv.captureStream(30);
}

// ------------------------------------------------------------------ scene
const renderer = new THREE.WebGLRenderer({ canvas: $('view'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2029);
const cam = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.05, 60);
cam.position.set(0.5, 1.3, 4.2);
const controls = new OrbitControls(cam, renderer.domElement);
controls.target.set(0.4, 0.95, 0); controls.update();
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(1.5, 3, 2.5); scene.add(sun);
const grid = new THREE.GridHelper(8, 32, 0x3a4658, 0x262e3a); scene.add(grid);

// raw keypoint skeleton (floor frame, mirrored, scaled to the hero) drawn beside the avatar
const RAW_EDGES = [['leftShoulder', 'rightShoulder'], ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'], ['rightShoulder', 'rightElbow'],
  ['rightElbow', 'rightWrist'], ['leftShoulder', 'leftHip'], ['rightShoulder', 'rightHip'], ['leftHip', 'rightHip'], ['leftHip', 'leftKnee'],
  ['leftKnee', 'leftAnkle'], ['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle'], ['leftAnkle', 'leftHeel'], ['leftAnkle', 'leftToe'],
  ['rightAnkle', 'rightHeel'], ['rightAnkle', 'rightToe'], ['neck', 'nose'], ['leftWrist', 'leftHand'], ['rightWrist', 'rightHand']];
const rawGeo = new THREE.BufferGeometry();
rawGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAW_EDGES.length * 6), 3));
const rawLines = new THREE.LineSegments(rawGeo, new THREE.LineBasicMaterial({ color: 0x5ad1ff }));
scene.add(rawLines);
const footMarks = {};
for (const s of ['left', 'right']) {
  footMarks[s] = new THREE.Mesh(new THREE.RingGeometry(0.04, 0.06, 24), new THREE.MeshBasicMaterial({ color: 0x4ade80, side: THREE.DoubleSide }));
  footMarks[s].rotation.x = -Math.PI / 2; scene.add(footMarks[s]);
}
const lookTarget = new THREE.Vector3();

// ------------------------------------------------------------------ VRM + hero contract
const loader = new GLTFLoader();
loader.register((p) => new VRMLoaderPlugin(p));
let vrm = null, hero = null, pipeline = null, mhr = null, fx = null;

async function loadVRM(url) {
  if (vrm) { scene.remove(vrm.scene); VRMUtils.deepDispose(vrm.scene); }
  const gltf = await loader.loadAsync(url);
  vrm = gltf.userData.vrm;
  VRMUtils.rotateVRM0(vrm);
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  vrm.scene.traverse((o) => { o.frustumCulled = false; });
  scene.add(vrm.scene);
  const isVRM0 = vrm.meta?.metaVersion === '0';
  const rest = vrm.humanoid.normalizedRestPose;
  const hipsY = rest.hips.position[1];
  // the hero contract the game's VRM hero exposes: pose in the VRM1 convention, hips in hero-root metres
  hero = {
    vrm,
    info: { hipHeight: hipsY, vrm0: isVRM0 },
    // expression presets (same names as the game hero's setExpression); hold ~1.2 s then ease back
    setExpression(name) {
      const P = { determined: { angry: 0.45, happy: 0.12 }, angry: { angry: 0.7 }, happy: { happy: 0.85 }, surprised: { surprised: 0.8 }, relaxed: { relaxed: 0.7 } };
      this._expr = { target: P[name] ?? {}, until: performance.now() + 1200 }; lab.lastExpression = name;
    },
    updateExpression(dt) {
      const em = vrm.expressionManager; if (!em) return;
      const tgt = this._expr && performance.now() < this._expr.until ? this._expr.target : {};
      for (const n of ['angry', 'happy', 'surprised', 'relaxed']) {
        const cur = em.getValue(n) ?? 0, goal = tgt[n] ?? 0;
        em.setValue(n, cur + (goal - cur) * (1 - Math.exp(-dt * 12)));
      }
    },
    applyHumanoidPose(pose) {
      const p = isVRM0 ? toVRM0Pose(pose, this._tmp ??= { hips: new THREE.Vector3(), rotations: {} }) : pose;
      for (const [b, q] of Object.entries(p.rotations)) vrm.humanoid.getNormalizedBoneNode(b)?.quaternion.copy(q);
      vrm.humanoid.getNormalizedBoneNode('hips')?.position.copy(p.hips);
    },
  };
  return vrm;
}

// ------------------------------------------------------------------ sources
const camera = new Camera(Object.assign(document.createElement('video'), { muted: true, playsInline: true }));
let source = null, clip = null;
const recorder = new Recorder();

async function makeSource(name) {
  if (name === 'synthetic') return new SyntheticSource();
  if (name === 'still') return new SyntheticSource({ still: true, noise: 0.01 });
  if (name === 'clip') { clip ??= await RecordedSource.load('/motion/clips/demo-hmr.json'); return clip; }
  if (name === 'hmr' || name === 'mediapipe') {
    if (!camera.active) await camera.start();
    if (name === 'hmr') return new HMRSource(camera);
    const { MediaPipeSource } = await import('../sources/mediapipeSource.js');
    return new MediaPipeSource(camera);
  }
  throw new Error('unknown source ' + name);
}

let lastFrame = null;
async function setSource(name) {
  source?.stop();
  source = await makeSource(name);
  source.onStatus = (k, m) => { $('status').textContent = `${k}: ${m}`; };
  source.onPose = (f) => { lastFrame = f; recorder.push(f); };
  pipeline.setSource(source);
  pipeline.calibrate();
  await source.start();
  $('preview').style.display = name === 'hmr' || name === 'mediapipe' || name === 'clip' ? 'block' : 'none';
}

// ------------------------------------------------------------------ UI
function bindUI() {
  for (const el of document.querySelectorAll('[data-opt]')) {
    const k = el.dataset.opt;
    const set = () => { pipeline.options[k] = el.type === 'checkbox' ? el.checked : el.value; };
    el.onchange = set; set();
  }
  for (const el of document.querySelectorAll('[data-num]')) {
    const k = el.dataset.num;
    const set = () => { pipeline.options[k] = +el.value; $(k + 'V').textContent = el.value; };
    el.oninput = set; set();
  }
  $('follow').onchange = (e) => { pipeline.options.root.follow = e.target.checked; };
  $('lookat').onchange = (e) => { pipeline.options.lookAt = e.target.checked ? lookTarget : null; };
  $('calib').onclick = () => pipeline.calibrate();
  $('fx').onchange = (e) => fx?.setEnabled(e.target.checked);
  addEventListener('keydown', (e) => { if (e.key === 'c') pipeline.calibrate(); });
  $('source').onchange = (e) => setSource(e.target.value);
  $('vrm').onchange = async (e) => { await loadVRM(e.target.value); await buildPipeline(); await setSource($('source').value); };
  $('rec').onclick = () => {
    if (!recorder.active) { recorder.start(); $('rec').textContent = 'Stop'; $('dl').disabled = true; }
    else { lab.recorded = recorder.stop(); $('rec').textContent = 'Record'; $('dl').disabled = false; }
  };
  $('dl').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(lab.recorded)], { type: 'application/json' }));
    a.download = 'motion-clip.json'; a.click();
  };
}

async function buildPipeline() {
  const prevOpts = pipeline?.options;
  pipeline?.dispose();
  pipeline = await createMotionPipeline({ hero, mhr, options: prevOpts ? { ...prevOpts } : {} });
  pipeline.actions.on((name) => {
    const el = $('events');
    el.innerHTML = `<span class="tag on">${name}</span>` + el.innerHTML.split('</span>').slice(0, 6).join('</span>');
    lab.events.push({ name, t: performance.now() });
  });
  lab.pipeline = pipeline;
  if (!fx) fx = createFx({ scene, camera: cam, hero, motion: pipeline });
  else { fx.setHero(hero); fx.setMotion(pipeline); }
  fx.setEnabled($('fx')?.checked ?? true);
  lab.fx = fx;
}

// ------------------------------------------------------------------ draw
const prev = $('preview'), pctx = prev.getContext('2d');
function drawPreview() {
  if (prev.style.display === 'none') return;
  const v = camera.video;
  pctx.fillStyle = '#000'; pctx.fillRect(0, 0, prev.width, prev.height);
  if (camera.active && v.videoWidth) pctx.drawImage(v, 0, 0, prev.width, prev.height);
  const f = lastFrame;
  if (!f?.kp2d?.length) return;
  pctx.strokeStyle = '#5ad1ff'; pctx.lineWidth = 2;
  for (const [a, b] of f.edges ?? []) {
    const p = f.kp2d[a], q = f.kp2d[b]; if (!p || !q) continue;
    pctx.beginPath(); pctx.moveTo(p.x * prev.width, p.y * prev.height); pctx.lineTo(q.x * prev.width, q.y * prev.height); pctx.stroke();
  }
}

function drawRaw() {
  const s = pipeline.lastSample, pos = rawGeo.attributes.position.array;
  rawLines.visible = $('showRaw').checked && !!s;
  if (!s) return;
  const off = +$('rawOff').value, k = s.k;
  // place the raw skeleton where the avatar's root is, offset sideways
  const follow = pipeline.options.root.follow;
  let i = 0;
  for (const [a, b] of RAW_EDGES) {
    for (const n of [a, b]) {
      const p = s.pts[n];
      if (!p) { pos[i++] = 0; pos[i++] = -10; pos[i++] = 0; continue; }
      pos[i++] = (follow ? p.x * k : (p.x - s.hips.x) * k) + off;
      pos[i++] = p.y * k;
      pos[i++] = follow ? p.z * k : (p.z - s.hips.z) * k;
    }
  }
  rawGeo.attributes.position.needsUpdate = true;
}

function fmt(n, d = 1) { return Number.isFinite(n) ? n.toFixed(d) : '–'; }
let hudT = 0;
function drawHUD(now) {
  if (now - hudT < 250) return; hudT = now;
  const m = pipeline.metrics.snapshot();
  lab.last = m;
  const rows = [
    ['Solver', pipeline.state.solver + (pipeline.state.calibrated ? ' · calibrated' : ' · calibrating')],
    ['Tracker latency (capture→arrive)', fmt(m.latency.track) + ' ms'],
    ['Prediction horizon', fmt(m.latency.lead) + ' ms'],
    ['Motion→avatar lag (xcorr)', fmt(m.latency.e2e) + ' ms' + (m.latency.e2eCorr ? ` (r ${fmt(m.latency.e2eCorr, 2)})` : '')],
    ['Jitter speed raw / filter / final', `${fmt(m.jitter.rawSpeed, 2)} / ${fmt(m.jitter.outSpeed, 2)} / ${fmt(m.jitter.finalSpeed, 2)} rad/s ${m.jitter.ok ? '✓' : '✗'}`],
    ['Jitter accel raw / out', `${fmt(m.jitter.rawAcc, 0)} / ${fmt(m.jitter.outAcc, 0)} rad/s²`],
    ['Foot skate tracked / locked', `${fmt(m.footSkate.raw * 100, 1)} / ${fmt(m.footSkate.out * 100, 2)} cm/s`],
    ['Both feet planted', fmt(m.footSkate.contact * 100, 0) + ' %'],
    ['FK vs joints_3d', m.fkError.mean ? `${fmt(m.fkError.mean, 3)} mean / ${fmt(m.fkError.max, 3)} max mm` : '–'],
    ['Cost solve / update / fx', `${fmt(m.cost.solveMs, 2)} / ${fmt(m.cost.updateMs, 2)} / ${fmt(fx?.stats.ms ?? 0, 2)} ms`],
  ];
  $('mt').innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('');
  const st = pipeline.state;
  const tag = (t, on) => `<span class="tag ${on ? 'on' : ''}">${t}</span>`;
  $('st').innerHTML = [
    tag('L contact', st.contacts.left), tag('R contact', st.contacts.right), tag('L lock', st.locked.left), tag('R lock', st.locked.right),
    tag('legs tracked', st.legsTracked), tag('hand L: ' + st.hands.left, st.hands.left !== 'relaxed'), tag('hand R: ' + st.hands.right, st.hands.right !== 'relaxed'),
  ].join('') + `<div style="color:var(--dim);margin-top:4px">weights: arms ${fmt(st.weights.leftUpperArm ?? 0, 2)}/${fmt(st.weights.rightUpperArm ?? 0, 2)} · legs ${fmt(st.weights.leftUpperLeg ?? 0, 2)}/${fmt(st.weights.rightUpperLeg ?? 0, 2)} · head ${fmt(st.weights.head ?? 0, 2)}</div>`;
}

const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = clock.getDelta();
  if (!lab.manual) step(dt);
}
function step(dt) {
  if (!pipeline || !vrm) return;
  const now = performance.now();
  lookTarget.copy(cam.position);
  pipeline.update(dt, now);
  // keep the avatar framed: the orbit target follows the hips horizontally
  const hp = pipeline.pose.hips, tx = hp.x + 0.4, k = lab.noFollow ? 0 : 1 - Math.exp(-dt * 3);
  const dx = (tx - controls.target.x) * k, dz = (hp.z - controls.target.z) * k;
  controls.target.x += dx; controls.target.z += dz; cam.position.x += dx; cam.position.z += dz;
  const ts = fx ? fx.update(dt) : 1;        // after the camera follow, before rendering (hit-stop + shake)
  hero.updateExpression(dt);
  vrm.update(dt * ts);
  const fk = pipeline.state.heroFK;
  for (const s of ['left', 'right']) {
    const p = fk?.pos[s + 'Foot'];
    footMarks[s].visible = !!p && pipeline.state.locked[s];
    if (p) footMarks[s].position.set(p.x, 0.005, p.z);
  }
  drawRaw(); drawPreview(); drawHUD(now);
  renderer.render(scene, cam);
}

addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix(); });

const lab = { events: [], THREE, step, setSource, cam, controls, triggerTest: (o) => { const r = runTriggerTest(o); r.text = formatTriggerTest(r); return r; },
  moveBench: (o = { seeds: [1] }) => { const r = runRobustness(o); r.text = Object.entries(r.configs).map(([n, c]) => formatBench(c, n)).join('\n\n'); return r; }, get vrm() { return vrm; }, get source() { return source; } };
/** Automation: run a source for `ms` with a fixed 60 Hz update loop (works with the tab hidden), return metrics. */
lab.measure = async (name, ms = 8000, opts = {}, warm = 2500) => {
  lab.manual = true;
  if (name) await setSource(name);
  Object.assign(pipeline.options, opts);
  let last = performance.now();
  const id = setInterval(() => { const n = performance.now(); step((n - last) / 1000); last = n; }, 1000 / 60);
  await new Promise((r) => setTimeout(r, warm));
  pipeline.metrics.reset(); lab.events.length = 0;
  await new Promise((r) => setTimeout(r, ms));
  clearInterval(id);
  lab.manual = false;
  return { ...pipeline.metrics.snapshot(), events: lab.events.map((e) => e.name), solver: pipeline.state.solver };
};
/**
 * Punch path probe (QA v3 r2 P1-2): lock the synthetic jab/cross, and per punch compare the avatar's
 * shoulder->fist direction at its peak extension with the tracked (input) shoulder->wrist direction at the raw
 * peak (both in hero/avatar space, mirrored). Returns per-punch yaw off straight-forward and the 3D angle error.
 */
lab.punchProbe = async (ms = 6000, opts = {}) => {
  lab.manual = true;
  await setSource('synthetic');
  source.phase = 1;
  Object.assign(pipeline.options, opts);
  const rec = { left: [], right: [] };
  let last = performance.now();
  const id = setInterval(() => {
    const n = performance.now(); step((n - last) / 1000); last = n;
    const fk = pipeline.state.heroFK, smp = pipeline.lastSample;
    if (!fk || !smp || !pipeline.state.calibrated) return;
    for (const s of ['left', 'right']) {
      const sh = fk.pos[s + 'UpperArm'], hd = fk.pos[s + 'Hand'];
      const rs = smp.pts[s + 'Shoulder'], rw = smp.pts[s + 'Wrist'];
      if (!sh || !hd || !rs || !rw) continue;
      rec[s].push({ t: n, out: hd.clone().sub(sh), raw: rw.clone().sub(rs) });
    }
  }, 1000 / 60);
  await new Promise((r) => setTimeout(r, ms));
  clearInterval(id); lab.manual = false;
  const deg = (r) => r * 180 / Math.PI;
  const yaw = (v, sg) => deg(Math.atan2(-sg * v.x, v.z));          // + = across the body (toward the midline)
  const res = [];
  for (const s of ['left', 'right']) {
    const sg = s === 'left' ? 1 : -1, a = rec[s];
    // segment punches: frames where the raw arm is extended forward (z > 60 % of the arm)
    let i = 0;
    while (i < a.length) {
      if (a[i].raw.z < 0.4) { i++; continue; }
      let j = i; while (j < a.length && a[j].t - a[i].t < 400) j++;
      const win = a.slice(Math.max(0, i - 3), j);
      const pr = win.reduce((b, x) => (x.raw.length() > b.raw.length() ? x : b));
      const po = win.reduce((b, x) => (x.out.z > b.out.z ? x : b));
      res.push({ side: s, inYaw: +yaw(pr.raw, sg).toFixed(1), outYaw: +yaw(po.out, sg).toFixed(1),
        err3d: +deg(po.out.angleTo(pr.raw)).toFixed(1), outFwdDeg: +deg(po.out.angleTo(new THREE.Vector3(0, 0, 1))).toFixed(1) });
      i = j + 5;
      while (i < a.length && a[i].raw.z >= 0.4) i++;
    }
  }
  const mean = (k) => +(res.reduce((s, x) => s + Math.abs(x[k]), 0) / Math.max(1, res.length)).toFixed(1);
  const max = (k) => Math.max(...res.map((x) => Math.abs(x[k])));
  source.phase = null;
  return { n: res.length, meanErr3d: mean('err3d'), maxErr3d: max('err3d'), meanInYaw: mean('inYaw'), meanOutYaw: mean('outYaw'), meanOutFwd: mean('outFwdDeg'), punches: res };
};
window.lab = lab;

(async () => {
  try {
    mhr = await MHRSkeleton.load();
    const vurl = Q.get('vrm') ?? $('vrm').value; $('vrm').value = vurl;
    await loadVRM(vurl);
    await buildPipeline();
    bindUI();
    const s = Q.get('source') ?? 'synthetic'; $('source').value = s;
    await setSource(s);
    $('status').textContent = `ready · ${pipeline.rig.source} rest skeleton · ${pipeline.rig.bones.length} bones`;
    lab.ready = true;
    frame();
  } catch (e) {
    console.error(e);
    $('status').textContent = 'error: ' + e.message;
  }
})();
