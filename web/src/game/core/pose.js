// Short procedural pose accents laid OVER the motion pipeline's output (QA r3 art P2-1).
//
// The motion pipeline has no "push" accent (its Accents cover punches, kicks, jump and land), and under the autoplay /
// demo players (any showcase stand without a camera) the tracked pose is a guard stance while the Breaklight fires, so
// the beam had no source. PoseOverlay.push() blends both arms into a two-hand palm push for ~0.9 s:
//   game.poseOverlay.update(dt, hero)   // every frame AFTER motion.update(), before hero.update()
// It reads the pose the pipeline just applied (hero.getHumanoidPose-style proxies), slerps the arm chain toward the
// push target by the envelope weight and writes it back with hero.applyHumanoidPose (which also feeds the replay
// recorder, so the replay shows the push too). Bones are VRM-normalized: identity = T-pose, the hero faces +Z, its
// left arm points +X.
import * as THREE from 'three';

const E = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'YXZ'));
const D = THREE.MathUtils.degToRad;

/** Push target (local rotations): arms forward at chest height, hands converging, elbows nearly straight, wrists bent
 *  back so the palms face the target. */
function pushTarget() {
  const qz = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);
  const qy = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
  return {
    leftShoulder: new THREE.Quaternion(), rightShoulder: new THREE.Quaternion(),
    // T-pose arm (+X / -X) tilted 12 deg down, then swung 94 deg forward (a little inward: the hands meet in front)
    leftUpperArm: qy(D(-94)).multiply(qz(D(-12))),
    rightUpperArm: qy(D(94)).multiply(qz(D(12))),
    leftLowerArm: qy(D(-8)), rightLowerArm: qy(D(8)),
    leftHand: qz(D(72)), rightHand: qz(D(-72)),
    spine: E(D(4), 0, 0), chest: E(D(5), 0, 0),
  };
}
/** Open palms: every finger bone straight (identity). */
const FINGERS = [];
for (const side of ['left', 'right']) for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) for (const j of (f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'])) FINGERS.push(side + f + j);

export class PoseOverlay {
  constructor() {
    this.target = pushTarget();
    for (const f of FINGERS) this.target[f] = new THREE.Quaternion();
    this._cache = {};
    this.t = -1; this.dur = 0;
    this.enabled = true;
    this._rot = {};
  }
  /** Start (or restart) the two-hand push; timing { in, hold, out } in seconds. */
  push({ in: tin = 0.09, hold = 0.5, out = 0.35 } = {}) {
    // already pushing: keep the hold going instead of snapping back through the blend-in
    if (this.active && this.t > tin) this.t = tin;
    else this.t = 0;
    this.env = { tin, hold, out };
    this.dur = tin + hold + out;
  }
  cancel() { this.t = -1; }
  get active() { return this.t >= 0 && this.t < this.dur; }
  get weight() {
    if (!this.active) return 0;
    const { tin, hold, out } = this.env, t = this.t;
    const s = (x) => x * x * (3 - 2 * x);
    if (t < tin) return s(t / tin);
    if (t < tin + hold) return 1;
    return 1 - s(Math.min(1, (t - tin - hold) / out));
  }
  /** Per frame, after the motion pipeline applied its pose. */
  update(dt, hero) {
    if (this.t < 0) return;
    this.t += dt;
    if (!this.active) { this.t = -1; return; }
    const w = this.weight;
    if (!this.enabled || w <= 0 || !hero?.proxies || !hero.applyHumanoidPose) return;
    const rot = this._rot;
    for (const k in rot) delete rot[k];
    for (const name in this.target) {
      const p = hero.proxies[name];
      if (!p) continue;
      rot[name] = (this._cache[name] ??= new THREE.Quaternion()).copy(p.quaternion).slerp(this.target[name], w);
    }
    try { hero.applyHumanoidPose({ rotations: rot }); } catch { /* */ }
  }
}
