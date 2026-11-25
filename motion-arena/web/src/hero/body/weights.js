// Skin-weight generation for the hero body. Owner: WP2. Supersedes geo/attributes.js skinToSegments for
// the body. See docs/character-art-spec.md 2.13 and hero/CONTRACTS.md §3.
//
// How it works
//   1. Every vertex gets weights from analytic FIELDS evaluated at its rest position, not from raw
//      distance to segments. Fields are functions of the limb parameter (x along the arm, the drop below
//      the hip joint along the leg, height along the spine) with smoothstep blend windows of about
//      ±1.2 x the joint radius (dims.WEIGHTS.blendWindow).
//   2. Overlap zones that two loft parts share (shoulder: torso + arm root, hip: pelvis + thigh top)
//      use the SAME field functions for both parts, so the hidden junctions move together.
//   3. Helper bones (rig.js):
//        ElbowHelper / KneeHelper  peak at 1.0 on the joint ring and fall to 0 at ±window. A ring on a
//                                  half-angle helper keeps its full radius, so at 130° the worst ring is
//                                  a 50/50 blend of rotations 32.5° apart (|cos 32.5°| = 0.84) instead of
//                                  0.42 for a plain parent/child blend.
//        HipHelper                 carries the crotch / buttock / inguinal rings (peak at the joint).
//        UpperArmTwist             proximal upper arm (cancels half of the arm roll at the shoulder).
//        ForeArmTwist              mid forearm: forearm (0%) -> twist (50% of hand twist) -> hand (100%),
//                                  so a 90° wrist twist is spread over the forearm (no candy-wrapper).
//   4. Two passes of Laplacian smoothing over the welded mesh graph (dims.WEIGHTS.smoothPasses),
//      then the 4 strongest influences are kept and normalized.

import * as THREE from 'three';
import { smoothstep as S } from './loft.js';
import { neckSeamWeights } from '../rig.js';

const NW = [0, 0];

export const PART = Object.freeze({ TORSO: 0, ARM: 1, DIGIT: 2, LEG: 3 });

/**
 * Field weights for one vertex. Returns a Map(boneName -> weight) (unnormalized).
 * p: Vector3 rest position, part: PART.*, J: dims.JOINT_WORLD, Wd: dims.WEIGHTS.
 */
export function fieldWeights(p, part, dims) {
  const J = dims.JOINT_WORLD, BW = dims.WEIGHTS.blendWindow;
  const w = new Map();
  const add = (b, v) => { if (v > 1e-5) w.set(b, (w.get(b) || 0) + v); };
  const side = p.x >= 0 ? 'left' : 'right';
  const X = Math.abs(p.x);

  // ---------------- spine core (torso, neck): height y
  const core = (scale) => {
    if (scale <= 1e-5) return;
    const y = p.y;
    const hs = S(J.spine[1] - 0.075, J.spine[1] + 0.06, y);          // hips -> spine (wide: smooth twist)
    const sc = S(J.chest[1] - 0.085, J.chest[1] + 0.055, y);         // spine -> chest
    const cn = S(J.neck[1] - 0.035, J.neck[1] + 0.03, y);            // chest -> neck (neck base)
    // neck -> head over the head's own seam window (rig.neckSeamWeights, y 1.47..1.55), so the neck skin and
    // the head's jaw-underside / nape vertices move identically on turns and tilts (QA P0-11)
    neckSeamWeights(y, NW);
    const nk = scale * hs * sc * cn;
    add('hips', scale * (1 - hs));
    add('spine', scale * hs * (1 - sc));
    add('chest', scale * hs * sc * (1 - cn));
    add('neck', nk * NW[0]);
    add('head', nk * NW[1]);
  };

  // ---------------- arm chain along |x| (shared by torso shoulder zone and the arm loft)
  const armChain = (scale) => {
    if (scale <= 1e-5) return;
    const sh = J.leftUpperArm[0], el = J.leftForeArm[0], wr = J.leftHand[0];
    const Rs = 0.048, Re = 0.037, Rw = 0.022;
    const b = S(sh - 1.6 * Rs, sh + 0.6 * Rs, X);                     // shoulder (clavicle bone) -> upper arm (biased medially: the deltoid cap follows the arm)
    const tw = 1 - S(sh + 0.13, sh + 0.23, X);                       // upper-arm twist (proximal) -> upper arm
    const e1 = S(el - BW * Re, el, X), e2 = S(el, el + BW * Re, X);   // -> elbow helper -> forearm
    const f1 = S(el + 0.03, el + 0.17, X);                           // forearm -> forearm twist
    const h = S(wr - BW * Rw, wr + BW * Rw * 1.15, X);               // -> hand (wrist)
    add(`${side}Shoulder`, scale * (1 - b));
    const ua = scale * b * (1 - e1);
    add(`${side}UpperArmTwist`, ua * tw);
    add(`${side}UpperArm`, ua * (1 - tw));
    add(`${side}ElbowHelper`, scale * b * e1 * (1 - e2));
    const fa = scale * b * e2;
    add(`${side}ForeArm`, fa * (1 - f1) * (1 - h));
    add(`${side}ForeArmTwist`, fa * f1 * (1 - h));
    add(`${side}Hand`, fa * h);
  };
  /** How much the arm chain owns a point (1 on the arm, 0 on the ribcage / neck). */
  const armOwn = () => {
    const ay = p.y - J.leftUpperArm[1], az = p.z;
    const r = Math.hypot(ay, az);
    const lat = S(0.035, 0.105, X);                    // medial: chest
    const rad = 1 - S(0.06, 0.115, r);                 // away from the arm axis (ribs, lats): chest
    const deep = S(J.leftUpperArm[0] - 0.005, J.leftUpperArm[0] + 0.040, X); // beyond the joint everything is arm
    return Math.max(lat * rad, deep);
  };

  // ---------------- leg chain: a = drop below the hip joint (along the rest leg axis -Y)
  const legChain = (scale, sd) => {
    if (scale <= 1e-5) return;
    const hip = J.leftThigh[1], kn = J.leftShin[1], an = J.leftFoot[1];
    const a = hip - p.y;
    const Rh = 0.085, Rk = 0.05;
    const hp = S(-0.085, 0.0, a), ht = S(0.0, 0.11, a);              // hips -> HipHelper -> thigh
    const k1 = S(hip - kn - BW * Rk, hip - kn, a), k2 = S(hip - kn, hip - kn + BW * Rk, a);
    // foot: below the ankle pivot, or forward of the ankle (instep / toes)
    const fw = Math.max(1 - S(an - 0.012, an + 0.042, p.y), S(0.035, 0.08, p.z) * (1 - S(an + 0.03, an + 0.07, p.y)));
    add('hips', scale * (1 - hp));
    add(`${sd}HipHelper`, scale * hp * (1 - ht));
    const th = scale * hp * ht;
    add(`${sd}Thigh`, th * (1 - k1));
    add(`${sd}KneeHelper`, th * k1 * (1 - k2));
    const sh = th * k2;
    add(`${sd}Shin`, sh * (1 - fw));
    add(`${sd}Foot`, sh * fw);
    void Rh;
  };
  /** Leg ownership of a pelvis point (shared by torso + leg loft tops). */
  const legOwn = (sd) => {
    const sx = sd === 'left' ? 1 : -1;
    const xs = p.x * sx;                          // signed toward this leg
    const a = J.leftThigh[1] - p.y;
    const med = S(-0.005, 0.05, xs);               // midline belongs to the pelvis
    const low = S(0.04, 0.12, a);                  // far down the leg belongs to the leg
    return Math.max(med, low);
  };

  if (part === PART.DIGIT) { add(`${side}Hand`, 1); return w; }
  if (part === PART.ARM) {
    const g = armOwn();
    core(1 - g); armChain(g);
    return w;
  }
  if (part === PART.LEG) {
    const g = legOwn(side);
    core(1 - g); legChain(g, side);
    return w;
  }
  // torso: spine core + shoulder zones + hip zones
  let gA = 0, gL = 0, gR = 0;
  if (p.y > 1.2) gA = armOwn();
  if (p.y < 0.99) { gL = legOwn('left') * (p.x > -0.01 ? 1 : 0); gR = legOwn('right') * (p.x < 0.01 ? 1 : 0); }
  // torso pelvis points get at most 85% leg ownership (keeps the waistline anchored to the hips)
  gL = Math.min(gL, 0.85); gR = Math.min(gR, 0.85);
  const sumL = gL + gR;
  if (sumL > 0.85) { gL *= 0.85 / sumL; gR *= 0.85 / sumL; }
  const gCore = Math.max(0, 1 - gA - gL - gR);
  core(gCore);
  armChain(gA);
  legChain(gL, 'left');
  legChain(gR, 'right');
  return w;
}

/**
 * Compute skinIndex / skinWeight for merged body arrays.
 * @param {Float32Array|number[]} positions  root-space rest positions (xyz)
 * @param {Uint32Array|number[]} index       triangle indices
 * @param {Uint8Array|number[]} partOf       PART.* per vertex
 * @param {object} rig                       ctx.rig (boneIndex)
 * @param {object} dims
 * @param {object} [opt] { smoothPasses, lambda, maxInfluences, freeze(vertex) -> bool }
 */
export function computeSkinWeights(positions, index, partOf, rig, dims, opt = {}) {
  const n = positions.length / 3;
  const nb = rig.boneOrder.length;
  const passes = opt.smoothPasses ?? dims.WEIGHTS.smoothPasses;
  const lambda = opt.lambda ?? 0.5;
  const maxInf = opt.maxInfluences ?? dims.WEIGHTS.maxInfluences;
  const W = new Float32Array(n * nb);
  const p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    p.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    const m = fieldWeights(p, partOf[i], dims);
    let sum = 0;
    for (const v of m.values()) sum += v;
    for (const [b, v] of m) {
      const bi = rig.boneIndex[b];
      if (bi === undefined) throw new Error(`weights: unknown bone ${b}`);
      W[i * nb + bi] += v / (sum || 1);
    }
    if (!sum) W[i * nb + rig.boneIndex.hips] = 1;
  }

  // ---- Laplacian smoothing over the welded graph (seam duplicates share one node)
  if (passes > 0) {
    const weld = weldIndex(positions);
    const nodes = new Map(); // weld root -> Set(neighbour roots)
    for (let t = 0; t < index.length; t += 3) {
      const a = weld[index[t]], b = weld[index[t + 1]], c = weld[index[t + 2]];
      for (const [x, y] of [[a, b], [b, c], [c, a]]) {
        if (!nodes.has(x)) nodes.set(x, new Set());
        if (!nodes.has(y)) nodes.set(y, new Set());
        nodes.get(x).add(y); nodes.get(y).add(x);
      }
    }
    const roots = [...nodes.keys()];
    const tmp = new Float32Array(n * nb);
    for (let pass = 0; pass < passes; pass++) {
      tmp.set(W);
      for (const r of roots) {
        if (partOf[r] === PART.DIGIT) continue;
        if (opt.freeze && opt.freeze(r)) continue;
        const nbs = nodes.get(r);
        const o = r * nb;
        for (let b = 0; b < nb; b++) {
          let acc = 0;
          for (const q of nbs) acc += tmp[q * nb + b];
          W[o + b] = (1 - lambda) * tmp[o + b] + lambda * (acc / nbs.size);
        }
      }
      // copy weld roots back to their duplicates
      for (let i = 0; i < n; i++) if (weld[i] !== i) W.copyWithin(i * nb, weld[i] * nb, weld[i] * nb + nb);
    }
  }

  // ---- keep the strongest influences, normalize
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4);
  const arr = [];
  for (let i = 0; i < n; i++) {
    const o = i * nb;
    // top-maxInf selection (insertion into a short sorted list; no per-vertex sort/alloc)
    arr.length = 0;
    for (let b = 0; b < nb; b++) {
      const v = W[o + b];
      if (arr.length === maxInf && v <= W[o + arr[maxInf - 1]]) continue;
      let k = arr.length < maxInf ? arr.length : maxInf - 1;
      while (k > 0 && W[o + arr[k - 1]] < v) { arr[k] = arr[k - 1]; k--; }
      arr[k] = b;
    }
    let sum = 0;
    for (const b of arr) sum += W[o + b];
    arr.forEach((b, k) => {
      skinIndex[i * 4 + k] = W[o + b] > 0 ? b : 0;
      skinWeight[i * 4 + k] = sum > 0 ? W[o + b] / sum : (k === 0 ? 1 : 0);
    });
  }
  return { skinIndex, skinWeight, dense: W, boneCount: nb };
}

/** Weld map by exact position (seam duplicates of a loft share the same position). */
function weldIndex(pos) {
  const n = pos.length / 3, map = new Map(), out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos[i * 3] * 1e6)},${Math.round(pos[i * 3 + 1] * 1e6)},${Math.round(pos[i * 3 + 2] * 1e6)}`;
    const e = map.get(k);
    if (e === undefined) { map.set(k, i); out[i] = i; } else out[i] = e;
  }
  return out;
}
