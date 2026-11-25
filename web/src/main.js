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
import { createPostChain } from './render/post.js';
import { createHeroLights } from './render/heroLights.js';
import { QualityManager } from './render/quality.js';
import { heroRenderStats } from './render/debugViews.js';
import { loadVRMHero } from './vrm/hero.js';
import { VRM_MODELS, DEFAULT_VRM, modelUrl, modelByUrl } from './vrm/models.js';
import { createMotionPipeline } from './motion/index.js';
import { createFx } from './fx/index.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const HERO_KIND = params.get('hero') === 'procedural' ? 'procedural' : 'vrm';
// VRM hero: driven by the motion pipeline (web/src/motion). Procedural hero: legacy Retargeter + PoseFilter.
const USE_PIPELINE = HERO_KIND === 'vrm';
let vrmUrl = params.get('vrm') || DEFAULT_VRM;

// Test hook (?fakecam=1): the camera is a GIF drawn to a canvas (machines / panes without a webcam)
if (params.get('fakecam')) {
  const img = new Image(); img.src = params.get('fakecamSrc') || '/test/demo_desktop.gif';
  const cv = document.createElement('canvas'); cv.width = 640; cv.height = 400;
  const cx = cv.getContext('2d');
  const draw = () => { if (img.complete && img.naturalWidth) cx.drawImage(img, 0, 52, 320, 200, 0, 0, 640, 400); };
  setInterval(draw, 33);
  navigator.mediaDevices.getUserMedia = async () => cv.captureStream(30);
}

// ------------------------------------------------------------------------------------------- renderer/scene
// antialias off: AA is SMAA/FXAA in the post chain (MSAA doesn't apply to the composer's offscreen buffers)
const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: false, powerPreference: 'high-performance', stencil: false });
configureRenderer(renderer, { postToneMapping: true });
renderer.info.autoReset = false; // several passes per frame: reset once per frame so the HUD shows frame totals

// The arena and the hero render in separate scenes (composited by the post chain) so the hero gets its own
// camera-following light rig without the arena sun adding a second terminator on the face.
const scene = new THREE.Scene();       // arena / world
const heroScene = new THREE.Scene();   // hero + its lights + overlays (ghost, skeleton)
const arena = buildArena(scene);
// game camera (spec 2.14): FOV 34 keeps perspective distortion low so the head doesn't shrink
const GAME_FOV = 34;
const camera3 = new THREE.PerspectiveCamera(GAME_FOV, innerWidth / innerHeight, 0.05, 400);
const heroLights = createHeroLights(heroScene, { sunDirection: arena.sunDirection });
const post = createPostChain(renderer, scene, heroScene, camera3);
let character = null;
let retarget = null;   // legacy driver (procedural hero only)
let motion = null;     // motion pipeline (VRM hero), rebuilt for every hero
let mhrRig = null;     // MHR skeleton, loaded once and shared across pipeline rebuilds
// live pipeline options set by the HUD (copied into every rebuilt pipeline)
const motionOpts = { mirror: true, springScale: 1, predict: true, predictMs: 50, footLock: true, ikArms: true, accents: true, hands: 'pose' };
let quality = null;
const resize = autoResize(renderer, camera3, {
  pixelRatio: () => quality?.dpr ?? Math.min(devicePixelRatio, 2),
  onResize: (w, h) => post.setSize(w, h),
});
quality = new QualityManager({
  mode: params.get('quality') || 'auto',
  apply: (p, dpr, reason) => {
    post.setPreset(p);
    heroLights.setShadows(p.shadows, p.shadowMap);
    arena.setShadows?.(p.shadows); post.invalidateWorldShadows();
    character?.materials?.setQuality(p.outlines);
    if (Math.abs(renderer.getPixelRatio() - dpr) > 1e-3) resize.apply();
    if (reason && !reason.startsWith('mode')) console.info(`[quality] ${reason} -> ${p.id} @ dpr ${dpr.toFixed(2)}`);
  },
});
const controls = new OrbitControls(camera3, renderer.domElement);
controls.enableDamping = true;
controls.enabled = false;

// ------------------------------------------------------------------------------------------- hero
// The hero loads async (VRM by default, ?vrm=/vrm/<file>.vrm to override, ?hero=procedural for the old
// procedural hero). The retargeter and pose-match ghost are rebuilt for every hero (they measure its rest pose).
const NO_GHOST = { visible: false, setPose() {}, highlight() {} };
let ghost = NO_GHOST;
let heroLoadToken = 0;
const contactBlob = createContactShadow();
scene.add(contactBlob.mesh);
// views were authored for the 1.79 m procedural hero; scale them by the loaded hero's height (same framing %)
const VIEW_BASE_HEIGHT = 1.79;
let heroScale = 1;
const debugState = { outlines: true, wireframe: false };

function showLoading(text, progress = null) {
  const el = $('loading');
  if (text === null) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.querySelector('.t').textContent = text;
  el.querySelector('i').style.width = progress == null ? '0%' : `${Math.round(progress * 100)}%`;
}

async function loadHero(url) {
  const token = ++heroLoadToken;
  const meta = modelByUrl(url);
  const label = HERO_KIND === 'procedural' ? 'procedural hero' : meta?.label || url.split('/').pop();
  showLoading(`Loading ${label}…`);
  ui.status('connecting', `Loading ${label}…`);
  let h;
  try {
    if (HERO_KIND === 'procedural') {
      h = await createCharacterAsync({ camera: camera3 });
      h.setCamera?.(camera3);
    } else {
      h = await loadVRMHero(url, { camera: camera3, renderer, quality: quality.tier, onProgress: (p) => showLoading(`Loading ${label}…`, p) });
    }
  } catch (e) {
    console.error('[hero] load failed', e);
    showLoading(null);
    ui.status('error', `Hero failed to load: ${e.message || e}`);
    return null;
  }
  if (token !== heroLoadToken) { h.dispose?.(); return null; } // a newer pick superseded this one
  // VRM: build the motion pipeline for this hero before swapping, so there is never a frame with a new hero
  // and no driver (the pipeline measures the hero's rest skeleton)
  let m = null;
  if (USE_PIPELINE) {
    try {
      m = await createMotionPipeline({ hero: h, mhr: mhrRig, options: { ...motionOpts } });
    } catch (e) {
      console.error('[motion] pipeline failed', e);
      h.dispose?.(); showLoading(null); ui.status('error', `Motion pipeline failed: ${e.message || e}`);
      return null;
    }
    if (token !== heroLoadToken) { m.dispose(); h.dispose?.(); return null; }
    mhrRig = m.mhr;
  }
  // swap in
  if (character) { heroScene.remove(character.root); character.dispose?.(); }
  if (ghost !== NO_GHOST) heroScene.remove(ghost);
  character = h;
  heroScene.add(h.root);
  // the hero is still in its rest pose here: measure it for the pose-match ghost
  const restPos = restPositions(h);
  if (USE_PIPELINE) {
    retarget = null;
    installMotion(m, h);
    ghost = new Ghost({ restPos });
  } else {
    retarget = new Retargeter(h);
    retarget.interp = +$('interp').value;
    ghost = new Ghost(retarget);
  }
  heroScene.add(ghost);
  poseMatch.ghost = ghost;
  if (mode === 'pose' && poseMatch.active) poseMatch._show();
  heroScale = HERO_KIND === 'procedural' ? 1 : (h.info?.height || VIEW_BASE_HEIGHT) / VIEW_BASE_HEIGHT;
  heroLights.setHeroHeight(h.info?.height || VIEW_BASE_HEIGHT);
  setView(view, { snap: true });
  h.materials?.setQuality(quality.preset.outlines);
  h.materials?.setOutlines(debugState.outlines);
  h.materials?.setWireframe(debugState.wireframe);
  if (source) { recalibrate(); h.resetDynamics?.(); }
  vrmUrl = url;
  $('modelCredit').textContent = HERO_KIND === 'procedural' ? 'Procedural hero (legacy fallback)'
    : `${h.info.name} · VRM ${h.info.version} · ${meta?.licence ?? ''}${meta?.credit ? ' · ' + meta.credit : ''}`;
  console.info(`[hero] ${label} ready in ${h.info?.totalMs ?? h.buildInfo?.totalMs} ms`, h.info);
  showLoading(null);
  ui.status(source ? 'ready' : '', source ? 'Tracking' : 'Pick a source and press Start');
  return h;
}

/** Hero-root-space positions of the legacy bone proxies (call while the hero is in its rest pose). */
function restPositions(h) {
  h.root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(h.root.matrixWorld).invert(), out = {};
  for (const [name, b] of Object.entries(h.bones)) out[name] = b.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
  return out;
}

/** Swap in a freshly built pipeline: drop the old one, hook the game's action handler and the live source. */
function installMotion(m, h) {
  motion?.dispose();          // restores the source's own onPose handler
  motion = m;
  Object.assign(m.options, motionOpts);
  h.fingersExternal = m.options.hands !== 'off';
  // one ActionDetector per pipeline (fed by its light-filtered stream); the legacy detector stays idle
  m.actions.sensitivity = +$('sens').value;
  m.actions.on(onAction);
  if (source) { source.onPose = onPose; m.setSource(source); m.calibrate(); }
  attachCombatFx(h, m);
}

/** Write HUD option changes into the live pipeline. */
function setMotionOption(key, value) {
  motionOpts[key] = value;
  if (!motion) return;
  motion.options[key] = value;
  if (key === 'hands' && character) character.fingersExternal = value !== 'off';
}

function recalibrate() {
  if (USE_PIPELINE) motion?.calibrate();
  else { filter.reset(); retarget?.recalibrate(); legacyActions.recalibrate(); }
}

// debug skeleton of the raw tracked pose (thin lines next to the avatar)
const skelGeo = new THREE.BufferGeometry();
skelGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(64 * 6), 3));
const skelLines = new THREE.LineSegments(skelGeo, new THREE.LineBasicMaterial({ color: 0x66ffcc, transparent: true, opacity: 0.8, depthTest: false }));
skelLines.renderOrder = 20;
skelLines.frustumCulled = false;
heroScene.add(skelLines);
const SKEL = [['leftShoulder', 'rightShoulder'], ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'], ['leftWrist', 'leftHand'],
  ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'], ['rightWrist', 'rightHand'], ['leftShoulder', 'leftHip'],
  ['rightShoulder', 'rightHip'], ['leftHip', 'rightHip'], ['leftHip', 'leftKnee'], ['leftKnee', 'leftAnkle'], ['leftAnkle', 'leftToe'],
  ['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle'], ['rightAnkle', 'rightToe'], ['neck', 'nose'], ['leftEar', 'rightEar']];

// ------------------------------------------------------------------------------------------- camera views
const VIEWS = {
  // spec 2.14 front cam: (0, 1.30, 4.9) -> (0, 0.98, 0), FOV 34: hero ~60% of viewport height.
  // QA r3 P2-7: the synthetic player's standing moves (arms toward the camera) measured 65.0-65.3 % at 1920x1080,
  // on the 65 % ceiling; pulled back 4.5 % along the same view ray (same pitch / look-at) -> ~61-62 % standing.
  // QA v3 r1 improvement 5: hero at 65-70 % of the viewport height (was ~62 %): 0.9x closer along the same ray
  // (same pitch / look-at), with the play HUD collapsed so nothing covers the bigger hero.
  front: { pos: [0, 1.281, 4.62], look: [0, 0.98, 0], mirror: true },
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
  const pos = new THREE.Vector3(...V.pos).multiplyScalar(heroScale), look = new THREE.Vector3(...V.look).multiplyScalar(heroScale);
  // a lerp between opposite sides (front <-> behind) would fly the camera through the hero: cut instead
  const from = camera3.position.clone().sub(camLook).setY(0), to = pos.clone().sub(look).setY(0);
  if (from.lengthSq() > 1e-6 && from.normalize().dot(to.normalize()) < 0) snap = true;
  camGoal.pos.copy(pos); camGoal.look.copy(look);
  if (snap) { _liftVec.set(0, 0, 0); camLift = 0; camera3.position.copy(camGoal.pos); camLook.copy(camGoal.look); camera3.lookAt(camLook); camera3.updateMatrixWorld(); }
  controls.enabled = !!V.orbit;
  if (V.orbit) { _liftVec.set(0, 0, 0); camLift = 0; controls.target.copy(camGoal.look); camera3.position.copy(camGoal.pos); }
  if (V.mirror !== null) setMirror(V.mirror);
  document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
}

// ------------------------------------------------------------------------------------------- state
const settings = { mirror: true, showSkel: true };
/** Mirror mode: the avatar is the player's mirror image (Front view). Behind view: off (same sides as the player). */
function setMirror(on) {
  $('mirror').checked = on;
  if (settings.mirror === on && motionOpts.mirror === on) return;
  settings.mirror = on;
  setMotionOption('mirror', on);
  // the predictor/springs hold rotations in the old (mirrored) convention: restart them (calibration is kept)
  motion?.reset();
}
const camera = new Camera($('video'));
const sources = {
  hmr: new HMRSource(camera),
  mediapipe: new MediaPipeSource(camera),
  synthetic: new SyntheticSource(),
};
let source = null;
const filter = new PoseFilter();            // legacy (procedural hero)
const legacyActions = new ActionDetector(); // legacy (procedural hero); the VRM hero uses motion.actions
/** The single active trigger detector (no double detection). */
const activeActions = () => (USE_PIPELINE ? motion?.actions : legacyActions);
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
let floaterSide = 1;
const FLOATER_BONES = ['headTop', 'head', 'neck', 'leftUpperArm', 'rightUpperArm', 'leftForeArm', 'rightForeArm', 'leftHand', 'rightHand',
  'leftHandTip', 'rightHandTip', 'hips', 'leftShin', 'rightShin', 'leftFoot', 'rightFoot', 'leftToe', 'rightToe'];
const _fv = new THREE.Vector3();
function floater(text, color) {
  if (!character) return;
  // QA v3 r2 P2-8: labels never cross the head or body. Project the posed skeleton to a screen rect (padded for
  // the head and limbs' thickness) and place the label OUTSIDE it, beside the shoulders, alternating sides; if a
  // side has no room inside the viewport, use the other one. (r1 anchored beside a shoulder, which still crossed
  // the face in Side view and on cross punches.)
  const W = innerWidth, H = innerHeight;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, headY = 0, shY = 0;
  camera3.updateMatrixWorld();
  for (const k of FLOATER_BONES) {
    const b = character.bones[k];
    if (!b) continue;
    b.getWorldPosition(_fv).project(camera3);
    const sx = (_fv.x * 0.5 + 0.5) * W, sy = (-_fv.y * 0.5 + 0.5) * H;
    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    if (k === 'head') headY = sy;
    if (k === 'leftUpperArm') shY = sy;
  }
  if (!isFinite(x0)) return;
  // head radius in px (head joint -> head top), used as the padding around the bone rect
  const pad = Math.max(24, Math.abs(headY - y0) * 0.9);
  x0 -= pad; x1 += pad;
  const halfW = text.length * 9 + 10;               // ~Bangers 34 px, centred (translate -50 %)
  const margin = 12;
  const leftX = x0 - margin - halfW, rightX = x1 + margin + halfW;
  const fitsL = leftX - halfW >= 8, fitsR = rightX + halfW <= W - 8;
  floaterSide = -floaterSide;
  let side = floaterSide;
  if (side < 0 && !fitsL && fitsR) side = 1;
  if (side > 0 && !fitsR && fitsL) side = -1;
  const x = THREE.MathUtils.clamp(side < 0 ? leftX : rightX, halfW + 8, W - halfW - 8);
  // shoulder height (the label floats up 90 px from there); stays clear of the top HUD
  const y = THREE.MathUtils.clamp(shY - 10, 150, H - 80);
  const el = document.createElement('div');
  el.className = 'floater'; el.textContent = text; el.style.color = color;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  $('floaters').appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

// ------------------------------------------------------------------------------------------- modes
const reaction = new ReactionTest(ui);
const poseMatch = new PoseMatchTest(ui, ghost); // ghost is swapped in by loadHero()
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

function onAction(name, info) {
  const a = ACTIONS[name];
  const sys = info.tCapture ? Math.round(info.t - info.tCapture) : null;
  logLine(`<b style="color:${a.color}">${a.label}</b> · ${sys != null ? `${sys} ms after capture` : ''}`);
  if (mode === 'free' && a.kind === 'impulse') floater(a.label + '!', a.color);
  // avatar-side action (the avatar is a mirror image when settings.mirror): hand pose + expression preset,
  // auto-fist on punches (punching hand + guard hand), reverts after the preset hold
  const avatarName = settings.mirror ? name.replace(/Left$/, '#').replace(/Right$/, 'Left').replace(/#$/, 'Right') : name;
  character?.setAction?.(avatarName);
  // fists: the pipeline's punch accent / hand poser closes the hands when it drives the fingers
  if (name.startsWith('punch') && !character?.fingersExternal) character?.setHandPose?.('fist', 'both');
  // QA v3 r2 P1-5: per-action faces (vrm/expressions.js): punch = focused frown (mouth closed), kick = a brief kiai,
  // jump = happy + small "aa"
  if (name.startsWith('punch')) character?.setExpression?.('determined');
  else if (name.startsWith('kick')) character?.setExpression?.('effort');
  else if (name === 'jump') character?.setExpression?.(character?.kind === 'vrm' ? 'jump' : 'happy');
  else if (name === 'handsUp') character?.setExpression?.('happy');
  reaction.onAction(name, info);
  fx?.onAction?.(name, info); // FX HOOK: hit-stop / impact / sparks
}
legacyActions.on(onAction);

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
  // VRM hero: the motion pipeline (chained after this handler on source.onPose) solves, filters, detects
  // triggers and drives the hero; this handler only keeps the HUD stats
  if (USE_PIPELINE) return;

  // player-space (person's own left/right) → triggers
  const filtered = filter.apply(frame.joints, frame.tCapture);
  legacyActions.update(filtered, frame.conf, frame.tCapture);

  // character-space → avatar
  let joints = filtered, conf = frame.conf;
  if (settings.mirror) ({ joints, conf } = mirrorPose(filtered, frame.conf));
  retarget?.setPose(joints, conf);
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
  if (USE_PIPELINE) { updatePipelineSkeleton(); return; }
  skelLines.visible = settings.showSkel && tracking && !!lastPose && !!character;
  if (!skelLines.visible) return;
  const J = lastPose.joints;
  const pos = skelGeo.attributes.position.array;
  // place the raw skeleton beside the avatar, aligned at the hips
  const hip = midpoint(J.leftHip, J.rightHip);
  const anchor = new THREE.Vector3();
  character.bones.hips.getWorldPosition(anchor);
  anchor.x -= 1.1 * heroScale;
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

// VRM: the pipeline's last sample (floor frame, calibrated, mirrored like the avatar) scaled to the hero
function updatePipelineSkeleton() {
  const smp = motion?.lastSample;
  skelLines.visible = settings.showSkel && tracking && !!smp && !!character;
  if (!skelLines.visible) return;
  const P = smp.pts, k = smp.k, pos = skelGeo.attributes.position.array;
  const ox = character.root.position.x - 1.1 * heroScale, oy = character.root.position.y, oz = character.root.position.z;
  let i = 0;
  for (const [a, b] of SKEL) {
    const pa = P[a], pb = P[b];
    for (const p of [pa, pb]) {
      const q = pa && pb ? p : null;   // missing joint: zero-length segment
      pos[i++] = q ? q.x * k + ox : ox; pos[i++] = q ? q.y * k + oy : oy; pos[i++] = q ? q.z * k + oz : oz;
    }
  }
  skelGeo.setDrawRange(0, SKEL.length * 2);
  skelGeo.attributes.position.needsUpdate = true;
}

// idle pose when nobody is tracked: relaxed standing with breathing
function idlePose(t) {
  if (!retarget) return;
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
let startToken = 0;
async function start() {
  stop();
  const token = ++startToken;   // a newer start()/stop() while awaiting the camera/model cancels this one
  const kind = $('source').value;
  const src = (source = sources[kind]);
  src.onStatus = (k, text) => ui.status(k, text);
  src.onPose = onPose;
  if (USE_PIPELINE && motion) motion.setSource(src);   // chains after onPose
  recalibrate(); character?.resetDynamics?.();
  try {
    if (kind !== 'synthetic') {
      ui.status('connecting', 'Opening camera…');
      const s = await camera.start($('cameraSel').value || undefined);
      if (token !== startToken) return;
      $('previewTag').textContent = `camera ${s.width}×${s.height} @ ${Math.round(s.frameRate || 0)}fps`;
      refreshCameras();
    }
    if (kind === 'hmr') src.url = $('serverUrl').value.trim();
    await src.start();
    if (token !== startToken) { if (src !== source) src.stop(); return; }
    $('startBtn').textContent = '■ Stop';
    $('startBtn').classList.add('running');
    ui.banner('Calibrating…', 'Stand still in your neutral spot for a second');
    setCompact(true); // play HUD: panels slide away, latency + triggers stay in the mini overlay (H toggles)
  } catch (e) {
    if (token !== startToken) return;
    console.error(e);
    ui.status('error', e.name === 'NotAllowedError' ? 'Camera permission denied' : `Failed: ${e.message || e}`);
    motion?.setSource(null);
    source = null;
  }
}
function stop() {
  startToken++;
  if (source) source.stop();
  motion?.setSource(null);
  source = null;
  camera.stop();
  tracking = false;
  $('startBtn').textContent = '▶ Start';
  $('startBtn').classList.remove('running');
}
$('startBtn').onclick = () => (source ? (stop(), setCompact(false), ui.status('', 'Stopped')) : start());

// ------------------------------------------------------------------------------------------- compact play HUD
// QA v3 r1 P2-1 / improvement 5: during play the setup + metrics panels slide off-screen and the webcam preview
// shrinks; a small overlay keeps the latency, fps and trigger chips visible. H or the HUD button toggles it.
const miniTrig = {};
for (const [k, a] of Object.entries(ACTIONS)) {
  const s = document.createElement('span');
  s.textContent = a.label; $('miniTrig').appendChild(s); miniTrig[k] = s;
}
function setCompact(on) {
  document.body.classList.toggle('compact', !!on);
  $('hudToggle').classList.toggle('on', !on);
  $('hudToggle').title = on ? 'Show the full HUD (H)' : 'Collapse the HUD for play (H)';
}
$('hudToggle').onclick = () => { setCompact(!document.body.classList.contains('compact')); $('hudToggle').blur(); };
$('calibBtn').onclick = () => { recalibrate(); character?.resetDynamics?.(); ui.banner('Calibrating…', 'Hold still for a second'); };
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
/** Relabel + re-range a slider (the VRM hero's pipeline has different, clearer knobs than the legacy filter). */
function reshapeRange(id, label, title, { min, max, step, value }) {
  const el = $(id), lab = el.closest('label');
  lab.firstChild.textContent = label + ' ';
  lab.title = title;
  Object.assign(el, { min, max, step }); el.value = value;
}
if (USE_PIPELINE) {
  // Responsiveness -> tracking-spring half-life scale (0.5 = the tuned defaults: arms 28 ms, legs 35, spine 50)
  reshapeRange('smooth', 'Responsiveness', 'Tracking spring stiffness: right = snappier (more jitter), left = smoother (more lag)',
    { min: 0, max: 1, step: 0.05, value: 0.5 });
  // Prediction -> how much of the tracker latency is hidden by extrapolation (pipeline predictMs)
  reshapeRange('interp', 'Prediction', 'Extrapolates each bone ahead to hide tracker latency (0 = off). Too much overshoots fast moves.',
    { min: 0, max: 100, step: 5, value: 50 });
  bindRange('smooth', (v) => `${Math.round(28 * 4 ** (1 - 2 * v))} ms`, (v) => setMotionOption('springScale', 4 ** (1 - 2 * v)));
  bindRange('interp', (v) => (v < 1 ? 'off' : `${v} ms`), (v) => { setMotionOption('predict', v >= 1); setMotionOption('predictMs', v); });
  // pipeline toggles (testing)
  const box = document.createElement('div');
  box.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:2px 10px';
  const TOGGLES = [['footLock', 'Foot lock', 'Plant feet on the floor (no skating) + leg IK'],
    ['ikArms', 'Arm reach IK', 'Straighten near-full reaches and punches'],
    ['accents', 'Accents', 'Anime punch / kick / jump / landing accents'],
    ['hands', 'Hand poses', 'Fist / open / point from the tracker (off: the hero curls its own fingers)']];
  for (const [key, label, title] of TOGGLES) {
    const l = document.createElement('label');
    l.className = 'check'; l.title = title;
    l.innerHTML = `<input type="checkbox" id="opt_${key}" ${motionOpts[key] && motionOpts[key] !== 'off' ? 'checked' : ''}/> ${label}`;
    l.querySelector('input').onchange = (e) => setMotionOption(key, key === 'hands' ? (e.target.checked ? 'pose' : 'off') : e.target.checked);
    box.appendChild(l);
  }
  const head = document.createElement('h3'); head.textContent = 'Motion pipeline';
  $('showSkel').closest('label').after(head, box);
} else {
  bindRange('smooth', (v) => (v < 0.02 ? 'off' : Math.round(v * 100) + '%'), (v) => (filter.strength = v));
  bindRange('interp', (v) => (v < 0.02 ? 'off' : Math.round(v * 100) + '%'), (v) => { if (retarget) retarget.interp = v; });
}
bindRange('sens', (v) => v.toFixed(2) + '×', (v) => { legacyActions.sensitivity = v; if (motion) motion.actions.sensitivity = v; });
$('mirror').onchange = (e) => setMirror(e.target.checked);
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
const STAGE_COLORS = { encode: '#a29bfe', transport: '#74b9ff', decode: '#81ecec', detect: '#ff7675', hmr: '#fdcb6e', inference: '#fdcb6e', display: '#55efc4',
  solve: '#e17055', pose: '#00cec9' };
// VRM: extra pipeline readouts in the Accuracy grid
if (USE_PIPELINE) {
  const grid = $('mConf').closest('.grid');
  grid.insertAdjacentHTML('beforeend', ['mFoot:Foot lock', 'mLead:Prediction', 'mE2E:Motion lag', 'mSolver:Solver']
    .map((x) => { const [id, l] = x.split(':'); return `<div>${l}<b id="${id}" class="small">–</b></div>`; }).join(''));
  $('mJitter').closest('div').firstChild.textContent = 'Jitter out/raw';
  $('mJitter').closest('div').title = 'RMS angular speed of hips/head/hands (rad/s): avatar output vs raw solver';
  $('mE2E').closest('div').title = 'Player motion -> avatar motion, cross-correlated wrists (includes prediction; excludes scan-out)';
}
let motionSnap = null;
function updateHUD() {
  if (USE_PIPELINE && motion) motionSnap = motion.metrics.snapshot();
  const actions = activeActions();
  const lat = stats.lat.slice(-60);
  const avg = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : NaN;
  $('mLatency').textContent = isNaN(avg) ? '–' : Math.round(avg);
  $('mLatencyCap').textContent = source === sources.synthetic ? 'synthetic: pose emit → on screen'
    : `camera (${camera.timestampKind}) → avatar on screen`;
  if (USE_PIPELINE) $('mLatencyCap').title = 'Capture time of the newest pose -> the first rendered frame showing it (+ half a vsync). '
    + 'Prediction then shows the pose up to "Prediction" ms ahead of that sample.';
  $('mP50').textContent = isNaN(avg) ? '–' : Math.round(pct(lat, 0.5)) + '';
  $('mP95').textContent = isNaN(avg) ? '–' : Math.round(pct(lat, 0.95)) + '';
  $('mTrackFps').textContent = stats.poseTimes.length;
  $('mCamFps').textContent = camera.active ? Math.round(camera.fps) : '–';
  const rt = stats.renderTimes;
  $('mRenderFps').textContent = rt.length > 1 ? Math.round(((rt.length - 1) * 1000) / (rt.at(-1) - rt[0])) : '–';
  $('mLost').textContent = stats.lost;
  $('mConf').textContent = tracking ? Math.round(stats.conf * 100) + '%' : '–';
  $('mVis').textContent = tracking ? Math.round(stats.vis * 100) + '%' : '–';
  if (USE_PIPELINE) {
    const m = motionSnap, st = motion?.state;
    $('mJitter').textContent = tracking && m ? `${m.jitter.outSpeed.toFixed(2)}/${m.jitter.rawSpeed.toFixed(2)}` : '–';
    $('mFoot').textContent = tracking && st ? `L ${st.locked.left ? '●' : '○'} R ${st.locked.right ? '●' : '○'}` : '–';
    $('mLead').textContent = tracking && m ? `${Math.round(m.latency.lead)} ms` : '–';
    $('mE2E').textContent = tracking && m && m.latency.e2eCorr > 0.5 ? `${Math.round(m.latency.e2e)} ms` : '–';
    $('mSolver').textContent = st ? `${st.solver}${st.calibrated ? '' : ' · calib…'}` : '–';
  } else $('mJitter').textContent = tracking ? stats.jitter.toFixed(1) + 'mm' : '–';
  $('mModel').textContent = source ? source.model || '…' : '–';
  // breakdown
  const T = { ...stats.timing };
  const stages = Object.entries(T).filter(([k]) => STAGE_COLORS[k] !== undefined && k !== 'display');
  if (USE_PIPELINE && motionSnap) stages.push(['solve', motionSnap.cost.solveMs], ['pose', motionSnap.cost.updateMs]);
  stages.push(['display', stats.displayWait || 0]);
  const tot = Math.max(30, ...stages.map(([, v]) => v));
  $('breakdown').innerHTML = stages.map(([k, v]) => `<div class="bar"><span>${k}</span><div><i style="width:${(v / tot) * 100}%;background:${STAGE_COLORS[k]}"></i></div><span>${v.toFixed(1)} ms</span></div>`).join('')
    + (T.rtt ? `<div class="bar"><span>round trip</span><div></div><span>${T.rtt.toFixed(1)} ms</span></div>` : '')
    + (USE_PIPELINE && motionSnap && tracking ? `<div class="bar"><span>predicted</span><div></div><span>−${motionSnap.latency.lead.toFixed(0)} ms</span></div>` : '');
  for (const [k, el] of Object.entries(trigEls)) {
    const on = !!actions && (!!actions.state[k] || performance.now() - (actions.lastFire[k] ?? -1e9) < 350);
    el.classList.toggle('on', on);
    el.style.background = on ? ACTIONS[k].color : '';
    miniTrig[k].classList.toggle('on', on);
    miniTrig[k].style.background = on ? ACTIONS[k].color : '';
  }
  // compact overlay
  $('miniLat').textContent = $('mLatency').textContent;
  $('miniFps').textContent = $('mRenderFps').textContent;
  $('miniTrack').textContent = $('mTrackFps').textContent;
  // rendering
  const rs = stats.renderInfo;
  if (rs) {
    $('mDraws').textContent = rs.calls;
    $('mTris').textContent = rs.triangles >= 1000 ? (rs.triangles / 1000).toFixed(1) + 'k' : rs.triangles;
    $('mFrameMs').textContent = quality.ema.toFixed(1);
    $('mTier').textContent = `${quality.preset.label}${quality.mode === 'auto' ? ' (auto)' : ''}`;
    $('mDpr').textContent = renderer.getPixelRatio().toFixed(2);
    $('mHeroMs').textContent = character?.timing ? character.timing.update.toFixed(2) : '–';
  }
  drawLatChart();
}
setInterval(updateHUD, 200);

// ------------------------------------------------------------------------------------------- FX HOOK
// >>> FX ATTACH POINT (wired by the lead; module owned by the motion/combat engineer: web/src/fx/*) <<<
// Expected shape: fx = createFx({ renderer, scene, heroScene, camera: camera3, post, heroLights, getHero: () => character })
//   fx.update(dt, t)          called every frame after the hero is posed, before rendering (shake, trails, sparks)
//   fx.onAction(name, info)   called for every fired trigger (hit-stop, impact frame, sparks)
//   fx.timeScale              optional (hit-stop): scales the hero/motion dt when present
// Until it is attached all three calls are no-ops. window.attachFx(fx) attaches one from the console / a module.
let fx = null;
let fxTimeScale = 1; // < 1 during a hit-stop (from last frame's fx.update)
window.attachFx = (f) => { fx = f; return fx; };
/** Combat FX (hit-stop, shake, trails, sparks, dust): driven by the motion pipeline's events. */
function attachCombatFx(h, m) {
  if (!fx) fx = createFx({ scene: heroScene, camera: camera3, hero: h, motion: m });
  else { fx.setHero(h); fx.setMotion(m); }
}

// ------------------------------------------------------------------------------------------- loop
const clock = new THREE.Clock();
const _hp = new THREE.Vector3(), _keyAim = new THREE.Vector3(), _follow = new THREE.Vector3(), _tmp = new THREE.Vector3();
let lastFrameAt = 0;

// ------------------------------------------------------------------------------------------- camera headroom
// Top of the hero (head top + hand tips) projected with the camera's GOAL pose (no lift, no shake). If it sits above
// HEADROOM.top (fraction of the viewport height from the top edge) the needed lift is the world height that moves it
// back down at the hero's depth; the applied lift rises quickly and settles slowly.
const HEADROOM = { top: 0.085, maxLift: 0.55, rise: 12, fall: 1.6, dolly: 0.35 };
const _goalCam = new THREE.PerspectiveCamera();
const _camBack = new THREE.Vector3(), _top = new THREE.Vector3(), _liftVec = new THREE.Vector3();
let camLift = 0;
function headroomLift(dt) {
  if (!character || !character.bones.headTop) { camLift += (0 - camLift) * (1 - Math.exp(-dt * HEADROOM.fall)); return camLift; }
  _goalCam.copy(camera3, false);
  _follow.y = 0;
  _goalCam.position.copy(camGoal.pos).add(_follow);
  _goalCam.lookAt(_tmp.copy(camGoal.look).add(_follow));
  _goalCam.updateMatrixWorld(); _goalCam.matrixWorldInverse.copy(_goalCam.matrixWorld).invert();
  _camBack.copy(camGoal.pos).sub(camGoal.look).normalize();
  let need = 0;
  const limit = 1 - 2 * HEADROOM.top; // NDC y of the headroom line
  for (const k of ['headTop', 'leftHandTip', 'rightHandTip']) {
    const b = character.bones[k];
    if (!b) continue;
    b.getWorldPosition(_top);
    const depth = -_tmp.copy(_top).applyMatrix4(_goalCam.matrixWorldInverse).z;
    const ndcY = _top.project(_goalCam).y;
    if (ndcY > limit && depth > 0) {
      // world height per NDC unit at that depth; the dolly-back adds a little room too, so this slightly overshoots
      const perNdc = depth * Math.tan(THREE.MathUtils.degToRad(_goalCam.fov) / 2);
      need = Math.max(need, (ndcY - limit) * perNdc);
    }
  }
  need = Math.min(need, HEADROOM.maxLift * heroScale);
  camLift += (need - camLift) * (1 - Math.exp(-dt * (need > camLift ? HEADROOM.rise : HEADROOM.fall)));
  return camLift;
}

/** retarget -> hero.update -> overlays/lights. Shared by the rAF loop and renderOnce(). */
function stepHero(dt, t) {
  if (!character) return;
  if (USE_PIPELINE) {
    // pipeline: predict to now + spring + confidence/base + accents + IK -> hero.applyHumanoidPose (also writes
    // the legacy bone proxies, so ghost / pose match / framing / contact shadow keep reading hero.bones)
    if (motion) motion.update(dt, performance.now());
  } else {
    if (!retarget) return;
    if (!tracking) idlePose(t);
    // frame order (CONTRACTS 8): retargeter writes hero.bones, then the hero syncs them to its skeleton/physics
    retarget.update(dt);
  }
  character.update?.(dt, t);
  contactBlob.update(character);
  if (mode === 'pose') poseMatch.update(dt, character.bones, character.root, tracking);
  character.bones.hips.getWorldPosition(_hp);
  ghost.position.set(_hp.x, 0, _hp.z);
  // character key light follows the camera azimuth, aimed at the chest
  _keyAim.set(_hp.x, _hp.y + 0.25 * heroScale, _hp.z);
  heroLights.update(camera3, _keyAim);
}

function renderFrame(dt) {
  renderer.info.reset();
  // VRM shader patches (SDF face, angel ring, lit-side / back rim) read the key + rim light in view / head space
  if (character?.materials?.updateFrame) { camera3.updateMatrixWorld(); character.materials.updateFrame(camera3, heroLights); }
  post.render(dt);
  stats.renderInfo = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
}

function frameLoop() {
  requestAnimationFrame(frameLoop);
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.elapsedTime;
  const now = performance.now();
  if (lastFrameAt) quality.frame(now - lastFrameAt);
  lastFrameAt = now;
  stats.renderTimes.push(now);
  while (stats.renderTimes.length > 61) stats.renderTimes.shift();

  if (tracking && now - stats.lastPoseAt > 600) tracking = false;
  stepHero(dt * fxTimeScale, t); // FX HOOK: hit-stop time scale

  // camera follow
  if (!controls.enabled) {
    if (character) character.bones.hips.getWorldPosition(_hp); else _hp.set(0, 0, 0);
    _follow.set(_hp.x * 0.6, 0, _hp.z * 0.6);
    // QA v3 r2 P1-3: vertical headroom. Standing framing is unchanged (~65 %); when the head top or a raised hand
    // would come within HEADROOM of the top edge (jump apex, hands up), the camera lifts (and eases back a
    // little) just enough to keep it in frame: fast up, slow settle, so it reads as a soft follow, not a jolt.
    // The lift is applied on top of the (slow) follow lerp, not through it, so it can keep up with a 0.45 s jump.
    const lift = headroomLift(dt);
    camera3.position.sub(_liftVec); camLook.y -= _liftVec.y;
    camera3.position.lerp(_tmp.copy(camGoal.pos).add(_follow), 1 - Math.exp(-dt * 3));
    camLook.lerp(_tmp.copy(camGoal.look).add(_follow), 1 - Math.exp(-dt * 3));
    _liftVec.set(0, lift, 0).addScaledVector(_camBack, lift * HEADROOM.dolly);
    camera3.position.add(_liftVec); camLook.y += lift;
    camera3.lookAt(camLook);
  } else controls.update();

  updateSkeletonLines();
  arena.update?.(dt, t);
  fxTimeScale = fx ? fx.update(dt) ?? 1 : 1; // FX HOOK: shake / trails / sparks (after camera follow, before render)
  renderFrame(dt);

  // latency: the newest pose has now been drawn (it is presented on the next vsync — add half a frame)
  if (stats.pendingCapture != null) {
    const vsync = stats.renderTimes.length > 2 ? (stats.renderTimes.at(-1) - stats.renderTimes[0]) / (stats.renderTimes.length - 1) : 16.7;
    const shown = performance.now() + vsync * 0.5;
    stats.lat.push(shown - stats.pendingCapture);
    if (stats.lat.length > 300) stats.lat.shift();
    stats.displayWait = shown - stats.lastPoseAt;
    stats.pendingCapture = null;
  }
}

// ------------------------------------------------------------------------------------------- character panel
function initCharacterPanel() {
  const sel = $('modelSel');
  sel.innerHTML = VRM_MODELS.map((m) => `<option value="${modelUrl(m.file)}">${m.label} · VRM ${m.version}</option>`).join('')
    + '<option value="procedural">Procedural hero (legacy)</option>';
  if (HERO_KIND === 'procedural') sel.value = 'procedural';
  else {
    if (!modelByUrl(vrmUrl)) sel.insertAdjacentHTML('beforeend', `<option value="${vrmUrl}">${vrmUrl.split('/').pop()}</option>`);
    sel.value = vrmUrl;
  }
  sel.onchange = () => {
    const v = sel.value;
    const q = new URLSearchParams(location.search);
    if (v === 'procedural' || HERO_KIND === 'procedural') { // switching hero kind: reload with the right params
      q.delete('vrm'); q.delete('hero');
      if (v === 'procedural') q.set('hero', 'procedural'); else q.set('vrm', v);
      location.search = q.toString();
      return;
    }
    q.set('vrm', v);
    history.replaceState(null, '', `${location.pathname}?${q}`);
    loadHero(v);
    sel.blur();
  };
  const qs = $('qualitySel');
  qs.value = quality.mode;
  qs.onchange = () => { quality.setMode(qs.value); qs.blur(); };
  $('outlinesChk').onchange = (e) => { debugState.outlines = e.target.checked; character?.materials?.setOutlines(debugState.outlines); };
  $('wireChk').onchange = (e) => { debugState.wireframe = e.target.checked; character?.materials?.setWireframe(debugState.wireframe); };
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
  if (e.key === 'h') $('hudToggle').click();
});

$('source').onchange();
initCharacterPanel();
setView('front');
frameLoop();
const characterReady = loadHero(vrmUrl);

// expose for debugging in the console (getters: the hero / retargeter are replaced when the model changes)
Object.assign(window, { THREE, controls, stats, sources, settings, motionOpts, setMirror, camera3, setView, loadHero, quality, post, heroLights, renderer, scene, heroScene, characterReady });
Object.defineProperties(window, {
  character: { get: () => character, configurable: true },
  retarget: { get: () => retarget, configurable: true },
  motion: { get: () => motion, configurable: true },
  actions: { get: () => activeActions(), configurable: true },
  poseMatch: { get: () => poseMatch, configurable: true },
  reaction: { get: () => reaction, configurable: true },
  ghost: { get: () => ghost, configurable: true },
});
// QA: render one frame synchronously (rAF is throttled in hidden panes): retarget -> hero.update -> render.
window.renderOnce = (dt = 1 / 60) => {
  stepHero(dt, clock.elapsedTime);
  camera3.updateMatrixWorld();
  renderFrame(dt);
  return { ...stats.renderInfo, hero: character ? heroRenderStats(character) : null };
};
// QA (spec 4.I): measureFraming() -> hero height % of viewport + any HUD panel overlapping the hero
window.measureFraming = () => character && measureFraming(camera3, character, {
  width: renderer.domElement.clientWidth, height: renderer.domElement.clientHeight,
  panels: ['setup', 'metrics', 'preview', 'topbar', 'mini'].map((id) => $(id)),
});
