// Hand states from InstantHMR's 3D hand keypoints -> blended authored finger poses for the VRM finger bones.
// Classifying (fist / open / point / relaxed) survives motion blur and reads better in a fighting game than raw
// per-finger angles. Mode 'tracked' (MHR finger rotations) is handled by the solver; this module is 'pose'.
import * as THREE from 'three';
import { clamp } from './math.js';

// MHR70 hand keypoints: [tip, DIP, PIP, MCP] per finger (DIP/PIP/MCP = "first/second/third joint")
const HAND_KP = {
  right: { wrist: 41, thumb: [21, 22, 23, 24], index: [25, 26, 27, 28], middle: [29, 30, 31, 32], ring: [33, 34, 35, 36], little: [37, 38, 39, 40] },
  left: { wrist: 62, thumb: [42, 43, 44, 45], index: [46, 47, 48, 49], middle: [50, 51, 52, 53], ring: [54, 55, 56, 57], little: [58, 59, 60, 61] },
};

/** Curl 0 (straight) .. 1 (fully curled) of one finger from its 4 keypoints + wrist. */
function curl(kp, ids, wrist) {
  const [tip, dip, pip, mcp] = ids.map((i) => kp[i]);
  if (!tip || !mcp) return 0.3;
  const seg = mcp.distanceTo(pip) + pip.distanceTo(dip) + dip.distanceTo(tip);
  const straight = tip.distanceTo(mcp) / (seg + 1e-6);              // 1 straight .. ~0.35 curled
  const a = pip.clone().sub(mcp).normalize(), b = mcp.clone().sub(kp[wrist]).normalize();
  const mcpBend = Math.acos(clamp(a.dot(b), -1, 1));                // knuckle flexion
  return clamp(((0.97 - straight) / 0.55) * 0.75 + (mcpBend / 1.4) * 0.25, 0, 1);
}

// Per finger [proximal, intermediate, distal] flexion (rad). Thumb: per segment [metacarpal, proximal, distal]
// a [across, down, roll] triple in the LEFT hand's local frame (mirrored for the right): `across` swings the
// thumb over the palm toward the little finger (+Y), `down` folds it toward the palm side (-Z for the left hand),
// `roll` turns its pad to face the fingers (opposition, about the thumb axis).
export const HAND_POSES = {
  // natural rest: curl increasing toward the little finger, thumb opposed and slightly in front of the index
  relaxed: { thumb: [[0.42, 0.32, 0.5], [0.18, 0.12, 0], [0.22, 0.05, 0]],
    index: [0.35, 0.45, 0.3], middle: [0.45, 0.55, 0.35], ring: [0.55, 0.62, 0.4], little: [0.65, 0.7, 0.45] },
  open: { thumb: [[0.1, 0.08, 0.2], [0.02, 0, 0], [0.04, 0, 0]],
    index: [0.04, 0.05, 0.03], middle: [0.04, 0.05, 0.03], ring: [0.05, 0.06, 0.04], little: [0.06, 0.07, 0.05] },
  // tight fist: fingers rolled in, thumb wrapped across the middle phalanges of index + middle
  fist: { thumb: [[0.75, 0.62, 0.85], [0.55, 0.35, 0], [0.75, 0.15, 0]],
    index: [1.5, 1.7, 1.0], middle: [1.55, 1.7, 1.0], ring: [1.55, 1.7, 1.0], little: [1.5, 1.7, 1.0] },
  point: { thumb: [[0.7, 0.55, 0.8], [0.5, 0.3, 0], [0.7, 0.1, 0]],
    index: [0.05, 0.05, 0.03], middle: [1.55, 1.7, 1.0], ring: [1.55, 1.7, 1.0], little: [1.5, 1.7, 1.0] },
};
// Thumb by segment DIRECTION (hand frame of the LEFT hand: +X along the fingers, +Y back of the hand, +Z thumb
// side; mirrored x for the right hand) + a roll about the segment (opposition: pad turned toward the fingers).
// Used when the rig's thumb rest positions are known (always for a VRM); Euler triples above are the fallback.
export const THUMB_DIRS = {
  relaxed: { dirs: [[0.62, -0.38, 0.68], [0.72, -0.5, 0.48], [0.78, -0.55, 0.3]], roll: [0.5, 0.2, 0] },
  open: { dirs: [[0.6, -0.12, 0.79], [0.75, -0.1, 0.65], [0.85, -0.05, 0.52]], roll: [0.2, 0, 0] },
  // wrapped over the middle phalanges of index + middle, below the palm
  fist: { dirs: [[0.62, -0.45, 0.62], [0.62, -0.55, -0.25], [0.35, -0.18, -0.92]], roll: [0.9, 0.3, 0.2] },
  point: { dirs: [[0.62, -0.5, 0.6], [0.55, -0.72, -0.1], [0.3, -0.4, -0.85]], roll: [0.9, 0.3, 0.2] },
};
const POSE_NAMES = Object.keys(HAND_POSES);
const VRM_F = { thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', little: 'Little' };
const SEGS = { thumb: ['Metacarpal', 'Proximal', 'Distal'], other: ['Proximal', 'Intermediate', 'Distal'] };
const _e = new THREE.Euler(0, 0, 0, 'YZX'), _z = new THREE.Vector3(0, 0, 1), _x = new THREE.Vector3(1, 0, 0);
const _qr = new THREE.Quaternion();

export class HandPoser {
  constructor(rig = null) {
    // thumb rest directions (hand frame = rest frame, normalized bones have identity rest rotations)
    this.thumbRest = null;
    if (rig?.restWorld) {
      const W = rig.restWorld, tr = {};
      for (const side of ['left', 'right']) {
        const m = W[side + 'ThumbMetacarpal'], p = W[side + 'ThumbProximal'], d = W[side + 'ThumbDistal'];
        if (!m || !p || !d) { tr[side] = null; continue; }
        const d0 = p.clone().sub(m).normalize(), d1 = d.clone().sub(p).normalize();
        tr[side] = [d0, d1, d1.clone()];
      }
      if (tr.left && tr.right) this.thumbRest = tr;
    }
    this._td = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this._tr = [0, 0, 0];
    this._qa = new THREE.Quaternion(); this._qp = new THREE.Quaternion(); this._qw = new THREE.Quaternion();
    this.weights = { left: { relaxed: 1 }, right: { relaxed: 1 } };
    this.state = { left: 'relaxed', right: 'relaxed' };
    this.curls = { left: null, right: null };
    this.override = { left: null, right: null };   // e.g. 'fist' during a punch accent
  }

  /** kp: 70 Vector3 (any frame); side: which hand's keypoints; outSide: which state slot to write (mirror). */
  classify(kp, side, conf = 1, outSide = side) {
    const H = HAND_KP[side];
    if (!kp || conf < 0.3) return this.state[outSide];
    const c = {}; for (const f of ['index', 'middle', 'ring', 'little', 'thumb']) c[f] = curl(kp, H[f], H.wrist);
    this.curls[outSide] = c;
    const others = (c.middle + c.ring + c.little) / 3;
    const prev = this.state[outSide];
    const hi = prev === 'fist' || prev === 'point' ? 0.42 : 0.5, lo = prev === 'open' ? 0.33 : 0.25;   // hysteresis
    let s = 'relaxed';
    if (others > hi && c.index > hi) s = 'fist';
    else if (others > hi && c.index < lo) s = 'point';
    else if (others < lo && c.index < lo) s = 'open';
    this.state[outSide] = s;
    return s;
  }

  /**
   * Blend weights toward the current state and write finger local rotations. Closing into a fist (or point)
   * blends with `tauFist` (snappy, so a punch reads as a fist from its first frames); opening uses `tau`.
   */
  apply(rotations, dt, present, tau = 0.07, tauFist = 0.035) {
    for (const side of ['left', 'right']) {
      const goal = this.override[side] ?? this.state[side];
      const w = this.weights[side];
      const k = 1 - Math.exp(-dt / (goal === 'fist' || goal === 'point' ? tauFist : tau));
      let sum = 0;
      for (const n of POSE_NAMES) { w[n] = (w[n] ?? 0) + ((n === goal ? 1 : 0) - (w[n] ?? 0)) * k; sum += w[n]; }
      const sgn = side === 'left' ? -1 : 1;           // curl is -Z for the left hand (fingers along +X), +Z right
      for (const f of Object.keys(VRM_F)) {
        const segs = f === 'thumb' ? SEGS.thumb : SEGS.other;
        for (let i = 0; i < 3; i++) {
          const bone = `${side}${VRM_F[f]}${segs[i]}`;
          if (present && !present.has(bone)) continue;
          const q = rotations[bone] ?? (rotations[bone] = new THREE.Quaternion());
          if (f === 'thumb' && this.thumbRest) {
            if (i === 0) {   // blended target directions + rolls for the 3 segments
              for (let j = 0; j < 3; j++) {
                this._td[j].set(0, 0, 0); this._tr[j] = 0;
                for (const n of POSE_NAMES) {
                  const m = w[n] / sum, T = THUMB_DIRS[n];
                  this._td[j].x += m * T.dirs[j][0] * -sgn; this._td[j].y += m * T.dirs[j][1]; this._td[j].z += m * T.dirs[j][2];
                  this._tr[j] += m * T.roll[j] * -sgn;
                }
                this._td[j].normalize();
              }
              this._qp.identity();          // world (hand-frame) rotation of the parent segment
            }
            // hand-frame rotation of this segment: rest dir -> target dir, then roll about it; local = parent^-1 * it
            this._qw.setFromUnitVectors(this.thumbRest[side][i], this._td[i]);
            if (this._tr[i]) this._qw.premultiply(this._qa.setFromAxisAngle(this._td[i], this._tr[i]));
            q.copy(this._qp).invert().multiply(this._qw);
            this._qp.copy(this._qw);
          } else if (f === 'thumb') {
            let ac = 0, dn = 0, rl = 0;
            for (const n of POSE_NAMES) { const t = HAND_POSES[n].thumb[i], m = w[n] / sum; ac += m * t[0]; dn += m * t[1]; rl += m * t[2]; }
            // left hand: across = +Y, down = -Z, roll = -X; mirrored (y, z angles negated, x kept) for the right
            _e.set(0, -sgn * ac, sgn * dn, 'YZX');
            q.setFromEuler(_e);
            if (rl) q.multiply(_qr.setFromAxisAngle(_x, -rl));   // a rotation about X mirrors to itself
          } else {
            let a = 0;
            for (const n of POSE_NAMES) a += (w[n] / sum) * HAND_POSES[n][f][i];
            q.setFromAxisAngle(_z, sgn * a);
          }
        }
      }
    }
    return rotations;
  }
}
