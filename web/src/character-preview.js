// Character preview + QA tooling (WP6a). Owner: WP6.
//
// Console API:  setPose(name) | setMode('t'|'test'|'anim') | setView(name) | turntable(on?) |
//               setWireframe(on) | setHeatmap(bone|'*'|null) | setOutlines(on) | setKeyLightAngle(yawDeg, pitchDeg?) |
//               checkRig() | perf() | hero | B
// URL params:   ?v=1 legacy v1 hero; ?parts=body,head subset; ?outline=0 no hulls; ?pose=squat; ?view=side
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createCharacterAsync } from './hero/index.js';
import { createCharacter as createCharacterV1 } from './character_v1.js';
import { JOINT_WORLD } from './hero/dims.js';
import { configureRenderer, autoResize } from './render/pipeline.js';
import { POSES, POSE_NAMES, applyPose } from './render/posePresets.js';
import { createDebugViews, setKeyLightAngle as setKeyLightHook, KEY_LIGHT_DEFAULT } from './render/debugViews.js';
import { createContactShadow } from './render/contactShadow.js';

const $ = (id) => document.getElementById(id);

// Same colour pipeline as the game so swatch / ΔE checks transfer (spec 2.11).
const renderer = new THREE.WebGLRenderer({ canvas: $('view'), antialias: true });
configureRenderer(renderer);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc6e8);
const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 100);
camera.position.set(0, 1.1, 4.2);
autoResize(renderer, camera);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.95, 0);
controls.enableDamping = true;
controls.update();

scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(2.5, 4, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -2; sun.shadow.camera.right = 2;
sun.shadow.camera.top = 2.5; sun.shadow.camera.bottom = -0.5;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun);

const ground = new THREE.Mesh(new THREE.CircleGeometry(3, 48), new THREE.MeshToonMaterial({ color: 0x7fb37a }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ---------------------------------------------------------------------------------------- hero
const params = new URLSearchParams(location.search);
const heroOpts = { camera };
if (params.get('parts')) heroOpts.parts = params.get('parts').split(',');
if (params.get('outline') === '0') heroOpts.outline = false;
const isV1 = params.get('v') === '1';
// v2 builds asynchronously (QA r1 P0-2): the rig exists at once (placeholder capsules), parts swap in when built
let hero = null;
const heroReady = isV1 ? Promise.resolve((hero = createCharacterV1())) : createCharacterAsync({ ...heroOpts, onShell: (h) => { hero = h; } });
scene.add(hero.root);
hero.setCamera?.(camera); // camera-locked key light
const B = hero.bones;
const blob = createContactShadow();
scene.add(blob.mesh);
const debug = createDebugViews(hero);

const exprSel = $('expr');
const fillExpressions = () => { exprSel.innerHTML = (hero.info.expressions || []).map((e) => `<option>${e}</option>`).join(''); };
fillExpressions();

/** Rig check: max deviation (m) of every contract joint from the spec 2.1 table, rest rotations identity. */
window.checkRig = function checkRig() {
  const v = new THREE.Vector3(), q = new THREE.Quaternion();
  const saved = { mode, pose, rotY: hero.root.rotation.y };
  setPose('t'); hero.root.rotation.y = 0;
  hero.root.updateMatrixWorld(true);
  const inv = hero.root.matrixWorld.clone().invert();
  let maxErr = 0, worst = '';
  for (const [n, p] of Object.entries(JOINT_WORLD)) {
    const b = B[n];
    if (!b) return { ok: false, missing: n };
    const e = b.getWorldPosition(v).applyMatrix4(inv).distanceTo(new THREE.Vector3(...p));
    if (e > maxErr) { maxErr = e; worst = n; }
  }
  const nonIdentity = Object.entries(B).filter(([, b]) => b.getWorldQuaternion(q).angleTo(new THREE.Quaternion()) > 1e-6).map(([n]) => n);
  hero.root.rotation.y = saved.rotY;
  if (saved.mode === 'anim') setMode('anim'); else setPose(saved.pose);
  return { ok: maxErr < 0.002, bones: Object.keys(B).length, maxErr, worst, nonIdentity };
};

// joint markers (QA helpers, excluded from counts/framing)
const markers = [];
const markerGeo = new THREE.SphereGeometry(0.012, 8, 6);
for (const [name, b] of Object.entries(B)) {
  const m = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: name.includes('Tip') || name.includes('Toe') || name === 'headTop' ? 0x00ff00 : 0xff0044, depthTest: false }));
  m.renderOrder = 999; m.visible = false; m.userData.qaHelper = true; b.add(m); markers.push(m);
}

// ---------------------------------------------------------------------------------------- poses
let mode = 'pose'; // 'pose' | 'anim'
let pose = 't';
function resetPose() { for (const b of Object.values(B)) b.rotation.set(0, 0, 0); hero.root.position.set(0, 0, 0); }

/** legacy "test pose" (kept for continuity with v1 screenshots) */
function testPose() {
  resetPose();
  B.leftUpperArm.rotation.z = -1.2;
  B.leftForeArm.rotation.y = -1.3;
  B.rightUpperArm.rotation.z = 1.25;
  B.rightForeArm.rotation.y = 1.0;
  B.rightHand.rotation.z = 0.4;
  B.leftThigh.rotation.x = -1.4;
  B.leftShin.rotation.x = 1.6;
  B.leftFoot.rotation.x = 0.3;
  B.spine.rotation.x = 0.1;
  B.chest.rotation.y = 0.2;
  B.head.rotation.set(-0.1, 0.35, 0.05);
}
function animPose(t) {
  resetPose();
  hero.root.position.x = Math.sin(t * 1.5) * 0.5;
  hero.root.position.y = Math.abs(Math.sin(t * 3)) * 0.05;
  B.spine.rotation.z = Math.sin(t * 1.5) * 0.1;
  B.chest.rotation.y = Math.sin(t * 1.2) * 0.25;
  B.head.rotation.x = Math.sin(t * 2) * 0.15;
  B.leftUpperArm.rotation.z = -1.1 + Math.sin(t * 3) * 0.6;
  B.leftForeArm.rotation.y = -0.8 - Math.sin(t * 3) * 0.6;
  B.rightUpperArm.rotation.z = 1.2;
  B.rightUpperArm.rotation.y = Math.sin(t * 3) * 0.5;
  B.rightForeArm.rotation.y = 1.2;
  B.leftThigh.rotation.x = Math.sin(t * 3) * 0.5;
  B.rightThigh.rotation.x = -Math.sin(t * 3) * 0.5;
  B.leftShin.rotation.x = Math.max(0, Math.sin(t * 3 + 1)) * 0.8;
  B.rightShin.rotation.x = Math.max(0, -Math.sin(t * 3 + 1)) * 0.8;
}

const PRESETS = [...POSE_NAMES, 'test'];
const poseRow = $('poseRow');
for (const name of PRESETS.slice().reverse()) {
  const b = document.createElement('button');
  b.dataset.pose = name;
  b.textContent = POSES[name]?.label || 'Test pose';
  poseRow.insertBefore(b, poseRow.children[1]);
}
function syncButtons() {
  document.querySelectorAll('[data-pose]').forEach((b) => b.classList.toggle('on', mode === 'pose' && b.dataset.pose === pose));
  document.querySelector('[data-mode="anim"]').classList.toggle('on', mode === 'anim');
}

/** Apply a QA pose preset by name (see render/posePresets.js). Returns the name, or null if unknown. */
function setPose(name) {
  if (name === 'test') { mode = 'pose'; pose = 'test'; testPose(); syncButtons(); return name; }
  if (!POSES[name]) { console.warn(`setPose: unknown pose "${name}". Available:`, PRESETS.join(', ')); return null; }
  mode = 'pose'; pose = name;
  const rotY = hero.root.rotation.y;
  hero.root.position.set(0, 0, 0);
  applyPose(hero, name);
  hero.root.rotation.y = rotY;
  syncButtons();
  return name;
}
/** v1-compatible: 't' | 'test' | 'anim' (or any preset name) */
function setMode(m) {
  if (m === 'anim') { mode = 'anim'; syncButtons(); hero.setHandPose?.('relaxed', 'both'); return m; }
  return setPose(m);
}
setPose.list = PRESETS;

// ---------------------------------------------------------------------------------------- views + turntable
const views = {
  front: [[0, 1.0, 4.6], [0, 0.92, 0]],
  side: [[4.6, 1.0, 0], [0, 0.92, 0]],
  back: [[0, 1.1, -4.6], [0, 0.92, 0]],
  q34: [[3.2, 1.25, 3.3], [0, 0.95, 0]],
  face: [[0.0, 1.65, 0.75], [0, 1.62, 0]],
  far: [[0, 1.30, 4.9], [0, 0.98, 0]], // = game front cam (spec 2.14)
};
function setView(v) {
  const V = views[v];
  if (!V) return null;
  camera.position.set(...V[0]); controls.target.set(...V[1]); controls.update();
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  return v;
}
let turntableOn = false;
const TURNTABLE_PERIOD = 30; // s per revolution
function turntable(on = !turntableOn) {
  turntableOn = !!on;
  if (!turntableOn) hero.root.rotation.y = 0;
  $('turntable').classList.toggle('on', turntableOn);
  return turntableOn;
}

// ---------------------------------------------------------------------------------------- debug toggles
function setWireframe(on) { debug.setWireframe(on); $('wire').checked = debug.mode === 'wire'; if (on) $('heat').value = ''; }
function setHeatmap(bone) {
  debug.setHeatmap(bone || null);
  $('heat').value = bone ? String(bone) : '';
  $('wire').checked = debug.mode === 'wire';
}
function setOutlines(on) { debug.setOutlines(on); $('outline').checked = !!on; }
let keyLightVia = null;
function setKeyLightAngle(yaw = KEY_LIGHT_DEFAULT.yaw, pitch = KEY_LIGHT_DEFAULT.pitch) {
  keyLightVia = setKeyLightHook(hero, yaw, pitch);
  $('keyYaw').value = yaw;
  $('keyYawVal').textContent = `${Math.round(yaw)}°${keyLightVia ? '' : ' (n/a)'}`;
  return keyLightVia;
}
$('keyYaw').title = 'Camera-locked key light yaw (0 = from the camera, +35 = spec default, camera-left). '
  + 'Needs hero.setKeyLight (REQUEST(WP6) in render/debugViews.js); shows (n/a) until WP1 exposes it.';

// bone list for the weight heatmap
if (hero.rig?.boneOrder) {
  $('heat').insertAdjacentHTML('beforeend', hero.rig.boneOrder.map((n) => `<option value="${n}">${n}</option>`).join(''));
}

// ---------------------------------------------------------------------------------------- wiring
document.querySelectorAll('[data-pose]').forEach((b) => b.addEventListener('click', () => setPose(b.dataset.pose)));
document.querySelector('[data-mode="anim"]').addEventListener('click', () => setMode('anim'));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('turntable').addEventListener('click', () => turntable());
exprSel.addEventListener('change', (e) => hero.setExpression(e.target.value));
$('mouth').addEventListener('input', (e) => hero.setMouthOpen(+e.target.value));
$('blink').addEventListener('input', (e) => hero.blink(+e.target.value));
$('joints').addEventListener('change', (e) => markers.forEach((m) => (m.visible = e.target.checked)));
$('outline').addEventListener('change', (e) => setOutlines(e.target.checked));
$('wire').addEventListener('change', (e) => setWireframe(e.target.checked));
$('heat').addEventListener('change', (e) => setHeatmap(e.target.value || null));
$('blob').addEventListener('change', (e) => (blob.mesh.visible = e.target.checked));
$('keyYaw').addEventListener('input', (e) => setKeyLightAngle(+e.target.value));
if (params.get('outline') === '0') $('outline').checked = false;

Object.assign(window, {
  hero, heroReady, B, setPose, setMode, setView, turntable, setWireframe, setHeatmap, setOutlines, setKeyLightAngle,
  POSE_NAMES: PRESETS, perf: () => perfSnapshot(), renderOnce,
});

// ---------------------------------------------------------------------------------------- perf HUD
const perfState = { upd: [], frame: [], last: performance.now() };
function avg(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function perfSnapshot() {
  const c = debug.stats();
  const info = renderer.info.render;
  return {
    fps: perfState.frame.length ? Math.round(1000 / avg(perfState.frame)) : 0,
    drawCallsTotal: info.calls, trianglesTotal: info.triangles, // whole frame incl. shadow pass + ground
    charDraws: c.draws, charOutlineDraws: c.outlineDraws, charShadowDraws: c.shadowDraws, charTris: c.tris,
    updateMs: +avg(perfState.upd).toFixed(3), updateMsMax: +Math.max(0, ...perfState.upd).toFixed(3),
    geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, programs: renderer.info.programs?.length,
  };
}
function drawPerf() {
  const p = perfSnapshot();
  const flag = (v, lim) => (v > lim ? `<span class="bad">${v}</span>` : `${v}`);
  $('perf').innerHTML =
    `<b>perf</b>   ${p.fps} fps\n` +
    `frame draws  ${p.drawCallsTotal}  (incl. shadow)\n` +
    `frame tris   ${p.trianglesTotal.toLocaleString()}\n` +
    `<b>character</b>\n` +
    `draws        ${flag(p.charDraws, 14)} / 14   (outl ${p.charOutlineDraws})\n` +
    `shadow draws ${flag(p.charShadowDraws, 4)} / 4\n` +
    `tris         ${flag(p.charTris, 60000)} / 60k\n` +
    `update()     ${p.updateMs > 0.4 ? `<span class="bad">${p.updateMs.toFixed(3)}</span>` : p.updateMs.toFixed(3)} ms avg  (max ${p.updateMsMax.toFixed(2)})\n` +
    `key light    ${keyLightVia || 'not exposed (REQUEST WP6)'}\n` +
    `build        ${hero.buildInfo ? (hero.isReady ? `${hero.buildInfo.totalMs} ms (block ${flag(hero.buildInfo.maxBlockMs, 250)})` : 'loading…') : 'n/a'}\n` +
    `mode         ${mode === 'anim' ? 'animate' : pose}${debug.mode !== 'normal' ? ' · ' + debug.mode : ''}`;
}
setInterval(drawPerf, 250);

// ---------------------------------------------------------------------------------------- loop
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => frame(clock.getDelta()));
/** QA: render one frame synchronously (rAF is throttled when the pane is hidden). */
function renderOnce(dt = 1 / 60) { frame(dt); return renderer.info.render; }
function frame(dt) {
  const t = clock.elapsedTime;
  const now = performance.now();
  perfState.frame.push(now - perfState.last); perfState.last = now;
  if (perfState.frame.length > 120) perfState.frame.shift();
  if (mode === 'anim') animPose(t);
  if (turntableOn) hero.root.rotation.y = (hero.root.rotation.y + (dt * Math.PI * 2) / TURNTABLE_PERIOD) % (Math.PI * 2);
  const t0 = performance.now();
  hero.update(dt, t);
  perfState.upd.push(performance.now() - t0);
  if (perfState.upd.length > 600) perfState.upd.shift();
  blob.update(hero);
  controls.update();
  renderer.render(scene, camera);
}

// initial state (URL overridable)
setView(params.get('view') || 'front');
setMode(params.get('pose') || 't');
setKeyLightAngle(KEY_LIGHT_DEFAULT.yaw);
heroReady.then(() => {
  fillExpressions();
  setKeyLightAngle(+$('keyYaw').value);
  debug.refresh();
  if (mode === 'pose') setPose(pose); // re-applies hand pose + expression on the built parts
  setPose.ready = true;
  if (hero.buildInfo) console.info(`[hero] built in ${hero.buildInfo.totalMs} ms (longest block ${hero.buildInfo.maxBlockMs} ms)`, hero.buildInfo.parts);
});
