// Hero v2 rig: THREE.Bone hierarchy (contract bones + markers + helper bones), one shared Skeleton,
// and the helper-bone drivers. Owner: WP0. See hero/CONTRACTS.md.
//
// Rest pose: T-pose, faces +Z, Y up, feet on y = 0, identity rest rotations, unit scale.
// Contract bones/markers are written by retarget.js (and the preview) BEFORE hero.update();
// helper bones are only written by rig.updateHelpers() (called from hero.update()) and by WP5 dynamics.

import * as THREE from 'three';
import { JOINT_OFFSETS as J, JOINT_WORLD, LENGTHS as L } from './dims.js';

export const SIDES = [['left', 1], ['right', -1]];

/** The 19 contract bones (retargeted). Order is also their skeleton index order (0..18). */
export const CONTRACT_BONES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftForeArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightForeArm', 'rightHand',
  'leftThigh', 'leftShin', 'leftFoot', 'rightThigh', 'rightShin', 'rightFoot',
];
/** 5 markers (THREE.Bone, NOT in the skeleton, never skinned to). */
export const MARKERS = ['leftHandTip', 'rightHandTip', 'leftToe', 'rightToe', 'headTop'];

/** Helper bones: [name, parent, local rest offset]. Skeleton indices 19.. in this order. */
export const HELPER_DEFS = [
  ['leftUpperArmTwist', 'leftUpperArm', [0.4 * L.upperArm, 0, 0]],
  ['rightUpperArmTwist', 'rightUpperArm', [-0.4 * L.upperArm, 0, 0]],
  ['leftForeArmTwist', 'leftForeArm', [0.5 * L.foreArm, 0, 0]],
  ['rightForeArmTwist', 'rightForeArm', [-0.5 * L.foreArm, 0, 0]],
  ['leftElbowHelper', 'leftUpperArm', [L.upperArm, 0, 0]],      // at the elbow pivot
  ['rightElbowHelper', 'rightUpperArm', [-L.upperArm, 0, 0]],
  ['leftKneeHelper', 'leftThigh', [0, -L.thigh, 0]],            // at the knee pivot
  ['rightKneeHelper', 'rightThigh', [0, -L.thigh, 0]],
  ['leftHipHelper', 'hips', [...J.thigh]],                      // at the thigh joint
  ['rightHipHelper', 'hips', [-J.thigh[0], J.thigh[1], J.thigh[2]]],
  // cloth jiggle bones (rest identity; driven by WP5). World rest y ~0.96 for hems.
  ['shirtHemL', 'spine', [0.130, -0.060, 0.030]],
  ['shirtHemR', 'spine', [-0.130, -0.060, 0.030]],
  ['shirtHemBack', 'spine', [0, -0.060, -0.090]],
  ['sleeveCuffL', 'leftForeArm', [0, 0, 0]],                    // pivot at the elbow; cuff ends at forearm t 0.24
  ['sleeveCuffR', 'rightForeArm', [0, 0, 0]],
  // hair spring groups (head-local; head pivot at world y 1.495)
  ['hairBangs', 'head', [0, 0.170, 0.085]],
  ['hairL', 'head', [0.095, 0.150, 0.010]],
  ['hairR', 'head', [-0.095, 0.150, 0.010]],
  ['hairBack', 'head', [0, 0.140, -0.090]],
];
export const HELPER_BONES = HELPER_DEFS.map((d) => d[0]);

/**
 * Shared neck seam weights (QA r1 P0-11), the SAME window the head uses for its jaw-underside / nape vertices
 * (head.js NECK_BLEND, feathered there at r 1.1..1.8 x neck radius), so both sides of the seam move
 * identically. Returns [neck, head] summing to 1: head share = smoothstep(1.47, 1.55, y).
 * Head yaw is split between the neck and head bones by the retargeter (neck = 40 % of the head rotation,
 * retarget.js), and the QA presets do the same (render/posePresets.js), so a 70 deg turn blends 28 -> 70 deg
 * across the window (worst LBS radius loss cos 21 = 0.93) instead of 0 -> 70.
 */
export const NECK_BLEND = Object.freeze([1.47, 1.55]);
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export function neckSeamWeights(y, out = [0, 0]) {
  const h = sstep(NECK_BLEND[0], NECK_BLEND[1], y);
  out[0] = 1 - h; out[1] = h;
  return out;
}
/** Skeleton bone order: index i in skinIndex == SKELETON_BONES[i]. Stable contract. */
export const SKELETON_BONES = [...CONTRACT_BONES, ...HELPER_BONES];

const _qi = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);

/** Twist part of q about unit axis (swing-twist decomposition). Writes into out. */
export function twistAbout(q, axis, out = new THREE.Quaternion()) {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  out.set(axis.x * d, axis.y * d, axis.z * d, q.w);
  const len = Math.hypot(out.x, out.y, out.z, out.w);
  if (len < 1e-9) return out.identity();
  out.x /= len; out.y /= len; out.z /= len; out.w /= len;
  if (out.w < 0) { out.x = -out.x; out.y = -out.y; out.z = -out.z; out.w = -out.w; }
  return out;
}

export function createRig() {
  const root = new THREE.Group();
  root.name = 'HeroCharacter';
  const all = {};
  const bone = (name, parent, [x, y, z]) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    parent.add(b);
    all[name] = b;
    return b;
  };

  // ---- contract bones + markers
  bone('hips', root, J.hips);
  bone('spine', all.hips, J.spine);
  bone('chest', all.spine, J.chest);
  bone('neck', all.chest, J.neck);
  bone('head', all.neck, J.head);
  bone('headTop', all.head, J.headTop);
  for (const [side, s] of SIDES) {
    const mx = ([x, y, z]) => [s * x, y, z];
    bone(`${side}Shoulder`, all.chest, mx(J.shoulder));
    bone(`${side}UpperArm`, all[`${side}Shoulder`], mx(J.upperArm));
    bone(`${side}ForeArm`, all[`${side}UpperArm`], mx(J.foreArm));
    bone(`${side}Hand`, all[`${side}ForeArm`], mx(J.hand));
    bone(`${side}HandTip`, all[`${side}Hand`], mx(J.handTip));
    bone(`${side}Thigh`, all.hips, mx(J.thigh));
    bone(`${side}Shin`, all[`${side}Thigh`], J.shin);
    bone(`${side}Foot`, all[`${side}Shin`], J.foot);
    bone(`${side}Toe`, all[`${side}Foot`], J.toe);
  }
  // ---- helper bones
  for (const [name, parent, off] of HELPER_DEFS) bone(name, all[parent], off);

  /** Public contract map (what retarget.js sees): 19 bones + 5 markers. Helpers are NOT in here. */
  const bones = {};
  for (const n of [...CONTRACT_BONES.slice(0, 5), 'headTop']) bones[n] = all[n];
  for (const [side] of SIDES) for (const p of ['Shoulder', 'UpperArm', 'ForeArm', 'Hand', 'HandTip', 'Thigh', 'Shin', 'Foot', 'Toe']) bones[side + p] = all[side + p];
  const helpers = Object.fromEntries(HELPER_BONES.map((n) => [n, all[n]]));

  // ---- skeleton: bone inverses computed in ROOT space with root at identity (rest pose)
  root.updateMatrixWorld(true);
  const skelBones = SKELETON_BONES.map((n) => all[n]);
  const boneInverses = skelBones.map((b) => b.matrixWorld.clone().invert());
  const skeleton = new THREE.Skeleton(skelBones, boneInverses);
  const boneIndex = Object.fromEntries(SKELETON_BONES.map((n, i) => [n, i]));

  // ---- rest world positions (root space) of every bone/marker/helper
  const restWorld = {};
  for (const [n, b] of Object.entries(all)) restWorld[n] = b.getWorldPosition(new THREE.Vector3());
  for (const [n, p] of Object.entries(JOINT_WORLD)) {
    if (restWorld[n].distanceTo(new THREE.Vector3(...p)) > 1e-6) throw new Error(`rig: ${n} rest position mismatch`);
  }

  /**
   * Default deform segments for distance-based skinning (geo/attributes.js skinToSegments).
   * { bone, a: Vector3, b: Vector3, r } in root-space rest coordinates; r = nominal radius.
   */
  const W = restWorld;
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const segments = [
    { bone: 'hips', a: v(0, 0.84, 0), b: v(0, 0.97, 0), r: 0.14 },
    { bone: 'spine', a: v(0, 1.02, 0), b: v(0, 1.20, 0), r: 0.13 },
    { bone: 'chest', a: v(0, 1.24, 0), b: v(0, 1.40, 0), r: 0.14 },
    { bone: 'neck', a: W.neck.clone(), b: v(0, 1.48, 0), r: 0.045 },
    { bone: 'head', a: v(0, 1.52, 0), b: v(0, 1.68, 0), r: 0.11 },
  ];
  for (const [side] of SIDES) {
    const seg = (b, c, r) => segments.push({ bone: side + b, a: W[side + b].clone(), b: W[side + c].clone(), r });
    seg('Shoulder', 'UpperArm', 0.05);
    seg('UpperArm', 'ForeArm', 0.045);
    seg('ForeArm', 'Hand', 0.035);
    seg('Hand', 'HandTip', 0.03);
    seg('Thigh', 'Shin', 0.07);
    seg('Shin', 'Foot', 0.045);
    seg('Foot', 'Toe', 0.04);
  }

  /**
   * Bind a SkinnedMesh to the shared skeleton. Geometry must be in ROOT-space rest coordinates.
   * The mesh becomes a child of rig.root with identity transform; bindMode 'attached';
   * bindMatrix = identity (explicit, so the skeleton inverses are never recomputed from a posed rig).
   */
  function bind(mesh) {
    if (!mesh.isSkinnedMesh) throw new Error('rig.bind: expected a THREE.SkinnedMesh');
    if (mesh.parent !== root) root.add(mesh);
    mesh.position.set(0, 0, 0); mesh.quaternion.identity(); mesh.scale.set(1, 1, 1);
    mesh.bindMode = THREE.AttachedBindMode;
    mesh.bind(skeleton, new THREE.Matrix4());
    mesh.frustumCulled = false; // skinned bounds are not tracked; the hero is always framed
    return mesh;
  }

  // ---- helper drivers (call after the retargeter has written the contract bones)
  const tw = new THREE.Quaternion();
  function updateHelpers() {
    for (const [side] of SIDES) {
      const ua = all[`${side}UpperArm`], fa = all[`${side}ForeArm`], hd = all[`${side}Hand`];
      // UpperArmTwist cancels 50% of the upper-arm roll about the bone axis (local X)
      twistAbout(ua.quaternion, X_AXIS, tw);
      _qi.copy(tw).invert();
      all[`${side}UpperArmTwist`].quaternion.identity().slerp(_qi, 0.5);
      // ForeArmTwist takes 50% of the hand's twist about the forearm axis
      twistAbout(hd.quaternion, X_AXIS, tw);
      all[`${side}ForeArmTwist`].quaternion.identity().slerp(tw, 0.5);
      // joint helpers: half of the child rotation
      all[`${side}ElbowHelper`].quaternion.identity().slerp(fa.quaternion, 0.5);
      all[`${side}KneeHelper`].quaternion.identity().slerp(all[`${side}Shin`].quaternion, 0.5);
      all[`${side}HipHelper`].quaternion.identity().slerp(all[`${side}Thigh`].quaternion, 0.5);
    }
  }

  /** Reset every contract bone + helper to rest (identity rotation, rest position). */
  const restLocal = Object.fromEntries(Object.entries(all).map(([n, b]) => [n, b.position.clone()]));
  function resetPose() {
    for (const [n, b] of Object.entries(all)) { b.quaternion.identity(); b.position.copy(restLocal[n]); b.scale.set(1, 1, 1); }
    root.updateMatrixWorld(true);
  }

  return { root, bones, helpers, all, skeleton, boneIndex, boneOrder: SKELETON_BONES, restWorld, segments, bind, updateHelpers, resetPose, neckSeamWeights,
    dispose() { skeleton.dispose(); } };
}
