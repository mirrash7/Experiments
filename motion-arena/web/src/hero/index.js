// Hero v2 facade. Owner: WP0. Other packages request changes via notes (see CONTRACTS.md).
//
//   import { createCharacter } from './character.js';   // re-exports this module
//   const hero = createCharacter();
//   scene.add(hero.root);
//   // each frame: drive hero.bones.* (retargeter), then hero.update(dt, time)
//
// Async (QA r1 P0-2, load budget 400 ms total / <= 250 ms per main-thread block):
//   const hero = await createCharacterAsync({ camera, onShell(h) { scene.add(h.root); retarget = new Retargeter(h); } });
//   onShell runs synchronously before the first yield: the hero's rig (bones, root) already exists and can be
//   retargeted + updated while the parts build; a cheap capsule placeholder stands in until every part is
//   built, then the real meshes are swapped in at once (hero.ready resolves, hero.isReady = true).
//   Parts build one per task, yielding to the browser between them; the costume uses buildCostumeAsync when
//   the costume module exports it (falls back to buildCostume).
//
// v1 API kept: root, bones, setExpression, blink, setMouthOpen, update, dispose, info.
// v2 additions: setGaze(x, y), setHandPose(pose, side), setAction(name), setCamera(camera),
//               rig, helpers, skeleton, parts (builder results, for QA tooling), buildInfo, ready, isReady.

import * as THREE from 'three';
import dims from './dims.js';
import palette from './palette.js';
import { createRig } from './rig.js';
import { createToonMaterial, createOutlineMaterial, createSharedMaterials } from './materials/index.js';
import { EXPRESSIONS, DEFAULT_EXPRESSION, HAND_POSES, ACTION_PRESETS } from './contracts.js';
import { buildBody } from './body/body.js';
import { buildHead } from './head/head.js';
import { buildHair } from './head/hair.js';
import * as costumeModule from './costume/index.js';
import { createDynamics } from './dynamics/index.js';

const { buildCostume } = costumeModule;

/** Build order matters: later builders can read earlier results via ctx.parts. */
export const DEFAULT_BUILDERS = { body: buildBody, head: buildHead, hair: buildHair, costume: buildCostume };

/** Yield to the browser (input, rAF, paint) between build steps. */
export function yieldToBrowser() {
  if (typeof globalThis.scheduler?.yield === 'function') return globalThis.scheduler.yield();
  // MessageChannel is not throttled like setTimeout in background tabs
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'undefined') { setTimeout(resolve, 0); return; }
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(0);
  });
}

/** Cheap stand-in (one merged non-skinned mesh per bone segment group) shown while the parts build. */
function createPlaceholder(rig) {
  const group = new THREE.Group();
  group.name = 'heroPlaceholder';
  const mat = new THREE.MeshToonMaterial({ color: palette.color(palette.MAT.SKIN), transparent: true, opacity: 0.55, depthWrite: false });
  const geos = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (const s of rig.segments) {
    const bone = rig.all[s.bone];
    const len = s.a.distanceTo(s.b);
    const g = new THREE.CapsuleGeometry(s.r * 0.9, Math.max(0.001, len), 3, 10);
    const mid = s.a.clone().add(s.b).multiplyScalar(0.5).sub(rig.restWorld[s.bone]); // bone-local (identity rest)
    const dir = s.b.clone().sub(s.a).normalize();
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir));
    g.translate(mid.x, mid.y, mid.z);
    const m = new THREE.Mesh(g, mat);
    m.name = 'placeholder_' + s.bone;
    m.userData.qaHelper = true; // excluded from framing / counts
    bone.add(m);
    geos.push(m);
  }
  return {
    group, meshes: geos,
    dispose() { for (const m of geos) { m.parent?.remove(m); m.geometry.dispose(); } mat.dispose(); },
  };
}

/**
 * Builds the hero shell (rig, shared materials, facade API) and returns { hero, steps } where steps is the
 * list of build steps still to run. Both createCharacter (runs them inline) and createCharacterAsync
 * (yields between them) use it.
 */
function createShell(options) {
  const opt = { outline: true, castShadow: true, expression: DEFAULT_EXPRESSION, parts: Object.keys(DEFAULT_BUILDERS), builders: {}, camera: null, ...options };
  const tShell = performance.now();
  const rig = createRig();
  const { root, bones } = rig;

  const shared = createSharedMaterials({ palette });
  const materials = {
    createToonMaterial, createOutlineMaterial,
    body: shared.body, face: shared.face, hair: shared.hair,
    outline: opt.outline ? shared.outline : null,
  };
  const ctx = { rig, dims, palette, materials, options: opt, parts: {}, camera: opt.camera, dt: 0, time: 0 };
  const buildInfo = { mode: 'sync', totalMs: 0, maxBlockMs: 0, parts: {}, blocks: [] };

  const builders = { ...DEFAULT_BUILDERS, ...opt.builders };
  const order = [...Object.keys(DEFAULT_BUILDERS), ...Object.keys(opt.builders).filter((k) => !DEFAULT_BUILDERS[k])];
  let dynamics = null;
  let ready = false;
  let hidden = null; // meshes held invisible until the swap (async only)

  const headApi = () => ctx.parts.head?.api;
  const bodyApi = () => ctx.parts.body?.api;

  // ---- face / hands / actions routing (state is remembered and re-applied once the parts exist)
  const state = { expression: opt.expression, hand: { left: 'relaxed', right: 'relaxed' }, gaze: [0, 0], camera: opt.camera };
  let actionTimer = 0;
  function setExpression(name) { state.expression = name; return headApi()?.setExpression?.(name) ?? name; }
  function blink(amount = 1) { headApi()?.blink?.(amount); }
  function setMouthOpen(amount = 0) { headApi()?.setMouthOpen?.(amount); }
  function setGaze(x = 0, y = 0) { state.gaze = [x, y]; headApi()?.setGaze?.(x, y); }
  function setHandPose(pose = 'relaxed', side = 'both') {
    if (!HAND_POSES.includes(pose)) return;
    for (const s of side === 'both' ? ['left', 'right'] : [side]) state.hand[s] = pose;
    bodyApi()?.setHandPose?.(pose, side);
  }
  function setAction(name) {
    const p = ACTION_PRESETS[name] || ACTION_PRESETS.idle;
    if (p.expression) setExpression(p.expression);
    setHandPose('relaxed', 'both');
    if (p.hand) setHandPose(...p.hand);
    actionTimer = p.hold || 0;
    return ACTION_PRESETS[name] ? name : 'idle';
  }

  // ---- per frame: called after the retargeter wrote the contract bones
  let internalTime = 0;
  const partList = [];
  function update(dt = 1 / 60, time) {
    dt = dt > 0.1 ? 0.1 : dt > 0 ? dt : 0;
    internalTime += dt;
    ctx.dt = dt;
    ctx.time = time === undefined ? internalTime : time;
    if (actionTimer > 0 && (actionTimer -= dt) <= 0) setAction('idle');
    rig.updateHelpers();
    root.updateMatrixWorld(true);
    if (!ready) return;
    for (let i = 0; i < partList.length; i++) partList[i].update?.(dt, ctx);
    dynamics?.update(dt, ctx);
    shared.update(dt, ctx);
  }

  function setCamera(camera) { state.camera = camera; ctx.camera = camera; shared.setCamera(camera); }

  let placeholder = null;
  let disposed = false;
  function dispose() {
    disposed = true;
    placeholder?.dispose(); placeholder = null;
    for (const p of Object.values(ctx.parts)) p.dispose?.();
    dynamics?.dispose();
    shared.dispose();
    rig.dispose();
    if (root.parent) root.parent.remove(root);
  }

  const info = {
    height: dims.INFO.height,
    upperArm: dims.LENGTHS.upperArm,
    foreArm: dims.LENGTHS.foreArm,
    hand: dims.LENGTHS.hand,
    thigh: dims.LENGTHS.thigh,
    shin: dims.LENGTHS.shin,
    footHeight: dims.LENGTHS.ankleHeight,
    shoulderWidth: dims.INFO.shoulderWidth,
    hipWidth: dims.INFO.hipWidth,
    expressions: EXPRESSIONS.slice(),
    handPoses: HAND_POSES.slice(),
    actions: Object.keys(ACTION_PRESETS),
    version: 2,
  };

  const hero = {
    root, bones, setExpression, blink, setMouthOpen, update, dispose, info,
    setGaze, setHandPose, setAction, setCamera,
    rig, helpers: rig.helpers, skeleton: rig.skeleton, parts: ctx.parts,
    dynamics: null, resetDynamics: () => dynamics?.reset(),
    buildInfo, isReady: false, ready: null,
  };

  // ---- build steps
  const addMeshes = (list) => {
    for (const m of list || []) {
      if (!m.parent) root.add(m);
      if (!opt.castShadow) m.castShadow = false;
      if (hidden) { if (m.visible) { hidden.push(m); m.visible = false; } }
    }
  };
  const steps = [];
  for (const key of order) {
    if (!opt.parts.includes(key) || !builders[key]) continue;
    steps.push({
      name: key,
      run: (async) => {
        const asyncBuilder = async && key === 'costume' && !opt.builders.costume && typeof costumeModule.buildCostumeAsync === 'function'
          ? costumeModule.buildCostumeAsync : null;
        const done = (res) => { addMeshes(res.meshes); ctx.parts[key] = res; partList.push(res); };
        if (asyncBuilder) return asyncBuilder(ctx, { yieldToBrowser }).then(done);
        return done(builders[key](ctx));
      },
    });
  }
  steps.push({
    name: 'dynamics',
    run: () => {
      // WP5 secondary motion (sash verlet + ribbon, cloth/hair springs); options.dynamics === false disables it
      dynamics = opt.dynamics === false ? null : createDynamics(ctx);
      hero.dynamics = dynamics;
      addMeshes(dynamics?.meshes);
    },
  });
  steps.push({
    name: 'finish',
    run: () => {
      info.expressions = headApi()?.expressions?.slice() || EXPRESSIONS.slice();
      if (state.camera) shared.setCamera(state.camera);
      // re-apply state requested while building
      if (state.expression) headApi()?.setExpression?.(state.expression);
      headApi()?.setGaze?.(...state.gaze);
      for (const s of ['left', 'right']) bodyApi()?.setHandPose?.(state.hand[s], s);
      if (hidden) { for (const m of hidden) m.visible = true; hidden = null; }
      placeholder?.dispose(); placeholder = null;
      ready = true;
      hero.isReady = true;
      root.updateMatrixWorld(true);
    },
  });

  buildInfo.shellMs = +(performance.now() - tShell).toFixed(1);
  return {
    hero, steps, ctx,
    beginAsync(withPlaceholder) {
      hidden = [];
      if (withPlaceholder) placeholder = createPlaceholder(rig);
    },
    isDisposed: () => disposed,
  };
}

function timeStep(buildInfo, name, ms) {
  buildInfo.parts[name] = +((buildInfo.parts[name] || 0) + ms).toFixed(1);
}

/**
 * @param {object} [options]
 * @param {boolean} [options.outline=true]      build outline hulls
 * @param {boolean} [options.castShadow=true]
 * @param {string}  [options.expression='happy']
 * @param {string[]} [options.parts]            subset of builders to run, e.g. ['body'] (isolation preview)
 * @param {object}  [options.builders]          override builders by key, e.g. { body: myBuildBody }
 * @param {THREE.Camera} [options.camera]       camera for the camera-locked key light (WP1)
 * @param {boolean} [options.dynamics=true]     false disables WP5 secondary motion
 */
export function createCharacter(options = {}) {
  const t0 = performance.now();
  const { hero, steps } = createShell(options);
  for (const s of steps) {
    const ts = performance.now();
    s.run(false);
    timeStep(hero.buildInfo, s.name, performance.now() - ts);
  }
  const total = performance.now() - t0;
  Object.assign(hero.buildInfo, { mode: 'sync', totalMs: +total.toFixed(1), maxBlockMs: +total.toFixed(1), blocks: [+total.toFixed(1)] });
  hero.ready = Promise.resolve(hero);
  return hero;
}

/**
 * Async build: same options as createCharacter, plus
 * @param {(hero) => void} [options.onShell]   called synchronously with the (not yet built) hero
 * @param {boolean} [options.placeholder=true] show a capsule stand-in until the swap
 * @returns {Promise<hero>} resolves once every part is built and swapped in (hero.isReady)
 */
export function createCharacterAsync(options = {}) {
  const { onShell, placeholder = true, ...rest } = options;
  const t0 = performance.now();
  const shell = createShell(rest);
  const { hero, steps } = shell;
  const bi = hero.buildInfo;
  bi.mode = 'async';
  shell.beginAsync(placeholder);
  let blockStart = performance.now();
  const endBlock = () => {
    const ms = +(performance.now() - blockStart).toFixed(1);
    bi.blocks.push(ms);
    if (ms > bi.maxBlockMs) bi.maxBlockMs = ms;
  };
  hero.ready = (async () => {
    onShell?.(hero);
    for (const s of steps) {
      endBlock();
      await yieldToBrowser();
      if (shell.isDisposed()) return hero;
      blockStart = performance.now();
      const ts = performance.now();
      const r = s.run(true);
      if (r && typeof r.then === 'function') {
        // async builder: its own yields end blocks too; time its total here
        endBlock();
        await r;
        blockStart = performance.now();
      }
      timeStep(bi, s.name, performance.now() - ts);
    }
    endBlock();
    bi.totalMs = +(performance.now() - t0).toFixed(1);
    return hero;
  })();
  return hero.ready;
}

export default createCharacter;
