// Jiggle-bone springs + motion filters (WP5). Owner: WP5. Spec 2.12.
//
// MotionTracker: per-frame estimate of a point's linear velocity/acceleration and a frame's angular
//   velocity/acceleration from world transforms, low-passed (EMA, default 60 ms) so 30 Hz tracker
//   steps / jitter don't excite the springs; soft dead-zones remove the residual noise floor.
// JiggleBone: damped rotational spring on a helper bone (rest = identity). Modelled as a pendulum with a
//   lever `r` (bone-local): the inertial force on the lever tip, f = -(a + α×r + ω×(ω×r)) + Δg, gives an
//   angular acceleration (r×f)/|r|² that drives θ'' = gain·(r×f)/|r|² − kθ − dθ'. θ is a rotation vector
//   in the parent frame (== the helper's local frame, rest rotations are identity). Twist about the lever
//   is removed, |θ| is clamped to maxDeg.
// No allocations after construction.

import * as THREE from 'three';

const DEG = Math.PI / 180;
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _f = new THREE.Vector3();
const _t = new THREE.Vector3();
const _g = new THREE.Vector3();
const _p0 = new THREE.Vector3();
const _s0 = new THREE.Vector3();

export const emaAlpha = (dt, tau) => (tau > 0 ? 1 - Math.exp(-dt / tau) : 1);

/** Clamp vector length in place. */
export function clampLen(v, max) {
  const l2 = v.lengthSq();
  if (l2 > max * max) v.multiplyScalar(max / Math.sqrt(l2));
  return v;
}
/** Soft dead-zone: shrinks |v| by `zone` (never flips), so sub-noise inputs map to zero smoothly. */
export function deadZone(v, zone) {
  const l = v.length();
  if (l <= zone) return v.set(0, 0, 0);
  return v.multiplyScalar((l - zone) / l);
}

/**
 * Filtered kinematics of an Object3D: pivot point (its world position) and orientation (`frameObj` world
 * quaternion, defaults to the object's parent). All outputs in WORLD space.
 */
export class MotionTracker {
  constructor({ tauV = 0.06, tauA = 0.04, maxA = 40, maxW = 30, maxAlpha = 400, deadA = 0.6, deadAlpha = 4 } = {}) {
    Object.assign(this, { tauV, tauA, maxA, maxW, maxAlpha, deadA, deadAlpha });
    this.p = new THREE.Vector3(); this.pPrev = new THREE.Vector3();
    this.q = new THREE.Quaternion(); this.qPrev = new THREE.Quaternion();
    this.v = new THREE.Vector3(); this.vPrev = new THREE.Vector3(); this.a = new THREE.Vector3();
    this.w = new THREE.Vector3(); this.wPrev = new THREE.Vector3(); this.alpha = new THREE.Vector3();
    this.aOut = new THREE.Vector3(); this.alphaOut = new THREE.Vector3(); // dead-zoned outputs
    this.valid = false;
    this.jump = 0;       // last frame's raw displacement (m), for teleport detection
    this.turn = 0;       // last frame's raw rotation (rad)
  }
  reset() { this.valid = false; this.v.set(0, 0, 0); this.a.set(0, 0, 0); this.w.set(0, 0, 0); this.alpha.set(0, 0, 0); this.aOut.set(0, 0, 0); this.alphaOut.set(0, 0, 0); }
  /** p: world position, q: world quaternion. */
  update(dt, p, q) {
    if (!this.valid) {
      this.p.copy(p); this.pPrev.copy(p); this.q.copy(q); this.qPrev.copy(q);
      this.valid = true; this.jump = 0; this.turn = 0;
      return this;
    }
    this.pPrev.copy(this.p); this.p.copy(p);
    this.qPrev.copy(this.q); this.q.copy(q);
    this.jump = this.p.distanceTo(this.pPrev);
    if (dt < 1e-5) return this;
    const kV = emaAlpha(dt, this.tauV), kA = emaAlpha(dt, this.tauA);
    // linear
    _v.subVectors(this.p, this.pPrev).divideScalar(dt);
    this.vPrev.copy(this.v);
    this.v.lerp(_v, kV);
    _v.subVectors(this.v, this.vPrev).divideScalar(dt);
    this.a.lerp(_v, kA);
    clampLen(this.a, this.maxA);
    // angular: dq = q * qPrev^-1 (world), as a rotation vector / dt
    _q.copy(this.q).multiply(_qi.copy(this.qPrev).invert());
    if (_q.w < 0) { _q.x = -_q.x; _q.y = -_q.y; _q.z = -_q.z; _q.w = -_q.w; }
    const s = Math.sqrt(_q.x * _q.x + _q.y * _q.y + _q.z * _q.z);
    const ang = 2 * Math.atan2(s, _q.w);
    this.turn = ang;
    if (s > 1e-9) _w.set(_q.x, _q.y, _q.z).multiplyScalar(ang / s / dt); else _w.set(0, 0, 0);
    clampLen(_w, this.maxW);
    this.wPrev.copy(this.w);
    this.w.lerp(_w, kV);
    _w.subVectors(this.w, this.wPrev).divideScalar(dt);
    this.alpha.lerp(_w, kA);
    clampLen(this.alpha, this.maxAlpha);
    deadZone(this.aOut.copy(this.a), this.deadA);
    deadZone(this.alphaOut.copy(this.alpha), this.deadAlpha);
    return this;
  }
}

/**
 * Damped rotational spring on one helper bone.
 * opts: { k, d, maxDeg, lever: [x,y,z] (bone-local, metres), gain, gravityGain, tracker opts }
 */
export class JiggleBone {
  constructor(bone, { k, d, maxDeg, lever, gain = 0.5, gravityGain = 0.1, tracker = {} }) {
    this.bone = bone;
    this.k = k; this.d = d; this.max = maxDeg * DEG; this.gain = gain; this.gGain = gravityGain;
    this.r = new THREE.Vector3(...lever);
    this.rHat = this.r.clone().normalize();
    this.r2 = this.r.lengthSq();
    this.theta = new THREE.Vector3(); this.omega = new THREE.Vector3();
    this.drive = new THREE.Vector3();          // angular accel input (parent-local), held for the frame
    this.tracker = new MotionTracker(tracker);
    this.wp = new THREE.Vector3(); this.wq = new THREE.Quaternion(); this.wqInv = new THREE.Quaternion();
    this.peak = 0;                             // max |θ| since last stats read (deg), for QA
  }
  reset() { this.theta.set(0, 0, 0); this.omega.set(0, 0, 0); this.drive.set(0, 0, 0); this.tracker.reset(); this.bone.quaternion.identity(); }
  /** Per frame (before substeps): read the parent frame + pivot, compute the drive torque. */
  sense(dt) {
    const parent = this.bone.parent;
    this.wp.setFromMatrixPosition(this.bone.matrixWorld);
    // parent matrices are current (hero.update ran root.updateMatrixWorld): decompose instead of
    // getWorldQuaternion, which re-walks the whole parent chain per spring (QA r1 P1-6)
    parent.matrixWorld.decompose(_p0, this.wq, _s0);
    const tr = this.tracker.update(dt, this.wp, this.wq);
    this.wqInv.copy(this.wq).invert();
    // into parent-local
    const a = _v.copy(tr.aOut).applyQuaternion(this.wqInv);
    const w = _w.copy(tr.w).applyQuaternion(this.wqInv);
    const al = _t.copy(tr.alphaOut).applyQuaternion(this.wqInv);
    // inertial force on the lever tip (per unit mass)
    _f.copy(a);
    _g.crossVectors(al, this.r); _f.add(_g);                         // α × r
    _g.crossVectors(w, this.r); _g.crossVectors(w, _g); _f.add(_g);  // ω × (ω × r)
    _f.negate();
    // gravity change relative to rest (rest frame: g = -Y)
    _g.set(0, -9.8, 0).applyQuaternion(this.wqInv); _g.y += 9.8;
    _f.addScaledVector(_g, this.gGain / Math.max(this.gain, 1e-6));
    this.drive.crossVectors(this.r, _f).multiplyScalar(this.gain / this.r2);
  }
  /** One integration substep (semi-implicit Euler). */
  step(h) {
    const th = this.theta, om = this.omega;
    om.x += (this.drive.x - this.k * th.x - this.d * om.x) * h;
    om.y += (this.drive.y - this.k * th.y - this.d * om.y) * h;
    om.z += (this.drive.z - this.k * th.z - this.d * om.z) * h;
    th.addScaledVector(om, h);
    // no twist about the lever
    const rh = this.rHat;
    th.addScaledVector(rh, -th.dot(rh));
    om.addScaledVector(rh, -om.dot(rh));
    // limit
    const l = th.length();
    if (l > this.max) {
      th.multiplyScalar(this.max / l);
      const radial = om.dot(th) / this.max;          // outward speed
      if (radial > 0) om.addScaledVector(th, -radial / this.max);
    }
  }
  /** Write the bone rotation. */
  apply() {
    const th = this.theta, l = th.length();
    if (!(l < 10)) { this.reset(); return; }           // NaN guard
    if (l < 1e-7) this.bone.quaternion.identity();
    else this.bone.quaternion.setFromAxisAngle(_v.copy(th).divideScalar(l), l);
    this.bone.updateMatrixWorld(true);
    const deg = l / DEG;
    if (deg > this.peak) this.peak = deg;
  }
}
