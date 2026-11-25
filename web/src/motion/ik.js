// IK + contacts, in hero root space after the tracked/procedural pose is blended:
//   twoBoneIK          analytic hip-knee-ankle / shoulder-elbow-wrist (Holden "Simple Two Joint IK"), pole =
//                      the current mid joint so IK only corrects reach, never style
//   FootContact        contact = foot low (height above the calibrated floor) AND slow (horizontal speed),
//                      majority-filtered; forced off during jumps
//   FootLock           world-space foot lock with inertialized lock/unlock (cubic offset decay), release on
//                      drift; output = IK target for the ankle
import * as THREE from 'three';
import { clamp, smoothstep, frameQuat, twistOf, quatLog, quatExp } from './math.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const acosC = (x) => Math.acos(clamp(x, -1, 1));

/**
 * Two-bone IK. a, b, c: current world positions of root/mid/end; aRot, bRot: their world rotations (modified
 * in place); target: desired end position. `soft` softens the last bit of extension (fraction of chain length).
 * Returns the reach ratio actually achieved.
 */
export function twoBoneIK(a, b, c, aRot, bRot, target, soft = 0.02) {
  const lab = _a.copy(b).sub(a).length(), lcb = _b.copy(b).sub(c).length();
  const L = lab + lcb;
  let lat = _c.copy(target).sub(a).length();
  // soft clamp near full extension (avoids the hyper-extension snap)
  const ds = L * soft, dsoft = L - ds;
  if (lat > dsoft) lat = dsoft + ds * (1 - Math.exp(-(lat - dsoft) / ds));
  lat = clamp(lat, 1e-4, L - 1e-5);
  const ca = _a.copy(c).sub(a).normalize(), ba = _b.copy(b).sub(a).normalize();
  const ab_bc = _d.copy(a).sub(b).normalize();
  const cb = new THREE.Vector3().copy(c).sub(b).normalize();
  const ta = new THREE.Vector3().copy(target).sub(a).normalize();
  const ac_ab_0 = acosC(ca.dot(ba));
  const ba_bc_0 = acosC(ab_bc.dot(cb));
  const ac_at_0 = acosC(ca.dot(ta));
  const ac_ab_1 = acosC((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat));
  const ba_bc_1 = acosC((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb));
  const axis0 = new THREE.Vector3().crossVectors(ca, ba);
  if (axis0.lengthSq() < 1e-10) return lat / L;        // fully straight with no pole info: leave as is
  axis0.normalize();
  const axis1 = new THREE.Vector3().crossVectors(ca, ta);
  _q0.setFromAxisAngle(axis0, ac_ab_1 - ac_ab_0);
  _q1.setFromAxisAngle(axis0, ba_bc_1 - ba_bc_0);
  if (axis1.lengthSq() > 1e-10) _q2.setFromAxisAngle(axis1.normalize(), ac_at_0); else _q2.identity();
  // world: a' = r2 r0 a ; b' = r2 r0 r1 b
  const r20 = _q2.clone().multiply(_q0);
  aRot.premultiply(r20);
  bRot.premultiply(_q1).premultiply(r20);
  return lat / L;
}

export class FootContact {
  constructor({ height = 0.07, speed = 0.35, window = 5 } = {}) {
    this.height = height; this.speed = speed; this.window = window;
    this.hist = []; this.contact = true; this.prev = null; this.v = 0;
    this.lastHeight = 0;
  }
  /** p: lowest foot point (heel/toe) in floor frame (y = height above floor, metres player scale), t ms */
  push(p, t, forceOff = false) {
    // horizontal speed over a ~150 ms baseline (per-frame keypoint noise, especially monocular depth, would
    // otherwise read as 0.3-0.5 m/s on a planted foot); depth (z) is down-weighted
    this.trail = this.trail ?? [];
    this.trail.push({ x: p.x, z: p.z, t });
    while (this.trail.length > 2 && t - this.trail[1].t >= 150) this.trail.shift();
    const o = this.trail[0];
    if (t - o.t > 30) this.v = Math.hypot(p.x - o.x, (p.z - o.z) * 0.5) / ((t - o.t) / 1000);
    this.lastHeight = p.y;
    const raw = !forceOff && p.y < this.height && this.v < this.speed;
    this.hist.push(raw); if (this.hist.length > this.window) this.hist.shift();
    const votes = this.hist.reduce((s, x) => s + (x ? 1 : 0), 0);
    if (forceOff) this.contact = false;
    else if (!this.contact && votes > this.window / 2 && raw) this.contact = true;
    else if (this.contact && votes < this.window / 2) this.contact = false;
    return this.contact;
  }
}

/** Inertialized world-space foot lock. All positions in hero root space. */
export class FootLock {
  constructor({ unlockDistance = 0.22, blendTime = 0.16 } = {}) {
    this.unlockDistance = unlockDistance; this.blendTime = blendTime;
    this.locked = false; this.lockPos = new THREE.Vector3();
    this.offset = new THREE.Vector3(); this.offsetT = 1e9;     // inertialization offset and its age (s)
    this.out = new THREE.Vector3(); this.has = false;
  }
  reset() { this.locked = false; this.has = false; this.offsetT = 1e9; }
  /**
   * input: FK ankle position this frame; contact: bool; floorY: ankle height when planted.
   * Returns the ankle IK target.
   */
  update(input, contact, floorY, dt, reach = null) {
    const prevOut = this.has ? this.out.clone() : input.clone();
    const was = this.locked;
    // a planted foot the leg can no longer reach (even with the pelvis lowered) is released, not dragged
    if (this.locked && reach && reach.hip.distanceTo(this.lockPos) > reach.max) this.locked = false;
    if (contact && !this.locked && (!reach || reach.hip.distanceTo(input) < reach.max * 0.97)) {
      this.locked = true;
      // re-plant on the previous spot after a brief flicker instead of sliding to a new one
      // plant where the foot is DISPLAYED (output incl. any blend offset), so locking never slides the foot
      this.lockPos.copy(prevOut); this.lockPos.y = floorY;
    }
    this.sinceUnlock = this.locked ? 0 : (this.sinceUnlock ?? 1e9) + dt;
    if (this.locked && (!contact || _a.copy(input).sub(this.lockPos).setY(0).length() > this.unlockDistance)) {
      this.locked = false;
    }
    if (this.locked) this.lockPos.y += (floorY - this.lockPos.y) * Math.min(1, dt * 4);  // follow floor refinement
    const raw = (this.locked ? this.lockPos : input).clone();
    // inertialize the discontinuity at a lock/unlock switch: offset = old output - new target, decayed smoothly
    if (this.has && was !== this.locked) { this.offset.copy(prevOut).sub(raw); this.offsetT = 0; }
    this.offsetT += dt;
    this.out.copy(raw).add(this._offset());
    this.has = true;
    return this.out;
  }
  _offset() {
    const t = clamp(this.offsetT / this.blendTime, 0, 1);
    const k = 1 - t * t * (3 - 2 * t);          // smooth cubic decay
    return this.offset.clone().multiplyScalar(k);
  }
}

/** Swing-twist hinge clamp: keep the flexion angle about `axis` within [lo, hi] (radians). */
export function clampHinge(q, axis, lo, hi) {
  // project to the hinge: angle about axis from the twist part
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  let ang = 2 * Math.atan2(d, q.w);
  if (ang > Math.PI) ang -= 2 * Math.PI;
  if (ang < -Math.PI) ang += 2 * Math.PI;
  if (ang >= lo && ang <= hi) return q;
  const swing = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, -ang));
  return q.copy(swing.multiply(new THREE.Quaternion().setFromAxisAngle(axis, clamp(ang, lo, hi))));
}

/**
 * Pole-vector IK for a hinge limb (hip-knee-ankle): places the mid joint in the plane spanned by root->target
 * and `pole` (the knee/elbow facing direction), then builds both bone frames from (bone direction, facing).
 * Because both frames share that plane, the mid joint bends purely about its hinge axis (the knee can never
 * bend sideways, whatever twist the input had). restInvA/restInvB = inverse rest frames (frameQuat(rest bone
 * dir, rest facing)^-1). Writes world rotations into outA/outB; returns the reach ratio.
 */
const _n = new THREE.Vector3(), _u1 = new THREE.Vector3(), _u2 = new THREE.Vector3(), _k = new THREE.Vector3(), _dd = new THREE.Vector3();
export function poleIK(a, l1, l2, target, pole, restInvA, restInvB, outA, outB, soft = 0.03) {
  const L = l1 + l2;
  _dd.copy(target).sub(a);
  let lat = _dd.length();
  const ds = L * soft, dsoft = L - ds;
  if (lat > dsoft) lat = dsoft + ds * (1 - Math.exp(-(lat - dsoft) / ds));
  lat = clamp(lat, Math.abs(l1 - l2) + 1e-4, L - 1e-5);
  _dd.normalize();
  _n.copy(pole).addScaledVector(_dd, -pole.dot(_dd));
  if (_n.lengthSq() < 1e-8) _n.set(0, 0, 1).addScaledVector(_dd, -_dd.z);
  _n.normalize();
  const cosA = clamp((l1 * l1 + lat * lat - l2 * l2) / (2 * l1 * lat), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
  _u1.copy(_dd).multiplyScalar(cosA).addScaledVector(_n, sinA);                 // root -> mid
  _k.copy(a).addScaledVector(_u1, l1);                                           // mid joint
  _u2.copy(a).addScaledVector(_dd, lat).sub(_k).normalize();                     // mid -> end
  frameQuat(_u1, _n, outA).multiply(restInvA);
  frameQuat(_u2, _n, outB).multiply(restInvB);
  return lat / L;
}

/**
 * Wrist limits on a hand LOCAL rotation (relative to the forearm), VRM1 frame: the forearm runs along +X (left)
 * / -X (right) and the palm faces -Y in the rest pose, so flexion/extension is the swing about Z and radial/ulnar
 * deviation the swing about Y. Clamps flexion/extension to +-flex and deviation to +-dev (elliptical), keeps the
 * twist (pronation, handled by the forearm split). `straighten` 0..1 blends the swing toward a straight wrist.
 */
const _tw = new THREE.Quaternion(), _sw = new THREE.Quaternion(), _rv = new THREE.Vector3();
export function clampWrist(q, side, flex = 0.785, dev = 0.52, straighten = 0) {
  const ax = side === 'left' ? _AXL : _AXR;
  twistOf(q, ax, _tw);
  _sw.copy(_tw).invert().premultiply(q);                       // q = swing * twist
  quatLog(_sw, _rv);
  _rv.x = 0;                                                   // (numerical) no swing about the bone axis
  const e = Math.hypot(_rv.z / flex, _rv.y / dev);
  if (e > 1) _rv.multiplyScalar(1 / e);
  if (straighten > 0) _rv.multiplyScalar(1 - clamp(straighten, 0, 1));
  quatExp(_rv, _sw);
  return q.copy(_sw).multiply(_tw);
}
const _AXL = new THREE.Vector3(1, 0, 0), _AXR = new THREE.Vector3(-1, 0, 0);

export { smoothstep };
