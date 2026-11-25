// Canonical pose format shared by every tracking source.
//
// A source emits PoseFrame objects:
//   {
//     source: 'hmr' | 'mediapipe' | 'synthetic',
//     tCapture: ms (performance.now timebase) when the camera frame was captured,
//     joints: { [name]: THREE.Vector3 }   metres, three.js axes (x = camera right, y up, z toward camera),
//                                         absolute when the source knows depth (InstantHMR), hip-centred otherwise
//     conf:   { [name]: 0..1 }
//     kp2d:   [{ x, y, c }]  normalised 0..1 image coords for the overlay, plus `edges` [[a,b]]
//     timing: { ...ms }      per-stage timings reported by the source
//   }
//
// Joint names are from the PERSON's point of view (leftWrist = the person's left wrist).
import * as THREE from 'three';

export const JOINTS = [
  'nose', 'leftEar', 'rightEar', 'neck',
  'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
  'leftHand', 'rightHand',
  'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle',
  'leftToe', 'rightToe', 'leftHeel', 'rightHeel',
];

const SWAP = {};
for (const j of JOINTS) {
  if (j.startsWith('left')) SWAP[j] = 'right' + j.slice(4);
  else if (j.startsWith('right')) SWAP[j] = 'left' + j.slice(5);
  else SWAP[j] = j;
}

/** Mirror a pose (x → -x, left ↔ right) so the avatar behaves like a mirror image of the player. */
export function mirrorPose(joints, conf) {
  const mj = {}, mc = {};
  for (const name of Object.keys(joints)) {
    const v = joints[name];
    mj[SWAP[name] ?? name] = new THREE.Vector3(-v.x, v.y, v.z);
    mc[SWAP[name] ?? name] = conf[name];
  }
  return { joints: mj, conf: mc };
}

export function midpoint(a, b) {
  return new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
}

/** Convert a camera-frame point (x right, y down, z forward) to three.js axes. */
export function camToThree(x, y, z) {
  return new THREE.Vector3(x, -y, -z);
}

// ---------------------------------------------------------------------------
// One-euro filter (Casiez et al.) for vectors — low lag on fast moves, low jitter when still.
class LowPass {
  constructor() { this.y = null; }
  filter(x, a) {
    if (this.y === null) this.y = x.clone();
    else this.y.lerp(x, a);
    return this.y;
  }
}

const alpha = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuroVec3 {
  constructor(minCutoff = 1.5, beta = 0.6, dCutoff = 1.0) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = new LowPass(); this.dx = new LowPass();
    this.prev = null; this.tPrev = null;
  }
  filter(v, tMs) {
    if (this.prev === null) {
      this.prev = v.clone(); this.tPrev = tMs;
      this.x.filter(v, 1); this.dx.filter(new THREE.Vector3(), 1);
      return v.clone();
    }
    const dt = Math.max(1e-3, (tMs - this.tPrev) / 1000);
    this.tPrev = tMs;
    const d = v.clone().sub(this.prev).divideScalar(dt);
    this.prev.copy(v);
    const ed = this.dx.filter(d, alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * ed.length();
    return this.x.filter(v, alpha(cutoff, dt)).clone();
  }
}

/** Filters every joint of a pose with its own one-euro filter. strength 0 = raw, 1 = heavy. */
export class PoseFilter {
  constructor() { this.filters = {}; this.strength = 0.35; }
  reset() { this.filters = {}; }
  apply(joints, tMs) {
    if (this.strength <= 0.001) return joints;
    // Map strength to one-euro params: higher strength = lower cutoff, lower beta.
    const minCutoff = THREE.MathUtils.lerp(6.0, 0.4, this.strength);
    const beta = THREE.MathUtils.lerp(2.0, 0.08, this.strength);
    const out = {};
    for (const [name, v] of Object.entries(joints)) {
      let f = this.filters[name];
      if (!f) f = this.filters[name] = new OneEuroVec3(minCutoff, beta);
      f.minCutoff = minCutoff; f.beta = beta;
      out[name] = f.filter(v, tMs);
    }
    return out;
  }
}
