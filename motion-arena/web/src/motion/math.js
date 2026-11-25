// Small quaternion / vector helpers shared by the motion pipeline. All quaternions are THREE.Quaternion (xyzw).
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

export const LN2 = Math.LN2;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** log map: rotation q -> rotation vector (axis * angle), shortest path. */
export function quatLog(q, out = new THREE.Vector3()) {
  let { x, y, z, w } = q;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-9) return out.set(2 * x, 2 * y, 2 * z);
  const a = 2 * Math.atan2(s, w);
  return out.set((x / s) * a, (y / s) * a, (z / s) * a);
}

/** exp map: rotation vector -> quaternion. */
export function quatExp(v, out = new THREE.Quaternion()) {
  const a = v.length();
  if (a < 1e-9) return out.set(v.x / 2, v.y / 2, v.z / 2, 1).normalize();
  const s = Math.sin(a / 2) / a;
  return out.set(v.x * s, v.y * s, v.z * s, Math.cos(a / 2));
}

/** Rotation vector of a * inverse(b) (the world-frame difference). */
export function quatDiff(a, b, out = new THREE.Vector3()) {
  _q.copy(b).invert().premultiply(a);
  return quatLog(_q, out);
}

/** Orthonormal frame quaternion whose x axis is `p` and whose xy-plane contains `s`. */
export function frameQuat(p, s, out = new THREE.Quaternion()) {
  const e1 = new THREE.Vector3().copy(p).normalize();
  const e2 = new THREE.Vector3().copy(s).addScaledVector(e1, -s.dot(e1));
  if (e2.lengthSq() < 1e-10) {
    // degenerate: pick any perpendicular
    if (Math.abs(e1.y) < 0.9) e2.set(0, 1, 0); else e2.set(1, 0, 0);
    e2.addScaledVector(e1, -e2.dot(e1));
  }
  e2.normalize();
  const e3 = new THREE.Vector3().crossVectors(e1, e2);
  _m.makeBasis(e1, e2, e3);
  return out.setFromRotationMatrix(_m);
}

/** Twist part of q about unit `axis` (swing-twist decomposition, q = swing * twist). */
export function twistOf(q, axis, out = new THREE.Quaternion()) {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  out.set(axis.x * d, axis.y * d, axis.z * d, q.w);
  if (out.length() < 1e-9) return out.identity();
  return out.normalize();
}

/** Fractional power of a rotation (slerp from identity). */
export function quatPow(q, t, out = new THREE.Quaternion()) {
  return out.identity().slerp(q, t);
}

/** Mirror a world rotation across the YZ plane (x -> -x). */
export function mirrorQuat(q, out = q) { return out.set(q.x, -q.y, -q.z, q.w); }

/** Shortest-arc rotation taking unit a to unit b. */
export function fromTo(a, b, out = new THREE.Quaternion()) {
  return out.setFromUnitVectors(_v.copy(a).normalize(), new THREE.Vector3().copy(b).normalize());
}

export function halflifeToDamping(hl) { return (4 * LN2) / (hl + 1e-5); }

/**
 * Critically damped spring with a moving goal ("tracking spring", Holden): state x/v follow goal g with goal
 * velocity gv, exact for any dt. The error is taken against the goal's position at the start of the step and
 * the goal is assumed to move linearly over dt, so a goal moving at constant velocity is tracked with zero lag;
 * only discontinuities (new tracker samples) are smoothed. Quaternions use rotation vectors (QuatSpring).
 */
export class VecSpring {
  constructor() { this.x = new THREE.Vector3(); this.v = new THREE.Vector3(); this.init = false; }
  reset(x) { this.x.copy(x); this.v.set(0, 0, 0); this.init = true; }
  update(g, gv, halflife, dt) {
    if (!this.init) { this.reset(g); this.v.copy(gv); return this.x; }
    const y = halflifeToDamping(halflife) / 2;
    // error relative to where the moving goal was at the start of the step (g - gv dt): no lag on a ramp
    const j0 = _v.copy(this.x).sub(g).addScaledVector(gv, dt);
    const j1 = new THREE.Vector3().copy(this.v).sub(gv).addScaledVector(j0, y);
    const e = Math.exp(-y * dt);
    this.x.copy(j0).addScaledVector(j1, dt).multiplyScalar(e).add(g);
    this.v.sub(gv).addScaledVector(j1, -y * dt).multiplyScalar(e).add(gv);
    return this.x;
  }
}

export class QuatSpring {
  constructor() { this.q = new THREE.Quaternion(); this.v = new THREE.Vector3(); this.init = false; }
  reset(q) { this.q.copy(q); this.v.set(0, 0, 0); this.init = true; }
  update(goal, gv, halflife, dt) {
    if (!this.init) { this.reset(goal); this.v.copy(gv); return this.q; }
    const y = halflifeToDamping(halflife) / 2;
    const goalPrev = quatExp(new THREE.Vector3().copy(gv).multiplyScalar(-dt)).multiply(goal);
    const j0 = quatDiff(this.q, goalPrev, new THREE.Vector3());
    const j1 = new THREE.Vector3().copy(this.v).sub(gv).addScaledVector(j0, y);
    const e = Math.exp(-y * dt);
    const d = j0.addScaledVector(j1, dt).multiplyScalar(e);
    this.v.sub(gv).addScaledVector(j1, -y * dt).multiplyScalar(e).add(gv);
    quatExp(d, this.q).multiply(goal).normalize();
    return this.q;
  }
}

/** One-euro filter on a Vector3 (only used for the root depth axis and the action stream). */
export class OneEuro3 {
  constructor(minCutoff = 1, beta = 0.5, dCutoff = 1) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.x = null; this.dx = new THREE.Vector3(); this.t = 0;
  }
  reset() { this.x = null; }
  filter(v, tMs) {
    if (!this.x) { this.x = v.clone(); this.dx.set(0, 0, 0); this.t = tMs; return this.x.clone(); }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000); this.t = tMs;
    const a = (c) => 1 / (1 + 1 / (2 * Math.PI * c * dt));
    const d = v.clone().sub(this.x).divideScalar(dt);
    this.dx.lerp(d, a(this.dCutoff));
    this.x.lerp(v, a(this.minCutoff + this.beta * this.dx.length()));
    return this.x.clone();
  }
}

/** Ring buffer statistics helper. */
export class Window {
  constructor(n = 120) { this.n = n; this.a = []; }
  push(x) { this.a.push(x); if (this.a.length > this.n) this.a.shift(); }
  get mean() { return this.a.length ? this.a.reduce((s, x) => s + x, 0) / this.a.length : 0; }
  get rms() { return this.a.length ? Math.sqrt(this.a.reduce((s, x) => s + x * x, 0) / this.a.length) : 0; }
  pct(p) { if (!this.a.length) return 0; const s = [...this.a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
  clear() { this.a.length = 0; }
}
