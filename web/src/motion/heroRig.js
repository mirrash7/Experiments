// VRM humanoid bone hierarchy + the hero's rest skeleton (positions of the normalized bones in T-pose).
//
// Convention used by the whole motion pipeline ("VRM1 convention"): hero root space, the character faces +Z,
// its left is +X, y up, metres. Normalized bones have identity rest rotation, so a bone's local rotation is
// directly what `applyHumanoidPose` wants. (VRM 0.x models after VRMUtils.rotateVRM0 have their normalized
// frame turned 180 deg about Y: see toVRM0Pose in pipeline.js.)
import * as THREE from 'three';

const SIDES = ['left', 'right'];
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
const FINGER_SEGS = { Thumb: ['Metacarpal', 'Proximal', 'Distal'], default: ['Proximal', 'Intermediate', 'Distal'] };

/** VRM 1.0 humanoid parent table (only the bones the motion pipeline drives). */
export const VRM_PARENT = {
  hips: null, spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck',
};
for (const s of SIDES) {
  Object.assign(VRM_PARENT, {
    [`${s}Shoulder`]: 'upperChest', [`${s}UpperArm`]: `${s}Shoulder`, [`${s}LowerArm`]: `${s}UpperArm`,
    [`${s}Hand`]: `${s}LowerArm`, [`${s}UpperLeg`]: 'hips', [`${s}LowerLeg`]: `${s}UpperLeg`,
    [`${s}Foot`]: `${s}LowerLeg`, [`${s}Toes`]: `${s}Foot`,
  });
  for (const f of FINGERS) {
    const segs = FINGER_SEGS[f] ?? FINGER_SEGS.default;
    segs.forEach((seg, i) => { VRM_PARENT[`${s}${f}${seg}`] = i === 0 ? `${s}Hand` : `${s}${f}${segs[i - 1]}`; });
  }
}
export const BODY_BONES = Object.keys(VRM_PARENT).filter((b) => !/(Thumb|Index|Middle|Ring|Little)/.test(b));
export const FINGER_BONES = Object.keys(VRM_PARENT).filter((b) => /(Thumb|Index|Middle|Ring|Little)/.test(b));
export const ALL_BONES = Object.keys(VRM_PARENT);
export { FINGERS, FINGER_SEGS };

export const swapSide = (name) => name.startsWith('left') ? 'right' + name.slice(4)
  : name.startsWith('right') ? 'left' + name.slice(5) : name;

// Canonical T-pose proportions (fractions of the height), VRM1 convention, local offsets from the parent.
// Used only when neither a VRM nor a rest pose is available.
function canonicalOffsets(h, info) {
  const hip = info.hipHeight ?? 0.53 * h;
  const ua = info.upperArm ?? 0.17 * h, la = info.lowerArm ?? 0.155 * h;
  const ul = info.upperLeg ?? 0.245 * h, ll = info.lowerLeg ?? 0.245 * h;
  const ankle = Math.max(0.03, hip - ul - ll);
  const o = {
    hips: [0, hip, 0], spine: [0, 0.055 * h, 0], chest: [0, 0.07 * h, 0], upperChest: [0, 0.07 * h, 0],
    neck: [0, 0.09 * h, 0], head: [0, 0.055 * h, 0],
  };
  for (const s of SIDES) {
    const x = s === 'left' ? 1 : -1;
    Object.assign(o, {
      [`${s}Shoulder`]: [0.02 * h * x, 0.06 * h, 0], [`${s}UpperArm`]: [0.065 * h * x, 0, 0],
      [`${s}LowerArm`]: [ua * x, 0, 0], [`${s}Hand`]: [la * x, 0, 0],
      [`${s}UpperLeg`]: [0.055 * h * x, -0.03 * h, 0], [`${s}LowerLeg`]: [0, -ul, 0], [`${s}Foot`]: [0, -ll, 0],
      [`${s}Toes`]: [0, -ankle * 0.8, 0.09 * h],
    });
    const fx = (dx, dy, dz) => [dx * h * x, dy * h, dz * h];
    o[`${s}ThumbMetacarpal`] = fx(0.012, -0.004, 0.014); o[`${s}ThumbProximal`] = fx(0.018, 0, 0.012); o[`${s}ThumbDistal`] = fx(0.017, 0, 0.008);
    const zs = { Index: 0.014, Middle: 0.004, Ring: -0.006, Little: -0.015 };
    for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
      o[`${s}${f}Proximal`] = fx(0.055, 0, zs[f]); o[`${s}${f}Intermediate`] = fx(0.024, 0, 0); o[`${s}${f}Distal`] = fx(0.017, 0, 0);
    }
  }
  return o;
}

/**
 * The hero's rest skeleton. Sources, in order of preference:
 *   vrm (a three-vrm VRM: exact normalized rest pose; VRM0 is converted to the VRM1 convention),
 *   info.restPose (a VRMPose like vrm.humanoid.normalizedRestPose, plus info.vrm0 if it is a VRM0 model),
 *   info {height, hipHeight, upperArm, lowerArm, upperLeg, lowerLeg} on top of canonical proportions.
 */
export class HeroRig {
  constructor({ vrm = null, info = {} } = {}) {
    let rest = null, flip = false;
    if (vrm?.humanoid) { rest = vrm.humanoid.normalizedRestPose; flip = vrm.meta?.metaVersion === '0'; }
    else if (info.restPose) { rest = info.restPose; flip = !!info.vrm0; }
    const offsets = {};
    if (rest) {
      for (const b of ALL_BONES) {
        const p = rest[b]?.position;
        if (p) offsets[b] = new THREE.Vector3(flip ? -p[0] : p[0], p[1], flip ? -p[2] : p[2]);
      }
      this.source = vrm ? 'vrm' : 'info.restPose';
    } else {
      const h = info.height ?? 1.6;
      for (const [b, v] of Object.entries(canonicalOffsets(h, info))) offsets[b] = new THREE.Vector3(...v);
      this.source = 'canonical';
    }
    this.present = new Set(Object.keys(offsets));
    this.bones = ALL_BONES.filter((b) => this.present.has(b));
    // parent among present bones (e.g. neck -> chest when the model has no upperChest)
    this.parent = {};
    for (const b of this.bones) {
      let p = VRM_PARENT[b];
      while (p && !this.present.has(p)) p = VRM_PARENT[p];
      this.parent[b] = p ?? null;
    }
    // offsets are relative to the *VRM* parent; re-express relative to the present parent
    this.offset = {};
    this.restWorld = {};
    const worldOf = (b) => {
      if (this.restWorld[b]) return this.restWorld[b];
      let p = VRM_PARENT[b];
      const w = offsets[b].clone();
      // walk the full VRM chain (missing intermediate bones contribute nothing)
      while (p && !this.present.has(p)) p = VRM_PARENT[p];
      if (p) w.add(worldOf(p));
      return (this.restWorld[b] = w);
    };
    for (const b of this.bones) worldOf(b);
    for (const b of this.bones) {
      const p = this.parent[b];
      this.offset[b] = p ? this.restWorld[b].clone().sub(this.restWorld[p]) : this.restWorld[b].clone();
    }
    const W = this.restWorld, len = (a, b) => (W[a] && W[b] ? W[a].distanceTo(W[b]) : 0);
    this.hipHeight = W.hips.y;
    this.height = info.height ?? (W.head ? W.head.y + 0.12 * (W.head.y / 1.4) : 1.6);
    this.arm = {}; this.leg = {};
    for (const s of SIDES) {
      this.arm[s] = [len(`${s}UpperArm`, `${s}LowerArm`), len(`${s}LowerArm`, `${s}Hand`)];
      this.leg[s] = [len(`${s}UpperLeg`, `${s}LowerLeg`), len(`${s}LowerLeg`, `${s}Foot`)];
    }
    this.ankleHeight = W.leftFoot ? W.leftFoot.y : 0.08;
    this.toeHeight = W.leftToes ? W.leftToes.y : 0.03;
  }

  /** Rest direction (unit, hero space) from bone b to its child c. */
  restDir(b, c) { return this.restWorld[c].clone().sub(this.restWorld[b]).normalize(); }

  /**
   * Forward kinematics of the hero: local rotations {bone: Quaternion} + hips position -> world rotations and
   * positions in hero root space. Missing locals are identity.
   */
  fk(locals, hipsPos, out = { rot: {}, pos: {} }) {
    for (const b of this.bones) {
      const p = this.parent[b];
      const q = out.rot[b] ?? (out.rot[b] = new THREE.Quaternion());
      const x = out.pos[b] ?? (out.pos[b] = new THREE.Vector3());
      const l = locals[b];
      if (!p) { if (l) q.copy(l); else q.identity(); x.copy(hipsPos); continue; }
      q.copy(out.rot[p]); if (l) q.multiply(l);
      x.copy(this.offset[b]).applyQuaternion(out.rot[p]).add(out.pos[p]);
    }
    return out;
  }
}
