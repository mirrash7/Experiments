// Pose solvers: tracker frame -> WORLD rotations of the VRM humanoid bones (camera-aligned three.js frame,
// before floor calibration and mirroring). Two solvers emit the same format:
//   MHRSolver       InstantHMR's MHR parameters -> MHR FK -> rest-pose-aligned copy of joint rotations
//                   (real twist for forearm/upper arm/thigh/head, MHR's own spine distribution, wrist + fingers)
//   KeypointSolver  3D keypoints (MediaPipe / synthetic / HMR without params) -> two-axis bone frames with twist
//                   from extra landmarks (palm index/pinky, heel/toe, ears/nose) and a weighted spine split.
//
// Retarget formula (pixiv's Mixamo -> VRM delta, plus a rest offset): W_bone = R_j * R0_j^-1 * A_bone, with
// A_bone = F(MHR rest dirs) * F(VRM rest dirs)^-1 so that the MHR rest pose maps onto the VRM T-pose bone by bone.
import * as THREE from 'three';
import { frameQuat, fromTo, smoothstep } from './math.js';

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const FINGER_MHR = { Thumb: 'thumb', Index: 'index', Middle: 'middle', Ring: 'ring', Little: 'pinky' };

// VRM bone -> [MHR joint whose global rotation drives it, dir-from joint, dir-to joint, secondary rule]
function mhrMap(hasUpperChest) {
  const m = {
    hips: ['root'], spine: ['c_spine1'], chest: [hasUpperChest ? 'c_spine2' : 'c_spine3'], upperChest: ['c_spine3'],
    neck: ['c_neck'], head: ['c_head'],
  };
  for (const [s, p] of [['left', 'l'], ['right', 'r']]) {
    Object.assign(m, {
      [`${s}Shoulder`]: [`${p}_clavicle`, `${p}_clavicle`, `${p}_uparm`, 'fwd'],
      [`${s}UpperArm`]: [`${p}_uparm`, `${p}_uparm`, `${p}_lowarm`, 'elbow'],
      [`${s}LowerArm`]: [`${p}_lowarm`, `${p}_lowarm`, `${p}_wrist`, 'palm'],
      [`${s}Hand`]: [`${p}_wrist`, `${p}_wrist`, `${p}_middle1`, 'palm'],
      [`${s}UpperLeg`]: [`${p}_upleg`, `${p}_upleg`, `${p}_lowleg`, 'fwd'],
      [`${s}LowerLeg`]: [`${p}_lowleg`, `${p}_lowleg`, `${p}_foot`, 'fwd'],
      [`${s}Foot`]: [`${p}_transversetarsal`, `${p}_foot`, `${p}_ball`, 'side'],
      [`${s}Toes`]: [`${p}_ball`, null, null, 'toe'],
    });
    for (const [F, f] of Object.entries(FINGER_MHR)) {
      const segs = F === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
      const js = F === 'Thumb' ? [1, 2, 3, 'null'] : [1, 2, 3, 'null'];
      segs.forEach((seg, i) => {
        m[`${s}${F}${seg}`] = [`${p}_${f}${js[i]}`, `${p}_${f}${js[i]}`, `${p}_${f}${js[i + 1] === 'null' ? '_null' : js[i + 1]}`, 'palm'];
      });
    }
  }
  return m;
}

/** VRM-side rest frame (p0, s0) for a bone, from the hero's rest skeleton. */
function vrmRestFrame(rig, b, rule) {
  const W = rig.restWorld, side = b.startsWith('left') ? 'left' : 'right';
  const child = {
    Shoulder: 'UpperArm', UpperArm: 'LowerArm', LowerArm: 'Hand', Hand: 'MiddleProximal', UpperLeg: 'LowerLeg',
    LowerLeg: 'Foot', Foot: 'Toes',
  };
  const key = b.replace(/^(left|right)/, '');
  let p;
  if (child[key] && W[side + child[key]]) p = rig.restDir(b, side + child[key]);
  else if (/(Thumb|Index|Middle|Ring|Little)/.test(b)) {
    const next = { Metacarpal: 'Proximal', Proximal: b.includes('Thumb') ? 'Distal' : 'Intermediate', Intermediate: 'Distal' };
    const seg = b.match(/(Metacarpal|Proximal|Intermediate|Distal)$/)[1];
    const nb = next[seg] ? b.replace(seg, next[seg]) : null;
    if (nb && W[nb]) p = rig.restDir(b, nb);
    else { const parent = rig.parent[b]; p = parent && W[parent] ? W[b].clone().sub(W[parent]).normalize() : X.clone().multiplyScalar(side === 'left' ? 1 : -1); }
  } else if (key === 'Hand') p = X.clone().multiplyScalar(side === 'left' ? 1 : -1);
  else if (key === 'Foot') p = new THREE.Vector3(0, -0.5, 1).normalize();
  else p = Z.clone();
  let s;
  if (rule === 'palm') {
    const a = W[side + 'IndexProximal'], c = W[side + 'LittleProximal'];
    s = a && c ? a.clone().sub(c) : Z.clone();
  } else if (rule === 'side') s = X.clone();
  else if (rule === 'toe') { p = Z.clone(); s = X.clone(); }
  else s = Z.clone();
  return [p, s];
}

export class MHRSolver {
  constructor(mhr, rig, { limits = false } = {}) {
    this.mhr = mhr; this.rig = rig; this.limits = limits;
    this.map = mhrMap(rig.present.has('upperChest'));
    this.align = {};      // bone -> {j, A (Quaternion), R0inv (Quaternion)}
    const rest = mhr.rest;
    const P = (name) => mhr.jointPos(rest, mhr.index[name]);
    for (const b of rig.bones) {
      const e = this.map[b];
      if (!e) continue;
      const [jn, from, to, rule] = e;
      const j = mhr.index[jn];
      if (j === undefined) continue;
      const R0inv = mhr.jointQuat(rest, j).invert();
      let A = new THREE.Quaternion();
      if (rule) {
        let pm, sm;
        if (rule === 'toe') { pm = Z.clone(); sm = X.clone(); }
        else {
          pm = P(to).sub(P(from)).normalize();
          const side = jn[0];
          if (rule === 'fwd') sm = Z.clone();
          else if (rule === 'side') sm = X.clone();
          else if (rule === 'elbow') sm = P(`${side}_wrist`).sub(P(`${side}_lowarm`));
          else sm = P(`${side}_index1`).sub(P(`${side}_pinky1`));
        }
        const [p0, s0] = vrmRestFrame(rig, b, rule);
        A = frameQuat(pm, sm).multiply(frameQuat(p0, s0).invert());
      }
      this.align[b] = { j, A, R0inv };
    }
    this.fk = null;
    this._buf = null;
  }

  /** frame.mhr (204) -> {world: {bone: Quaternion}, hips: Vector3 (three frame, metres), fk} */
  solve(frame) {
    // NB: MHR's own min/max parameter limits are fitting priors, not anatomical limits: InstantHMR outputs
    // violate them on every frame (flexible spine/foot/scale params), so clamping is off by default.
    const params = this.limits ? this.mhr.clampParams(frame.mhr) : frame.mhr;
    this._buf = this.mhr.forward(params, this._buf ?? undefined);
    const fk = this._buf, world = {};
    const q = new THREE.Quaternion();
    for (const [b, { j, A, R0inv }] of Object.entries(this.align)) {
      world[b] = this.mhr.jointQuat(fk, j, q).clone().multiply(R0inv).multiply(A);
    }
    const ct = frame.camT ?? [0, 0, 0];
    const root = this.mhr.index.root;
    const hips = new THREE.Vector3(fk.pos[root * 3] + ct[0], fk.pos[root * 3 + 1] - ct[1], fk.pos[root * 3 + 2] - ct[2]);
    return { world, hips, fk };
  }
}

/**
 * Keypoint -> rotation solver. Needs frame.joints (three frame); uses frame.extra.{left,right}{Index,Pinky}
 * when present for wrist twist. Keeps per-limb last good bend axes for straight-limb cases.
 */
export class KeypointSolver {
  constructor(rig, { spine = [0.3, 0.35, 0.35] } = {}) {
    this.rig = rig; this.spine = spine;
    this.restInv = {};
    for (const b of rig.bones) {
      const rule = /(UpperArm)$/.test(b) ? 'elbow' : /(LowerArm|Hand)$/.test(b) ? 'palm' : /Foot$/.test(b) ? 'side' : /Toes$/.test(b) ? 'toe' : 'fwd';
      const [p0, s0] = vrmRestFrame(rig, b, rule);
      this.restInv[b] = frameQuat(p0, s0).invert();
    }
    this.lastBend = {};
    this.headPitch = -0.3;   // nose sits below the ear line: neutral head offset (calibrated)
  }

  _limb(b, p, s) { return frameQuat(p, s).multiply(this.restInv[b]); }

  /** Bend-plane secondary axis: component of `next` orthogonal to `p`, falling back to the last good one. */
  _bend(key, p, next, fallback, sign = 1) {
    const s = next.clone().addScaledVector(p, -next.dot(p) / p.lengthSq()).multiplyScalar(sign);
    const w = smoothstep(0.08, 0.3, s.length() / (next.length() + 1e-6));
    const last = this.lastBend[key] ?? fallback.clone();
    const out = s.normalize().multiplyScalar(w).addScaledVector(last, 1 - w);
    if (w > 0.5) this.lastBend[key] = out.clone().normalize();
    return out;
  }

  solve(frame) {
    const J = frame.joints, E = frame.extra ?? {};
    const world = {}, rig = this.rig;
    const mid = (a, b) => a.clone().add(b).multiplyScalar(0.5);
    const hipMid = mid(J.leftHip, J.rightHip), shMid = mid(J.leftShoulder, J.rightShoulder);
    const hipsW = frameQuat(J.leftHip.clone().sub(J.rightHip), shMid.clone().sub(hipMid));
    const topW = frameQuat(J.leftShoulder.clone().sub(J.rightShoulder), shMid.clone().sub(hipMid));
    world.hips = hipsW;
    const rel = hipsW.clone().invert().multiply(topW);
    const [a, b] = this.spine;
    const has = (n) => rig.present.has(n);
    world.spine = hipsW.clone().multiply(new THREE.Quaternion().slerp(rel, has('upperChest') ? a : a + b * 0.5));
    if (has('upperChest')) { world.chest = hipsW.clone().multiply(new THREE.Quaternion().slerp(rel, a + b)); world.upperChest = topW.clone(); }
    else world.chest = topW.clone();
    const chestFwd = Z.clone().applyQuaternion(topW), chestUp = Y.clone().applyQuaternion(topW);
    // head from ears + nose
    if (J.leftEar && J.rightEar && J.nose) {
      const left = J.leftEar.clone().sub(J.rightEar);
      const fwd = J.nose.clone().sub(mid(J.leftEar, J.rightEar));
      const up = new THREE.Vector3().crossVectors(fwd, left);
      const head = frameQuat(left, up).multiply(new THREE.Quaternion().setFromAxisAngle(X, this.headPitch));
      world.head = head;
      world.neck = topW.clone().slerp(head, 0.5);
    } else { world.head = topW.clone(); world.neck = topW.clone(); }

    for (const s of ['left', 'right']) {
      const S = J[s + 'Shoulder'], El = J[s + 'Elbow'], Wr = J[s + 'Wrist'];
      world[s + 'Shoulder'] = topW.clone();
      if (S && El && Wr) {
        const pU = El.clone().sub(S), pF = Wr.clone().sub(El);
        world[s + 'UpperArm'] = this._limb(s + 'UpperArm', pU, this._bend(s + 'Arm', pU, pF, chestFwd));
        // forearm: swing from the upper arm (twist comes from the hand via the common twist split)
        const lower = fromTo(pU, pF).multiply(world[s + 'UpperArm']);
        world[s + 'LowerArm'] = lower;
        const idx = E[s + 'Index'], pky = E[s + 'Pinky'];
        if (idx && pky) {
          const hc = mid(idx, pky);
          world[s + 'Hand'] = this._limb(s + 'Hand', hc.clone().sub(Wr), idx.clone().sub(pky));
        } else if (J[s + 'Hand']) {
          world[s + 'Hand'] = fromTo(pF, J[s + 'Hand'].clone().sub(Wr)).multiply(lower);
        } else world[s + 'Hand'] = lower.clone();
      }
      const H = J[s + 'Hip'], K = J[s + 'Knee'], A = J[s + 'Ankle'];
      if (H && K && A) {
        const pT = K.clone().sub(H), pS = A.clone().sub(K);
        const toe = J[s + 'Toe'], heel = J[s + 'Heel'];
        const footFwd = toe && heel ? toe.clone().sub(heel) : chestFwd.clone().setY(0);
        // knee points forward: the shin swings backward, so the forward axis is minus the shin's bend component
        const kneeFwd = this._bend(s + 'Leg', pT, pS, footFwd.clone().normalize(), -1);
        const sT = kneeFwd.clone().add(footFwd.clone().normalize().multiplyScalar(0.3));
        world[s + 'UpperLeg'] = this._limb(s + 'UpperLeg', pT, sT);
        world[s + 'LowerLeg'] = this._limb(s + 'LowerLeg', pS, footFwd.clone().addScaledVector(pS, 0));
        if (toe) {
          const up = K.clone().sub(A);
          const left = new THREE.Vector3().crossVectors(up, footFwd);
          world[s + 'Foot'] = this._limb(s + 'Foot', toe.clone().sub(A), left);
        } else world[s + 'Foot'] = world[s + 'LowerLeg'].clone();
        world[s + 'Toes'] = world[s + 'Foot'].clone();
      }
    }
    void chestUp;
    return { world, hips: hipMid };
  }
}
