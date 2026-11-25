import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createCharacterAsync } from './hero/index.js';
import { Retargeter } from './retarget.js';
import { PoseFilter, mirrorPose, midpoint } from './pose.js';
import { ActionDetector, ACTIONS } from './actions.js';
import { ReactionTest, PoseMatchTest, Ghost } from './tests.js';
import { buildArena } from './arena.js';
import { Camera } from './sources/camera.js';
import { HMRSource } from './sources/hmrSource.js';
import { MediaPipeSource } from './sources/mediapipeSource.js';
import { SyntheticSource } from './sources/syntheticSource.js';
import { configureRenderer, autoResize } from './render/pipeline.js';
import { createContactShadow } from './render/contactShadow.js';
import { measureFraming } from './render/framing.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------------------------------- renderer/scene
const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true, powerPreference: 'high-performance' });
// colour pipeline (spec 2.11): Neutral tone mapping for the arena; hero materials are toneMapped:false
configureRenderer(renderer);

const scene = new THREE.Scene();
const arena = buildArena(scene);
// game camera (spec 2.14): FOV 34 keeps perspective distortion low so the head doesn't shrink
const GAME_FOV = 34;
const camera3 = new THREE.PerspectiveCamera(GAME_FOV, innerWidth / innerHeight, 0.05, 400);
autoResize(renderer, camera3);
const controls = new OrbitControls(camera3, renderer.domElement);
controls.enableDamping = true;
controls.enabled = false;

// Async hero build (QA r1 P0-2): the rig exists synchronously (onShell runs before the first yield), so the
// retargeter, ghost and idle pose work from frame 1 on a capsule placeholder; the parts build one per task
// and are swapped in together when ready.
let character = null;
const characterReady = createCharacterAsync({ camera: camera3, onShell: (h) => { character = h; } });
scene.add(character.root);
character.setCamera?.(camera3); // camera-locked character key light (spec 2.8)
characterReady.then((h) => {
  console.info(`[hero] built in ${h.buildInfo.totalMs} ms (longest block ${h.buildInfo.maxBlockMs} ms)`, h.buildInfo.parts);
  // compile the hero programs off the critical path where supported, so the first real frame doesn't stall
  renderer.compileAsync?.(scene, camera3).catch(() => {});
  if (!source) ui.status('', 'Pick a source and press Start');
}).catch((e) => { console.error('[hero] build failed', e); ui.status('error', 'Hero failed to load'); });
const contactBlob = createContactShadow();
scene.add(contactBlob.mesh);
const retarget = new Retargeter(character);
const ghost = new Ghost(retarget);
scene.add(ghost);

// debug skeleton of the raw tracked pose (thin lines next to the avatar)
const skelGeo = new THREE.BufferGeometry();
skelGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(64 * 6), 3));
const skelLines = new THREE.LineSegments(skelGeo, new THREE.LineBasicMaterial({ color: 0x66ffcc, transparent: true, opacity: 0.8, depthTest: false }));
skelLines.renderOrder = 20;
skelLines.frustumCulled = false;
scene.add(skelLines);
const SKEL = [['leftShoulder', 'rightShoulder'], ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'], ['leftWrist', 'leftHand'],
  ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'], ['rightWrist', 'rightHand'], ['leftShoulder', 'leftHip'],
  ['rightShoulder', 'rightHip'], ['leftHip', 'rightHip'], ['leftHip', 'leftKnee'], ['leftKnee', 'leftAnkle'], ['leftAnkle', 'leftToe'],
  ['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle'], ['rightAnkle', 'rightToe'], ['neck', 'nose'], ['leftEar', 'rightEar']];

// ------------------------------------------------------------------------------------------- camera views
const VIEWS = {
  // spec 2.14 front cam: (0, 1.30, 4.9) -> (0, 0.98, 0), FOV 34: hero ~60% of viewport height.
  // QA r3 P2-7: the synthetic player's standing moves (arms toward the camera) measured 65.0-65.3 % at 1920x1080,
  // on the 65 % ceiling; pulled back 4.5 % along the same view ray (same pitch / look-at) -> ~61-62 % standing.
  front: { pos: [0, 1.314, 5.12], look: [0, 0.98, 0], mirror: true },
  // over-the-shoulder: hero's back fills ~55%, looking out over the deck toward the sea
  behind: { pos: [0, 1.48, -5.1], look: [0, 1.0, 0.4], mirror: false },
  // side profile, slightly in front so the face reads
  side: { pos: [4.95, 1.30, 0.7], look: [0, 0.98, 0], mirror: null },
  orbit: { pos: [3.0, 2.0, 4.4], look: [0, 0.98, 0], mirror: null, orbit: true },
};
let view = 'front';
const camGoal = { pos: new THREE.Vector3(...VIEWS.front.pos), look: new THREE.Vector3(...VIEWS.front.look) };
camera3.position.copy(camGoal.pos);
const camLook = camGoal.look.clone();
function setView(v, { snap = false } = {}) {
  view = v;
  const V = VIEWS[v];
  // a lerp between opposite sides (front <-> behind) would fly the camera through the hero: cut instead
  const from = camera3.position.clone().sub(camLook).setY(0), to = new THREE.Vector3(...V.pos).sub(new THREE.Vector3(...V.look)).setY(0);
  if (from.lengthSq() > 1e-6 && from.normalize().dot(to.normalize()) < 0) snap = true;
  camGoal.pos.set(...V.pos); camGoal.look.set(...V.look);
  if (snap) { camera3.position.copy(camGoal.pos); camLook.copy(camGoal.look); camera3.lookAt(camLook); camera3.updateMatrixWorld(); }
  controls.enabled = !!V.orbit;
  if (V.orbit) { controls.target.copy(camGoal.look); camera3.position.copy(camGoal.pos); }
  if (V.mirror !== null) { $('mirror').checked = V.mirror; settings.mirror = V.mirror; }
  document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
}

// ------------------------------------------------------------------------------------------- state
const settings = { mirror: true, showSkel: true };
const camera = new Camera($('video'));
const sources = {
  hmr: new HMRSource(camera),
  mediapipe: new MediaPipeSource(camera),
  synthetic: new SyntheticSource(),
};
let source = null;
const filter = new PoseFilter();
const actions = new ActionDetector();
const stats = {
  lat: [], poseTimes: [], frames: 0, lost: 0, lastPoseAt: 0, conf: 0, vis: 0, jitter: 0, timing: {},
  renderTimes: [], pendingCapture: null, lastJ: null, lastJ2: null,
};
let tracking = false;
let lastPose = null;

// ------------------------------------------------------------------------------------------- UI helpers
const ui = {
  status(kind, text) { const el = $('status'); el.className = 'pill ' + kind; el.querySelector('span').textContent = text; },
  prompt(p) {
    const el = $('prompt');
    if (!p) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.querySelector('.text').textContent = p.text;
    el.querySelector('.text').style.color = p.color || '#fff';
    el.querySelector('.sub').textContent = p.sub || '';
  },
  flash(text, color) {
    const el = $('flash');
    el.textContent = text; el.style.color = color; el.classList.add('show');
    clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 700);
  },
  banner(t, s) {
    const el = $('banner');
    el.querySelector('.t').textContent = t; el.querySelector('.s').textContent = s;
    el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 3500);
  },
  meter(m) {
    const el = $('meter');
    if (!m) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.querySelector('i').style.width = `${m.value}%`;
    el.querySelector('.label').textContent = m.label;
  },
  showResults(r) {
    const el = $('results');
    el.querySelector('h2').textContent = r.title;
    el.querySelector('table').innerHTML = `<tr>${r.header.map((h) => `<th>${h}</th>`).join('')}</tr>` +
      r.rows.map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
    el.querySelector('.foot').innerHTML = r.footer.map((f) => `<div>${f}</div>`).join('');
    el.classList.remove('hidden');
  },
};
$('closeResults').onclick = () => $('results').classList.add('hidden');

// triggers panel
const trigEls = {};
for (const [k, a] of Object.entries(ACTIONS)) {
  const s = document.createElement('span');
  s.textContent = a.label; $('triggers').appendChild(s); trigEls[k] = s;
}
function logLine(html) {
  const d = document.createElement('div'); d.innerHTML = html;
  $('log').prepend(d);
  while ($('log').children.length > 6) $('log').lastChild.remove();
}
function floater(text, color) {
  const head = new THREE.Vector3();
  character.bones.head.getWorldPosition(head);
  head.y += 0.45;
  head.project(camera3);
  const el = document.createElement('div');
  el.className = 'floater'; el.textContent = text; el.style.color = color;
  el.style.left = `${(head.x * 0.5 + 0.5) * innerWidth + (Math.random() - 0.5) * 80}px`;
  el.style.top = `${(-head.y * 0.5 + 0.5) * innerHeight}px`;
  $('floaters').appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

// ------------------------------------------------------------------------------------------- modes
const reaction = new ReactionTest(ui);
const poseMatch = new PoseMatchTest(ui, ghost);
let mode = 'free';
function setMode(m) {
  reaction.stop(); poseMatch.stop(); ui.meter(null);
  mode = m;
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  if (!source) { ui.banner('Start tracking first', 'Pick a source on the left and press Start'); }
  if (m === 'reaction') reaction.start();
  if (m === 'pose') poseMatch.start();
  if (m === 'free') ui.banner('Free move', 'Move around — triggers light up on the right');
}
document.querySelectorAll('#modes button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
document.querySelectorAll('#views button').forEach((b) => (b.onclick = () => setView(b.dataset.view)));

actions.on((name, info) => {
  const a = ACTIONS[name];
  const sys = info.tCapture ? Math.round(info.t - info.tCapture) : null;
  logLine(`<b style="color:${a.color}">${a.label}</b> · ${sys != null ? `${sys} ms after capture` : ''}`);
  if (mode === 'free' && a.kind === 'impulse') floater(a.label + '!', a.color);
  // avatar-side action (the avatar is a mirror image when settings.mirror): hand pose + expression preset,
  // auto-fist on punches (punching hand + guard hand), reverts after the preset hold
  const avatarName = settings.mirror ? name.replace(/Left$/, '#').replace(/Right$/, 'Left').replace(/#$/, 'Right') : name;
  character.setAction?.(avatarName);
  if (name.startsWith('punch')) character.setHandPose?.('fist', 'both');
  if (name === 'jump' || name.startsWith('punch') || name.startsWith('kick')) character.setExpression?.('determined');
  else if (name === 'handsUp') character.setExpression?.('happy');
  reaction.onAction(name, info);
});

// ------------------------------------------------------------------------------------------- tracking
function onPose(frame) {
  const now = performance.now();
  stats.poseTimes.push(now);
  while (stats.poseTimes.length && now - stats.poseTimes[0] > 1000) stats.poseTimes.shift();
  stats.timing = frame.timing || {};
  if (frame.kp2d) drawOverlay(frame);
  if (!frame.joints) {
    stats.lost++;
    if (now - stats.lastPoseAt > 400) tracking = false;
    return;
  }
  stats.lastPoseAt = now;
  tracking = true;
  stats.pendingCapture = frame.tCapture;

  const confVals = Object.values(frame.conf);
  stats.conf = confVals.reduce((a, b) => a + b, 0) / Math.max(1, confVals.length);
  stats.vis = confVals.filter((c) => c > 0.5).length / Math.max(1, confVals.length);

  // player-space (person's own left/right) → triggers
  const filtered = filter.apply(frame.joints, frame.tCapture);
  actions.update(filtered, frame.conf, frame.tCapture);

  // character-space → avatar
  let joints = filtered, conf = frame.conf;
  if (settings.mirror) ({ joints, conf } = mirrorPose(filtered, frame.conf));
  retarget.setPose(joints, conf);
  lastPose = { joints, conf };

  // jitter: RMS of 2nd difference (acceleration noise) of the wrists & head, mm per frame
  // hip-relative, so depth/translation noise doesn't dominate the limb jitter figure
  const hipC = midpoint(filtered.leftHip, filtered.rightHip);
  const J = {};
  for (const k of ['leftWrist', 'rightWrist', 'nose', 'leftShoulder', 'rightShoulder']) J[k] = filtered[k].clone().sub(hipC);
  if (stats.lastJ && stats.lastJ2) {
    let s = 0, n = 0;
    for (const k of ['leftWrist', 'rightWrist', 'nose', 'leftShoulder', 'rightShoulder']) {
      const a = J[k].clone().sub(stats.lastJ[k].clone().multiplyScalar(2)).add(stats.lastJ2[k]);
      s += a.lengthSq(); n++;
    }
    const j = Math.sqrt(s / n) * 1000;
    stats.jitter = stats.jitter * 0.9 + j * 0.1;
  }
  stats.lastJ2 = stats.lastJ; stats.lastJ = J;
}

const overlay = $('overlay');
const octx = overlay.getContext('2d');
function drawOverlay(frame) {
  const w = (overlay.width = overlay.clientWidth * devicePixelRatio);
  const h = (overlay.height = overlay.clientHeight * devicePixelRatio);
  octx.clearRect(0, 0, w, h);
  const vid = $('video');
  // map normalised video coords → object-fit:cover canvas coords
  const vw = vid.videoWidth || 16, vh = vid.videoHeight || 9;
  const scale = Math.max(w / vw, h / vh), ox = (w - vw * scale) / 2, oy = (h - vh * scale) / 2;
  const P = (p) => [ox + p.x * vw * scale, oy + p.y * vh * scale];
  octx.lineWidth = 2.5 * devicePixelRatio;
  for (const [a, b] of frame.edges || []) {
    const pa = frame.kp2d[a], pb = frame.kp2d[b];
    if (!pa || !pb) continue;
    const c = Math.min(pa.c, pb.c);
    octx.strokeStyle = c > 0.5 ? 'rgba(80,255,190,0.9)' : 'rgba(255,120,120,0.5)';
    octx.beginPath(); octx.moveTo(...P(pa)); octx.lineTo(...P(pb)); octx.stroke();
  }
  octx.fillStyle = '#ffd23f';
  for (const p of frame.kp2d) {
    if (p.c < 0.3) continue;
    const [x, y] = P(p);
    octx.beginPath(); octx.arc(x, y, 2.6 * devicePixelRatio, 0, 7); octx.fill();
  }
}

function updateSkeletonLines() {
  skelLines.visible = settings.showSkel && tracking && !!lastPose;
  if (!skelLines.visible) return;
  const J = lastPose.joints;
  const pos = skelGeo.attributes.position.array;
  // place the raw skeleton beside the avatar, aligned at the hips
  const hip = midpoint(J.leftHip, J.rightHip);
  const anchor = new THREE.Vector3();
  character.bones.hips.getWorldPosition(anchor);
  anchor.x -= 1.1;
  let i = 0;
  for (const [a, b] of SKEL) {
    for (const k of [a, b]) {
      const p = J[k];
      pos[i++] = p.x - hip.x + anchor.x; pos[i++] = p.y - hip.y + anchor.y; pos[i++] = p.z - hip.z + anchor.z;
    }
  }
  skelGeo.setDrawRange(0, SKEL.length * 2);
  skelGeo.attributes.position.needsUpdate = true;
}

// idle pose when nobody is tracked: relaxed standing with breathing
function idlePose(t) {
  const P = retarget.restPos;
  const V = (p, dx = 0, dy = 0, dz = 0) => new THREE.Vector3(p.x + dx, p.y + dy, p.z + dz);
  const br = Math.sin(t * 1.6) * 0.008;
  const sway = Math.sin(t * 0.7) * 0.02;
  const joints = {
    leftHip: V(P.leftThigh, sway), rightHip: V(P.rightThigh, sway),
    leftShoulder: V(P.leftUpperArm, sway * 1.5, br), rightShoulder: V(P.rightUpperArm, sway * 1.5, br),
    neck: V(P.neck, sway * 1.6, br), nose: V(P.head, sway * 1.6 + Math.sin(t * 0.5) * 0.02, 0.05 + br, 0.12),
    leftEar: V(P.head, 0.08 + sway * 1.6, 0.08 + br, 0), rightEar: V(P.head, -0.08 + sway * 1.6, 0.08 + br, 0),
  };
  const conf = { nose: 1, leftEar: 1, rightEar: 1 };
  retarget.setPose(joints, conf);
  retarget.rootTarget.set(0, 0, 0);
}

// ------------------------------------------------------------------------------------------- start/stop
async function start() {
  stop();
  const kind = $('source').value;
  source = sources[kind];
  source.onStatus = (k, text) => ui.status(k, text);
  source.onPose = onPose;
  filter.reset(); retarget.recalibrate(); actions.recalibrate(); character.resetDynamics?.();
  try {
    if (kind !== 'synthetic') {
      ui.status('connecting', 'Opening camera…');
      const s = await camera.start($('cameraSel').value || undefined);
      $('previewTag').textContent = `camera ${s.width}×${s.height} @ ${Math.round(s.frameRate || 0)}fps`;
      refreshCameras();
    }
    if (kind === 'hmr') source.url = $('serverUrl').value.trim();
    await source.start();
    $('startBtn').textContent = '■ Stop';
    $('startBtn').classList.add('running');
    ui.banner('Calibrating…', 'Stand still in your neutral spot for a second');
  } catch (e) {
    console.error(e);
    ui.status('error', e.name === 'NotAllowedError' ? 'Camera permission denied' : `Failed: ${e.message || e}`);
    source = null;
  }
}
function stop() {
  if (source) source.stop();
  source = null;
  camera.stop();
  tracking = false;
  $('startBtn').textContent = '▶ Start';
  $('startBtn').classList.remove('running');
}
$('startBtn').onclick = () => (source ? (stop(), ui.status('', 'Stopped')) : start());
$('calibBtn').onclick = () => { retarget.recalibrate(); actions.recalibrate(); character.resetDynamics?.(); ui.banner('Calibrating…', 'Hold still for a second'); };
$('source').onchange = () => {
  const k = $('source').value;
  $('urlRow').style.display = k === 'hmr' ? '' : 'none';
  $('camRow').style.display = k === 'synthetic' ? 'none' : '';
  if (source) start();
};
async function refreshCameras() {
  try {
    const cams = await Camera.list();
    const sel = $('cameraSel'), cur = sel.value;
    sel.innerHTML = '<option value="">Default</option>' + cams.map((c, i) => `<option value="${c.deviceId}">${c.label || 'Camera ' + (i + 1)}</option>`).join('');
    sel.value = cur;
  } catch { /* ignore */ }
}
refreshCameras();
$('cameraSel').onchange = () => source && start();

const bindRange = (id, fmt, fn) => {
  const el = $(id), out = $(id + 'Val');
  const upd = () => { out.textContent = fmt(+el.value); fn(+el.value); };
  el.oninput = upd; upd();
};
bindRange('smooth', (v) => (v < 0.02 ? 'off' : Math.round(v * 100) + '%'), (v) => (filter.strength = v));
bindRange('interp', (v) => (v < 0.02 ? 'off' : Math.round(v * 100) + '%'), (v) => (retarget.interp = v));
bindRange('sens', (v) => v.toFixed(2) + '×', (v) => (actions.sensitivity = v));
$('mirror').onchange = (e) => (settings.mirror = e.target.checked);
$('showSkel').onchange = (e) => (settings.showSkel = e.target.checked);
$('pipeline').onchange = (e) => (sources.hmr.maxInFlight = e.target.checked ? 2 : 1);

// ------------------------------------------------------------------------------------------- HUD
const latCtx = $('latChart').getContext('2d');
function pct(arr, p) { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
function drawLatChart() {
  const c = $('latChart'), w = (c.width = c.clientWidth * devicePixelRatio), h = (c.height = 70 * devicePixelRatio);
  latCtx.clearRect(0, 0, w, h);
  const data = stats.lat.slice(-120);
  if (!data.length) return;
  const max = Math.max(100, ...data) * 1.15;
  latCtx.strokeStyle = 'rgba(255,255,255,0.08)'; latCtx.lineWidth = 1;
  latCtx.font = `${9 * devicePixelRatio}px Inter`; latCtx.fillStyle = 'rgba(255,255,255,0.35)';
  for (const g of [33, 66, 100, 150, 200].filter((g) => g < max)) {
    const y = h - (g / max) * h; latCtx.beginPath(); latCtx.moveTo(0, y); latCtx.lineTo(w, y); latCtx.stroke();
    latCtx.fillText(g + '', 3, y - 2);
  }
  latCtx.strokeStyle = '#ffd23f'; latCtx.lineWidth = 1.6 * devicePixelRatio; latCtx.beginPath();
  data.forEach((v, i) => { const x = (i / 119) * w, y = h - (v / max) * h; i ? latCtx.lineTo(x, y) : latCtx.moveTo(x, y); });
  latCtx.stroke();
}
const STAGE_COLORS = { encode: '#a29bfe', transport: '#74b9ff', decode: '#81ecec', detect: '#ff7675', hmr: '#fdcb6e', inference: '#fdcb6e', display: '#55efc4' };
function updateHUD() {
  const lat = stats.lat.slice(-60);
  const avg = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : NaN;
  $('mLatency').textContent = isNaN(avg) ? '–' : Math.round(avg);
  $('mLatencyCap').textContent = source === sources.synthetic ? 'synthetic: pose emit → on screen'
    : `camera (${camera.timestampKind}) → avatar on screen`;
  $('mP50').textContent = isNaN(avg) ? '–' : Math.round(pct(lat, 0.5)) + '';
  $('mP95').textContent = isNaN(avg) ? '–' : Math.round(pct(lat, 0.95)) + '';
  $('mTrackFps').textContent = stats.poseTimes.length;
  $('mCamFps').textContent = camera.active ? Math.round(camera.fps) : '–';
  const rt = stats.renderTimes;
  $('mRenderFps').textContent = rt.length > 1 ? Math.round(((rt.length - 1) * 1000) / (rt.at(-1) - rt[0])) : '–';
  $('mLost').textContent = stats.lost;
  $('mConf').textContent = tracking ? Math.round(stats.conf * 100) + '%' : '–';
  $('mVis').textContent = tracking ? Math.round(stats.vis * 100) + '%' : '–';
  $('mJitter').textContent = tracking ? stats.jitter.toFixed(1) + 'mm' : '–';
  $('mModel').textContent = source ? source.model || '…' : '–';
  // breakdown
  const T = { ...stats.timing };
  const stages = Object.entries(T).filter(([k]) => STAGE_COLORS[k] !== undefined && k !== 'display');
  stages.push(['display', stats.displayWait || 0]);
  const tot = Math.max(30, ...stages.map(([, v]) => v));
  $('breakdown').innerHTML = stages.map(([k, v]) => `<div class="bar"><span>${k}</span><div><i style="width:${(v / tot) * 100}%;background:${STAGE_COLORS[k]}"></i></div><span>${v.toFixed(1)} ms</span></div>`).join('')
    + (T.rtt ? `<div class="bar"><span>round trip</span><div></div><span>${T.rtt.toFixed(1)} ms</span></div>` : '');
  for (const [k, el] of Object.entries(trigEls)) {
    const on = !!actions.state[k] || performance.now() - (actions.lastFire[k] ?? -1e9) < 350;
    el.classList.toggle('on', on);
    el.style.background = on ? ACTIONS[k].color : '';
  }
  drawLatChart();
}
setInterval(updateHUD, 200);

// ------------------------------------------------------------------------------------------- loop
const clock = new THREE.Clock();
let poseAppliedAt = 0;
function frameLoop() {
  requestAnimationFrame(frameLoop);
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.elapsedTime;
  const now = performance.now();
  stats.renderTimes.push(now);
  while (stats.renderTimes.length > 61) stats.renderTimes.shift();

  if (tracking && now - stats.lastPoseAt > 600) tracking = false;
  if (!tracking) idlePose(t);

  // frame order (CONTRACTS 8): retargeter writes hero.bones, then the hero updates helpers/parts/materials
  retarget.update(dt);
  character.update?.(dt, t);
  contactBlob.update(character);
  if (mode === 'pose') poseMatch.update(dt, character.bones, character.root, tracking);

  // ghost follows the avatar's hips
  const hp = new THREE.Vector3();
  character.bones.hips.getWorldPosition(hp);
  ghost.position.set(hp.x, 0, hp.z);

  // camera follow
  if (!controls.enabled) {
    const follow = new THREE.Vector3(hp.x * 0.6, 0, hp.z * 0.6);
    camera3.position.lerp(camGoal.pos.clone().add(follow), 1 - Math.exp(-dt * 3));
    camLook.lerp(camGoal.look.clone().add(follow), 1 - Math.exp(-dt * 3));
    camera3.lookAt(camLook);
  } else controls.update();

  updateSkeletonLines();
  arena.update?.(dt, t);
  renderer.render(scene, camera3);

  // latency: the newest pose has now been drawn (it is presented on the next vsync — add half a frame)
  if (stats.pendingCapture != null) {
    const vsync = stats.renderTimes.length > 2 ? (stats.renderTimes.at(-1) - stats.renderTimes[0]) / (stats.renderTimes.length - 1) : 16.7;
    const shown = performance.now() + vsync * 0.5;
    stats.lat.push(shown - stats.pendingCapture);
    if (stats.lat.length > 300) stats.lat.shift();
    stats.displayWait = shown - stats.lastPoseAt;
    stats.pendingCapture = null;
    poseAppliedAt = now;
  }
  void poseAppliedAt;
}


// keyboard shortcuts
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'c') $('calibBtn').click();
  if (e.key === ' ') { e.preventDefault(); $('startBtn').click(); }
  if (e.key === '1') setMode('free');
  if (e.key === '2') setMode('reaction');
  if (e.key === '3') setMode('pose');
  if (e.key === 'v') { const ks = Object.keys(VIEWS); setView(ks[(ks.indexOf(view) + 1) % ks.length]); }
});

$('source').onchange();
setView('front');
if (character.isReady) ui.status('', 'Pick a source and press Start'); else ui.status('connecting', 'Loading hero…');
frameLoop();

// expose for debugging in the console
Object.assign(window, { retarget, character, characterReady, actions, stats, sources, camera3, setView });
// QA: render one frame synchronously (rAF is throttled in hidden panes): retarget -> hero.update -> render.
window.renderOnce = (dt = 1 / 60) => {
  if (!tracking) idlePose(clock.elapsedTime);
  retarget.update(dt);
  character.update?.(dt, clock.elapsedTime);
  contactBlob.update(character);
  camera3.updateMatrixWorld();
  renderer.render(scene, camera3);
  return renderer.info.render;
};
// QA (spec 4.I): measureFraming() -> hero height % of viewport + any HUD panel overlapping the hero
window.measureFraming = () => measureFraming(camera3, character, {
  width: renderer.domElement.clientWidth, height: renderer.domElement.clientHeight,
  panels: ['setup', 'metrics', 'preview', 'topbar'].map((id) => $(id)),
});
