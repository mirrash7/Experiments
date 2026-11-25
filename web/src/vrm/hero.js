// VRM hero: loads a VRM 0.x or 1.0 avatar with @pixiv/three-vrm and wraps it in the game's hero facade.
//
// Frame convention ("hero space" = hero.root local space, the same for every model):
//   +Y up, feet on y = 0, the character FACES +Z, the character's LEFT is +X, metres.
//
// POSE CONTRACT (for the motion pipeline)
//   hero.applyHumanoidPose({ hips, rotations })
//     hips:      THREE.Vector3, optional. Hips joint position in metres, in hero space (hero.info.hipHeight is the
//                rest height; x/z = 0 at rest).
//     rotations: { [VRMHumanBoneName]: THREE.Quaternion }, optional entries. Each is the LOCAL rotation of that
//                normalized humanoid bone relative to its normalized parent, expressed in VRM 1.0 normalized axes
//                (= hero space axes: +X character's left, +Y up, +Z forward). Identity for every bone = VRM T-pose rest.
//                Bones not listed keep their current rotation. The parent of a bone is the nearest PRESENT bone in
//                VRMHumanBoneParentMap (e.g. if a model has no upperChest, neck's parent is chest).
//   VRM 0.x models are handled internally (three-vrm's normalized rig for 0.x is rotated 180 deg about Y after
//   VRMUtils.rotateVRM0; we conjugate rotations and transform the hips position), so callers never branch on version.
//   Call it any time before hero.update(dt); update() runs vrm.update (humanoid -> raw bones, look-at, expressions,
//   spring bones, constraints).
//
// LEGACY ADAPTER (until the new motion pipeline replaces retarget.js)
//   hero.bones.{hips, spine, chest, neck, head, left/rightShoulder, UpperArm, ForeArm, Hand, Thigh, Shin, Foot,
//   leftHandTip, rightHandTip, leftToe, rightToe, headTop} are proxy Object3Ds under hero.root in hero space with
//   IDENTITY rest rotations in the T-pose (what retarget.js assumes). Every frame hero.update() copies the proxy
//   rotations (and hips position) onto the normalized bones. applyHumanoidPose writes the proxies too, so the
//   legacy bones always mirror the rendered pose (HUD, ghost, framing, contact shadow keep working).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMHumanBoneList, VRMHumanBoneParentMap } from '@pixiv/three-vrm';
import { tuneMToon } from './mtoonTuning.js';
import { tuneSpringBones } from './springTuning.js';
import { mergeVRMPrimitives } from './mergePrimitives.js';

/** Legacy bone name -> VRM humanoid bone name. */
export const LEGACY_TO_VRM = {
  hips: 'hips', spine: 'spine', chest: 'chest', neck: 'neck', head: 'head',
  leftShoulder: 'leftShoulder', leftUpperArm: 'leftUpperArm', leftForeArm: 'leftLowerArm', leftHand: 'leftHand',
  rightShoulder: 'rightShoulder', rightUpperArm: 'rightUpperArm', rightForeArm: 'rightLowerArm', rightHand: 'rightHand',
  leftThigh: 'leftUpperLeg', leftShin: 'leftLowerLeg', leftFoot: 'leftFoot',
  rightThigh: 'rightUpperLeg', rightShin: 'rightLowerLeg', rightFoot: 'rightFoot',
};

// game expression names -> VRM preset weights (VRM 0.x presets are renamed to 1.0 names by three-vrm)
const EXPRESSION_PRESETS = {
  neutral: {}, idle: {},
  happy: { happy: 0.85 },
  determined: { angry: 0.45, happy: 0.12 },
  angry: { angry: 0.8 },
  surprised: { surprised: 0.8 },
  sad: { sad: 0.7 },
  relaxed: { relaxed: 0.7 },
};
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
const FINGER_JOINTS = ['Metacarpal', 'Proximal', 'Intermediate', 'Distal'];

const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _m = new THREE.Matrix4();

let _loader = null;
function loader() {
  if (!_loader) {
    _loader = new GLTFLoader();
    _loader.register((p) => new VRMLoaderPlugin(p));
  }
  return _loader;
}

/**
 * @param {string} url
 * @param {object} [o]
 * @param {THREE.Camera} [o.camera]     look-at default target
 * @param {THREE.WebGLRenderer} [o.renderer]  used to precompile programs
 * @param {(p:number)=>void} [o.onProgress]  0..1
 * @param {string} [o.quality='high']   MToon tuning tier (low drops minor outlines)
 */
export async function loadVRMHero(url, { camera = null, renderer = null, onProgress = null, quality = 'high' } = {}) {
  const t0 = performance.now();
  const gltf = await loader().loadAsync(url, (e) => { if (e.total) onProgress?.(e.loaded / e.total); });
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error(`${url} is not a VRM file`);
  const tLoad = performance.now() - t0;
  const isVRM0 = vrm.meta?.metaVersion === '0';

  VRMUtils.rotateVRM0(vrm); // 0.x faces -Z: rotate the scene so every model faces +Z
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  const merge = mergeVRMPrimitives(gltf.scene);
  vrm.scene.traverse((o) => {
    if (o.isMesh) { o.frustumCulled = false; o.castShadow = true; o.receiveShadow = false; }
  });

  const root = new THREE.Group();
  root.name = 'VRMHero';
  root.add(vrm.scene);
  vrm.humanoid.resetNormalizedPose();
  vrm.update(0);
  root.updateMatrixWorld(true);

  // ---- feet on y = 0 (measured from the rest-pose skinned bounds)
  const box = meshBounds(vrm.scene);
  vrm.scene.position.y -= box.min.y;
  root.updateMatrixWorld(true);
  box.translate(_v.set(0, -box.min.y, 0));

  const humanoid = vrm.humanoid;
  const rigRoot = humanoid.normalizedHumanBonesRoot;
  const norm = (n) => humanoid.getNormalizedBoneNode(n);
  // rotation of the normalized rig in hero space (identity for 1.0, 180 deg about Y for 0.x)
  const rigQ = new THREE.Quaternion();
  rigRoot.matrixWorld.decompose(_v, rigQ, new THREE.Vector3());
  const rootQInv = root.getWorldQuaternion(new THREE.Quaternion()).invert();
  rigQ.premultiply(rootQInv);
  const rigQInv = rigQ.clone().invert();
  // hero space -> normalized-rig-root space (for the hips position)
  const heroToRig = new THREE.Matrix4().copy(rigRoot.matrixWorld).invert().multiply(root.matrixWorld);

  // ---- proxies: one Object3D per present humanoid bone, normalized hierarchy, identity rest, hero space
  const legacyRig = new THREE.Group();
  legacyRig.name = 'LegacyRig';
  root.add(legacyRig);
  const proxies = {};
  const restWorld = {}; // hero-space rest positions
  const toHero = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const present = VRMHumanBoneList.filter((n) => norm(n));
  for (const n of present) restWorld[n] = norm(n).getWorldPosition(new THREE.Vector3()).applyMatrix4(toHero);
  const parentOf = (n) => { let p = VRMHumanBoneParentMap[n]; while (p && !norm(p)) p = VRMHumanBoneParentMap[p]; return p || null; };
  for (const n of present) { // VRMHumanBoneList is parent-first
    const o = new THREE.Object3D();
    o.name = 'proxy_' + n;
    const p = parentOf(n);
    (p ? proxies[p] : legacyRig).add(o);
    o.position.copy(restWorld[n]).sub(p ? restWorld[p] : _v.set(0, 0, 0));
    proxies[n] = o;
  }

  // ---- legacy bone map + markers
  const bones = {};
  const missing = [];
  for (const [legacy, vrmName] of Object.entries(LEGACY_TO_VRM)) {
    if (proxies[vrmName]) { bones[legacy] = proxies[vrmName]; continue; }
    missing.push(vrmName);
    // virtual leaf (only shoulders/chest/neck can be missing): sits on its child joint, never synced
    const fallbackParent = { chest: 'spine', neck: 'chest', leftShoulder: 'chest', rightShoulder: 'chest' }[vrmName];
    const parent = bones[Object.keys(LEGACY_TO_VRM).find((k) => LEGACY_TO_VRM[k] === fallbackParent)] || proxies.spine;
    const v = new THREE.Object3D(); v.name = 'virtual_' + vrmName; parent.add(v); bones[legacy] = v;
  }
  if (missing.length) console.warn('[vrm] humanoid bones missing (virtual legacy proxies):', missing.join(', '));

  const addMarker = (name, parent, heroPos) => {
    const o = new THREE.Object3D(); o.name = 'marker_' + name;
    parent.updateMatrixWorld(true);
    o.position.copy(heroPos).sub(restWorldOf(parent));
    parent.add(o); bones[name] = o; return o;
  };
  const restWorldOf = (o) => { const p = new THREE.Vector3(); legacyRig.updateMatrixWorld(true); o.getWorldPosition(p); return p.applyMatrix4(toHero); };
  // hand tips: middle-finger end (distal + its length) or forearm direction * 0.42 of forearm length
  for (const s of ['left', 'right']) {
    const hand = restWorld[s + 'Hand'], lower = restWorld[s + 'LowerArm'];
    const distal = restWorld[s + 'MiddleDistal'], inter = restWorld[s + 'MiddleIntermediate'];
    let tip;
    if (distal && inter) tip = distal.clone().add(distal.clone().sub(inter).multiplyScalar(0.9));
    else tip = hand.clone().add(hand.clone().sub(lower).multiplyScalar(0.42));
    tip.y = hand.y; tip.z = hand.z; // keep the hand bone's rest direction purely lateral (T-pose)
    addMarker(s + 'HandTip', bones[s + 'Hand'], tip);
    // toe: ahead of the ankle at sole height (+2 cm, the legacy planting margin)
    const foot = restWorld[s + 'Foot'];
    const toes = restWorld[s + 'Toes'];
    const fwd = toes ? Math.max(0.08, toes.z - foot.z + 0.05) : (box.max.y * 0.1);
    addMarker(s + 'Toe', bones[s + 'Foot'], new THREE.Vector3(foot.x, 0.02, foot.z + fwd));
  }
  const headP = restWorld.head;
  addMarker('headTop', bones.head, new THREE.Vector3(headP.x, box.max.y, headP.z));

  // ---- measurements
  const d = (a, b) => (restWorld[a] && restWorld[b] ? restWorld[a].distanceTo(restWorld[b]) : 0);
  const info = {
    url, name: vrm.meta?.name || vrm.meta?.title || url.split('/').pop(),
    version: isVRM0 ? '0.x' : '1.0',
    authors: vrm.meta?.authors?.join(', ') || vrm.meta?.author || '',
    height: +box.max.y.toFixed(3),
    hipHeight: +restWorld.hips.y.toFixed(3),
    eyeHeight: +(restWorld.leftEye?.y ?? restWorld.head.y + 0.06).toFixed(3),
    shoulderWidth: +d('leftUpperArm', 'rightUpperArm').toFixed(3),
    armLength: +(d('leftUpperArm', 'leftLowerArm') + d('leftLowerArm', 'leftHand')).toFixed(3),
    upperArm: +d('leftUpperArm', 'leftLowerArm').toFixed(3), foreArm: +d('leftLowerArm', 'leftHand').toFixed(3),
    legLength: +(d('leftUpperLeg', 'leftLowerLeg') + d('leftLowerLeg', 'leftFoot') + restWorld.leftFoot.y).toFixed(3),
    thigh: +d('leftUpperLeg', 'leftLowerLeg').toFixed(3), shin: +d('leftLowerLeg', 'leftFoot').toFixed(3),
    ankleHeight: +restWorld.leftFoot.y.toFixed(3),
    springJoints: vrm.springBoneManager?.joints?.size ?? 0,
    expressions: Object.keys(vrm.expressionManager?.expressionMap ?? {}),
    loadMs: Math.round(tLoad),
    primitives: merge,
  };

  // ---- rendering + physics tuning
  const materials = tuneMToon(vrm, { quality, root, headProxy: proxies.head, restWorld });
  const springs = tuneSpringBones(vrm, { restWorld, info, root });
  info.materials = materials.summary;
  info.colliders = springs.summary;

  // ---- runtime state
  const lookTarget = new THREE.Object3D(); lookTarget.name = 'heroLookTarget';
  if (vrm.lookAt) { vrm.lookAt.target = camera || null; vrm.lookAt.autoUpdate = !!camera; }
  const expr = vrm.expressionManager;
  const state = {
    exprTarget: {}, exprCur: {}, exprHold: 0,
    blinkTimer: 2 + Math.random() * 2, blinkPhase: -1, manualBlink: null,
    handPose: { left: 'relaxed', right: 'relaxed' }, handHold: 0, handCurl: { left: 0, right: 0 },
  };
  const presetNames = new Set(Object.values(EXPRESSION_PRESETS).flatMap((p) => Object.keys(p)));

  // write proxy rotations -> normalized bones
  function syncToNormalized() {
    for (const n of present) {
      const p = proxies[n];
      const b = norm(n);
      b.quaternion.copy(rigQInv).multiply(p.quaternion).multiply(rigQ);
    }
    const hp = proxies.hips.position;
    norm('hips').position.copy(_v.copy(hp).applyMatrix4(heroToRig));
  }

  function applyHumanoidPose({ hips = null, rotations = null } = {}) {
    if (rotations) {
      for (const n in rotations) {
        const p = proxies[n];
        if (!p || !rotations[n]) continue;
        p.quaternion.copy(rotations[n]);
        norm(n).quaternion.copy(rigQInv).multiply(p.quaternion).multiply(rigQ);
      }
    }
    if (hips) {
      proxies.hips.position.copy(hips);
      norm('hips').position.copy(_v.copy(hips).applyMatrix4(heroToRig));
    }
  }

  /** Current pose in contract form (hero space). */
  function getHumanoidPose() {
    const rotations = {};
    for (const n of present) rotations[n] = proxies[n].quaternion.clone();
    return { hips: proxies.hips.position.clone(), rotations };
  }

  function resetPose() {
    for (const n of present) proxies[n].quaternion.identity();
    proxies.hips.position.copy(restWorld.hips);
    syncToNormalized();
  }

  function setExpression(name, weight) {
    if (weight === undefined) { // game preset (holds ~1.4 s, then eases back to neutral)
      const p = EXPRESSION_PRESETS[name] ?? (expr?.getExpression(name) ? { [name]: 1 } : {});
      state.exprTarget = { ...p };
      state.exprHold = name === 'neutral' || name === 'idle' ? 0 : 1.4;
      return name;
    }
    state.exprTarget[name] = weight; state.exprHold = Infinity;
    if (!presetNames.has(name)) presetNames.add(name);
    return name;
  }
  function blink(v = null) { state.manualBlink = v; if (v === null) state.blinkPhase = 0; }
  function setLookAt(target) {
    if (!vrm.lookAt) return;
    if (!target) { vrm.lookAt.target = null; vrm.lookAt.autoUpdate = false; vrm.lookAt.reset?.(); return; }
    if (target.isObject3D) vrm.lookAt.target = target;
    else { lookTarget.position.copy(target); lookTarget.updateMatrixWorld(); vrm.lookAt.target = lookTarget; }
    vrm.lookAt.autoUpdate = true;
  }
  function setHandPose(pose = 'relaxed', side = 'both') {
    for (const s of side === 'both' ? ['left', 'right'] : [side]) state.handPose[s] = pose;
    state.handHold = pose === 'relaxed' ? 0 : 0.9;
  }
  function setAction(name) {
    if (name === 'handsUp') setExpression('happy');
  }

  function updateFingers(dt) {
    const k = 1 - Math.exp(-dt * 18);
    for (const s of ['left', 'right']) {
      const goal = state.handPose[s] === 'fist' ? 1 : state.handPose[s] === 'open' ? -0.05 : 0.22;
      state.handCurl[s] += (goal - state.handCurl[s]) * k;
      const c = state.handCurl[s];
      const sign = s === 'left' ? -1 : 1; // curl toward the palm (palms face -Y in the T-pose)
      for (const f of FINGERS) {
        for (const j of FINGER_JOINTS) {
          const p = proxies[s + f + j];
          if (!p) continue;
          if (f === 'Thumb') { // thumb folds across the palm around the forward axis
            p.quaternion.setFromAxisAngle(_v.set(0, 1, 0), -sign * c * (j === 'Metacarpal' ? 0.5 : 0.6));
          } else {
            p.quaternion.setFromAxisAngle(_v.set(0, 0, 1), sign * c * (j === 'Proximal' ? 1.25 : 1.35));
          }
        }
      }
    }
  }

  function updateExpressions(dt) {
    if (!expr) return;
    if (state.exprHold !== Infinity && state.exprHold > 0 && (state.exprHold -= dt) <= 0) state.exprTarget = {};
    const k = 1 - Math.exp(-dt * 10);
    for (const n of presetNames) {
      const goal = state.exprTarget[n] ?? 0;
      const cur = state.exprCur[n] ?? 0;
      const v = cur + (goal - cur) * k;
      state.exprCur[n] = Math.abs(v) < 1e-3 ? 0 : v;
      if (expr.getExpression(n)) expr.setValue(n, state.exprCur[n]);
    }
    // auto blink (suppressed while smiling: happy overrides blink on most VRoid models anyway)
    let b = 0;
    if (state.manualBlink !== null) b = state.manualBlink;
    else {
      if (state.blinkPhase < 0 && (state.blinkTimer -= dt) <= 0) { state.blinkPhase = 0; state.blinkTimer = 2.2 + Math.random() * 3.3; }
      if (state.blinkPhase >= 0) {
        state.blinkPhase += dt / 0.16;
        b = state.blinkPhase < 0.5 ? state.blinkPhase * 2 : Math.max(0, 2 - state.blinkPhase * 2);
        if (state.blinkPhase >= 1) state.blinkPhase = -1;
      }
    }
    if (expr.getExpression('blink')) expr.setValue('blink', b);
  }

  const timing = { update: 0 };
  function update(dt = 1 / 60) {
    const u0 = performance.now();
    if (state.handHold > 0 && (state.handHold -= dt) <= 0) setHandPose('relaxed', 'both');
    // hero.fingersExternal: the motion pipeline writes finger rotations via applyHumanoidPose (its hand poser);
    // otherwise the hero's own curl (setHandPose) drives them
    if (!hero.fingersExternal) updateFingers(dt);
    syncToNormalized();
    updateExpressions(dt);
    vrm.update(dt);
    timing.update = performance.now() - u0;
  }

  resetPose();
  vrm.update(0);
  vrm.springBoneManager?.reset();
  root.updateMatrixWorld(true);

  if (renderer && camera) {
    // compile programs off the critical path where supported, so the first frame doesn't stall
    const tmp = new THREE.Scene(); tmp.add(root);
    await renderer.compileAsync?.(tmp, camera).catch(() => {});
    tmp.remove(root);
  }
  info.totalMs = Math.round(performance.now() - t0);

  const hero = {
    kind: 'vrm', root, vrm, gltf, bones, proxies, info, materials, springs, timing,
    restPositions: restWorld, isReady: true, isVRM0, fingersExternal: false,
    update, applyHumanoidPose, getHumanoidPose, resetPose,
    setExpression, blink, setLookAt, setHandPose, setAction,
    setCamera(cam) { if (cam) setLookAt(cam); },
    resetDynamics() { vrm.springBoneManager?.reset(); },
    dispose() {
      root.removeFromParent();
      VRMUtils.deepDispose(vrm.scene);
      materials.shared?.uFaceMap.value?.dispose();
      springs.dispose?.();
    },
  };
  return hero;
}

/** Rest-pose bounds of all meshes (skinned bounds), world space. */
function meshBounds(object) {
  const box = new THREE.Box3(), mb = new THREE.Box3();
  object.updateMatrixWorld(true);
  object.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    if (o.isSkinnedMesh) { o.skeleton?.update(); o.computeBoundingBox(); mb.copy(o.boundingBox).applyMatrix4(o.matrixWorld); }
    else { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); mb.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld); }
    box.union(mb);
  });
  void _q; void _m;
  return box;
}
