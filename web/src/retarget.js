// Retargets a canonical tracked pose onto the rigid-part character rig.
//
// The rig is built in a T-pose with identity joint rotations (see character.js), so rest directions are
// measured once from joint positions. Each frame:
//   torso/head: orientation from a basis (hips: hip line + spine, chest: shoulder line + spine, head: ears + nose)
//   limbs:      minimal swing from the parent's orientation onto the tracked bone direction (keeps twist stable)
//   root:       hip translation relative to a calibrated neutral position, then planted on the floor.
import * as THREE from 'three';
import { midpoint } from './pose.js';

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _qi = new THREE.Quaternion();
const HEAD_PITCH = -0.32; // nose sits below the ears: pitch the head frame up to level

function basisQuat(xAxis, upHint) {
  const x = _v1.copy(xAxis).normalize();
  const z = _v3.crossVectors(x, upHint).normalize(); // x × y = z
  const y = _v2.crossVectors(z, x).normalize();
  _m.makeBasis(x, y, z);
  return new THREE.Quaternion().setFromRotationMatrix(_m);
}

// limb chains: [bone, child bone/marker, from joint, to joint, conf joints, fallback root-space dir]
const LIMBS = [
  ['leftUpperArm', 'leftForeArm', 'leftShoulder', 'leftElbow', ['leftShoulder', 'leftElbow'], [0.25, -1, 0.05]],
  ['leftForeArm', 'leftHand', 'leftElbow', 'leftWrist', ['leftElbow', 'leftWrist'], [0.1, -1, 0.15]],
  ['leftHand', 'leftHandTip', 'leftWrist', 'leftHand', ['leftWrist', 'leftHand'], [0.05, -1, 0.1]],
  ['rightUpperArm', 'rightForeArm', 'rightShoulder', 'rightElbow', ['rightShoulder', 'rightElbow'], [-0.25, -1, 0.05]],
  ['rightForeArm', 'rightHand', 'rightElbow', 'rightWrist', ['rightElbow', 'rightWrist'], [-0.1, -1, 0.15]],
  ['rightHand', 'rightHandTip', 'rightWrist', 'rightHand', ['rightWrist', 'rightHand'], [-0.05, -1, 0.1]],
  ['leftThigh', 'leftShin', 'leftHip', 'leftKnee', ['leftHip', 'leftKnee'], [0.03, -1, 0]],
  ['leftShin', 'leftFoot', 'leftKnee', 'leftAnkle', ['leftKnee', 'leftAnkle'], [0, -1, 0]],
  ['leftFoot', 'leftToe', 'leftHeel', 'leftToe', ['leftAnkle', 'leftToe'], null],
  ['rightThigh', 'rightShin', 'rightHip', 'rightKnee', ['rightHip', 'rightKnee'], [-0.03, -1, 0]],
  ['rightShin', 'rightFoot', 'rightKnee', 'rightAnkle', ['rightKnee', 'rightAnkle'], [0, -1, 0]],
  ['rightFoot', 'rightToe', 'rightHeel', 'rightToe', ['rightAnkle', 'rightToe'], null],
];

const PARENT = {
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  leftShoulder: 'chest', rightShoulder: 'chest',
  leftUpperArm: 'leftShoulder', leftForeArm: 'leftUpperArm', leftHand: 'leftForeArm',
  rightUpperArm: 'rightShoulder', rightForeArm: 'rightUpperArm', rightHand: 'rightForeArm',
  leftThigh: 'hips', leftShin: 'leftThigh', leftFoot: 'leftShin',
  rightThigh: 'hips', rightShin: 'rightThigh', rightFoot: 'rightShin',
};
const ORDER = Object.keys(PARENT);

export class Retargeter {
  constructor(character) {
    this.char = character;
    this.bones = character.bones;
    this.root = character.root;
    this.root.updateMatrixWorld(true);
    this.restPos = {};
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    for (const [name, b] of Object.entries(this.bones)) {
      this.restPos[name] = b.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    }
    this.restHipsLocal = this.bones.hips.position.clone();
    this.restDir = {};
    for (const [bone, child] of LIMBS) {
      this.restDir[bone] = this.restPos[child].clone().sub(this.restPos[bone]).normalize();
    }
    this.target = {};
    for (const n of ORDER) this.target[n] = new THREE.Quaternion();
    this.rootOffset = new THREE.Vector3();
    this.rootTarget = new THREE.Vector3();
    this.calib = null;
    this._calibSamples = [];
    this.interp = 0.5;          // 0 = snap to every tracker update, 1 = very smooth
    this.moveScale = new THREE.Vector3(1.0, 1.0, 0.8);
    this.footMarkers = ['leftToe', 'rightToe', 'leftFoot', 'rightFoot'].map((n) => this.bones[n]).filter(Boolean);
    this.airborne = false;
    this.lastLimbConf = {};
  }

  recalibrate() { this.calib = null; this._calibSamples = []; }

  /** joints: character-space (already mirrored if needed), metres. */
  setPose(joints, conf) {
    const J = joints;
    const hipMid = midpoint(J.leftHip, J.rightHip);
    const spineUp = J.neck.clone().sub(hipMid);

    // ---- calibration of the neutral root position
    if (!this.calib) {
      this._calibSamples.push(hipMid.clone());
      if (this._calibSamples.length >= 15) {
        const c = new THREE.Vector3();
        this._calibSamples.forEach((s) => c.add(s));
        this.calib = c.divideScalar(this._calibSamples.length);
      }
    }
    if (this.calib) {
      const d = hipMid.clone().sub(this.calib).multiply(this.moveScale);
      d.x = THREE.MathUtils.clamp(d.x, -3, 3);
      d.z = THREE.MathUtils.clamp(d.z, -3, 3);
      d.y = THREE.MathUtils.clamp(d.y, -1, 1.2);
      this.rootTarget.copy(d);
    }

    // ---- torso
    const T = this.target;
    const hipsQ = basisQuat(J.leftHip.clone().sub(J.rightHip), spineUp);
    const chestQ = basisQuat(J.leftShoulder.clone().sub(J.rightShoulder), spineUp);
    T.hips.copy(hipsQ);
    T.spine.copy(hipsQ).slerp(chestQ, 0.5);
    T.chest.copy(chestQ);
    T.leftShoulder.copy(chestQ);
    T.rightShoulder.copy(chestQ);

    // ---- head
    const earMid = midpoint(J.leftEar, J.rightEar);
    const headConf = Math.min(conf.nose ?? 1, conf.leftEar ?? 1, conf.rightEar ?? 1);
    if (headConf > 0.3) {
      const fwd = J.nose.clone().sub(earMid);
      const x = J.leftEar.clone().sub(J.rightEar).normalize();
      const z = fwd.sub(x.clone().multiplyScalar(fwd.dot(x))).normalize();
      const y = new THREE.Vector3().crossVectors(z, x);
      const hq = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
      hq.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), HEAD_PITCH));
      // Limit head rotation relative to chest to anatomically plausible range
      const rel = chestQ.clone().invert().multiply(hq);
      const ang = 2 * Math.acos(Math.min(1, Math.abs(rel.w)));
      if (ang > 1.3) rel.slerp(new THREE.Quaternion(), 1 - 1.3 / ang);
      const headQ = chestQ.clone().multiply(rel);
      T.head.copy(headQ);
      T.neck.copy(chestQ).slerp(headQ, 0.4);
    } else {
      T.neck.copy(chestQ); T.head.copy(chestQ);
    }

    // ---- limbs
    for (const [bone, , from, to, confJ, fallback] of LIMBS) {
      const parentQ = T[PARENT[bone]];
      const c = Math.min(...confJ.map((n) => conf[n] ?? 0));
      this.lastLimbConf[bone] = c;
      const restWorld = this.restDir[bone].clone().applyQuaternion(parentQ);
      let dir;
      if (J[from] && J[to] && c >= 0.35) {
        dir = J[to].clone().sub(J[from]);
        if (dir.lengthSq() < 1e-8) dir = restWorld.clone();
        dir.normalize();
      } else if (fallback) {
        // limb not visible: relax it into a neutral standing pose relative to the hips
        dir = new THREE.Vector3(...fallback).normalize().applyQuaternion(hipsQ);
      } else {
        dir = restWorld.clone();
      }
      const swing = new THREE.Quaternion().setFromUnitVectors(restWorld.normalize(), dir);
      T[bone].copy(swing.multiply(parentQ));
    }
  }

  /** Advance the rig towards the latest target. dt seconds. */
  update(dt) {
    const k = this.interp <= 0.001 ? 1 : 1 - Math.exp(-dt * THREE.MathUtils.lerp(40, 7, this.interp));
    for (const n of ORDER) {
      const b = this.bones[n];
      const parent = PARENT[n];
      _qi.copy(parent ? this.target[parent] : _q.identity()).invert();
      const local = _qi.multiply(this.target[n]);
      b.quaternion.slerp(local, k);
    }
    this.rootOffset.lerp(this.rootTarget, k);
    const hips = this.bones.hips;
    hips.position.set(
      this.restHipsLocal.x + this.rootOffset.x,
      this.restHipsLocal.y + this.rootOffset.y,
      this.restHipsLocal.z + this.rootOffset.z,
    );
    // ---- plant on the floor: lift if feet go under, drop if floating while not jumping
    this.root.updateMatrixWorld(true);
    let minY = Infinity;
    for (const m of this.footMarkers) minY = Math.min(minY, m.getWorldPosition(_v1).y);
    const baseY = this.root.position.y;
    const footY = minY - baseY;
    this.airborne = this.rootOffset.y > 0.06;
    if (footY < 0.02 || !this.airborne) hips.position.y += 0.02 - footY;
    this.root.updateMatrixWorld(true);
  }

  /** Root-space positions of the rig's joints (for the accuracy test). */
  restPose() {
    for (const n of ORDER) { this.target[n].identity(); }
  }
}
