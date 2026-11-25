// Position-based verlet rope/ribbon chain with kinematic colliders (WP5). Owner: WP5. Spec 2.12.
//
// Chain: n particles, particle 0 pinned to an anchor (hips-local rest point), distance + bend constraints,
//   per-particle rest-shape spring (hips-rigid drape, strong near the knot, ~free at the tip), gravity, wind,
//   Optional `knot` (Object3D child of the anchor, e.g. the costume's sash knot that blends hips/HipHelper and
//   slides around the band): its current hips-local transform relative to its rest transform re-places the rest
//   targets, fully at the root (particle 0 = knot-driven pin) fading per particle by `knotW`.
//   damping RELATIVE to the anchor velocity (+ a little air drag) so the tail doesn't stream behind a steadily
//   moving body. Velocities are clamped relative to the anchor; NaN -> reset. World space.
//   Rigid carry (QA r2 P1-4): `carry` limits ({ anchorLin m/s, anchorAng rad/s, knotLin, knotAng }) bound how fast the
//   anchor / knot may move per frame as far as the simulation is concerned; the excess of a snap (pose preset change,
//   tracker pop, knot slide) moves the particles rigidly with the anchor / knot (knot share per particle = knotW) and
//   the previous-frame kinematic state is advanced by the same fraction, so the remaining motion is plausible and the
//   rest-shape frame never jumps. `maxRelFrame` (set by the owner each frame) overrides maxRelSpeed for that frame.
// Colliders: capsules (tapered), ellipsoids, tori, all bone-attached. Each frame `capture()` snapshots their
//   world placement; per substep they are interpolated between the previous and current frame so fast limbs
//   sweep through the substeps instead of teleporting (no tunnelling at 120 Hz).
// Floor (QA r3 P0-1): `floorY` (world, set by the owner each frame; -Infinity = none) + `o.floorClear`: after every
//   constraint iteration particles are kept at y >= floorY + floorClear, and on the last iteration a Coulomb-style
//   tangential friction (static muS, kinetic muK, relative to the substep start) makes the tail fold / bend onto the
//   floor instead of sliding. `floorPen` = deepest floor correction of the last substep (QA).
// Alternate drape (QA r3 P0-1): `alt` (world targets, n*3) blended into the rest targets by `altW` (0..1, owner sets it
//   per frame, e.g. drape over the knot-side thigh in deep hip flexion); `altK` raises the rest-shape stiffness and
//   `ceilLift` relaxes the knot ceiling by the same weight so the tail can lie over a thigh that rises above the knot.
// No allocations after construction.

import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

// ------------------------------------------------------------------------------------------- colliders
/** World-space snapshot buffer of a bone-attached collider: prev + cur, interpolated per substep. */
class Collider {
  constructor(def, bone) {
    this.type = def.type; this.bone = bone; this.def = def;
    // local definition
    if (def.type === 'capsule') { this.la = new THREE.Vector3(...def.a); this.lb = new THREE.Vector3(...def.b); this.r0 = def.r0; this.r1 = def.r1; }
    if (def.type === 'ellipsoid') { this.lc = new THREE.Vector3(...def.center); this.radii = new THREE.Vector3(...def.radii); }
    if (def.type === 'torus') { this.lc = new THREE.Vector3(...def.center); this.ringR = def.ringR; this.tubeR = def.tubeR; }
    // world snapshots [prev, cur] and the per-substep interpolated value
    const V = () => [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this.A = V(); this.B = V();      // capsule a/b, or centre (A) and axis/X (B)
    this.Y = V(); this.Z = V();      // ellipsoid axes Y/Z; torus uses B as axis
    this.scale = 1;
    this.motion = 0;                 // max point displacement this frame (m)
  }
  capture(first) {
    const mw = this.bone.matrixWorld;
    const e = mw.elements;
    this.scale = Math.hypot(e[0], e[1], e[2]);
    const A = this.A, B = this.B, Y = this.Y, Z = this.Z, s = this.scale;
    A[0].copy(A[1]); B[0].copy(B[1]); Y[0].copy(Y[1]); Z[0].copy(Z[1]);
    if (this.type === 'capsule') {
      A[1].copy(this.la).applyMatrix4(mw);
      B[1].copy(this.lb).applyMatrix4(mw);
    } else {
      A[1].copy(this.lc).applyMatrix4(mw);
      B[1].set(e[0] / s, e[1] / s, e[2] / s);      // local X axis
      Y[1].set(e[4] / s, e[5] / s, e[6] / s);      // local Y axis (torus axis)
      Z[1].set(e[8] / s, e[9] / s, e[10] / s);
    }
    if (first) { A[0].copy(A[1]); B[0].copy(B[1]); Y[0].copy(Y[1]); Z[0].copy(Z[1]); }
    this.motion = this.type === 'capsule'
      ? Math.max(A[0].distanceTo(A[1]), B[0].distanceTo(B[1]))
      : A[0].distanceTo(A[1]) + Y[0].distanceTo(Y[1]) * 0.15;
  }
  /** Conservative world AABB over the prev + cur frame placement (inflated by m). Writes into box (6 floats). */
  bounds(m, box) {
    const s = this.scale;
    let r;
    if (this.type === 'capsule') r = Math.max(this.r0, this.r1) * s;
    else if (this.type === 'ellipsoid') r = Math.max(this.radii.x, this.radii.y, this.radii.z) * s;
    else r = (this.ringR + this.tubeR) * s;
    r += m;
    const A = this.A, B = this.B;
    let x0 = Math.min(A[0].x, A[1].x), y0 = Math.min(A[0].y, A[1].y), z0 = Math.min(A[0].z, A[1].z);
    let x1 = Math.max(A[0].x, A[1].x), y1 = Math.max(A[0].y, A[1].y), z1 = Math.max(A[0].z, A[1].z);
    if (this.type === 'capsule') {
      x0 = Math.min(x0, B[0].x, B[1].x); y0 = Math.min(y0, B[0].y, B[1].y); z0 = Math.min(z0, B[0].z, B[1].z);
      x1 = Math.max(x1, B[0].x, B[1].x); y1 = Math.max(y1, B[0].y, B[1].y); z1 = Math.max(z1, B[0].z, B[1].z);
    }
    box[0] = x0 - r; box[1] = y0 - r; box[2] = z0 - r; box[3] = x1 + r; box[4] = y1 + r; box[5] = z1 + r;
    return box;
  }
  /** Forget the previous placement (teleport): no sweep this frame. */
  settle() {
    this.A[0].copy(this.A[1]); this.B[0].copy(this.B[1]); this.Y[0].copy(this.Y[1]); this.Z[0].copy(this.Z[1]);
  }
  /** Interpolate prev→cur at t into slot 2. */
  at(t) {
    this.A[2].lerpVectors(this.A[0], this.A[1], t);
    this.B[2].lerpVectors(this.B[0], this.B[1], t);
    if (this.type !== 'capsule') {
      this.Y[2].lerpVectors(this.Y[0], this.Y[1], t);
      this.Z[2].lerpVectors(this.Z[0], this.Z[1], t);
    }
  }
  /**
   * Signed distance (to the inflated surface, margin m) of point (x,y,z) using slot 2; writes the outward
   * normal into `n` and returns the distance. Pushing by -d along n resolves a penetration.
   */
  sdf(x, y, z, m, n) {
    const s = this.scale;
    if (this.type === 'capsule') {
      const a = this.A[2], b = this.B[2];
      const bx = b.x - a.x, by = b.y - a.y, bz = b.z - a.z;
      const px = x - a.x, py = y - a.y, pz = z - a.z;
      const l2 = bx * bx + by * by + bz * bz;
      let t = l2 > 1e-12 ? (px * bx + py * by + pz * bz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = px - bx * t, dy = py - by * t, dz = pz - bz * t;
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const r = (this.r0 + (this.r1 - this.r0) * t) * s + m;
      if (dl > 1e-9) n.set(dx / dl, dy / dl, dz / dl); else n.set(0, 0, 1);
      return dl - r;
    }
    if (this.type === 'ellipsoid') {
      const c = this.A[2], R = this.radii;
      const px = x - c.x, py = y - c.y, pz = z - c.z;
      const X = this.B[2], Y = this.Y[2], Z = this.Z[2];
      const rx = R.x * s + m, ry = R.y * s + m, rz = R.z * s + m;
      const ux = (px * X.x + py * X.y + pz * X.z) / rx;
      const uy = (px * Y.x + py * Y.y + pz * Y.z) / ry;
      const uz = (px * Z.x + py * Z.y + pz * Z.z) / rz;
      const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
      if (ul < 1e-9) { n.copy(Z); return -Math.min(rx, ry, rz); }
      // radial projection in scaled space (approximate distance, exact surface point on the ray)
      const k = 1 / ul;
      const sx = ux * k * rx, sy = uy * k * ry, sz = uz * k * rz;   // surface point, local
      const wx = X.x * sx + Y.x * sy + Z.x * sz, wy = X.y * sx + Y.y * sy + Z.y * sz, wz = X.z * sx + Y.z * sy + Z.z * sz;
      const ex = px - wx, ey = py - wy, ez = pz - wz;
      const el = Math.sqrt(ex * ex + ey * ey + ez * ez);
      // gradient direction for the normal
      const gx = ux / rx, gy = uy / ry, gz = uz / rz;
      n.set(X.x * gx + Y.x * gy + Z.x * gz, X.y * gx + Y.y * gy + Z.y * gz, X.z * gx + Y.z * gy + Z.z * gz).normalize();
      return ul < 1 ? -el : el;
    }
    // torus about local Y
    const c = this.A[2], ax = this.Y[2];
    const px = x - c.x, py = y - c.y, pz = z - c.z;
    const h = px * ax.x + py * ax.y + pz * ax.z;
    let qx = px - ax.x * h, qy = py - ax.y * h, qz = pz - ax.z * h;
    const ql = Math.sqrt(qx * qx + qy * qy + qz * qz);
    if (ql > 1e-9) { qx /= ql; qy /= ql; qz /= ql; } else { qx = this.Z[2].x; qy = this.Z[2].y; qz = this.Z[2].z; }
    const R = this.ringR * s;
    const rx = px - qx * R, ry = py - qy * R, rz = pz - qz * R;          // from ring centre-line
    const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (rl > 1e-9) n.set(rx / rl, ry / rl, rz / rl); else n.set(qx, qy, qz);
    return rl - (this.tubeR * s + m);
  }
}

export function createColliders(defs, rig) {
  const out = [];
  for (const d of defs) {
    const bone = rig.all[d.bone];
    if (bone) out.push(new Collider(d, bone));
  }
  return out;
}

// ------------------------------------------------------------------------------------------- chain
/**
 * opts: {
 *   restLocal: Vector3[] (anchor-bone-local rest points, [0] = pinned root), anchor: Object3D,
 *   gravity, damping (per 1/60 s, relative to anchor), airDrag, stiffness (distance), bend,
 *   shapeK: number[] per particle (1/s², rest-shape spring), margin (collision inflation),
 *   maxRelSpeed, wind, windPhase, ceiling (knot clearance, m)
 * }
 */
export class VerletChain {
  constructor(opts) {
    const n = opts.restLocal.length;
    this.n = n;
    this.o = opts;
    this.anchor = opts.anchor;
    this.rest = new Float32Array(n * 3);
    opts.restLocal.forEach((p, i) => { this.rest[i * 3] = p.x; this.rest[i * 3 + 1] = p.y; this.rest[i * 3 + 2] = p.z; });
    this.x = new Float32Array(n * 3);       // positions (world)
    this.v = new Float32Array(n * 3);       // velocities
    this.x0 = new Float32Array(n * 3);      // start-of-substep positions
    this.tw = new Float32Array(n * 3);      // rest targets (world), current substep
    this.len = new Float32Array(n - 1);     // rest lengths (local units)
    this.len2 = new Float32Array(Math.max(0, n - 2));
    for (let i = 0; i < n - 1; i++) this.len[i] = opts.restLocal[i].distanceTo(opts.restLocal[i + 1]);
    for (let i = 0; i < n - 2; i++) this.len2[i] = opts.restLocal[i].distanceTo(opts.restLocal[i + 2]);
    // contact info for the ribbon (outward normal + distance to the nearest collider), world
    this.cn = new Float32Array(n * 3);
    this.cd = new Float32Array(n).fill(1);
    // anchor transform: prev/cur frame, interpolated per substep
    this.ap = [new THREE.Vector3(), new THREE.Vector3()];
    this.aq = [new THREE.Quaternion(), new THREE.Quaternion()];
    this.as = 1;
    this.aMat = new THREE.Matrix4();
    this.av = new THREE.Vector3();          // filtered anchor velocity (set by the owner)
    this.valid = false;
    this.maxPen = 0;                        // QA: max remaining penetration after the last substep (m)
    this.maxSpeed = 0;                      // max particle speed relative to the anchor, last substep (m/s)
    // broadphase: colliders whose (swept) AABB overlaps the chain's (swept) AABB this frame
    this.active = [];
    this.activeN = 0;
    this._box = new Float32Array(6);
    this.rootPushMax = opts.rootPushMax ?? 0;   // root may slide this far off the knot out of a moving limb (m)
    // knot drive: delta = knot(current, anchor-local) · inverse(knot(rest)); prev/cur, interpolated per substep
    this.knot = opts.knot || null;
    this.kw = new Float32Array(n);
    this.k0inv = new THREE.Matrix4();
    this.kp = [new THREE.Vector3(), new THREE.Vector3()];
    this.kq = [new THREE.Quaternion(), new THREE.Quaternion()];
    this.kMat = new THREE.Matrix4();
    this.carry = opts.carry || null;
    this.maxRelFrame = opts.maxRelSpeed;
    this.lastCarry = 0;                      // QA: rigid-carry fraction applied at the last capture (0 = none)
    this._cA = new THREE.Matrix4(); this._cAi = new THREE.Matrix4(); this._cK = new THREE.Matrix4(); this._cKi = new THREE.Matrix4();
    // floor + alternate drape (see header)
    this.floorY = -Infinity;
    this.floorPen = 0;
    this.alt = new Float32Array(n * 3);
    this.altW = 0;
    this.altK = opts.altK ?? 0;
    this.ceilLift = 0;
    this._cP = new THREE.Vector3(); this._cQ = new THREE.Quaternion(); this._cQ2 = new THREE.Quaternion(); this._cV = new THREE.Vector3();
    if (this.knot) {
      for (let i = 0; i < n; i++) this.kw[i] = opts.knotW ? opts.knotW[i] : (i === 0 ? 1 : 0);
      // rest = the knot's local TRS at construction (the costume only moves it from its first update on); composed
      // from position/quaternion because knot.matrix may not have been refreshed yet
      const k = this.knot;
      this.k0inv.compose(opts.knotRestPosition || k.position, opts.knotRestQuaternion || k.quaternion, _one).invert();
    }
  }

  /** Knot delta (anchor-local) into slot. */
  _readKnot(slot) {
    const k = this.knot;
    _m.compose(k.position, k.quaternion, _one).multiply(this.k0inv);
    _m.decompose(this.kp[slot], this.kq[slot], _s);
  }

  /** World rest targets into tw for the current aMat (+ knot delta at t), blended toward `alt` by altW. */
  _targets(t) {
    this._restTargets(t);
    const w = this.altW;
    if (!(w > 0)) return;
    const tw = this.tw, alt = this.alt;
    for (let j = 3; j < tw.length; j++) tw[j] += (alt[j] - tw[j]) * w;
  }

  _restTargets(t) {
    const n = this.n, tw = this.tw, rest = this.rest, aMat = this.aMat;
    if (!this.knot) {
      for (let i = 0; i < n; i++) {
        _v.set(rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]).applyMatrix4(aMat);
        tw[i * 3] = _v.x; tw[i * 3 + 1] = _v.y; tw[i * 3 + 2] = _v.z;
      }
      return;
    }
    _p.lerpVectors(this.kp[0], this.kp[1], t);
    _q.slerpQuaternions(this.kq[0], this.kq[1], t);
    this.kMat.compose(_p, _q, _one).premultiply(aMat);
    const kw = this.kw, kMat = this.kMat;
    for (let i = 0; i < n; i++) {
      const j = i * 3, w = kw[i];
      _v.set(rest[j], rest[j + 1], rest[j + 2]);
      if (w >= 1) { _v.applyMatrix4(kMat); tw[j] = _v.x; tw[j + 1] = _v.y; tw[j + 2] = _v.z; continue; }
      _p.copy(_v).applyMatrix4(aMat);
      if (w > 0) { _v.applyMatrix4(kMat); _p.x += (_v.x - _p.x) * w; _p.y += (_v.y - _p.y) * w; _p.z += (_v.z - _p.z) * w; }
      tw[j] = _p.x; tw[j + 1] = _p.y; tw[j + 2] = _p.z;
    }
  }

  /** Once per frame after the colliders captured: keep only colliders that can touch the chain. */
  broadphase(colliders, simT) {
    const x = this.x, n = this.n, b = this._box, m = this.o.margin;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      if (x[j] < x0) x0 = x[j]; if (x[j] > x1) x1 = x[j];
      if (x[j + 1] < y0) y0 = x[j + 1]; if (x[j + 1] > y1) y1 = x[j + 1];
      if (x[j + 2] < z0) z0 = x[j + 2]; if (x[j + 2] > z1) z1 = x[j + 2];
    }
    // anchor sweep + particle travel this frame (relative speed + anchor speed) + slack
    const ap = this.ap[1], aq = this.ap[0];
    const travel = (this.maxSpeed + this.av.length()) * simT + aq.distanceTo(ap) + 0.03 + m;
    x0 -= travel; y0 -= travel; z0 -= travel; x1 += travel; y1 += travel; z1 += travel;
    let k = 0;
    for (let c = 0; c < colliders.length; c++) {
      colliders[c].bounds(0, b);
      if (b[0] > x1 || b[3] < x0 || b[1] > y1 || b[4] < y0 || b[2] > z1 || b[5] < z0) continue;
      this.active[k++] = colliders[c];
    }
    this.activeN = k;
  }

  /** Snap to the rest drape at the current anchor transform. */
  reset() {
    this.anchor.matrixWorld.decompose(this.ap[1], this.aq[1], _s);
    this.ap[0].copy(this.ap[1]); this.aq[0].copy(this.aq[1]);
    this.as = _s.x;
    this.aMat.copy(this.anchor.matrixWorld);
    if (this.knot) { this._readKnot(1); this.kp[0].copy(this.kp[1]); this.kq[0].copy(this.kq[1]); }
    this._targets(1);
    this.x.set(this.tw);
    this.x0.set(this.x);
    this._floor(false);
    this.v.fill(0);
    this.valid = true;
  }

  /** Once per frame, before the substeps: snapshot the anchor (dt: frame time, for the rigid-carry limits). */
  capture(dt = 0) {
    if (!this.valid) { this.reset(); return; }
    this.ap[0].copy(this.ap[1]); this.aq[0].copy(this.aq[1]);
    this.anchor.matrixWorld.decompose(this.ap[1], this.aq[1], _s);
    this.as = _s.x;
    if (this.knot) { this.kp[0].copy(this.kp[1]); this.kq[0].copy(this.kq[1]); this._readKnot(1); }
    this.lastCarry = 0;
    if (this.carry && dt > 0) this._carry(dt);
  }

  /** Rigid carry of the implausible part of this frame's anchor / knot motion (see header). */
  _carry(dt) {
    const C = this.carry, ap = this.ap, aq = this.aq, kp = this.kp, kq = this.kq;
    const excess = (d, lim) => (d > lim * dt ? 1 - (lim * dt) / d : 0);
    const fA = Math.max(excess(ap[0].distanceTo(ap[1]), C.anchorLin), excess(aq[0].angleTo(aq[1]), C.anchorAng));
    const fK = this.knot ? Math.max(excess(kp[0].distanceTo(kp[1]) * this.as, C.knotLin), excess(kq[0].angleTo(kq[1]), C.knotAng)) : 0;
    if (fA <= 0 && fK <= 0) return;
    this.lastCarry = Math.max(fA, fK);
    _s.setScalar(this.as);
    this._cAi.compose(ap[0], aq[0], _s).invert();                   // world -> previous anchor-local
    this._cP.lerpVectors(ap[0], ap[1], fA); this._cQ.slerpQuaternions(aq[0], aq[1], fA);
    this._cA.compose(this._cP, this._cQ, _s);                       // carried anchor
    if (this.knot) {
      this._cKi.compose(kp[0], kq[0], _one).invert();
      _p.lerpVectors(kp[0], kp[1], fK); _q.slerpQuaternions(kq[0], kq[1], fK);
      this._cK.compose(_p, _q, _one).multiply(this._cKi);           // knot delta advance (anchor-local)
      kp[0].copy(_p); kq[0].copy(_q);
    }
    const x = this.x, v = this.v, kw = this.kw, n = this.n, V = this._cV;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      _v.set(x[j], x[j + 1], x[j + 2]).applyMatrix4(this._cAi);     // anchor-local
      const w = this.knot ? kw[i] : 0;
      V.copy(_v);
      if (w > 0) { V.applyMatrix4(this._cK); _v.lerp(V, w); }
      _v.applyMatrix4(this._cA);
      x[j] = _v.x; x[j + 1] = _v.y; x[j + 2] = _v.z;
    }
    // velocities turn with the carried anchor rotation
    this._cQ2.copy(aq[0]).invert().premultiply(this._cQ);
    for (let i = 1; i < n; i++) {
      const j = i * 3;
      _v.set(v[j], v[j + 1], v[j + 2]).applyQuaternion(this._cQ2);
      v[j] = _v.x; v[j + 1] = _v.y; v[j + 2] = _v.z;
    }
    ap[0].copy(this._cP); aq[0].copy(this._cQ);
  }

  /** Knot motion this frame (m + 0.5·rad, anchor-local), for the owner's sleep/substep heuristics. */
  knotMotion() {
    return this.knot ? this.kp[0].distanceTo(this.kp[1]) * this.as + this.kq[0].angleTo(this.kq[1]) * 0.5 : 0;
  }

  /** One substep of length h; t = interpolation factor (0..1] of the frame for kinematic inputs. */
  step(h, t, colliders, time) {
    const o = this.o, n = this.n, x = this.x, v = this.v, x0 = this.x0, tw = this.tw;
    // anchor at t
    _p.lerpVectors(this.ap[0], this.ap[1], t);
    _q.slerpQuaternions(this.aq[0], this.aq[1], t);
    _s.setScalar(this.as);
    this.aMat.compose(_p, _q, _s);
    this._targets(t);
    const sc = this.as;
    // forces + damping
    const damp = Math.pow(1 - o.damping, h * 60);
    const air = Math.pow(1 - o.airDrag, h * 60);
    const av = this.av, maxRel = this.maxRelFrame;
    const wind = o.wind;
    const wx = wind * (Math.sin(time * 1.3 + o.windPhase) + 0.5 * Math.sin(time * 2.9 + 1.7 * o.windPhase));
    const wz = wind * 0.5 * Math.sin(time * 0.9 + 0.6 + o.windPhase);
    x0.set(x);
    for (let i = 1; i < n; i++) {
      const j = i * 3, k0 = o.shapeK[i], k = this.altK > k0 ? k0 + (this.altK - k0) * this.altW : k0;
      let vx = v[j] + (wx + k * (tw[j] - x[j])) * h;
      let vy = v[j + 1] + (-o.gravity + k * (tw[j + 1] - x[j + 1])) * h;
      let vz = v[j + 2] + (wz + k * (tw[j + 2] - x[j + 2])) * h;
      // damp relative to the body, then a little absolute air drag
      vx = (av.x + (vx - av.x) * damp) * air; vy = (av.y + (vy - av.y) * damp) * air; vz = (av.z + (vz - av.z) * damp) * air;
      let rx = vx - av.x, ry = vy - av.y, rz = vz - av.z;
      const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (rl > maxRel) { const f = maxRel / rl; rx *= f; ry *= f; rz *= f; vx = av.x + rx; vy = av.y + ry; vz = av.z + rz; }
      v[j] = vx; v[j + 1] = vy; v[j + 2] = vz;
      x[j] += vx * h; x[j + 1] += vy * h; x[j + 2] += vz * h;
    }
    x[0] = tw[0]; x[1] = tw[1]; x[2] = tw[2];
    // constraints
    const iters = o.iterations;
    for (let it = 0; it < iters; it++) {
      this._distance(this.len, 1, o.stiffness, sc);
      if (n > 2) this._distance(this.len2, 2, o.bend, sc);
      this._ceiling();
      this._collide(it === iters - 1);
      this._floor(it === iters - 1);
    }
    // velocities from positions
    const ih = 1 / h;
    let ms = 0;
    for (let i = 1; i < n; i++) {
      const j = i * 3;
      v[j] = (x[j] - x0[j]) * ih; v[j + 1] = (x[j + 1] - x0[j + 1]) * ih; v[j + 2] = (x[j + 2] - x0[j + 2]) * ih;
      const rx = v[j] - av.x, ry = v[j + 1] - av.y, rz = v[j + 2] - av.z;
      const s2 = rx * rx + ry * ry + rz * rz;
      if (s2 > ms) ms = s2;
    }
    this.maxSpeed = Math.sqrt(ms);
  }

  _distance(L, gap, stiff, sc) {
    const x = this.x, n = this.n;
    for (let i = 0; i + gap < n; i++) {
      const a = i * 3, b = (i + gap) * 3;
      const dx = x[b] - x[a], dy = x[b + 1] - x[a + 1], dz = x[b + 2] - x[a + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-9) continue;
      const rest = L[i] * sc;
      if (gap === 2 && d > rest) continue;               // bend: only resist folding (compression)
      const wA = i === 0 ? 0 : 1, wB = 1, ws = wA + wB;
      const c = ((d - rest) / d) * stiff / ws;
      x[a] += dx * c * wA; x[a + 1] += dy * c * wA; x[a + 2] += dz * c * wA;
      x[b] -= dx * c * wB; x[b + 1] -= dy * c * wB; x[b + 2] -= dz * c * wB;
    }
  }

  /** The tail never rises above the knot (anchor) minus a small clearance growing along the chain. */
  _ceiling() {
    const x = this.x, top = x[1] - this.o.ceiling + this.ceilLift * this.altW;
    for (let i = 1; i < this.n; i++) if (x[i * 3 + 1] > top) x[i * 3 + 1] = top;
  }

  _collide(record) {
    const x = this.x, m = this.o.margin, n = this.n, N = _v, cols = this.active, nc = this.activeN;
    let pen = 0;
    // root (QA r1 P1-7): a limb that sweeps over the knot (high knee) may push the pinned root out by up to
    // rootPushMax along its surface normal; colliders on the anchor bone itself never move the root. Full margin
    // (not half): with the knot-driven root riding over the raised thigh the ribbon's first ring must clear it too
    if (this.rootPushMax > 0) {
      const tx = this.tw[0], ty = this.tw[1], tz = this.tw[2];
      for (let c = 0; c < nc; c++) {
        if (cols[c].bone === this.anchor) continue;
        const d = cols[c].sdf(x[0], x[1], x[2], m, N);
        if (d < 0) { x[0] -= N.x * d; x[1] -= N.y * d; x[2] -= N.z * d; }
      }
      const dx = x[0] - tx, dy = x[1] - ty, dz = x[2] - tz, dl = Math.sqrt(dx * dx + dy * dy + dz * dz), mx = this.rootPushMax * this.as;
      if (dl > mx) { const f = mx / dl; x[0] = tx + dx * f; x[1] = ty + dy * f; x[2] = tz + dz * f; }
    }
    for (let i = 1; i < n; i++) {
      const j = i * 3;
      let best = 1e9, bx = 0, by = 0, bz = 0;
      // two passes resolve the wedge between overlapping colliders (thigh/hips, thigh/fur)
      for (let pass = 0; pass < 2; pass++) {
        for (let c = 0; c < nc; c++) {
          const d = cols[c].sdf(x[j], x[j + 1], x[j + 2], m, N);
          if (d < 0) { x[j] -= N.x * d; x[j + 1] -= N.y * d; x[j + 2] -= N.z * d; }
          if (pass === 1 && record) {
            if (d < best) { best = d; bx = N.x; by = N.y; bz = N.z; }
            if (-d > pen) pen = -d;
          }
        }
        if (!record) break;
      }
      if (record) { this.cd[i] = best; this.cn[j] = bx; this.cn[j + 1] = by; this.cn[j + 2] = bz; }
    }
    // segment midpoints: the ribbon between two particles must not cut through a limb either
    for (let i = 0; i < n - 1; i++) {
      const a = i * 3, b = a + 3;
      const mx = 0.5 * (x[a] + x[b]), my = 0.5 * (x[a + 1] + x[b + 1]), mz = 0.5 * (x[a + 2] + x[b + 2]);
      for (let c = 0; c < nc; c++) {
        const d = cols[c].sdf(mx, my, mz, m, N);
        if (d >= 0) continue;
        if (i === 0) { x[b] -= N.x * d; x[b + 1] -= N.y * d; x[b + 2] -= N.z * d; } else {
          x[a] -= N.x * d; x[a + 1] -= N.y * d; x[a + 2] -= N.z * d;
          x[b] -= N.x * d; x[b + 1] -= N.y * d; x[b + 2] -= N.z * d;
        }
        if (record && -d > pen) pen = -d;
      }
    }
    if (record) this.maxPen = pen;
  }

  /**
   * Floor: y >= floorY + floorClear for every free particle. friction: on the last iteration, the tangential (xz)
   * displacement of a particle in floor contact since the substep start is cancelled while it is within muS times the
   * normal correction (static), otherwise reduced by muK times it (kinetic), so the tail piles up / folds on the floor.
   */
  _floor(friction) {
    const F = this.floorY + (this.o.floorClear ?? 0.006);
    if (!(F > -1e8)) { this.floorPen = 0; return; }
    const x = this.x, x0 = this.x0, n = this.n, muS = this.o.floorMuS ?? 1.2, muK = this.o.floorMuK ?? 0.7;
    let pen = 0;
    for (let i = 1; i < n; i++) {
      const j = i * 3, d = F - x[j + 1];
      if (d < -1e-4) continue;                         // not in contact
      if (d > 0) { x[j + 1] = F; if (d > pen) pen = d; }
      if (!friction) continue;
      // normal "impulse" proxy: how far the particle was pushed up (incl. the fall of this substep), >= 0.5 mm
      const dn = Math.max(F - Math.min(x0[j + 1], F) + (d > 0 ? d : 0), 5e-4);
      const tx = x[j] - x0[j], tz = x[j + 2] - x0[j + 2], tl = Math.sqrt(tx * tx + tz * tz);
      if (tl < 1e-9) continue;
      const f = tl <= muS * dn ? 1 : Math.min(1, (muK * dn) / tl);
      x[j] -= tx * f; x[j + 2] -= tz * f;
    }
    this.floorPen = pen;
  }

  /** NaN / runaway guard. */
  healthy() {
    const x = this.x;
    const ax = x[0], ay = x[1], az = x[2];
    const lim = 4 * this.as;   // nothing may be > 4 m from the anchor
    for (let i = 3; i < x.length; i += 3) {
      const dx = x[i] - ax, dy = x[i + 1] - ay, dz = x[i + 2] - az;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (!(d2 < lim * lim)) return false;
    }
    return true;
  }
}
