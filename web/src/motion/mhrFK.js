// MHR forward kinematics in JS: the 204 InstantHMR/MHR model parameters -> 127 joint positions and global
// rotations. Port of MHR's `_torch_rig.py` skeleton (Apache-2.0) using the constants in
// /motion/mhr-rig.json (server/tools/extract_mhr_rig.py). Reference: server/mhr_fk.py.
//
// Per joint: local = (offset + t, prerot * eulerXYZ(r), 2^s), global = parent o local.
// Output frame: MHR's own axes in METRES (x = the character's left at rest, y up, z the character's front),
// which is exactly the three.js frame of our sources (camToThree flips InstantHMR's camera y and z back), so
// positions in the three frame are fk.pos * 1 + camToThree(cam_t).
import * as THREE from 'three';

// MHR70 keypoints that are a pure readout of one skeleton joint (InstantHMR mhr_landmarks70 W_vert = 0):
// [keypoint, joint]. kp 69 (neck) is the mean of joints 110 and 111.
export const KP_JOINT = [
  [5, 75], [6, 39], [9, 2], [10, 18], [11, 3], [12, 19], [41, 42], [62, 78],
  [21, 64], [22, 63], [23, 62], [24, 61], [25, 59], [26, 58], [27, 57], [28, 56], [29, 55], [30, 54], [31, 53],
  [32, 52], [33, 51], [34, 50], [35, 49], [36, 48], [37, 47], [38, 46], [39, 45], [40, 44],
  [42, 100], [43, 99], [44, 98], [45, 97], [46, 95], [47, 94], [48, 93], [49, 92], [50, 91], [51, 90], [52, 89],
  [53, 88], [54, 87], [55, 86], [56, 85], [57, 84], [58, 83], [59, 82], [60, 81], [61, 80],
];

export class MHRSkeleton {
  constructor(rig) {
    this.rig = rig;
    this.names = rig.joints;
    this.parents = Int32Array.from(rig.parents);
    this.n = this.names.length;
    this.nParams = rig.params.length;
    this.offsets = Float64Array.from(rig.offsets.flat());
    this.prerot = Float64Array.from(rig.prerot.flat());
    const T = rig.transform;
    this.tRow = Int32Array.from(T.map((e) => e[0]));
    this.tCol = Int32Array.from(T.map((e) => e[1]));
    this.tVal = Float64Array.from(T.map((e) => e[2]));
    this.limits = rig.limits;               // [paramIndex, min, max]
    this._jp = new Float64Array(this.n * 7);
    this.index = Object.fromEntries(this.names.map((n, i) => [n, i]));
    this.rest = this.forward(new Float32Array(this.nParams));
    // copy the rest result (forward reuses its output buffers only when asked)
    this.rest = { pos: this.rest.pos.slice(), quat: this.rest.quat.slice(), scale: this.rest.scale.slice() };
  }

  static async load(url = '/motion/mhr-rig.json') {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`MHR rig ${url}: HTTP ${res.status}`);
    return new MHRSkeleton(await res.json());
  }

  /** Soft-clamp pose parameters into MHR's own limits (tanh roll-off over `soft` rad). Returns a new array. */
  clampParams(params, soft = 0.15) {
    const p = Float32Array.from(params);
    for (const [i, lo, hi] of this.limits) {
      if (i >= p.length) continue;
      const x = p[i];
      if (x > hi - soft) p[i] = hi - soft + soft * Math.tanh((x - (hi - soft)) / soft);
      else if (x < lo + soft) p[i] = lo + soft - soft * Math.tanh(((lo + soft) - x) / soft);
    }
    return p;
  }

  /**
   * params: 204 numbers. Returns {pos: Float64Array(n*3) metres, quat: Float64Array(n*4) xyzw global,
   * scale: Float64Array(n)}. Pass `out` to reuse buffers.
   */
  forward(params, out) {
    const n = this.n, jp = this._jp;
    jp.fill(0);
    const R = this.tRow, C = this.tCol, V = this.tVal;
    for (let k = 0; k < R.length; k++) jp[R[k]] += V[k] * params[C[k]];
    const pos = out?.pos ?? new Float64Array(n * 3);
    const quat = out?.quat ?? new Float64Array(n * 4);
    const scale = out?.scale ?? new Float64Array(n);
    const off = this.offsets, pre = this.prerot, par = this.parents;
    for (let j = 0; j < n; j++) {
      const b = j * 7;
      // local translation (cm), rotation prerot * euler_xyz, scale
      const tx = jp[b] + off[j * 3], ty = jp[b + 1] + off[j * 3 + 1], tz = jp[b + 2] + off[j * 3 + 2];
      const cr = Math.cos(jp[b + 3] / 2), sr = Math.sin(jp[b + 3] / 2);
      const cp = Math.cos(jp[b + 4] / 2), sp = Math.sin(jp[b + 4] / 2);
      const cy = Math.cos(jp[b + 5] / 2), sy = Math.sin(jp[b + 5] / 2);
      const ex = sr * cp * cy - cr * sp * sy, ey = cr * sp * cy + sr * cp * sy;
      const ez = cr * cp * sy - sr * sp * cy, ew = cr * cp * cy + sr * sp * sy;
      const px = pre[j * 4], py = pre[j * 4 + 1], pz = pre[j * 4 + 2], pw = pre[j * 4 + 3];
      let lx = pw * ex + px * ew + py * ez - pz * ey;
      let ly = pw * ey - px * ez + py * ew + pz * ex;
      let lz = pw * ez + px * ey - py * ex + pz * ew;
      let lw = pw * ew - px * ex - py * ey - pz * ez;
      const ls = Math.pow(2, jp[b + 6]);
      const p = par[j];
      if (p < 0) {
        pos[j * 3] = tx; pos[j * 3 + 1] = ty; pos[j * 3 + 2] = tz;
        quat[j * 4] = lx; quat[j * 4 + 1] = ly; quat[j * 4 + 2] = lz; quat[j * 4 + 3] = lw;
        scale[j] = ls;
        continue;
      }
      const qx = quat[p * 4], qy = quat[p * 4 + 1], qz = quat[p * 4 + 2], qw = quat[p * 4 + 3], s = scale[p];
      // rotate local translation by parent rotation: v + 2w(u x v) + 2 u x (u x v)
      const ux = qy * tz - qz * ty, uy = qz * tx - qx * tz, uz = qx * ty - qy * tx;
      const rx = tx + 2 * (qw * ux + qy * uz - qz * uy);
      const ry = ty + 2 * (qw * uy + qz * ux - qx * uz);
      const rz = tz + 2 * (qw * uz + qx * uy - qy * ux);
      pos[j * 3] = pos[p * 3] + s * rx; pos[j * 3 + 1] = pos[p * 3 + 1] + s * ry; pos[j * 3 + 2] = pos[p * 3 + 2] + s * rz;
      const gx = qw * lx + qx * lw + qy * lz - qz * ly;
      const gy = qw * ly - qx * lz + qy * lw + qz * lx;
      const gz = qw * lz + qx * ly - qy * lx + qz * lw;
      const gw = qw * lw - qx * lx - qy * ly - qz * lz;
      const nl = 1 / Math.hypot(gx, gy, gz, gw);
      quat[j * 4] = gx * nl; quat[j * 4 + 1] = gy * nl; quat[j * 4 + 2] = gz * nl; quat[j * 4 + 3] = gw * nl;
      scale[j] = s * ls;
    }
    for (let i = 0; i < n * 3; i++) pos[i] *= 0.01;   // cm -> m
    return { pos, quat, scale };
  }

  jointPos(fk, j, out = new THREE.Vector3()) { return out.set(fk.pos[j * 3], fk.pos[j * 3 + 1], fk.pos[j * 3 + 2]); }
  jointQuat(fk, j, out = new THREE.Quaternion()) { return out.set(fk.quat[j * 4], fk.quat[j * 4 + 1], fk.quat[j * 4 + 2], fk.quat[j * 4 + 3]); }

  /**
   * Validation helper: FK joints -> the joint-readout MHR70 keypoints in InstantHMR camera axes (+cam_t) and the
   * error vs the server's j3d. Returns {mean, max} in millimetres over the KP_JOINT keypoints.
   */
  keypointError(fk, camT, j3d) {
    let sum = 0, max = 0, n = 0;
    const err = (kp, x, y, z) => {
      const r = j3d[kp];
      const e = Math.hypot(x - r[0], y - r[1], z - r[2]) * 1000;
      sum += e; n++; if (e > max) max = e;
    };
    // MHR metres (y up, z back) -> camera (y down, z forward) + cam_t
    const cam = (j) => [fk.pos[j * 3] + camT[0], -fk.pos[j * 3 + 1] + camT[1], -fk.pos[j * 3 + 2] + camT[2]];
    for (const [kp, j] of KP_JOINT) { const c = cam(j); err(kp, c[0], c[1], c[2]); }
    const a = cam(110), b = cam(111);
    err(69, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    return { mean: sum / n, max, n };
  }
}
