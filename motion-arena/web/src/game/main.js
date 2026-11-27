// BREAKLIGHT bootstrap (CORE): renderer + post chain + hero lights + quality, the VRM hero and its motion pipeline
// (mirror OFF: the gameplay camera is behind the hero), combat FX, trackers, and the AUDIO / VISUAL / UI modules
// (real modules when present, stand-ins otherwise), then the frame loop. Gameplay lives in core/game.js.
import * as THREE from 'three';
import { configureRenderer, autoResize } from '../render/pipeline.js';
import { createPostChain } from '../render/post.js';
import { createHeroLights } from '../render/heroLights.js';
import { QualityManager } from '../render/quality.js';
import { createContactShadow } from '../render/contactShadow.js';
import { loadVRMHero } from '../vrm/hero.js';
import { DEFAULT_VRM } from '../vrm/models.js';
import { createMotionPipeline } from '../motion/index.js';
import { createFx } from '../fx/index.js';
import { createBus } from './core/bus.js';
import { loadSettings, audioVolume } from './core/settings.js';
import { createGameClock } from './core/clock.js';
import { createStubAudio, createStubVisuals, createStubUI, fillMissing } from './core/stubs.js';
import { CameraDirector } from './core/camera.js';
import { Tracking } from './core/tracking.js';
import { Game } from './core/game.js';
import { AutoplaySource } from './core/autoplay.js';
import { createDebugOverlay } from './core/debug.js';
import { createRecorder, recordingRequested } from './record/recorder.js';
import { SessionSource } from './record/sessionSource.js';

const params = new URLSearchParams(location.search);
const settings = loadSettings(params);
const dev = settings.dev;
const stubAll = dev.stub === 'all' || dev.stub === '1';
const useStub = (name) => stubAll || dev.stub.split(',').includes(name);

// Real modules are optional at build time: the glob only contains the files that exist (no failed imports).
const MODULES = import.meta.glob(['./audio/index.js', './visual/index.js', './ui/index.js']);
async function realModule(name) {
  const key = `./${name}/index.js`;
  if (useStub(name) || !MODULES[key]) return null;
  try { return await MODULES[key](); } catch (e) { console.warn(`[boot] ${name} module failed to load, using the stand-in`, e); return null; }
}

// ------------------------------------------------------------------------------------------ renderer / scenes
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
configureRenderer(renderer, { postToneMapping: true });
renderer.info.autoReset = false;
const worldScene = new THREE.Scene();
const heroScene = new THREE.Scene();
worldScene.background = new THREE.Color(0x2a1a3a);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 600);
const heroLights = createHeroLights(heroScene, { sunDirection: new THREE.Vector3(-0.35, 0.55, 0.75).normalize() });
const post = createPostChain(renderer, worldScene, heroScene, camera);
let quality = null;
const resize = autoResize(renderer, camera, { pixelRatio: () => quality?.dpr ?? Math.min(devicePixelRatio, 2), onResize: (w, h) => post.setSize(w, h) });
const bus = createBus();
const perf = { fps: 0, frameMs: 16.7, frameMax: 0, motionMs: 0, frames: 0, longFrames: 0, hist: new Float32Array(240), histI: 0 };

/**
 * Extension points for add-on modules (e.g. a playtest recorder) without touching the loop:
 *   ctx.hooks.afterMotion.push((dt, hero, now) => ...)   after motion.update + game accents, before the replay / hero.update
 *   ctx.hooks.frame.push((dt, now) => ...)               end of every frame, after the UI update, before rendering
 *   ctx.hooks.trackerFrame.push((frame) => ...)          every tracker frame (before the motion pipeline's push)
 *   ctx.hooks.ready.push((ctx) => ...)                   once, when the tracker has started and the game is live
 * plus the bus events (state, judge, awaken, pause, resume, replay, ...).
 */
const hooks = { afterMotion: [], frame: [], trackerFrame: [], ready: [] };
const ctx = {
  THREE, renderer, camera, worldScene, heroScene, hooks,
  hero: null, motion: null, fx: null, audio: null, visuals: null, ui: null,
  quality: null, settings, bus, perf, post, heroLights,
  time: { now: 0, dt: 0, beat: 0, act: null },
  params,
};
quality = new QualityManager({
  mode: settings.quality || 'auto',
  apply: (p, dpr) => {
    post.setPreset(p);
    heroLights.setShadows(p.shadows, p.shadowMap);
    post.invalidateWorldShadows();
    ctx.hero?.materials?.setQuality(p.outlines);
    if (Math.abs(renderer.getPixelRatio() - dpr) > 1e-3) resize.apply();
    bus.emit('quality', { preset: p.id, dpr });
  },
});
ctx.quality = quality;

// ------------------------------------------------------------------------------------------ AUDIO + clock
const AUDIO_KEYS = ['unlock', 'clock', 'playSong', 'setIntensity', 'setOverdrive', 'stopSong', 'sfx', 'sfxLoop', 'setVolume'];
let audio = null;
const audioMod = await realModule('audio');
try { audio = audioMod?.createAudio?.({ volume: audioVolume(settings) }) ?? null; } catch (e) { console.warn('[boot] createAudio failed, using beeps', e); }
if (!audio) audio = createStubAudio();
else if (AUDIO_KEYS.some((k) => !audio[k])) { const filled = fillMissing(audio, createStubAudio()); console.info('[boot] audio: stand-ins for', filled.join(', ')); }
ctx.audio = audio;
try { audio.setVolume?.(audioVolume(settings)); } catch { /* */ }
const clock = createGameClock(audio);
const unlock = () => { try { audio.unlock(); } catch { /* */ } };
addEventListener('pointerdown', unlock, { capture: true });
addEventListener('keydown', unlock, { capture: true });

let ui = null;   // created in loadWorld(), once ctx.hero + ctx.motion exist (the hand cursor reads the hero)

// ------------------------------------------------------------------------------------------ camera director, tracking, game
const director = new CameraDirector(camera);
const tracking = new Tracking({ video: document.getElementById('bl-video'), onStatus: (k, t) => bootStatus?.(t, k) });
const debug = dev.debug ? createDebugOverlay() : null;
const game = new Game(ctx, { clock, tracking, director, debug });
ctx.game = game;
ctx.clock = clock;
ctx.director = director;
director.bind?.(ctx);
director.setUpcoming?.((aheadSec) => game.upcomingHit(aheadSec));
director.blastFrontFirst = true;      // the bloom bump on blasts is now short and low (0.55), so the front shot reads

bus.on('score', (s) => {
  ui.hud.setScore(Math.round(s.score));
  ui.hud.setCombo(s.combo, s.mult);
  ui.hud.setHealth(s.health, s.maxHealth);
  ui.hud.setFlow(s.flow, s.overdrive);
});
bus.on('beat', () => { if (game.score.overdrive) ui.hud.setFlow(game.score.flow, true); });

// boot screen: tracker choice (skipped by ?tracker= / ?autoplay / ?skip); shown once the UI exists
let bootStatus = (text) => { const el = document.getElementById('bl-boot-fallback'); if (el) el.textContent = text; };
let chosenTracker = null, resolveTracker = null;
const trackerPicked = new Promise((resolve) => { resolveTracker = resolve; });
const presetTracker = dev.autoplay ? 'autoplay' : params.get('tracker') ? settings.tracker : dev.skip ? (settings.tracker === 'auto' ? 'demo' : settings.tracker) : null;
if (presetTracker) { chosenTracker = presetTracker; resolveTracker(presetTracker); }
function showBoot() {
  const h = ui.screens.boot({ onTracker: (name) => { unlock(); if (!chosenTracker) { chosenTracker = name; resolveTracker(name); } }, current: settings.tracker, status: 'Loading the stage…' });
  bootStatus = (text, kind) => { try { h?.setStatus?.(text, kind); } catch { /* */ } };
}
game.state = 'boot';
director.setMode('title', { cut: true });

// ------------------------------------------------------------------------------------------ hero + motion + visuals + fx
let hero = null, motion = null, visuals = null, fx = null, contact = null, ready = false, worldReady = false, visualsReady = false;
const _hp = new THREE.Vector3(), _aim = new THREE.Vector3();

async function loadWorld() {
  hero = await loadVRMHero(DEFAULT_VRM, { camera, renderer, quality: quality.tier, onProgress: (p) => bootStatus?.(`Loading the hero… ${Math.round(p * 100)}%`) });
  heroScene.add(hero.root);
  hero.setCamera?.(camera);
  hero.materials?.setQuality(quality.preset.outlines);
  heroLights.setHeroHeight(hero.info?.height || 1.6);
  motion = await createMotionPipeline({ hero, options: { mirror: false, predict: true, predictMs: 50, footLock: true, ikArms: true, accents: true, hands: 'pose' } });
  hero.fingersExternal = motion.options.hands !== 'off';
  ctx.hero = hero; ctx.motion = motion;
  fx = createFx({ scene: heroScene, camera, hero, motion });
  ctx.fx = fx;
  contact = createContactShadow();
  worldScene.add(contact.mesh);
  game.setHero(hero); game.setMotion(motion);
  // playtest recorder (?record=1, docs/game/PLAYTEST.md): wraps motion.push / actions.pushFrame, so after setMotion
  if (recordingRequested(params)) ctx.recorder = createRecorder({ motion, bus, game, source: () => tracking.source,
    getMeta: () => ({ snap: game.snapshot(), tracker: tracking.kind, model: tracking.source?.model }) });
  game.applyFlashSetting();          // settings.reduceFlashes -> fx impact flashes off
  // UI (needs ctx.hero + ctx.motion for the hand cursor)
  const uiMod = await realModule('ui');
  try { ui = uiMod?.createUI?.(ctx) ?? null; } catch (e) { console.warn('[boot] createUI failed, using the plain DOM stand-in', e); }
  if (!ui) ui = createStubUI(ctx);
  else if (['cursor', 'screens', 'hud', 'update'].some((k) => !ui[k])) fillMissing(ui, createStubUI(ctx));
  ctx.ui = ui;
  document.getElementById('bl-boot-fallback')?.remove();
  showBoot();
  worldReady = true;   // motion + hero now run every frame (the cursor reads the hand bones in menus too)
  // VISUAL (after the hero: it may read ctx.hero)
  const visMod = await realModule('visual');
  try { visuals = visMod?.createVisuals ? await visMod.createVisuals(ctx) : null; } catch (e) { console.warn('[boot] createVisuals failed, using simple meshes', e); visuals = null; }
  if (!visuals) visuals = await createStubVisuals(ctx);
  else {
    const missing = ['stage', 'spirits', 'boss', 'vfx'].filter((k) => !visuals[k]);
    if (missing.length || !visuals.stage?.rift) { const st = await createStubVisuals(ctx); fillMissing(visuals, st); console.info('[boot] visuals: stand-ins for', missing.join(', ') || 'stage.rift'); }
    else fillMissing(visuals, await stubVisualsMethodsOnly());
  }
  ctx.visuals = visuals;
  if (visuals.stage.object && !visuals.stage.object.parent) worldScene.add(visuals.stage.object);
  await loadCV();
  game.applyFlashSetting();          // and the Photo Booth's flash (booth.setReduceFlash)
  try { visuals.boss?.hide?.(); } catch { /* */ }
  visualsReady = true;
  bootStatus?.('Ready', 'ready');
}

/**
 * CV features (Mirror Moment silhouette + Photo Booth). Optional: the game runs without them if the import or setup
 * fails (ctx.mirror / ctx.booth stay null and every game hook is guarded).
 */
async function loadCV() {
  if (useStub('cv')) return;
  try {
    const cv = await import('./cv/index.js');
    ctx.cv = cv;
    const mirror = ctx.mirror = cv.createMirror({ video: tracking.video, renderer, scene: worldScene, camera, hero, quality: quality.preset.id });
    bus.on('quality', ({ preset }) => { try { mirror.setQuality(preset); } catch { /* */ } });
    ctx.booth = cv.createPhotoBooth({
      video: tracking.video, renderer, heroScene, camera, hero, mirror, motion,
      getStats: () => game.lastResults ?? game.score.results({ cleared: true }), overlayParent: ui.root,
      onCountdown: () => audio.sfx('countdown'), onFlash: () => audio.sfx('perfect'),
    });
  } catch (e) {
    console.warn('[boot] CV features unavailable, continuing without them', e);
    ctx.mirror = null; ctx.booth = null;
  }
}

/** No-op versions of every VISUAL method, so a partial real module never throws in the loop. */
async function stubVisualsMethodsOnly() {
  const noop = () => {};
  return {
    stage: { update: noop, setAct: noop, pulse: noop },
    spirits: { update: noop },
    boss: { show: noop, hide: noop, update: noop, telegraph: noop, attack: noop, stagger: noop, openWeakPoint: noop, hit: noop, defeat: noop },
    vfx: { aura: noop, blast: noop, judgement: noop, shockwave: noop, update: noop },
  };
}

/**
 * The chart-reading bot. ?autoplay=1 uses it as the QA tracker; the no-camera 'demo' player is the same bot (so the
 * demo strikes the calibration T-pose, performs the tutorial drills and plays the chart instead of looping a canned
 * animation).
 */
function makeBot({ skill, jitterMs, demo = false }) {
  const notes = [];
  const bot = new AutoplaySource({
    clock, skill, jitterMs,
    model: demo ? 'Demo player (no camera)' : null,
    // during the Awakening, only notes up to the next waiting spirit (their times move while it waits)
    getNotes: () => {
      notes.length = 0;
      let lim = Infinity;
      if (game.awk) { for (const n of game.field.live) if (n.waitFor && !n.resolved) lim = Math.min(lim, n.beat); for (const n of game.field.pending) if (n.waitFor) lim = Math.min(lim, n.beat); }
      for (const n of game.field.live) if (n.beat <= lim) notes.push(n);
      for (const n of game.field.pending) if (n.beat <= lim) notes.push(n);
      return notes;
    },
    noteTime: (n) => game.judge.noteTime(n),
    isWaiting: (n) => game.awk?.waiting === n,
    getMode: () => {
      const s = game.state;
      if (s === 'calibrate') return 'tpose';
      if (s === 'tutorial') { const d = game._tutDrill ?? game._tutorial?.drill; return d ? 'drill:' + d : 'idle'; }
      return s === 'run' || s === 'boss' ? 'play' : 'idle';
    },
  });
  return bot;
}

async function startTracker(kind) {
  if (params.get('play')) {                      // replay a recorded playtest session (?play=<url>[&loop])
    const s = await SessionSource.load(params.get('play'), { loop: params.has('loop') });
    await tracking.start(s.kind, { custom: s, kind: s.kind === 'hmr' || s.kind === 'mediapipe' ? s.kind : 'demo' });
  } else if (kind === 'autoplay' || kind === 'demo' || kind === 'synthetic') {
    const demo = kind !== 'autoplay';
    const bot = makeBot({
      demo,
      skill: params.get('botSkill') != null ? +params.get('botSkill') : demo ? 0.9 : 1,
      jitterMs: params.get('botJitter') != null ? +params.get('botJitter') : 22,
    });
    game.bot = bot;
    await tracking.start(demo ? 'demo' : 'autoplay', { custom: bot, kind: demo ? 'demo' : 'autoplay' });
    bot.listen(motion.actions);
  } else {
    await tracking.start(kind, { demoFactory: () => { const b = makeBot({ demo: true, skill: 0.9, jitterMs: 22 }); game.bot = b; setTimeout(() => b.listen(motion.actions)); return b; } });
  }
  motion.setSource(tracking.source);
  motion.calibrate();
  game.setTrackerKind(tracking.kind);
  if (tracking.camera.active) ui.hud.pip.setVideo(tracking.video);
  tracking.onFrame = (f) => {
    if (f.kp2d && f.kp2d.length) ui.hud.pip.setSkeleton(f.kp2d, f.edges, { selfie: tracking.kind === 'hmr' || tracking.kind === 'mediapipe' });
    if (ctx.mirror) { try { ctx.mirror.setTrackerFrame(f); } catch { /* */ } }
    for (const fn of hooks.trackerFrame) { try { fn(f); } catch (e) { if (!fn._warned) { fn._warned = true; console.warn('[tracker] frame hook', e); } } }
  };
  console.info(`[boot] tracker: ${tracking.kind}${tracking.source?.model ? ' (' + tracking.source.model + ')' : ''}`);
}

// ------------------------------------------------------------------------------------------ frame loop
let last = performance.now(), fxScale = 1, fpsAcc = 0, fpsN = 0;
const stageArgs = { beat: 0, act: 'title', intensity: 0, overdrive: false };
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const rawMs = now - last; last = now;
  const dt = Math.min(0.05, Math.max(1e-4, rawMs / 1000));
  quality.frame(rawMs);
  perf.frameMs += (rawMs - perf.frameMs) * 0.05;
  perf.hist[perf.histI] = rawMs; perf.histI = (perf.histI + 1) % perf.hist.length;
  perf.frames++; if (rawMs > 25) perf.longFrames++;
  fpsAcc += rawMs; fpsN++;
  if (fpsAcc >= 500) { perf.fps = Math.round((fpsN * 1000) / fpsAcc); fpsAcc = 0; fpsN = 0; let m = 0; for (const x of perf.hist) m = Math.max(m, x); perf.frameMax = m; }
  clock.sample();
  const T = ctx.time;
  T.now = clock.frameNow; T.dt = dt; T.beat = clock.frameBeat; T.act = game.act;
  if (worldReady) {
    if (ready) game.update(dt);
    const m0 = performance.now();
    motion.update(dt, now);                         // applies the pose unless the replay owns the hero
    game.afterMotion(dt, hero);                     // procedural accents over the tracked pose (Breaklight push)
    for (const fn of hooks.afterMotion) { try { fn(dt, hero, now); } catch (e) { if (!fn._warned) { fn._warned = true; console.warn('[loop] afterMotion hook', e); } } }
    if (game.replaying) game.replay.update(dt, hero);
    perf.motionMs += (performance.now() - m0 - perf.motionMs) * 0.05;
    hero.update(dt * fxScale * (game.replaying ? 0.4 : 1));
    contact.update(hero);
    hero.bones.hips.getWorldPosition(_hp);
    director.update(dt, hero);
    _aim.set(_hp.x, _hp.y + 0.25, _hp.z);
    heroLights.update(camera, _aim);
    const S = game.score;
    stageArgs.beat = T.beat; stageArgs.act = game.act ?? 'title'; stageArgs.overdrive = S.overdrive;
    stageArgs.intensity = game.act === 'boss' ? 1 : 0.35 + (+game.act || 0) * 0.3;
    if (visualsReady) try {
      visuals.stage.update(dt, stageArgs);
      visuals.spirits.update(dt);
      if (game.state !== 'boss') visuals.boss?.update?.(dt);
      visuals.vfx.update(dt);
    } catch (e) { if (!frame._warned) { frame._warned = true; console.warn('[loop] visuals update threw', e); } }
    fxScale = fx?.update(dt) ?? 1;
    if (ctx.mirror) { try { ctx.mirror.update(dt, { beat: T.beat, overdrive: game.score.overdrive, act: game.act }); } catch (e) { if (!frame._cvWarned) { frame._cvWarned = true; console.warn('[loop] mirror.update threw', e); } } }
  } else {
    director.update(dt, null);
  }
  ui?.update(dt);   // after motion.update (cursor + screen + HUD)
  for (const fn of hooks.frame) { try { fn(dt, now); } catch (e) { if (!fn._warned) { fn._warned = true; console.warn('[loop] frame hook', e); } } }
  renderer.info.reset();
  if (hero?.materials?.updateFrame) hero.materials.updateFrame(camera, heroLights);
  post.render(dt);
  debug?.update(dt, game);
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------------------------------ boot sequence
try {
  await loadWorld();
} catch (e) {
  console.error('[boot] the hero / world failed to load', e);
  bootStatus?.(`Load failed: ${e.message || e}`, 'error');
  throw e;
}
const kind = await trackerPicked;
bootStatus?.('Starting the tracker…');
await startTracker(kind);
const skip = dev.skip;
// photosensitivity notice before the first calibration (first boot; each player in kiosk mode; never for autoplay)
if (!skip) { try { await game.flashNotice(); } catch (e) { console.warn('[boot] flash notice', e); } }
ready = true;
for (const fn of hooks.ready) { try { fn(ctx); } catch (e) { console.warn('[boot] ready hook', e); } }
if (skip === 'title') game.setState('title');
else if (skip === 'run') { unlock(); game.setState('run', { act: dev.act || 0 }); }
else if (skip === 'boss') { unlock(); game.setState('boss'); }
else if (skip === 'results') { demoResults(); }
else game.setState('calibrate');

/** ?skip=results: a results screen with demo numbers (no replay unless a run was recorded). */
function demoResults() {
  const s = game.score;
  s.reset();
  const kinds = ['perfect', 'perfect', 'great', 'perfect', 'good', 'great', 'perfect', 'miss', 'perfect', 'great'];
  for (let i = 0; i < 40; i++) s.judge(kinds[i % kinds.length], { songT: i * 0.5, hurt: false });
  s.punchSpeed(6.4); s.jumpHeight(31); s.reaction(287); s.playTime = 240;
  for (const m of ['punch', 'punch', 'kick', 'jump', 'squat', 'dodge', 'blast']) s.move(m);
  game.setState('results', { cleared: true });
}

// keyboard fallbacks + dev keys
addEventListener('keydown', (e) => {
  if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'SELECT') return;
  if (game.state === 'results' && game.replaying && (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ')) { game.skipReplay(); return; }
  if (game.awk && game.state === 'run' && (e.key === 'Enter' || e.key === 's' || e.key === 'S')) { game.skipAwaken(); return; }
  if (e.key === 'Escape' && (game.state === 'run' || game.state === 'boss')) game.setState('pause', { reason: 'manual' });
  if (e.key === 'Enter' && game.state === 'title') game.play();
  if (e.key === 'Enter' && game.state === 'calibrate') { motion.calibrate(); game.setState('title'); }
  if ((e.key === 'n' || e.key === 'N') && (game.state === 'title' || game.state === 'results' || game.state === 'pause')) game.newPlayer();
});

// results intro replay: a click / tap skips to the stats
addEventListener('pointerdown', () => { if (game.state === 'results' && game.replaying && game._replayIntro) game.skipReplay(); });

// QA / console handles
Object.assign(window, { ctx, game, bus, clock, tracking, director, quality, THREE });
Object.defineProperties(window, { hero: { get: () => hero, configurable: true }, motion: { get: () => motion, configurable: true } });
window.bl = {
  setState: (s, o) => game.setState(s, o),
  snapshot: () => game.snapshot(),
  results: () => game.lastResults,
  newPlayer: (o) => game.newPlayer(o),
  perf: () => ({ ...perf, hist: undefined, fps: perf.fps }),
};
